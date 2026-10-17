/**
 * scripts/update-pix-actions.js
 * ============================================
 * Atualiza Server Action "Gerar PIX" (id=1483) e Automated Actions
 * no sale.order para usar os campos REAIS do Odoo Studio:
 *
 *   x_studio_related_field_2jf_1k4uaua7n  → HTML (Boletos e QRCode)
 *   x_studio_boletos_pix                   → Cód PIX (html)
 *
 * E também grava nos campos x_studio_itau_* do sale.order
 * (que também existem: tipo_pagamento, situacao, txid, pix_status)
 *
 * Uso: node scripts/update-pix-actions.js <ODOO_API_KEY> [--dry-run]
 */
var xmlrpc = require('xmlrpc');

var ODOO_URL = process.env.ODOO_URL || 'https://ajlferroeaco.odoo.com';
var ODOO_DB  = process.env.ODOO_DB  || 'ajlferroeaco';
var ODOO_USER = process.env.ODOO_USERNAME || process.env.ODOO_USER || 'marcus@nytro.com.br';
var ODOO_API_KEY = process.argv[2] || '';
var DRY_RUN = process.argv.indexOf('--dry-run') >= 0;
var MIDDLEWARE_URL = process.env.RENDER_URL || 'https://api-odoo-rhzf.onrender.com';
var MIDDLEWARE_KEY = process.env.MIDDLEWARE_API_KEY || 'cnpja-odoo-secret-2024';

// Campos reais do Odoo Studio (sale.order)
var SO_FIELD_HTML     = 'x_studio_related_field_2jf_1k4uaua7n'; // HTML (Boletos e QRCode)
var SO_FIELD_PIX_HTML = 'x_studio_boletos_pix';                  // Cód PIX (html)

// Campos x_studio_itau_* que também existem no sale.order
var SO_ITAU_TIPO      = 'x_studio_itau_tipo_pagamento';
var SO_ITAU_SITUACAO  = 'x_studio_itau_situacao';
var SO_ITAU_TXID      = 'x_studio_itau_txid';
var SO_ITAU_PIX_STATUS = 'x_studio_itau_pix_status';
var SO_ITAU_PIX_CC    = 'x_studio_itau_pix_copia_cola';
var SO_ITAU_BOLETOS_HTML = 'x_studio_itau_boletos_html';

if (!ODOO_API_KEY) {
  console.error('Uso: node scripts/update-pix-actions.js <ODOO_API_KEY> [--dry-run]');
  process.exit(1);
}

console.log('=== UPDATE PIX ACTIONS ===');
console.log('Dry Run:', DRY_RUN);

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

async function main() {
  var client = createClient(ODOO_URL);
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
  // 1. Atualizar Server Action "Gerar PIX" (id=1483)
  // ============================================================
  console.log('\n--- 1: Atualizar Server Action "Gerar PIX" ---');

  var pixActionCode = [
    '# Gerar PIX via middleware Itau (sandbox safe: sem import/try/with)',
    '# Campos Studio do sale.order:',
    '#   ' + SO_FIELD_HTML + '  (HTML - Boletos e QRCode)',
    '#   ' + SO_FIELD_PIX_HTML + '  (HTML - Cód PIX)',
    '#   ' + SO_ITAU_TIPO + '  (Selection - Tipo Pagamento)',
    '#   ' + SO_ITAU_SITUACAO + '  (Selection - Status Itau)',
    '#   ' + SO_ITAU_TXID + '  (Char - TXID)',
    '#   ' + SO_ITAU_PIX_STATUS + '  (Selection - PIX Status)',
    '#   ' + SO_ITAU_PIX_CC + '  (Text - PIX Copia e Cola)',
    '#   ' + SO_ITAU_BOLETOS_HTML + '  (HTML - Itau Boletos/PIX HTML)',
    '',
    'MIDDLEWARE_URL = "' + MIDDLEWARE_URL + '/api/v1/itau/pagar"',
    'API_KEY = "' + MIDDLEWARE_KEY + '"',
    '',
    '# Ler dados do pedido',
    'order = records[0]',
    'fatura_id = order.id',
    'fatura_name = order.name or ""',
    'valor = order.amount_total or 0',
    'partner = order.partner_id',
    'pagador_nome = partner.name or ""',
    'pagador_cpf = (partner.vat or "") or ""',
    '',
    '# Montar payload',
    'payload = json.dumps({',
    '    "forma_pagamento": "PIX",',
    '    "fatura_name": fatura_name,',
    '    "fatura_id": fatura_id,',
    '    "fatura_valor": valor,',
    '    "pagador_nome": pagador_nome,',
    '    "pagador_cpf": pagador_cpf,',
    '})',
    '',
    '# Chamar middleware (sandbox safe: requests ja disponivel)',
    'resp = requests.post(',
    '    MIDDLEWARE_URL,',
    '    data=payload.encode("utf-8"),',
    '    headers={"Content-Type": "application/json", "X-API-Key": API_KEY},',
    '    timeout=30,',
    ')',
    'result = json.loads(resp.text)',
    '',
    '# Verificar resultado',
    'if result.get("success"):',
    '    pix_data = result.get("data", {})',
    '    pagamentos = pix_data.get("pagamentos", [])',
    '    pagamento = pagamentos[0] if pagamentos else {}',
    '    ',
    '    # Gravar campos no pedido',
    '    write_vals = {}',
    '    ',
    '    # Campos Studio principais (HTML)',
    '    if pagamento.get("html_pix"):',
    '        write_vals["' + SO_FIELD_HTML + '"] = pagamento["html_pix"]',
    '    if pagamento.get("pix_copia_cola"):',
    '        write_vals["' + SO_FIELD_PIX_HTML + '"] = pagamento["pix_copia_cola"]',
    '    ',
    '    # Campos x_studio_itau_* do sale.order',
    '    write_vals["' + SO_ITAU_TIPO + '"] = "pix"',
    '    write_vals["' + SO_ITAU_SITUACAO + '"] = "emitido"',
    '    write_vals["' + SO_ITAU_PIX_STATUS + '"] = "ativa"',
    '    if pagamento.get("txid"):',
    '        write_vals["' + SO_ITAU_TXID + '"] = pagamento["txid"]',
    '    if pagamento.get("pix_copia_cola"):',
    '        write_vals["' + SO_ITAU_PIX_CC + '"] = pagamento["pix_copia_cola"]',
    '    if pagamento.get("html_pix"):',
    '        write_vals["' + SO_ITAU_BOLETOS_HTML + '"] = pagamento["html_pix"]',
    '    ',
    '    if write_vals:',
    '        order.write(write_vals)',
    '    ',
    '    # Postar no chatter',
    '    body = "<b>PIX Gerado</b><br/>TXID: " + str(pagamento.get("txid", "")) + "<br/>Valor: R$ " + str(pagamento.get("valor_titulo", valor))',
    '    order.message_post(body=body, subtype_xmlid="mail.mt_note")',
    'else:',
    '    error_msg = result.get("message", "Erro desconhecido")',
    '    order.message_post(body="<b>Erro ao gerar PIX:</b> " + error_msg, subtype_xmlid="mail.mt_note")',
  ].join('\n');

  // Ler o Server Action atual
  var currentAction = await rpc(client, db, uid, pw, 'ir.actions.server', 'search_read', [
    [['id', '=', 1483]]
  ], { fields: ['name', 'code', 'model_name'] });

  if (currentAction && currentAction.length > 0) {
    console.log('  Server Action atual (id=1483):', currentAction[0].name);
    console.log('  Código atual (primeiros 200 chars):', (currentAction[0].code || '').substring(0, 200));

    if (DRY_RUN) {
      console.log('  🔄 [DRY-RUN] Atualizaria o código do Server Action');
    } else {
      try {
        await rpc(client, db, uid, pw, 'ir.actions.server', 'write', [[1483], {
          code: pixActionCode,
        }]);
        console.log('  ✅ Server Action atualizado com sucesso');
      } catch (err) {
        console.error('  ❌ Erro ao atualizar:', err.message);
      }
    }
  } else {
    console.log('  ⚠️ Server Action id=1483 não encontrado');
  }

  // ============================================================
  // 2. Atualizar Automated Action "PIX: Travar forma de pagamento" (id=94)
  // ============================================================
  console.log('\n--- 2: Atualizar Automated Action "PIX: Travar forma de pagamento" ---');

  // Ler o Server Action vinculado (id=1477)
  var lockPaySa = await rpc(client, db, uid, pw, 'ir.actions.server', 'search_read', [
    [['id', '=', 1477]]
  ], { fields: ['name', 'code'] });

  var newLockPayCode = [
    '# PIX: Travar forma de pagamento após PIX gerado',
    '# Verifica se o campo Cód PIX (' + SO_FIELD_PIX_HTML + ') está preenchido',
    'if record.' + SO_FIELD_PIX_HTML + ':',
    '    raise UserError("Não é possível alterar a forma de pagamento após PIX gerado. Cancele o PIX no Itaú primeiro.")',
  ].join('\n');

  if (lockPaySa && lockPaySa.length > 0) {
    console.log('  Server Action interno (id=1477):', lockPaySa[0].name);
    console.log('  Código atual:', (lockPaySa[0].code || '').substring(0, 200));

    if (DRY_RUN) {
      console.log('  🔄 [DRY-RUN] Atualizaria o código');
    } else {
      try {
        await rpc(client, db, uid, pw, 'ir.actions.server', 'write', [[1477], {
          code: newLockPayCode,
        }]);
        console.log('  ✅ Código atualizado');
      } catch (err) {
        console.error('  ❌ Erro:', err.message);
      }
    }
  }

  // ============================================================
  // 3. Atualizar Automated Action "PIX: Bloquear cancelar/voltar rascunho" (id=1478)
  // ============================================================
  console.log('\n--- 3: Atualizar Automated Action "PIX: Bloquear cancelar" ---');

  var lockCancelSa = await rpc(client, db, uid, pw, 'ir.actions.server', 'search_read', [
    [['id', '=', 1478]]
  ], { fields: ['name', 'code'] });

  var newLockCancelCode = [
    '# PIX: Bloquear cancelar e voltar rascunho após PIX gerado',
    'if record.' + SO_FIELD_PIX_HTML + ':',
    '    if record.state in ("cancel", "draft"):',
    '        raise UserError("Não é possível cancelar ou voltar para rascunho após PIX gerado. Cancele o PIX no Itaú primeiro.")',
  ].join('\n');

  if (lockCancelSa && lockCancelSa.length > 0) {
    console.log('  Server Action interno (id=1478):', lockCancelSa[0].name);
    console.log('  Código atual:', (lockCancelSa[0].code || '').substring(0, 200));

    if (DRY_RUN) {
      console.log('  🔄 [DRY-RUN] Atualizaria o código');
    } else {
      try {
        await rpc(client, db, uid, pw, 'ir.actions.server', 'write', [[1478], {
          code: newLockCancelCode,
        }]);
        console.log('  ✅ Código atualizado');
      } catch (err) {
        console.error('  ❌ Erro:', err.message);
      }
    }
  }

  // ============================================================
  // RESUMO
  // ============================================================
  console.log('\n=== RESUMO ===');
  console.log('Campos Studio sale.order usados:');
  console.log('  ' + SO_FIELD_HTML + '  (HTML - Boletos e QRCode)');
  console.log('  ' + SO_FIELD_PIX_HTML + '  (HTML - Cód PIX)');
  console.log('Campos x_studio_itau_* sale.order também gravados:');
  console.log('  ' + SO_ITAU_TIPO + ' = pix');
  console.log('  ' + SO_ITAU_SITUACAO + ' = emitido');
  console.log('  ' + SO_ITAU_TXID + ' = <txid>');
  console.log('  ' + SO_ITAU_PIX_STATUS + ' = ativa');
  console.log('  ' + SO_ITAU_PIX_CC + ' = <pix_copia_cola>');
  console.log('  ' + SO_ITAU_BOLETOS_HTML + ' = <html_pix>');
  if (DRY_RUN) console.log('\n⚠️  MODO DRY-RUN — nada foi alterado');
}

main().then(function() {
  console.log('\nFim.');
  process.exit(0);
}).catch(function(err) {
  console.error('ERRO FATAL:', err);
  process.exit(1);
});
