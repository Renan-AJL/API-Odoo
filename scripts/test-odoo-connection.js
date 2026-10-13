/**
 * Teste de conexão Odoo com nova API key
 * Verifica: auth, journals bancários, campos x_studio_*
 */
var xmlrpc = require('xmlrpc');

var ODOO_URL = 'https://ajlferroeco.odoo.com';
var ODOO_DB = 'ajlferroeco';
var ODOO_USER = 'renan@ajlferroeco.com.br';
var ODOO_API_KEY = '4ebecf7338eea1538b72d6dda289da77e31819cb';

var base = ODOO_URL.replace(/\/+$/, '');
var host = base.replace('https://', '');

function rpcCall(path, method, params) {
  return new Promise(function(resolve, reject) {
    var client = xmlrpc.createSecureClient({ host: host, path: path, port: 443 });
    client.methodCall(method, params, function(err, result) {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function main() {
  console.log('Testando conexão Odoo...');
  console.log('URL:', ODOO_URL);
  console.log('DB:', ODOO_DB);
  console.log('User:', ODOO_USER);

  // Step 1: Auth
  var uid;
  try {
    uid = await rpcCall('/xmlrpc/2/common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
    if (!uid) {
      console.error('FALHA AUTH: uid=0 (credenciais inválidas)');
      process.exit(1);
    }
    console.log('AUTH OK! UID:', uid);
  } catch (err) {
    console.error('ERRO AUTH:', err.message);
    process.exit(1);
  }

  function exec(model, method, args, kwargs) {
    var params = [ODOO_DB, uid, ODOO_API_KEY, model, method, args];
    if (kwargs) params.push(kwargs);
    return rpcCall('/xmlrpc/2/object', 'execute_kw', params);
  }

  // Step 2: Journals bancários
  try {
    var journals = await exec('account.journal', 'search_read', [[['type', '=', 'bank']]], { fields: ['id', 'name', 'code'], limit: 20 });
    console.log('\nJOURNALS BANCARIOS (' + journals.length + '):');
    journals.forEach(function(j) {
      var marker = (j.name.toUpperCase().indexOf('ITAU') >= 0) ? ' <-- ITAU' : '';
      console.log('  id=' + j.id + ' | ' + j.name + ' | code=' + j.code + marker);
    });
  } catch (err) {
    console.error('ERRO JOURNALS:', err.message);
  }

  // Step 3: Campos x_studio_*
  try {
    var invIds = await exec('account.move', 'search', [[['move_type', '=', 'out_invoice']]], { limit: 1, order: 'id desc' });
    if (!invIds || !invIds.length) {
      console.log('\nNenhuma invoice para testar campos');
    } else {
      var inv = await exec('account.move', 'read', [[invIds[0]], ['name', 'payment_state', 'x_studio_itau_pix_status', 'x_studio_itau_boleto_status', 'x_studio_itau_status_pagamento', 'x_studio_itau_tipo_pagamento', 'x_studio_itau_txid', 'x_studio_itau_nosso_numero']]);
      console.log('\nCAMPOS x_studio_* OK! Invoice teste:');
      console.log('  ID:', inv[0].id);
      console.log('  Nome:', inv[0].name);
      console.log('  payment_state:', inv[0].payment_state);
      console.log('  x_studio_itau_tipo_pagamento:', inv[0].x_studio_itau_tipo_pagamento || '(vazio)');
      console.log('  x_studio_itau_status_pagamento:', inv[0].x_studio_itau_status_pagamento || '(vazio)');
      console.log('  x_studio_itau_pix_status:', inv[0].x_studio_itau_pix_status || '(vazio)');
      console.log('  x_studio_itau_boleto_status:', inv[0].x_studio_itau_boleto_status || '(vazio)');
      console.log('  x_studio_itau_txid:', inv[0].x_studio_itau_txid || '(vazio)');
      console.log('  x_studio_itau_nosso_numero:', inv[0].x_studio_itau_nosso_numero || '(vazio)');
    }
  } catch (err) {
    console.error('\nERRO CAMPOS x_studio_*:', err.message);
    console.error('Os campos x_studio_itau_* NAO existem no Odoo ou tem nome diferente!');
  }

  // Step 4: Invoices pendentes
  try {
    var count = await exec('account.move', 'search_count', [[['move_type', '=', 'out_invoice'], ['payment_state', '!=', 'paid'], '|', ['x_studio_itau_tipo_pagamento', 'like', 'PIX'], ['x_studio_itau_tipo_pagamento', 'like', 'BOLETO']]]);
    console.log('\nINVOICES PENDENTES (PIX+Boleto):', count);
  } catch (err) {
    console.log('\nNao foi possivel contar invoices pendentes:', err.message);
  }

  // Step 5: bank statements
  try {
    var stmtCount = await exec('account.bank.statement', 'search_count', [[]]);
    console.log('\nBANK STATEMENTS existentes:', stmtCount);
  } catch (err) {
    console.log('\nNao foi possivel contar bank statements:', err.message);
  }

  console.log('\n=== TESTE CONCLUIDO ===');
}

main().catch(function(err) {
  console.error('ERRO FATAL:', err.message);
  process.exit(1);
});
