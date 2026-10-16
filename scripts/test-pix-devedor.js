// Testes unitarios para utils/pix-devedor.js
const { normalizeDevedor, buildDevedorFromDoc, stripDoc, validateCpf, validateCnpj } = require('../utils/pix-devedor');

var pass = 0;
var fail = 0;

function assert(condition, msg) {
  if (condition) { pass++; }
  else { fail++; console.error('  FAIL: ' + msg); }
}

function assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; }
  else { fail++; console.error('  FAIL: ' + msg + ' | expected: ' + JSON.stringify(expected) + ' | got: ' + JSON.stringify(actual)); }
}

console.log('\n=== stripDoc ===');
assertEq(stripDoc(null), '', 'null -> empty');
assertEq(stripDoc(undefined), '', 'undefined -> empty');
assertEq(stripDoc(false), '', 'false -> empty');
assertEq(stripDoc(''), '', 'empty string -> empty');
assertEq(stripDoc('null'), '', 'string "null" -> empty');
assertEq(stripDoc('None'), '', 'string "None" -> empty');
assertEq(stripDoc('123.456.789-01'), '12345678901', 'formatted CPF -> digits');
assertEq(stripDoc('22.603.750/0001-90'), '22603750000190', 'formatted CNPJ -> digits');
assertEq(stripDoc('12345678901'), '12345678901', 'raw CPF digits');

console.log('\n=== validateCpf ===');
assert(validateCpf('52998224725'), 'valid CPF 52998224725');
assert(validateCpf('12345678909'), 'valid CPF 12345678909');
assert(!validateCpf('00000000000'), 'invalid CPF all zeros');
assert(!validateCpf('11111111111'), 'invalid CPF all ones');
assert(!validateCpf('12345678900'), 'invalid CPF wrong check digit');
assert(!validateCpf('12345'), 'invalid CPF too short');
assert(!validateCpf(''), 'invalid CPF empty');

console.log('\n=== validateCnpj ===');
assert(validateCnpj('11222333000181'), 'valid CNPJ 11222333000181');
assert(!validateCnpj('00000000000000'), 'invalid CNPJ all zeros');
assert(!validateCnpj('11111111111111'), 'invalid CNPJ all ones');
assert(!validateCnpj('11222333000182'), 'invalid CNPJ wrong check digit');
assert(!validateCnpj('12345'), 'invalid CNPJ too short');

console.log('\n=== normalizeDevedor ===');

// CPF via cpf_cnpj field
var r1 = normalizeDevedor({ nome: 'JOAO SILVA', cpf_cnpj: '529.982.247-25' });
assert(r1 && r1.cpf === '52998224725' && !r1.cnpj, 'cpf_cnpj formatted CPF -> cpf field');
assertEq(r1.nome, 'JOAO SILVA', 'nome preserved');

// CNPJ via cpf_cnpj field
var r2 = normalizeDevedor({ nome: 'EMPRESA LTDA', cpf_cnpj: '11.222.333/0001-81' });
assert(r2 && r2.cnpj === '11222333000181' && !r2.cpf, 'cpf_cnpj formatted CNPJ -> cnpj field');

// cpf + cnpj already split
var r3 = normalizeDevedor({ nome: 'JOAO', cpf: '52998224725', cnpj: '' });
assert(r3 && r3.cpf === '52998224725' && !r3.cnpj, 'split cpf only');

var r4 = normalizeDevedor({ nome: 'EMPRESA', cpf: '', cnpj: '11222333000181' });
assert(r4 && r4.cnpj === '11222333000181' && !r4.cpf, 'split cnpj only');

// THE BUG: null cpf/cnpj from Odoo (the original error)
var r5 = normalizeDevedor({ nome: 'MARCUS VINICIUS DE SOUZA', cpf: null, cnpj: null });
assert(r5 === undefined, 'null cpf + null cnpj -> undefined (omit devedor)');

// String 'null' (common Odoo XML-RPC representation)
var r6 = normalizeDevedor({ nome: 'MARCUS VINICIUS DE SOUZA', cpf: 'null', cnpj: 'null' });
assert(r6 === undefined, 'string "null" cpf + cnpj -> undefined');

// No nome -> undefined
var r7 = normalizeDevedor({ cpf: '52998224725' });
assert(r7 === undefined, 'no nome -> undefined');

// Empty devedor
var r8 = normalizeDevedor(null);
assert(r8 === undefined, 'null devedor -> undefined');

var r9 = normalizeDevedor({});
assert(r9 === undefined, 'empty object -> undefined');

// CPF with leading zeros (Odoo strips them)
var r10 = normalizeDevedor({ nome: 'CPF CURTO', cpf_cnpj: '123456789' });
assert(r10 && r10.cpf && r10.cpf.length === 11, 'short CPF padded to 11 digits');

// Misclassified: >11 digits in cpf field -> reclassify as CNPJ
var r11 = normalizeDevedor({ nome: 'EMPRESA', cpf: '11222333000181' });
assert(r11 && r11.cnpj === '11222333000181' && !r11.cpf, 'cpf field with 14 digits -> reclassify as cnpj');

console.log('\n=== buildDevedorFromDoc ===');

var b1 = buildDevedorFromDoc('JOAO', '529.982.247-25');
assert(b1 && b1.cpf === '52998224725', 'formatted CPF -> clean');

var b2 = buildDevedorFromDoc('EMPRESA', '11.222.333/0001-81');
assert(b2 && b2.cnpj === '11222333000181', 'formatted CNPJ -> clean');

var b3 = buildDevedorFromDoc('MARCUS', '');  // empty doc
assert(b3 === undefined, 'empty doc -> undefined');

var b4 = buildDevedorFromDoc('MARCUS', null);  // null doc
assert(b4 === undefined, 'null doc -> undefined');

var b5 = buildDevedorFromDoc('MARCUS', 'null');  // string "null"
assert(b5 === undefined, 'string "null" doc -> undefined');

console.log('\n=== RESULTADO ===');
console.log('Pass: ' + pass + ' | Fail: ' + fail);
if (fail > 0) process.exit(1);
