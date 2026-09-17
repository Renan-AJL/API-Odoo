/**
 * Check Odoo partner fields
 */
const xmlrpc = require('xmlrpc');

const ODOO_URL = 'https://ajlferroeaco.odoo.com';
const ODOO_DB = 'ajlferroeaco';
const ODOO_USER = 'marcus@nytro.com.br';
const ODOO_API_KEY = '35a6a8b79f1fa688bd5c49b3ba45ec390cfe1b52';

function createClient(path) {
  var base = ODOO_URL.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  return xmlrpc.createSecureClient({ host, port: 443, path: path });
}

function authenticate() {
  return new Promise((resolve, reject) => {
    const client = createClient('/xmlrpc/2/common');
    client.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err) reject(err); else resolve(uid);
    });
  });
}

function executeKw(uid, model, method, args, kwargs) {
  return new Promise((resolve, reject) => {
    const client = createClient('/xmlrpc/2/object');
    const params = kwargs ? [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs] : [ODOO_DB, uid, ODOO_API_KEY, model, method, args];
    client.methodCall('execute_kw', params, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

async function main() {
  const uid = await authenticate();
  console.log('UID:', uid);
  const pwd = ODOO_API_KEY;

  // 1. Discover IE/CNPJ/Studio fields on res.partner
  console.log('\n=== DISCOVERING res.partner FIELDS ===');
  const allFields = await executeKw(uid, 'res.partner', 'fields_get', [[], ['string', 'type']]);
  
  var ieFields = [], cnpjFields = [], legalNameFields = [], ibgeFields = [], studioFields = [];
  
  for (var f in allFields) {
    var fl = f.toLowerCase();
    var info = allFields[f];
    if (fl.indexOf('inscricao_estadual') >= 0 || fl.indexOf('inscr_est') >= 0 || fl === 'l10n_br_ie_code' || fl.indexOf('ie_code') >= 0) {
      ieFields.push({ name: f, string: info.string, type: info.type });
    }
    if (fl.indexOf('cnpj') >= 0 || fl === 'cnpj_cpf' || fl === 'vat') {
      cnpjFields.push({ name: f, string: info.string, type: info.type });
    }
    if (fl.indexOf('legal_name') >= 0 || fl.indexOf('razao_social') >= 0) {
      legalNameFields.push({ name: f, string: info.string, type: info.type });
    }
    if (fl.indexOf('ibge') >= 0) {
      ibgeFields.push({ name: f, string: info.string, type: info.type });
    }
    if (fl.indexOf('x_studio') >= 0) {
      studioFields.push({ name: f, string: info.string, type: info.type });
    }
  }
  
  console.log('\nIE fields:', JSON.stringify(ieFields, null, 2));
  console.log('\nCNPJ fields:', JSON.stringify(cnpjFields, null, 2));
  console.log('\nLegal Name fields:', JSON.stringify(legalNameFields, null, 2));
  console.log('\nIBGE fields:', JSON.stringify(ibgeFields, null, 2));
  console.log('\nStudio fields:');
  studioFields.forEach(f => console.log('  ' + f.name + ' | ' + f.string + ' | ' + f.type));

  // 2. Read partner 133026 (CREDMAK)
  console.log('\n=== PARTNER 133026 (CREDMAK) ===');
  var allFieldNames = Object.keys(allFields);
  var interestingFields = ['name', 'vat', 'cnpj_cpf', 'inscr_est', 'l10n_br_ie_code', 'legal_name',
    'street', 'number', 'street2', 'city', 'state_id', 'zip', 'phone', 'email', 'is_company',
    'country_id', 'city_id', 'l10n_br_city_id', 'district'];
  // Add IE and CNPJ fields
  ieFields.forEach(f => { if (interestingFields.indexOf(f.name) < 0) interestingFields.push(f.name); });
  cnpjFields.forEach(f => { if (interestingFields.indexOf(f.name) < 0) interestingFields.push(f.name); });
  
  for (var i = 0; i < interestingFields.length; i++) {
    try {
      var recs = await executeKw(uid, 'res.partner', 'read', [[133026], [interestingFields[i]]]);
      if (recs && recs[0] && recs[0][interestingFields[i]] !== undefined) {
        console.log('  ' + interestingFields[i] + ' = ' + JSON.stringify(recs[0][interestingFields[i]]));
      }
    } catch (e) {
      console.log('  ' + interestingFields[i] + ' = NOT_AVAILABLE');
    }
  }

  // 3. Read company (emitente AJL)
  console.log('\n=== COMPANY (EMITENTE) ===');
  var companyIds = await executeKw(uid, 'res.company', 'search', [[['name', 'ilike', 'AJL']]], { limit: 1 });
  if (companyIds && companyIds.length > 0) {
    var cFields = ['name', 'vat', 'cnpj_cpf', 'inscr_est', 'l10n_br_ie_code', 'legal_name', 'street', 'number', 'city', 'state_id', 'zip'];
    for (var cf = 0; cf < cFields.length; cf++) {
      try {
        var cRecs = await executeKw(uid, 'res.company', 'read', [companyIds, [cFields[cf]]]);
        if (cRecs && cRecs[0] && cRecs[0][cFields[cf]] !== undefined) {
          console.log('  ' + cFields[cf] + ' = ' + JSON.stringify(cRecs[0][cFields[cf]]));
        }
      } catch (e) {
        console.log('  ' + cFields[cf] + ' = NOT_AVAILABLE');
      }
    }
  }

  // 4. Also check a partner with IE (J L FREDERICO from previous test)
  console.log('\n=== PARTNER with IE (J L FREDERICO) ===');
  var jlIds = await executeKw(uid, 'res.partner', 'search', [[['name', 'ilike', 'FREDERICO']]], { limit: 1 });
  if (jlIds && jlIds.length > 0) {
    console.log('  ID: ' + jlIds[0]);
    for (var j = 0; j < ieFields.length; j++) {
      try {
        var recs = await executeKw(uid, 'res.partner', 'read', [[jlIds[0]], [ieFields[j].name]]);
        if (recs && recs[0]) console.log('  ' + ieFields[j].name + ' = ' + JSON.stringify(recs[0][ieFields[j].name]));
      } catch (e) {}
    }
    try { var r = await executeKw(uid, 'res.partner', 'read', [[jlIds[0]], ['cnpj_cpf', 'vat', 'inscr_est']]); console.log('  cnpj_cpf=' + JSON.stringify(r[0].cnpj_cpf) + ' vat=' + JSON.stringify(r[0].vat) + ' inscr_est=' + JSON.stringify(r[0].inscr_est)); } catch(e) {}
  }

  console.log('\n=== DONE ===');
}

main().catch(e => console.error('ERROR:', e.message));
