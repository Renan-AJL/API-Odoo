/**
 * services/odoo-field-setup.js - Auto-setup de campos Itau no Odoo
 * ============================================================
 * Cria automaticamente todos os campos x_studio_itau_* no model account.move
 * E adiciona os campos ao form view na aba "Itau".
 *
 * Executado automaticamente na inicializacao do servidor.
 * Idempotente - seguro executar multiplas vezes.
 *
 * Campos criados:
 *   x_studio_itau_situacao           - Status Itau (EMITIDO/PAGO/CANCELADO/EXPIRADO/ERRO)
 *   x_studio_itau_status_pagamento   - Status Pagamento (PENDENTE/PAGO/CANCELADO/EXPIRADO)
 *   x_studio_itau_tipo_pagamento     - Tipo Pagamento (PIX/BOLETO/CARTAO)
 *   x_studio_itau_pix_status         - PIX Status (ATIVA/CONCLUIDA/REMOVIDA_PELO_PSP/EXPIRADA)
 *   x_studio_itau_pix_data_pagamento - PIX Data Pagamento (datetime)
 *   x_studio_itau_pix_e2e            - PIX End-to-End ID (char)
 *   x_studio_itau_txid               - PIX TXID (char)
 *   x_studio_itau_pix_copia_cola     - PIX Copia e Cola (text)
 *   x_studio_itau_nosso_numero       - Nosso Numero (char)
 *   x_studio_itau_boleto_status      - Boleto Status (EM_ABERTO/PAGO/CANCELADO/EXPIRADO)
 *   x_studio_itau_boleto_data_pagamento - Boleto Data Pagamento (date)
 *   x_studio_itau_link_status        - Link/PDF URL (char)
 *   x_studio_itau_boletos_html       - HTML with QR Code (html)
 *   x_studio_itau_resposta_json      - Resposta JSON (text)
 *   x_studio_boleto_cancelado        - Boleto Cancelado (boolean)
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');

// ============================================================
// Odoo XML-RPC helpers
// ============================================================

function odooAuth(oc) {
  return new Promise(function(ok, fail) {
    var base = oc.url.replace(/\/+$/, '');
    var host = base.replace('https://', '');
    var client = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
    client.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, r) {
      if (e || !r) return fail(e || new Error('Odoo auth failed'));
      ok({ uid: r, host: host });
    });
  });
}

function odooExec(oc, host, uid, model, method, args, kwargs) {
  return new Promise(function(ok, fail) {
    var client = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });
    var params = [oc.db, uid, oc.password, model, method, args];
    if (kwargs) params.push(kwargs);
    client.methodCall('execute_kw', params, function(e, r) {
      if (e) return fail(e);
      ok(r);
    });
  });
}

// ============================================================
// FIELD DEFINITIONS
// ============================================================

var FIELDS_TO_CREATE = [
  {
    name: 'x_studio_itau_situacao',
    field_description: 'Status Itau',
    ttype: 'selection',
    selection: "[('emitido','Emitido'),('pago','Pago'),('cancelado','Cancelado'),('expirado','Expirado'),('erro','Erro')]",
  },
  {
    name: 'x_studio_itau_status_pagamento',
    field_description: 'Status Pagamento Itau',
    ttype: 'selection',
    selection: "[('pendente','Pendente'),('pago','Pago'),('cancelado','Cancelado'),('expirado','Expirado')]",
  },
  {
    name: 'x_studio_itau_tipo_pagamento',
    field_description: 'Tipo Pagamento Itau',
    ttype: 'selection',
    selection: "[('pix','PIX'),('boleto','Boleto'),('cartao','Cartao')]",
  },
  {
    name: 'x_studio_itau_pix_status',
    field_description: 'PIX Status',
    ttype: 'selection',
    selection: "[('ativa','Ativa'),('concluida','Concluida'),('removida_pelo_psp','Removida pelo PSP'),('expirada','Expirada')]",
  },
  {
    name: 'x_studio_itau_pix_data_pagamento',
    field_description: 'PIX Data Pagamento',
    ttype: 'datetime',
  },
  {
    name: 'x_studio_itau_pix_e2e',
    field_description: 'PIX End-to-End ID',
    ttype: 'char',
  },
  {
    name: 'x_studio_itau_txid',
    field_description: 'PIX TXID',
    ttype: 'char',
  },
  {
    name: 'x_studio_itau_pix_copia_cola',
    field_description: 'PIX Copia e Cola',
    ttype: 'text',
  },
  {
    name: 'x_studio_itau_nosso_numero',
    field_description: 'Nosso Numero Itau',
    ttype: 'char',
  },
  {
    name: 'x_studio_itau_boleto_status',
    field_description: 'Boleto Status',
    ttype: 'selection',
    selection: "[('em_aberto','Em Aberto'),('pago','Pago'),('cancelado','Cancelado'),('expirado','Expirado')]",
  },
  {
    name: 'x_studio_itau_boleto_data_pagamento',
    field_description: 'Boleto Data Pagamento',
    ttype: 'date',
  },
  {
    name: 'x_studio_itau_link_status',
    field_description: 'Itau Link Status',
    ttype: 'char',
  },
  {
    name: 'x_studio_itau_boletos_html',
    field_description: 'Itau Boletos HTML',
    ttype: 'html',
  },
  {
    name: 'x_studio_itau_resposta_json',
    field_description: 'Itau Resposta JSON',
    ttype: 'text',
  },
  {
    name: 'x_studio_boleto_cancelado',
    field_description: 'Boleto Cancelado',
    ttype: 'boolean',
  },
];

// ============================================================
// MAIN SETUP FUNCTION
// ============================================================

/**
 * setupItauFields - Creates missing itau fields on account.move and
 * adds them to the form view in the "Itau" tab.
 * Returns { created, skipped, errors, viewUpdated }
 */
async function setupItauFields() {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    console.log('[FIELD-SETUP] Odoo desabilitado, pulando setup de campos');
    return { created: 0, skipped: 0, errors: 0, viewUpdated: false };
  }

  console.log('[FIELD-SETUP] Iniciando verificacao/criacao de campos Itau...');

  var odooHost, odooUid;
  try {
    var authResult = await odooAuth(oc);
    odooUid = authResult.uid;
    odooHost = authResult.host;
  } catch (err) {
    console.error('[FIELD-SETUP] Erro auth Odoo:', err.message);
    return { created: 0, skipped: 0, errors: 1, viewUpdated: false };
  }

  // Get model ID for account.move
  var modelIds;
  try {
    modelIds = await odooExec(oc, odooHost, odooUid, 'ir.model', 'search', [
      [['model', '=', 'account.move']]
    ]);
  } catch (err) {
    console.error('[FIELD-SETUP] Erro ao buscar model account.move:', err.message);
    return { created: 0, skipped: 0, errors: 1, viewUpdated: false };
  }

  if (!modelIds || modelIds.length === 0) {
    console.error('[FIELD-SETUP] Modelo account.move nao encontrado');
    return { created: 0, skipped: 0, errors: 1, viewUpdated: false };
  }
  var modelId = modelIds[0];

  // Detect ALL existing fields in one search_read call
  // Domain: name in NOMES AND model in [account.move, account.bank.statement.line]
  // Usa 'model' (char field direto) em vez de 'model_id.model' (Many2one traversal)
  // que pode falhar em Odoo 19 SaaS por permissoes ou API changes
  var NOMES = FIELDS_TO_CREATE.map(function(f) { return f.name; });
  var existingFields = {};
  var detectionOk = false;
  try {
    var existingData = await odooExec(oc, odooHost, odooUid, 'ir.model.fields', 'search_read',
      [[['name', 'in', NOMES], ['model', 'in', ['account.move', 'account.bank.statement.line']]]],
      { fields: ['name', 'model', 'state'] }
    );
    if (existingData && existingData.length > 0) {
      for (var e = 0; e < existingData.length; e++) {
        existingFields[existingData[e].name] = existingData[e];
      }
    }
    detectionOk = true;
  } catch (err) {
    console.error('[FIELD-SETUP] Erro ao detectar campos existentes via search_read:', err.message);
    console.error('[FIELD-SETUP] NAO sera tentada criacao de campos — risco de "Field names must be unique"');
  }

  var existingCount = Object.keys(existingFields).length;
  console.log('[FIELD-SETUP] ' + existingCount + ' campo(s) itau ja existem no Odoo (deteccao ' + (detectionOk ? 'OK' : 'FALHOU') + ')');

  // Se todos os 15 campos ja existem, pula criacao completamente
  if (existingCount >= FIELDS_TO_CREATE.length) {
    console.log('[FIELD-SETUP] Todos os ' + existingCount + ' campos ja existem. Nenhuma criacao necessaria.');
    // Ainda tenta atualizar a view se necessario
    var viewUpdated = await setupItauFormView(oc, odooHost, odooUid);
    return { created: 0, skipped: existingCount, errors: 0, viewUpdated: viewUpdated };
  }

  // Se a deteccao falhou completamente, NAO tenta criar — risco de duplicata
  if (!detectionOk) {
    console.error('[FIELD-SETUP] Deteccao falhou. Abortando criacao para evitar erros de duplicata.');
    return { created: 0, skipped: 0, errors: 1, viewUpdated: false };
  }

  // Create missing fields
  var created = 0;
  var skipped = 0;
  var errors = 0;

  for (var i = 0; i < FIELDS_TO_CREATE.length; i++) {
    var f = FIELDS_TO_CREATE[i];
    var fieldName = f.name;

    if (existingFields[fieldName]) {
      console.log('[FIELD-SETUP]   ' + fieldName + ': JA EXISTE');
      skipped++;
      continue;
    }

    // Create field
    var vals = {
      name: fieldName,
      field_description: f.field_description,
      ttype: f.ttype,
      model_id: modelId,
      store: true,
    };

    // Handle selection fields
    if (f.ttype === 'selection') {
      vals.selection = f.selection;
    }

    // Handle char size
    if (f.ttype === 'char') {
      vals.size = 256;
    }

    try {
      var fieldId = await odooExec(oc, odooHost, odooUid, 'ir.model.fields', 'create', [vals]);
      console.log('[FIELD-SETUP]   ' + fieldName + ': CRIADO (id=' + fieldId + ')');
      created++;
    } catch (err) {
      // Se o campo ja existe (Field names must be unique), conta como skipped
      if (err.message && err.message.indexOf('unique') !== -1) {
        console.log('[FIELD-SETUP]   ' + fieldName + ': JA EXISTE (criacao recusada pelo Odoo)');
        skipped++;
      } else {
        console.error('[FIELD-SETUP]   ' + fieldName + ': ERRO - ' + err.message);
        errors++;
      }
    }
  }

  // Update form view to add Itau tab
  var viewUpdated = false;
  if (created > 0 || existingCount > 0) {
    viewUpdated = await setupItauFormView(oc, odooHost, odooUid);
  }

  // Invalidate field detection cache
  try {
    var payPoll = require('./itau-payment-poll');
    if (payPoll.invalidateFieldCache) {
      payPoll.invalidateFieldCache();
    }
  } catch (e) { /* ignore */ }

  console.log('[FIELD-SETUP] Resultado: ' + created + ' criados, ' + skipped + ' existentes, ' + errors + ' erros, view=' + (viewUpdated ? 'OK' : 'NAO'));

  return { created: created, skipped: skipped, errors: errors, viewUpdated: viewUpdated };
}

// ============================================================
// FORM VIEW SETUP - Add Itau tab to account.move form
// ============================================================

/**
 * setupItauFormView - Adds an "Itau" tab with all itau fields to the
 * account.move form view. Finds the inherited view and modifies its arch.
 */
async function setupItauFormView(oc, host, uid) {
  console.log('[FIELD-SETUP] Verificando form view account.move...');

  try {
    // Find the main account.move form view
    var viewIds = await odooExec(oc, host, uid, 'ir.ui.view', 'search',
      [[['model', '=', 'account.move'], ['type', '=', 'form'], ['inherit_id', '=', false]]],
      { limit: 1 }
    );

    if (!viewIds || viewIds.length === 0) {
      // Try finding any account.move form view
      viewIds = await odooExec(oc, host, uid, 'ir.ui.view', 'search',
        [[['model', '=', 'account.move'], ['type', '=', 'form']]],
        { limit: 1 }
      );
    }

    if (!viewIds || viewIds.length === 0) {
      console.log('[FIELD-SETUP] Nenhum form view account.move encontrado');
      return false;
    }

    var mainViewId = viewIds[0];

    // Check if we already have an inherited view with itau fields
    var existingInheritIds = await odooExec(oc, host, uid, 'ir.ui.view', 'search',
      [[['model', '=', 'account.move'], ['type', '=', 'form'], ['name', 'like', 'Itau']]]
    );

    if (existingInheritIds && existingInheritIds.length > 0) {
      console.log('[FIELD-SETUP] View herdada Itau ja existe (id=' + existingInheritIds[0] + ')');
      return true;
    }

    // Build the inherited view arch with Itau tab
    var itauTabArch = [
      '<data>',
      '  <xpath expr="//page[last()]" position="after">',
      '    <page string="Itau" name="itau_tab" autofocus="autofocus">',
      '      <group>',
      '        <group string="Status Itau">',
      '          <field name="x_studio_itau_situacao"/>',
      '          <field name="x_studio_itau_status_pagamento"/>',
      '          <field name="x_studio_itau_tipo_pagamento"/>',
      '        </group>',
      '        <group string="PIX">',
      '          <field name="x_studio_itau_txid"/>',
      '          <field name="x_studio_itau_pix_status"/>',
      '          <field name="x_studio_itau_pix_data_pagamento"/>',
      '          <field name="x_studio_itau_pix_e2e"/>',
      '          <field name="x_studio_itau_pix_copia_cola"/>',
      '        </group>',
      '      </group>',
      '      <group>',
      '        <group string="Boleto">',
      '          <field name="x_studio_itau_nosso_numero"/>',
      '          <field name="x_studio_itau_boleto_status"/>',
      '          <field name="x_studio_itau_boleto_data_pagamento"/>',
      '          <field name="x_studio_boleto_cancelado"/>',
      '        </group>',
      '        <group string="Dados Complementares">',
      '          <field name="x_studio_itau_link_status"/>',
      '          <field name="x_studio_itau_boletos_html"/>',
      '          <field name="x_studio_itau_resposta_json"/>',
      '        </group>',
      '      </group>',
      '    </page>',
      '  </xpath>',
      '</data>',
    ].join('\n');

    // Create inherited view
    var viewVals = {
      name: 'account.move.form.itau.tab',
      model: 'account.move',
      type: 'form',
      inherit_id: mainViewId,
      arch_base: itauTabArch,
      active: true,
    };

    var newViewId = await odooExec(oc, host, uid, 'ir.ui.view', 'create', [viewVals]);
    console.log('[FIELD-SETUP] View herdada Itau criada (id=' + newViewId + ')');
    return true;

  } catch (err) {
    console.error('[FIELD-SETUP] Erro ao configurar form view:', err.message);
    return false;
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  setupItauFields: setupItauFields,
  FIELDS_TO_CREATE: FIELDS_TO_CREATE,
};
