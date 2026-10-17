var xmlrpc = require('xmlrpc');
require('dotenv').config();

// Use the middleware's own Odoo config
var oc = {
  url: process.env.ODOO_URL || 'https://ajlferroeaco.odoo.com',
  db: process.env.ODOO_DB || 'ajlferroeaco',
  user: process.env.ODOO_USERNAME || 'marcus@nytro.com.br',
  password: process.env.ODOO_API_KEY || '',
};

if (!oc.password) {
  console.error('Need ODOO_API_KEY env var');
  process.exit(1);
}

var base = oc.url.replace(/\/+$/, '');
var host = base.replace('https://', '');
var common = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
var models = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object',D port: 443 });

function rpc(method, params) {
  return new Promise(function(ok, fail) {
    var client = method === 'authenticate' ? common : models;
    client.methodCall(method, params, function(e, r) { if (e) fail(e); else ok(r); });
  });
}

async function main() {
  var uid = await rpc('authenticate', [oc.db, oc.user, oc.password, {}]);
  console.log('UID:', uid);

  // Search for x_studio_motorista field on account.move
  var fields = await rpc('execute_kw', [oc.db, uid, oc.password, 'ir.model.fields', 'search_read',
    [[['name', '=', 'x_studio_motorista'], ['model', 'in', ['account.move', 'sale.order']]]],
    {fields: ['name', 'model', 'ttype', 'field_description', 'relation', 'selection']}
  ]);

  console.log('\n=== x_studio_motorista field ===');
  fields.forEach(function(f) {
    console.log('Model:', f.model);
    console.log('Type:', f.ttype);
    console.log('Description:', f.field_description);
    console.log('Relation:', f.relation || 'N/A');
    console.log('Selection:', f.selection || 'N/A');
    console.log('---');
  });

  if (fields.length === 0) {
    console.log('x_studio_motorista NAO ENCONTRADO em account.move nem sale.order');
  }
}

main().catch(function(e) { console.error(e.message); process.exit(1); });
