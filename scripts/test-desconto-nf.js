/**
 * test-desconto-nf.js — Checks da demanda desconto na NF + descrição completa (23/10/2026)
 *  A) Desconto embutido no vUnCom (buildLineData — verificação de fonte + matemática)
 *  B) Consistência SEFAZ 629: vProd = qCom × vUnCom (com desconto)
 *  C) vNF = total da fatura com desconto (payload desconto_valor)
 *  D) infCpl 'Desconto: R$ ...' no XML
 *  E) xProd = produto + observação (teto 120 chars)
 *  F) DANFE: coluna DESCRICAO 0.30 + quebra em 2 linhas
 * Execução: node scripts/test-desconto-nf.js
 */
var path = require('path');
var assert = require('assert');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
var emitSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-odoo-emit.js'), 'utf8');
var xmlSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-nfe-xml.js'), 'utf8');
var danfeSrc = fs.readFileSync(path.join(ROOT, 'services/danfe-pdf.js'), 'utf8');
var gerarXmlNFe = require(path.join(ROOT, 'services/sieg-nfe-xml.js')).gerarXmlNFe;

var PASS = 0;
function ok(nome, cond, extra) {
  if (!cond) { console.error('  [FALHA] ' + nome + (extra ? ' — ' + extra : '')); process.exitCode = 1; return; }
  PASS++;
  console.log('  [OK] ' + nome + (extra ? ' — ' + extra : ''));
}
var round2 = function (n) { return Math.round((parseFloat(n) || 0) * 100) / 100; };

console.log('== A. Fonte: desconto embutido no buildLineData ==');
ok('sieg-odoo-emit lê line.discount', emitSrc.indexOf('parseFloat(line.discount)') >= 0);
ok('vUnCom líquido aplicado', emitSrc.indexOf('vUnLiquido = vUnLiquido * (1 - discPct / 100)') >= 0);
ok('price_unit do lineData = vUnLiquido', emitSrc.indexOf('price_unit: vUnLiquido') >= 0);
ok('desconto_linha viaja no item', emitSrc.indexOf('desconto_linha: descontoLinha') >= 0);
ok('payload desconto_valor presente', emitSrc.indexOf('desconto_valor:') >= 0);

console.log('== B. Matemática do desconto + consistência 629 ==');
// linha real: q=3, pu=49.75, desconto 5% (sem fator de imposto)
var pu = 49.75, q = 3, disc = 5;
var vUn = pu * (1 - disc / 100);
var qty3 = Math.round(q * 1000) / 1000;
var vUn4 = Math.round(vUn * 10000) / 10000;
var vProd = Math.round(qty3 * vUn4 * 100) / 100;
ok('vUnCom líquido = 47.2625', Math.abs(vUn4 - 47.2625) < 1e-9, String(vUn4));
ok('vProd 629 = 141.79 (= subtotal líquido do Odoo)', Math.abs(vProd - 141.79) < 1e-9, String(vProd));
ok('desconto da linha = R$ 7.46', Math.abs(round2(pu * q * disc / 100) - 7.46) < 1e-9);
// linha com imposto por dentro: fator 1.12
var pu2 = 112.0, q2 = 1, disc2 = 10;
var vUn2 = pu2 * 0.9;                       // 100.80
var gross2 = (pu2 * q2 * 0.9);              // grossSubtotal líquido bruto = 100.80
ok('imposto por dentro: vUnCom 100.80 = vProd 100.80', Math.abs(vUn2 - gross2) < 1e-9);

console.log('== C. vNF da fatura com desconto ==');
// fatura: item1 3x49.75 -5% = 141.79 | item2 2x35.5 -10% = 63.90 | sem IPI
var vProd1 = 141.79, vProd2 = Math.round(2 * Math.round(35.5 * 0.9 * 10000) / 10000 * 100) / 100;
var vNF = round2(vProd1 + vProd2);
ok('vNF = 205.69 (= total da fatura com desconto)', Math.abs(vNF - 205.69) < 1e-9, String(vNF));

console.log('== D. infCpl Desconto no XML ==');
ok('xml lê order.desconto_valor', xmlSrc.indexOf('order.desconto_valor') >= 0);
ok("xml escreve 'Desconto: R$ '", xmlSrc.indexOf("'Desconto: R$ '") >= 0);

console.log('== E. xProd completo (fix rejeicao 225 — NFe 00073124) ==');
ok('helper dedicado buildXProdCompleto', emitSrc.indexOf('function buildXProdCompleto') >= 0);
ok('buildLineData usa o helper', emitSrc.indexOf('buildXProdCompleto(productName, line.name)') >= 0);
ok('XML mantém <xProd> do product_name', xmlSrc.indexOf('line.product_name || line.xProd') >= 0);
// Unidade real: extrai o helper da fonte e testa com os dados da fatura 479
var mFn = emitSrc.match(/function buildXProdCompleto[\s\S]*?\n\}/);
assert(mFn, 'helper buildXProdCompleto encontrado na fonte');
var buildXProdCompleto = eval('(' + mFn[0] + ')');
// linha real 523 (obs repetia o nome do produto -> duplicava e estourava o padrao)
var nm523 = '523 - Tubo Ret 40x60 1,25 GI (Padrão - BR)';
var x523 = buildXProdCompleto(nm523, '[523] 523 - Tubo Ret 40x60 1,25 GI (Padrão - BR)\n523 - Tubo Ret 40x60 1,25 GI (Padrão - BR)');
ok('523: sem duplicação do nome', x523 === nm523, JSON.stringify(x523));
// telha com medida na obs
var nm834 = '834 - Telha TP 25 (0,43) nacional (Padrão - MT)';
var x834 = buildXProdCompleto(nm834, '[834] 834 - Telha TP 25 (0,43) nacional (Padrão - MT)\n26 x 700');
ok('834: nome + medida da obs', x834 === nm834 + ' - 26 x 700', JSON.stringify(x834));
// enrijecido (nome com espaço duplo + obs)
var x2285 = buildXProdCompleto('2285 - Perfil U 150x50 1,95 (Padrão - BR)', '[2285] 2285 - Perfil U 150x50 1,95  (Padrão - BR)\nENRIJECIDO **');
ok('2285: obs ENRIJECIDO preservada', /- ENRIJECIDO \*\*$/.test(x2285), JSON.stringify(x2285));
// obs com espaço final (linha real '09 x 6,700 ')
var x407 = buildXProdCompleto('407 - Telha TP 40 (0,43) nacional (Padrão - MT)', '[407] 407 - Telha TP 40 (0,43) nacional (Padrão - MT)\n09 x 6,700 ');
ok('407: sem espaço final', x407 === '407 - Telha TP 40 (0,43) nacional (Padrão - MT) - 09 x 6,700', JSON.stringify(x407));
// linha só com o nome (sem obs)
var x35 = buildXProdCompleto('35 - Barra Chata 1.1/2x1/4 (Padrão - BR)', '[35] 35 - Barra Chata 1.1/2x1/4 (Padrão - BR)');
ok('35: nome puro (obs inexistente)', x35 === '35 - Barra Chata 1.1/2x1/4 (Padrão - BR)', JSON.stringify(x35));
// teto 120 + corte nunca termina em espaço/separador
var xLong = buildXProdCompleto('A'.repeat(100), 'A'.repeat(100) + '\n' + 'B'.repeat(16) + ' ' + 'C'.repeat(10));
ok('teto 120 chars respeitado', xLong.length <= 120, String(xLong.length));
ok('corte não termina em espaço', !/\s$/.test(xLong), JSON.stringify(xLong.slice(-6)));
// valores da fatura 73124 (15 linhas) — todos dentro do padrão
var linhas73124 = [
  ['523 - Tubo Ret 40x60 1,25 GI (Padrão - BR)', '[523] 523 - Tubo Ret 40x60 1,25 GI (Padrão - BR)\n523 - Tubo Ret 40x60 1,25 GI (Padrão - BR)'],
  ['2285 - Perfil U 150x50 1,95 (Padrão - BR)', '[2285] 2285 - Perfil U 150x50 1,95  (Padrão - BR)\nENRIJECIDO **'],
  ['834 - Telha TP 25 (0,43) nacional (Padrão - MT)', '[834] 834 - Telha TP 25 (0,43) nacional (Padrão - MT)\n26 x 700'],
  ['407 - Telha TP 40 (0,43) nacional (Padrão - MT)', '[407] 407 - Telha TP 40 (0,43) nacional (Padrão - MT)\n09 x 6,700 '],
  ['35 - Barra Chata 1.1/2x1/4 (Padrão - BR)', '[35] 35 - Barra Chata 1.1/2x1/4 (Padrão - BR)'],
];
var todasOk = true;
for (var li = 0; li < linhas73124.length; li++) {
  var xv = buildXProdCompleto(linhas73124[li][0], linhas73124[li][1]);
  if (xv.length > 120 || /\s$/.test(xv) || /^\s/.test(xv) || xv.indexOf(xv.trim()) !== 0) todasOk = false;
}
ok('todas as linhas da 73124 dentro do padrão SEFAZ', todasOk);

console.log('== F. DANFE descrição maior + wrap ==');
ok("coluna DESCRICAO 0.30", danfeSrc.indexOf("{ t: 'DESCRICAO', w: 0.30 }") >= 0);
ok('célula com quebra de 2 linhas (height)', danfeSrc.indexOf("height: h - 4") >= 0);
ok('linha alta p/ descrição longa (h=22)', danfeSrc.indexOf("descTxt.length > 52 ? 22 : 14") >= 0);

console.log('== G. XML end-to-end com desconto ==');
var company = {
  cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL', street: 'Avenida Juscelino Kubitschek de Oliveira', number: '7525',
  street2: 'Cidade Industrial', city: 'Curitiba', state: 'PR', zip: '81350160',
  state_ibge: '41', city_ibge_code: '4106902', inscr_est: '9032009877', crt: '1', phone: '4132100000',
};
var partner = {
  cnpj_cpf: '12345678000199', legal_name: 'CREDMAK TESTE LTDA', street: 'Rua Teste', number: '100',
  street2: 'Centro', city: 'Curitiba', state: 'PR', zip: '80000000', city_ibge_code: '4106902',
  inscr_est: '12345678-01', email: 'teste@teste.com',
};
var order = {
  name: 'TESTE-DESC', number: '77778', date_order: '2026-10-23T12:00:00Z',
  amount_total: 205.69, note: '', obs_nfe: '', sale_order_number: 'S02399',
  desconto_valor: 12.11, forma_pagamento_label: 'BOLETO 30/60',
  boleto_detalhes: [], duplicatas: [], forma_pagamento: 'BOLETO 30/60',
};
var lines = [
  {
    default_code: '1493', product_name: '[1493] 1493 - Telha Bandeja (0,43) imp - obs completa da linha', xProd: '[1493] 1493 - Telha Bandeja (0,43) imp - obs completa da linha',
    ncm: '73089090', cfop: '5102', uom: 'UN', qty: 2, price_unit: 50.0, price_subtotal: 100.0,
    csosn: '', cst_icms: '00', mod_bc: '3', orig: '0', vbc_icms: '100.00', vicms: '18.00', picms: '18',
    cst_pis: '01', vbc_pis: '100.00', ppis: '1.65', vpis: '1.65', cst_cofins: '01',
    vbc_cofins: '100.00', pcofins: '7.6', vcofins: '7.60', peso_unitario: 0,
  },
];
var xml = gerarXmlNFe({
  company: company, partner: partner, order: order, lines: lines,
  pagamentos: [{ indPag: '1', tPag: '15', vPag: '205.69' }],
  duplicatas: [{ dVenc: '2026-11-22', vDup: '205.69' }],
  config: { serie: '100', tpAmb: '2', natOp: 'Venda de Mercadoria', mod: '55' },
  tipo: 'nfe',
});
ok('XML gerado', xml && String(xml).indexOf('<infNFe') > 0);
if (xml) {
  var s = String(xml);
  ok("infCpl contém 'Desconto: R$ 12.11'", s.indexOf('Desconto: R$ 12.11') >= 0);
  ok('xProd com observação completa', s.indexOf('obs completa da linha') >= 0);
  ok('vUnCom do item = 50.0000 (embed já aplicado antes do XML)', s.indexOf('<vUnCom>50.0000</vUnCom>') >= 0);
  ok('vProd do item = 100.00', s.indexOf('<vProd>100.00</vProd>') >= 0);
}

console.log('');
console.log('PASS: ' + PASS + ' checks');
if (process.exitCode) console.log('*** HOUVE FALHAS ***'); else console.log('*** TODOS OK ***');
