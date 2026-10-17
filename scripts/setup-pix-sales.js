/**
 * scripts/setup-pix-sales.js
 * ============================================
 * Configura regras de PIX no app Vendas (sale.order) via XML-RPC:
 *
 * 1. Cria campos x_studio_itau_* no sale.order (se não existirem)
 * 2. Cria Server Action "Gerar PIX" no sale.order
 * 3. Cria Automated Action: travar forma de pagamento após PIX
 * 4. Cria Automated Action: travar cancelar/voltar rascunho após PIX
 * 5. Cria Automated Action: só Finance cria fatura
 *
 * Uso: node scripts/setup-pix-sales.js <ODOO_API_KEY> [--dry-run]
 *
 * ODOO_URL, ODOO_DB, ODOO_USER lidos do .env ou config
 */
var xmlrpc = require('xmlrpc');

// ============================================================
// CONFIG
// ============================================================
var ODOO_URL = process.env.ODOO_URL || 'https://ajlferroeaco.odoo.com';
var ODOO_DB  = process.env.ODOO_DB  || 'ajlferroeaco';
var ODOO_USER = process.env.ODOO_USERNAME || process.env.ODOO_USER || 'marcus@nytro.com.br';
var ODOO_API_KEY = process.argv[2] || '';
var DRY_RUN = process.argv.indexOf('--dry-run') >= 0;
var MIDDLEWARE_URL = process.env.RENDER_URL || 'https://api-odoo-rhzf.onrender.com';
var MIDDLEWARE_KEY = process.env.MIDDLEWARE_API_KEY || 'cnpja-odoo-secret-2024';

if (!ODOO_API_KEY) {
  console.error('Uso: node scripts/setup-pix-sales.js <ODOO_API_KEY> [--dry-run]');
  console.error('Gere a API key em Odoo: Settings > Users > API Keys');
  process.exit(1);
}

console.log('=== SETUP PIX SALES ===');
console.log('URL:', ODOO_URL);
console.log('DB:', ODOO_DB);
console.log('User:', ODOO_USER);
console.log('Dry Run:', DRY_RUN);
console.log('Middleware:', MIDDLEWARE_URL);

// ============================================================
// XML-RPC helpers
// ============================================================
function createClient(url) {
  var base = url.replace(/\/+$/, '');
  return {
    common: xmlrpc.createSecureClient({ host: base.replace('https://', ''), path: '/xmlrpc/2/common', port: 443 }),
    models: xmlrpc.createSecureClient({ host: base.replace('https://', ''), path: '/xmlrpc/2/object', port: 443 }),
  };
}

function rpc(client, db, uid, password, model, method, args, kwargs) {
  return new Promise(function(resolve, reject) {
    var params = [db, uid, password, model, method, args || []];
    if (kwargs) params.push(kwargs);
    client.models.methodCall('execute_kw', params, function(err, result) {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  var client = createClient(ODOO_URL);

  // Auth
  var uid = await new Promise(function(resolve, reject) {
    client.common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], function(err, result) {
      if (err || !result) return reject(err || new Error('Auth failed'));
      resolve(result);
    });
  });
  console.log('Autenticado. UID:', uid);

  var db = ODOO_DB;
  var pw = ODOO_API_KEY;

  // ============================================================
  // PASSO 0: Verificar o que já existe
  // ============================================================
  console.log('\n--- PASSO 0: Verificando existentes ---');

  // Verificar campos itau no sale.order
  var soModelIds = await rpc(client, db, uid, pw, 'ir.model', 'search', [[['model', '=', 'sale.order']]]);
  var soModelId = soModelIds && soModelIds[0] || 0;
  console.log('sale.order model ID:', soModelId);

  var existingItauFields = await rpc(client, db, uid, pw, 'ir.model.fields', 'search_read', [
    [['model_id', '=', soModelId], ['name', 'like', 'x_studio_itau']]
  ], { fields: ['name', 'field_description', 'ttype'] });
  console.log('Campos itau em sale.order:', existingItauFields.length);
  for (var f of existingItauFields) {
    console.log('  ', f.name, '(' + f.ttype + ') -', f.field_description);
  }

  // Verificar Server Actions existentes
  var existingActions = await rpc(client, db, uid, pw, 'ir.actions.server', 'search_read', [
    [['model_name', 'like', 'sale.order']]
  ], { fields: ['name', 'code', 'model_name'] });
  console.log('Server Actions em sale.order:', existingActions.length);
  for (var a of existingActions) {
    console.log('  ', a.id, '-', a.name);
  }

  // Verificar Automated Actions existentes
  var existingAuto = await rpc(client, db, uid, pw, 'base.automation', 'search_read', [
    [['model_name', 'like', 'sale.order']]
  ], { fields: ['name', 'active', 'trigger'] });
  console.log('Automated Actions em sale.order:', existingAuto.length);
  for (var au of existingAuto) {
    console.log('  ', au.id, '-', au.name, '(ativo:', au.active, ', trigger:', au.trigger, ')');
  }

  // Verificar campos de pagamento no sale.order
  var paymentFields = ['payment_term_id', 'x_studio_itau_tipo_pagamento', 'x_studio_itau_pix_copia_cola'];
  var paymentFieldData = await rpc(client, db, uid, pw, 'ir.model.fields', 'search_read', [
    [['model_id', '=', soModelId], ['name', 'in', paymentFields]]
  ], { fields: ['name', 'field_description', 'ttype'] });
  console.log('Campos de pagamento em sale.order:');
  for (var pf of paymentFieldData) {
    console.log('  ', pf.name, '(' + pf.ttype + ') -', pf.field_description);
  }

  // ============================================================
  // PASSO 1: Criar campos x_studio_itau_* no sale.order (se não existirem)
  // ============================================================
  console.log('\n--- PASSO 1: Campos Itaú no sale.order ---');

  var FIELDS_SO = [
    { name: 'x_studio_itau_tipo_pagamento', field_description: 'Tipo Pagamento Itaú', ttype: 'selection', selection: "[('pix','PIX'),('boleto','Boleto'),('cartao','Cartão')]" },
    { name: 'x_studio_itau_situacao', field_description: 'Status Itaú', ttype: 'selection', selection: "[('emitido','Emitido'),('pago','Pago'),('cancelado','Cancelado'),('expirado','Expirado'),('erro','Erro')]" },
    { name: 'x_studio_itau_txid', field_description: 'PIX TXID', ttype: 'char' },
    { name: 'x_studio_itau_pix_copia_cola', field_description: 'PIX Copia e Cola', ttype: 'text' },
    { name: 'x_studio_itau_boletos_html', field_description: 'Itaú Boletos/PIX HTML', ttype: 'html' },
    { name: 'x_studio_itau_pix_status', field_description: 'PIX Status', ttype: 'selection', selection: "[('ativa','Ativa'),('concluida','Concluída'),('removida_pelo_psp','Removida pelo PSP'),('expirada','Expirada')]" },
  ];

  var existingNames = existingItauFields.map(function(f) { return f.name; });
  var createdFields = 0;

  for (var fd of FIELDS_SO) {
    if (existingNames.indexOf(fd.name) >= 0) {
      console.log('  ✅', fd.name, '- JÁ EXISTE');
      continue;
    }

    var vals = {
      name: fd.name,
      field_description: fd.field_description,
      ttype: fd.ttype,
      model_id: soModelId,
      store: true,
    };
    if (fd.ttype === 'selection') vals.selection = fd.selection;
    if (fd.ttype === 'char') vals.size = 256;

    if (DRY_RUN) {
      console.log('  🔄 [DRY-RUN] Criaria:', fd.name, '(' + fd.ttype + ')');
      createdFields++;
      continue;
    }

    try {
      var fieldId = await rpc(client, db, uid, pw, 'ir.model.fields', 'create', [vals]);
      console.log('  ✅', fd.name, '- CRIADO (id=' + fieldId + ')');
      createdFields++;
    } catch (err) {
      if (err.message && err.message.indexOf('unique') !== -1) {
        console.log('  ⚠️', fd.name, '- JÁ EXISTE (recusado pelo Odoo)');
      } else {
        console.error('  ❌', fd.name, '- ERRO:', err.message);
      }
    }
  }

  console.log('Campos criados:', createdFields);

  // ============================================================
  // PASSO 2: Criar Server Action "Gerar PIX" no sale.order
  // ============================================================
  console.log('\n--- PASSO 2: Server Action "Gerar PIX" ---');

  // Verificar se já existe
  var existingPixAction = await rpc(client, db, uid, pw, 'ir.actions.server', 'search', [
    [['name', '=', 'Gerar PIX'], ['model_name', '=', 'sale.order']]
  ]);

  if (existingPixAction && existingPixAction.length > 0) {
    console.log('  ✅ Server Action "Gerar PIX" já existe (id=' + existingPixAction[0] + ')');
  } else {
    // Código Python do Server Action
    var pixActionCode = [
      '# Gerar PIX via middleware Itaú',
      'import json',
      'import urllib.request',
      '',
      'MIDDLEWARE_URL = "' + MIDDLEWARE_URL + '"',
      'API_KEY = "' + MIDDLEWARE_KEY + '"',
      '',
      '# Ler dados do pedido',
      'order = records[0]',
      'fatura_id = order.id',
      'fatura_name = order.name or ""',
      'valor = order.amount_total or 0',
      '',
      '# Dados do pagador',
      'partner = order.partner_id',
      'pagador_nome = partner.name or ""',
      'pagador_cpf = partner.cnpj_cpf or (partner.vat or "") if hasattr(partner, "cnpj_cpf") else (partner.vat or "")',
      '',
      '# Montar payload',
      'payload = json.dumps({',
      '    "forma_pagamento": "PIX",',
      '    "fatura_name": fatura_name,',
      '    "fatura_id": fatura_id,',
      '    "fatura_valor": valor,',
      '    "pagador_nome": pagador_nome,',
      '    "pagador_cpf": pagador_cpf,',
      '}).encode("utf-8")',
      '',
      '# Chamar middleware',
      'try:',
      '    req = urllib.request.Request(',
      '        MIDDLEWARE_URL + "/api/v1/itau/pagar",',
      '        data=payload,',
      '        headers={"Content-Type": "application/json", "X-API-Key": API_KEY},',
      '        method="POST",',
      '    )',
      '    with urllib.request.urlopen(req, timeout=30) as resp:',
      '        result = json.loads(resp.read().decode("utf-8"))',
      '    ',
      '    if result.get("success"):',
      '        pix_data = result.get("data", {})',
      '        pagamento = pix_data.get("pagamentos", [{}])[0] if pix_data.get("pagamentos") else {}',
      '        ',
      '        # Gravar campos no pedido',
      '        write_vals = {}',
      '        write_vals["x_studio_itau_tipo_pagamento"] = "pix"',
      '        write_vals["x_studio_itau_situacao"] = "emitido"',
      '        if pagamento.get("txid"):',
      '            write_vals["x_studio_itau_txid"] = pagamento["txid"]',
      '        if pagamento.get("pix_copia_cola"):',
      '            write_vals["x_studio_itau_pix_copia_cola"] = pagamento["pix_copia_cola"]',
      '        if pagamento.get("html_pix"):',
      '            write_vals["x_studio_itau_boletos_html"] = pagamento["html_pix"]',
      '        ',
      '        order.write(write_vals)',
      '        ',
      '        # Postar no chatter',
      '        body = "<b>PIX Gerado</b><br/>TXID: " + str(pagamento.get("txid", "")) + "<br/>Valor: R$ " + str(pagamento.get("valor_titulo", valor))',
      '        order.message_post(body=body, subtype_xmlid="mail.mt_note")',
      '    else:',
      '        error_msg = result.get("message", "Erro desconhecido")',
      '        order.message_post(body="<b>⚠️ Erro ao gerar PIX:</b> " + error_msg, subtype_xmlid="mail.mt_note")',
      'except Exception as e:',
      '    order.message_post(body="<b>⚠️ Erro ao gerar PIX:</b> " + str(e), subtype_xmlid="mail.mt_note")',
    ].join('\n');

    if (DRY_RUN) {
      console.log('  🔄 [DRY-RUN] Criaria Server Action "Gerar PIX"');
    } else {
      try {
        var actionId = await rpc(client, db, uid, pw, 'ir.actions.server', 'create', [{
          name: 'Gerar PIX',
          model_name: 'sale.order',
          state: 'code',
          code: pixActionCode,
          usage: 'ir_actions_server',
        }]);
        console.log('  ✅ Server Action "Gerar PIX" criado (id=' + actionId + ')');
        console.log('  📋 Adicione o botão no formulário via Odoo Studio:');
        console.log('     Settings > Technical > Actions > Server Actions > id=' + actionId);
        console.log('     No form sale.order, adicione botão que chama esta ação');
      } catch (err) {
        console.error('  ❌ Erro ao criar Server Action:', err.message);
      }
    }
  }

  // ============================================================
  // PASSO 3: Automated Action - Travar forma de pagamento após PIX
  // ============================================================
  console.log('\n--- PASSO 3: Automated Action - Travar pagamento após PIX ---');

  var existingLockPayment = await rpc(client, db, uid, pw, 'base.automation', 'search', [
    [['name', '=', 'PIX: Travar forma de pagamento'], ['model_name', '=', 'sale.order']]
  ]);

  if (existingLockPayment && existingLockPayment.length > 0) {
    console.log('  ✅ Automated Action já existe (id=' + existingLockPayment[0] + ')');
  } else {
    var lockPaymentCode = [
      '# PIX: Travar forma de pagamento após PIX gerado',
      '# Se PIX já foi gerado (tipo_pagamento = pix), não permite alterar',
      'if record.x_studio_itau_tipo_pagamento == "pix":',
      '    # Verificar se payment_term_id foi alterado',
      '    if "payment_term_id" in record._fields and record.payment_term_id:',
      '        # PIX = pagamento imediato, se mudou, bloquear',
      '        raise UserError("Não é possível alterar a forma de pagamento após PIX gerado. Cancele o PIX no Itaú primeiro.")',
    ].join('\n');

    if (DRY_RUN) {
      console.log('  🔄 [DRY-RUN] Criaria Automated Action para travar pagamento');
    } else {
      try {
        var autoId1 = await rpc(client, db, uid, pw, 'base.automation', 'create', [{
          name: 'PIX: Travar forma de pagamento',
          model_name: 'sale.order',
          trigger: 'on_write',
          active: true,
          code: lockPaymentCode,
          state: 'code',
        }]);
        console.log('  ✅ Automated Action criado (id=' + autoId1 + ')');
      } catch (err) {
        console.error('  ❌ Erro:', err.message);
        console.log('  💡 Dica: Pode precisar criar via Odoo UI: Settings > Technical > Automated Actions');
      }
    }
  }

  // ============================================================
  // PASSO 4: Automated Action - Travar cancelar/voltar rascunho após PIX
  // ============================================================
  console.log('\n--- PASSO 4: Automated Action - Travar cancelar após PIX ---');

  var existingLockCancel = await rpc(client, db, uid, pw, 'base.automation', 'search', [
    [['name', '=', 'PIX: Bloquear cancelar/voltar rascunho'], ['model_name', '=', 'sale.order']]
  ]);

  if (existingLockCancel && existingLockCancel.length > 0) {
    console.log('  ✅ Automated Action já existe (id=' + existingLockCancel[0] + ')');
  } else {
    var lockCancelCode = [
      '# PIX: Bloquear cancelar e voltar rascunho após PIX gerado',
      'if record.x_studio_itau_tipo_pagamento == "pix":',
      '    # Verificar se o estado está mudando para cancel ou draft',
      '    if "state" in record._fields:',
      '        new_state = record.state',
      '        if new_state in ("cancel", "draft"):',
      '            raise UserError("Não é possível cancelar ou voltar para rascunho após PIX gerado. Cancele o PIX no Itaú primeiro.")',
    ].join('\n');

    if (DRY_RUN) {
      console.log('  🔄 [DRY-RUN] Criaria Automated Action para travar cancelar');
    } else {
      try {
        var autoId2 = await rpc(client, db, uid, pw, 'base.automation', 'create', [{
          name: 'PIX: Bloquear cancelar/voltar rascunho',
          model_name: 'sale.order',
          trigger: 'on_write',
          active: true,
          code: lockCancelCode,
          state: 'code',
        }]);
        console.log('  ✅ Automated Action criado (id=' + autoId2 + ')');
      } catch (err) {
        console.error('  ❌ Erro:', err.message);
        console.log('  💡 Dica: Pode precisar criar via Odoo UI: Settings > Technical > Automated Actions');
      }
    }
  }

  // ============================================================
  // PASSO 5: Informações sobre restricao de fatura para Finance
  // ============================================================
  console.log('\n--- PASSO 5: Restrição de criação de fatura (só Finance) ---');
  console.log('  ℹ️  No Odoo SaaS, a restrição de quem pode criar fatura é feita via:');
  console.log('     1. Settings > Users > Access Rights > Remover "Create" em account.move do grupo Vendas');
  console.log('     2. OU: Automated Action que verifica se o usuário é do grupo Finance');
  console.log('  ℹ️  Recomendado: Configurar permissões diretamente no Odoo UI');
  console.log('     - Vendedor: pode confirmar pedido, NÃO pode criar fatura');
  console.log('     - Finance: pode criar fatura, pode cancelar PIX/boleto');

  // ============================================================
  // RESUMO
  // ============================================================
  console.log('\n=== RESUMO ===');
  console.log('Campos Itaú criados em sale.order:', createdFields);
  console.log('');
  console.log('📋 PRÓXIMOS PASSOS MANUAIS:');
  console.log('1. No Odoo Studio, adicionar os campos x_studio_itau_* na aba Itaú do sale.order');
  console.log('2. No formulário sale.order, adicionar botão "Gerar PIX" que chama o Server Action');
  console.log('3. Configurar permissões: Vendedor NÃO cria fatura, só Finance');
  if (DRY_RUN) console.log('\n⚠️  MODO DRY-RUN — nada foi alterado');
}

main().then(function() {
  console.log('\nFim.');
  process.exit(0);
}).catch(function(err) {
  console.error('ERRO FATAL:', err);
  process.exit(1);
});
