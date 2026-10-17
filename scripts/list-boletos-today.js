/**
 * Lista todos os boletos emitidos hoje no Odoo
 * Usa XML-RPC direto para buscar account.move com x_studio_itau_nosso_numero preenchido
 */
var xmlrpc = require('xmlrpc');

// Config from the running middleware
var ODOO_URL = 'https://ajlferroeaco.odoo.com';
var ODOO_DB = 'ajlferroeaco';
var ODOO_USER = 'marcus@nytro.com.br';
var ODOO_API_KEY = process.env.ODOO_API_KEY || '';

if (!ODOO_API_KEY) {
  console.error('ERRO: ODOO_API_KEY nao definida. Use: ODOO_API_KEY=<key> node list-boletos-today.js');
  process.exit(1);
}

var host = ODOO_URL.replace('https://', '').replace(/\/+$/, '');

function rpc(path, method, params) {
  return new Promise(function(resolve, reject) {
    var client = xmlrpc.createSecureClient({ host: host, path: path, port: 443 });
    client.methodCall(method, params, function(err, result) {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function main() {
  // 1. Authenticate
  console.log('Autenticando no Odoo...');
  var uid = await rpc('/xmlrpc/2/common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
  if (!uid) throw new Error('Auth falhou');
  console.log('UID:', uid);

  // 2. Search for invoices with boletos emitted today
  var today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  console.log('Buscando faturas com boleto emitido em:', today);

  // Domain: move_type=out_invoice, state=posted, x_studio_itau_nosso_numero is set,
  // x_studio_boleto_cancelado is False, x_studio_itau_situacao = emitido
  var domain = [
    ['move_type', '=', 'out_invoice'],
    ['state', '=', 'posted'],
    ['x_studio_itau_nosso_numero', '!=', false],
    ['x_studio_itau_nosso_numero', '!=', ''],
    ['x_studio_boleto_cancelado', '=', false],
  ];

  // First, try to find all with nosso_numero today
  // Use invoice_date = today or create_date = today
  var domainToday = domain.concat([['invoice_date', '>=', today]]);
  var domainAll = domain; // fallback: all uncanceled

  var ids;
  try {
    ids = await rpc('/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY, 'account.move', 'search', [domainToday], {limit: 100}
    ]);
    console.log('Faturas com boleto hoje:', ids.length);
  } catch (err) {
    console.error('Erro search hoje:', err.message);
    ids = [];
  }

  if (ids.length === 0) {
    // Fallback: search all uncanceled boletos (might include older ones)
    console.log('Nenhuma fatura com boleto hoje. Buscando todas nao canceladas...');
    try {
      ids = await rpc('/xmlrpc/2/object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, 'account.move', 'search', [domainAll], {limit: 200, order: 'invoice_date desc'}
      ]);
      console.log('Total faturas com boleto (nao canceladas):', ids.length);
    } catch (err) {
      console.error('Erro search all:', err.message);
      process.exit(1);
    }
  }

  if (ids.length === 0) {
    console.log('Nenhuma fatura com boleto encontrada.');
    return;
  }

  // 3. Read the invoices
  var fields = [
    'id', 'name', 'invoice_date', 'partner_id', 'amount_total',
    'x_studio_itau_nosso_numero', 'x_studio_itau_situacao',
    'x_studio_itau_boleto_status', 'x_studio_boleto_cancelado',
    'x_studio_itau_resposta_json',
  ];

  var invoices = await rpc('/xmlrpc/2/object', 'execute_kw', [
    ODOO_DB, uid, ODOO_API_KEY, 'account.move', 'read', [ids, fields]
  ]);

  console.log('\n=== BOLETOS ENCONTRADOS ===\n');
  for (var i = 0; i < invoices.length; i++) {
    var inv = invoices[i];
    var nn = inv.x_studio_itau_nosso_numero || '';
    var partner = Array.isArray(inv.partner_id) ? inv.partner_id[1] : inv.partner_id;
    var situacao = inv.x_studio_itau_situacao || '';
    var bStatus = inv.x_studio_itau_boleto_status || '';
    console.log(JSON.stringify({
      id: inv.id,
      name: inv.name,
      date: inv.invoice_date,
      partner: partner,
      total: inv.amount_total,
      nosso_numero: nn,
      situacao: situacao,
      boleto_status: bStatus,
      cancelado: inv.x_studio_boleto_cancelado || false,
    }));
  }

  // Also search for invoices with TRIPLE boletos (multiple nosso_numero)
  // Check resposta_json for multiple boletos
  console.log('\n=== VERIFICANDO BOLETOS TRIPLICADOS ===\n');
  for (var i = 0; i < invoices.length; i++) {
    var inv = invoices[i];
    var jsonStr = inv.x_studio_itau_resposta_json || '';
    if (jsonStr && jsonStr.length > 10) {
      try {
        // Try to parse the JSON to count boletos
        var cleaned = jsonStr.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null');
        var data = JSON.parse(cleaned);
        var boletoCount = 0;
        if (data.dados && data.dados.boleto) boletoCount = 1;
        if (data.dados && data.dados.boletos) boletoCount = data.dados.boletos.length;
        if (Array.isArray(data)) boletoCount = data.length;
        if (boletoCount > 1) {
          console.log('FATURA ' + inv.name + ' (ID:' + inv.id + ') TEM ' + boletoCount + ' BOLETOS NA RESPOSTA!');
        }
      } catch (e) {
        // Can't parse, skip
      }
    }
  }

  console.log('\nTotal:', invoices.length, 'faturas com boleto');
}

main().catch(function(err) {
  console.error('ERRO:', err.message);
  process.exit(1);
});
