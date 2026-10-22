/**
 * test-acrescimo-nf.js — Checks do lote de demandas 23/10 (middleware)
 *  A) Acréscimo: detecção da linha + rateio proporcional (simulação matemática
 *     idêntica ao bloco 6a-quater) + XML vNF = base + acréscimo + IPI
 *  B) XML: transporta AJL sempre presente (mesmo sem frete, modFrete 9)
 *  C) XML: Venc: DD/MM/AAAA no infCpl (duplicata segue ISO)
 *  D) XML: "Acréscimo: R$ ..." no infCpl
 *  E) Fabricação: rota /api/v1/fabricacao/ordens montada e validações
 * Execução: node scripts/test-acrescimo-nf.js (repo raiz) ou caminho absoluto.
 */
var path = require('path');
var assert = require('assert');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
var gerarXmlNFe = require(path.join(ROOT, 'services/sieg-nfe-xml.js')).gerarXmlNFe;
var emitSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-odoo-emit.js'), 'utf8');
var xmlSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-nfe-xml.js'), 'utf8');
var fabSrc = fs.readFileSync(path.join(ROOT, 'routes/fabricacao.js'), 'utf8');
var srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

var PASS = 0;
function ok(nome, cond, extra) {
  if (!cond) { console.error('  [FALHA] ' + nome + (extra ? ' — ' + extra : '')); process.exitCode = 1; return; }
  PASS++;
  console.log('  [OK] ' + nome + (extra ? ' — ' + extra : ''));
}

console.log('== A. Rateio do Acréscimo (simulação do bloco 6a-quater) ==');
// Dados de duas linhas como saem do buildLineData (valores fiscais)
var round2 = function (n) { return Math.round((parseFloat(n) || 0) * 100) / 100; };
var linesData = [
  { qty: 2, price_unit: 50.0, price_subtotal: 100.0, vbc_icms: '100.00', vicms: '18.00', picms: '18', vbc_ipi: '100.00', pipi: '10', vipi: '10.00', vbc_pis: '100.00', vpis: '1.65', vbc_cofins: '100.00', vcofins: '7.60' },
  { qty: 1, price_unit: 35.5, price_subtotal: 35.5, vbc_icms: '35.50', vicms: '6.39', picms: '18', vbc_ipi: '35.50', pipi: '10', vipi: '3.55', vbc_pis: '35.50', vpis: '0.59', vbc_cofins: '35.50', vcofins: '2.70' },
];
var valorAcrescimo = 20.0;
// — exatamente a mesma matemática do bloco inserido em sieg-odoo-emit.js —
var baseProd = 0;
for (var bp = 0; bp < linesData.length; bp++) baseProd += parseFloat(linesData[bp].price_subtotal) || 0;
var novoTotal = round2(baseProd + valorAcrescimo);
ok('base = 135.50', Math.abs(baseProd - 135.5) < 1e-9, String(baseProd));
var fator = novoTotal / baseProd;
for (var fr = 0; fr < linesData.length; fr++) {
  var fld = linesData[fr];
  fld.price_unit = Math.round((parseFloat(fld.price_unit) || 0) * fator * 10000) / 10000;
  fld.price_subtotal = round2((parseFloat(fld.price_subtotal) || 0) * fator);
  fld.vbc_icms = String(round2((parseFloat(fld.vbc_icms) || 0) * fator));
  fld.vicms = String(round2((parseFloat(fld.vicms) || 0) * fator));
  fld.vbc_pis = String(round2((parseFloat(fld.vbc_pis) || 0) * fator));
  fld.vpis = String(round2((parseFloat(fld.vpis) || 0) * fator));
  fld.vbc_cofins = String(round2((parseFloat(fld.vbc_cofins) || 0) * fator));
  fld.vcofins = String(round2((parseFloat(fld.vcofins) || 0) * fator));
  fld.vbc_ipi = String(round2((parseFloat(fld.vbc_ipi) || 0) * fator));
  fld.vipi = String(round2((parseFloat(fld.vipi) || 0) * fator));
}
var vProdSum = 0, vIPISum = 0;
for (var li = 0; li < linesData.length; li++) {
  vProdSum += parseFloat(linesData[li].price_subtotal) || 0;
  vIPISum += parseFloat(linesData[li].vipi) || 0;
}
var vNFValue = round2(vProdSum + vIPISum);
ok('vNF = base + acréscimo + IPI rateado (155.50 + 15.55)', Math.abs(vNFValue - 171.05) < 0.02, String(vNFValue));
// consistência pICMS × vBC = vICMS (percentuais intactos)
for (var ck = 0; ck < linesData.length; ck++) {
  var L = linesData[ck];
  var vIcmsEsperado = round2(parseFloat(L.vbc_icms) * parseFloat(L.picms) / 100);
  ok('linha ' + (ck + 1) + ': vICMS = pICMS × vBC (consistente)', Math.abs(parseFloat(L.vicms) - vIcmsEsperado) <= 0.011,
    L.vicms + ' vs ' + vIcmsEsperado);
  var vIpiEsperado = round2(parseFloat(L.vbc_ipi) * parseFloat(L.pipi) / 100);
  ok('linha ' + (ck + 1) + ': vIPI = pIPI × vBC (consistente)', Math.abs(parseFloat(L.vipi) - vIpiEsperado) <= 0.011,
    L.vipi + ' vs ' + vIpiEsperado);
}
ok('bloco 6a-quater presente no emit', emitSrc.indexOf('6a-quater. ACRÉSCIMO') >= 0);
ok('detecção isAcrescLine presente no emit', emitSrc.indexOf("norm.indexOf('acrescimo') === 0") >= 0);
ok('linha ACRÉSCIMO excluída dos itens (invoiceLines = keptLines)', emitSrc.indexOf('invoiceLines = keptLines') >= 0);
ok('acrescimo_valor vai no payload order', emitSrc.indexOf('acrescimo_valor: valorAcrescimo') >= 0);

console.log('== B/C/D. XML — transporta AJL, Venc DD/MM/AAAA, Acréscimo no infCpl ==');
var company = {
  cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL', street: 'Avenida Juscelino Kubitschek de Oliveira', number: '7525',
  street2: 'Cidade Industrial', city: 'Curitiba', state: 'PR', zip: '81350160',
  state_ibge: '41', city_ibge_code: '4106902', inscr_est: '9032009877', crt: '1', phone: '4132100000',
};
var partner = {
  cnpj_cpf: '12345678000199', legal_name: 'CLIENTE TESTE LTDA', street: 'Rua Teste', number: '100',
  street2: 'Centro', city: 'Curitiba', state: 'PR', zip: '80000000', city_ibge_code: '4106902',
  inscr_est: '12345678-01', email: 'teste@teste.com',
};
var order = {
  name: 'TESTE-ACR', number: '77777', date_order: '2026-10-23T12:00:00Z',
  amount_total: 200, note: '', obs_nfe: '', sale_order_number: 'S00001',
  acrescimo_valor: 20.0,
  boleto_detalhes: [
    { parcela: '1/2', valor: '77.75', vencimento: '2026-11-22', nosso_numero: '', linha_digitavel: '' },
    { parcela: '2/2', valor: '77.75', vencimento: '2026-12-07', nosso_numero: '', linha_digitavel: '' },
  ],
  forma_pagamento_label: 'BOLETO 30/45', duplicatas: [], forma_pagamento: 'BOLETO 30/45',
};
var lines = [
  { default_code: 'P1', product_name: 'PRODUTO 1', ncm: '72191200', cfop: '5102', uom: 'UN',
    qty: 2, price_unit: 50, price_subtotal: 100, csosn: '', cst_icms: '00', mod_bc: '3',
    vbc_icms: '100.00', vicms: '18.00', picms: '18', cst_pis: '01', vbc_pis: '100', ppis: '1.65', vpis: '1.65',
    cst_cofins: '01', vbc_cofins: '100', pcofins: '7.6', vcofins: '7.6',
    cst_ipi: '00', vbc_ipi: '100', pipi: '10', vipi: '10', cenq: '999', peso_unitario: 0 },
  { default_code: 'P2', product_name: 'PRODUTO 2', ncm: '72191200', cfop: '5102', uom: 'UN',
    qty: 1, price_unit: 35.5, price_subtotal: 35.5, csosn: '', cst_icms: '00', mod_bc: '3',
    vbc_icms: '35.50', vicms: '6.39', picms: '18', cst_pis: '01', vbc_pis: '35.5', ppis: '1.65', vpis: '0.59',
    cst_cofins: '01', vbc_cofins: '35.5', pcofins: '7.6', vcofins: '2.7',
    cst_ipi: '00', vbc_ipi: '35.5', pipi: '10', vipi: '3.55', cenq: '999', peso_unitario: 0 },
];
var pagamentos = [
  { indPag: '1', tPag: '15', vPag: '77.75' },
  { indPag: '1', tPag: '15', vPag: '77.75' },
];
var xml = gerarXmlNFe({
  company: company, partner: partner, order: order, lines: lines, pagamentos: pagamentos,
  duplicatas: [
    { dVenc: '2026-11-22', vDup: '77.75' },
    { dVenc: '2026-12-07', vDup: '77.75' },
  ],
  config: { serie: '100', tpAmb: '2', natOp: 'Venda de Mercadoria', mod: '55' },
  tipo: 'nfe',
});

ok('XML gerado', xml && xml.indexOf('<infNFe') > 0);
ok('<transporta> presente (sem frete — modFrete 9)', xml.indexOf('<transporta>') > 0);
ok('modFrete 9 (sem frete)', xml.indexOf('<modFrete>9</modFrete>') > 0);
ok('CNPJ da AJL como transportadora', xml.indexOf('<CNPJ>22603750000190</CNPJ>') > 0);
ok('transporta vem ANTES de vol (ordem do schema)', xml.indexOf('<transporta>') < xml.indexOf('<vol>') || xml.indexOf('<vol>') === -1);
ok('Venc: DD/MM/AAAA no infCpl', xml.indexOf('Venc: 22/11/2026') > 0 && xml.indexOf('Venc: 07/12/2026') > 0);
ok('duplicata dVenc segue ISO (schema)', xml.indexOf('<dVenc>2026-11-22</dVenc>') > 0);
ok('Acréscimo: R$ 20.00 no infCpl', xml.indexOf('Acréscimo: R$ 20.00') > 0);
ok('transporta xNome = razão social AJL', xml.indexOf('AJL COMERCIO ATACADISTA') > 0);

console.log('== E. Rota de fabricação (PCP/Base44) ==');
ok('routes/fabricacao.js existe', fabSrc.length > 1000);
ok('POST /ordens definido', fabSrc.indexOf("router.post('/ordens'") >= 0);
ok('GET /ordens/:nome definido', fabSrc.indexOf("router.get('/ordens/:nome'") >= 0);
ok('permitir_estoque_negativo default TRUE', fabSrc.indexOf('? !!body.permitir_estoque_negativo : true') >= 0);
ok('origin BASE44-PCP (não colide com automação 56)', fabSrc.indexOf("'BASE44-PCP' +") >= 0);
ok('action_confirm chamado sem checagem de estoque', fabSrc.indexOf("'action_confirm'") >= 0);
ok('server.js monta /api/v1/fabricacao', srvSrc.indexOf("require('./routes/fabricacao')") >= 0 && srvSrc.indexOf("'/api/v1/fabricacao'") >= 0);

console.log('\n===== ' + PASS + ' CHECKS OK =====');
if (process.exitCode) { console.error('HOUVE FALHAS'); process.exit(1); }
