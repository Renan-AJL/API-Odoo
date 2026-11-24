/**
 * Teste 24/11/2026 — ST ICMS MANUAL (x_studio_st_icms, v1.2.44)
 * Demanda: NF com Substituição Tributária que SOMA no valor da NF — fatura
 * OURO PRETO #5975 (30x43.2193 = 1296.58, preço de tabela SEM ST, ajustada
 * para fechar 1635.00 EXATO como na tabela do usuário):
 *   vProd 1296.58 (INTACTO) | próprio 12% = 155.59 | BCST 2533.39 (MVA 95.39%)
 *   | vICMSST = 494.01 − 155.59 = 338.42 | vNF = 1296.58 + 338.42 = 1635.00
 * Case 3 documenta por que a linha foi ajustada: com 43.22 (2 casas) o total
 * seria 1635.03. Referência: services/st-icms-manual.js + bloco 6e
 * (sieg-odoo-emit.js) + ICMS10/ICMSTot/vNF (sieg-nfe-xml.js).
 */
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'AJL TI';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '4133730076';

var fs = require('fs');
var { gerarXmlNFe } = require('../services/sieg-nfe-xml');
var { aplicarStManualLinhas, round2 } = require('../services/st-icms-manual');

var companyPR = {
  cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL DISTRIBUIDORA', inscr_est: '9069585890',
  street: 'Avenida Juscelino Kubitschek de Oliveira', number: '7525', street2: 'Cidade Industrial',
  city: 'Curitiba', city_ibge_code: '4106902', state: 'PR', zip: '81450000',
  phone: '4133730076', crt: '3', state_ibge: '41',
};
var partner = {
  cnpj_cpf: '86940145000198', xNome: 'OURO PRETO COMERCIO DE FERRO E ACO LTDA',
  legal_name: 'OURO PRETO COMERCIO DE FERRO E ACO LTDA', inscr_est: '1019826100',
  street: 'Rua Teste', number: '100', street2: 'Bairro', city: 'Ponta Grossa',
  city_ibge_code: '4115202', state: 'PR', zip: '84015010', phone: '4200000000',
  email: 'ouro@teste.com.br',
};

// estado das linhas DEPOIS do bloco 6b (ICMS manual 12%: BC 1296.58 / vICMS 155.59)
// — fatura #5975 ajustada: 30 x 43.2193
function linhasSt() {
  return [{
    default_code: '2287', product_name: 'Telha TP 40 (0,50) Nacional', ncm: '73089090',
    cfop: '5102', uom: 'UN', qty: 30, price_unit: 43.2193, price_subtotal: 1296.58,
    orig: '0', csosn: '', cst_icms: '00', mod_bc: '3',
    vbc_icms: '1296.58', vicms: '155.59', picms: '12.00',
    cst_pis: '01', vbc_pis: '1296.58', ppis: '0.00', vpis: '0.00',
    cst_cofins: '01', vbc_cofins: '1296.58', pcofins: '0.00', vcofins: '0.00',
  }];
}
// variante preço 2 casas (43.22 × 30 = 1296.60 → vNF 1635.03) — o motivo do ajuste
function linhasPreco2Casas() {
  var l = linhasSt();
  l[0].qty = 30; l[0].price_unit = 43.22; l[0].price_subtotal = 1296.60;
  l[0].vbc_icms = '1296.60';
  return l;
}
// linha normal sem ST (regressão)
function linhasNormais() {
  return linhasSt();
}

function base(lines, vPag) {
  return {
    company: companyPR, partner,
    order: { name: 'SO999', number: '999', date_order: '2026-11-24T12:00:00-03:00', amount_total: round2(parseFloat(lines[0].price_subtotal) + 338.42) },
    lines: lines, pagamentos: [{ tPag: '90', vPag: vPag }],
  };
}

var falhas = 0;
function check(label, cond, detalhe) {
  if (cond) console.log('  PASS  ' + label);
  else { falhas++; console.error('  FAIL  ' + label + (detalhe ? ' -> ' + detalhe : '')); }
}
function quase(a, b, tol) { return Math.abs(a - b) <= (tol || 0.011); }

console.log('=== 1) Fatura #5975 (30x43.2193): ST SOMA no vNF, fecha 1635.00 EXATO ===');
var l1 = linhasSt();
var r1 = aplicarStManualLinhas(l1, { mva: 95.39, aliquotaSt: 19.5 });
check('vProd INTACTO: subtotal continua 1296.58', l1[0].price_subtotal === 1296.58, String(l1[0].price_subtotal));
check('vUnCom INTACTO: 43.2193', l1[0].price_unit === 43.2193, String(l1[0].price_unit));
check('CST = 10', l1[0].cst_icms === '10');
check('ICMS próprio preservado (vICMS 155.59)', l1[0].vicms === '155.59', String(l1[0].vicms));
check('BC próprio preservado (1296.58)', l1[0].vbc_icms === '1296.58', String(l1[0].vbc_icms));
check('BCST = 2533.39 (1296.58 × 1.9539)', l1[0].vbcst === '2533.39', String(l1[0].vbcst));
check('pMVAST = 95.39', l1[0].pmvast === '95.39');
check('pICMSST = 19.5', l1[0].picmsst === '19.5');
check('vICMSST = 338.42 (494.01 − 155.59)', l1[0].vicmsst === '338.42', String(l1[0].vicmsst));
check('modBCST = 4', l1[0].modbcst === '4');
check('DIFAL zerado', l1[0].difal === 0);
check('vNF = vProd + vICMSST = 1635.00', quase(r1.vProdTotal + r1.vICMSSTTotal, 1635.00),
  String(round2(r1.vProdTotal + r1.vICMSSTTotal)));
check('ST bruta confere: BCST×19,5% = 494.01', quase(round2(parseFloat(l1[0].vbcst) * 0.195), 494.01), String(round2(parseFloat(l1[0].vbcst) * 0.195)));

console.log('=== 2) XML da #5975: ICMS10 + ICMSTot com ST + vNF 1635.00 ===');
var xml2 = gerarXmlNFe(base(l1, 1635.00));
fs.writeFileSync('/tmp/nfe_st_teste.xml', xml2); // p/ validacao estrutural via python
check('XML: grupo ICMS10', /<ICMS><ICMS10>/.test(xml2));
check('XML: CST 10', /<CST>10<\/CST>/.test(xml2));
check('XML: modBCST 4', /<modBCST>4<\/modBCST>/.test(xml2));
check('XML: pMVAST 95.39', /<pMVAST>95.39<\/pMVAST>/.test(xml2));
check('XML: vBCST do item 2533.39', /<vBCST>2533\.39<\/vBCST>/.test(xml2));
check('XML: pICMSST 19.50', /<pICMSST>19\.50<\/pICMSST>/.test(xml2));
check('XML: vICMSST do item 338.42', /<vICMSST>338\.42<\/vICMSST>/.test(xml2));
check('XML: vICMS próprio 155.59 no item', /<vICMS>155\.59<\/vICMS>/.test(xml2));
check('XML: vProd 1296.58 (preço de tabela)', /<vProd>1296\.58<\/vProd>/.test(xml2));
check('XML: ICMSTot vBCST 2533.39', /<vBCST>2533\.39<\/vBCST>/.test(xml2));
check('XML: ICMSTot vST 338.42', /<vST>338\.42<\/vST>/.test(xml2));
check('XML: ICMSTot vProd 1296.58', /<ICMSTot>[\s\S]*<vProd>1296\.58<\/vProd>/.test(xml2));
check('XML: vNF 1635.00 (ST somada)', /<vNF>1635\.00<\/vNF>/.test(xml2));
check('XML: ordem XSD ICMS10 (modBCST antes de pMVAST antes de vBCST)',
  xml2.indexOf('<modBCST>') < xml2.indexOf('<pMVAST>') && xml2.indexOf('<pMVAST>') < xml2.indexOf('<vBCST>'));

console.log('=== 2b) CFOP 5401/6401 e natOp "Vendas de produto ST" (modelo NF 62346, v1.2.46) ===');
var l2b = linhasSt();
var r2b = aplicarStManualLinhas(l2b, { mva: 95.39, aliquotaSt: 19.5 }, { isInterstate: false });
check('CFOP interno com ST = 5401 (modelo 62346)', l2b[0].cfop === '5401', String(l2b[0].cfop));
check('natOp com ST = "Vendas de produto ST"', r2b.natOpSt === 'Vendas de produto ST', String(r2b.natOpSt));
check('CFOP sai no XML do det', /<CFOP>5401<\/CFOP>/.test(gerarXmlNFe(base(l2b, 1296.58))));
var l2bi = linhasSt();
var r2bi = aplicarStManualLinhas(l2bi, { mva: 95.39, aliquotaSt: 19.5 }, { isInterstate: true });
check('CFOP interestadual com ST = 6401', l2bi[0].cfop === '6401', String(l2bi[0].cfop));
check('XML interestadual com CFOP 6401', /<CFOP>6401<\/CFOP>/.test(gerarXmlNFe(base(l2bi, 1296.58))));
var l2bs = linhasSt(); // sem opts (compat): CFOP default interno
aplicarStManualLinhas(l2bs, { mva: 95.39, aliquotaSt: 19.5 });
check('sem opts -> CFOP interno 5401 (compat)', l2bs[0].cfop === '5401', String(l2bs[0].cfop));

console.log('=== 3) Variante preço 2 casas (43.22×30=1296.60): daria 1635.03 ===');
console.log('      (por isso a linha da #5975 foi ajustada para 43.2193 = vUnCom da tabela)');
var l3 = linhasPreco2Casas();
var r3 = aplicarStManualLinhas(l3, { mva: 95.39, aliquotaSt: 19.5 });
check('BCST = 2533.43', l3[0].vbcst === '2533.43', String(l3[0].vbcst));
check('vICMSST = 338.43', l3[0].vicmsst === '338.43', String(l3[0].vicmsst));
check('vNF = 1635.03 com vProd 1296.60', quase(r3.vProdTotal + r3.vICMSSTTotal, 1635.03), String(round2(r3.vProdTotal + r3.vICMSSTTotal)));

console.log('=== 4) Multi-linhas: vNF = ΣvProd + ΣvICMSST ===');
var l4 = [
  Object.assign(linhasSt()[0], { default_code: 'A', qty: 10, price_unit: 80.00, price_subtotal: 800.00, vbc_icms: '800.00', vicms: '96.00' }),
  Object.assign(linhasSt()[0], { default_code: 'B', qty: 5, price_unit: 99.32, price_subtotal: 496.60, vbc_icms: '496.60', vicms: '59.59' }),
];
var r4 = aplicarStManualLinhas(l4, { mva: 95.39, aliquotaSt: 19.5 });
var soma4 = round2(r4.vProdTotal + r4.vICMSSTTotal);
check('ΣvProd = 1296.60', quase(r4.vProdTotal, 1296.60), String(r4.vProdTotal));
check('vNF = ΣvProd + ΣvICMSST', quase(soma4, round2(r4.vProdTotal + r4.vBCSTTotal * 0.195 - r4.vICMSTotal)), String(soma4));
check('CST 10 nas duas linhas', l4[0].cst_icms === '10' && l4[1].cst_icms === '10');
check('vProd das linhas intocado', l4[0].price_subtotal === 800.00 && l4[1].price_subtotal === 496.60);

console.log('=== 5) Guardas: ST sem MVA / sem alíquota ===');
var errou1 = false;
try { aplicarStManualLinhas(linhasSt(), { mva: 0, aliquotaSt: 19.5 }); }
catch (e) { errou1 = /MVA/.test(e.message); }
check('ST sem MVA -> erro claro (não emite NF errada)', errou1);
var errou2 = false;
try { aplicarStManualLinhas(linhasSt(), { mva: 95.39, aliquotaSt: 0 }); }
catch (e) { errou2 = true; }
check('ST sem alíquota -> erro', errou2);

console.log('=== 6) Regressão: SEM ST o fluxo de hoje fica INTACTO ===');
var l6 = linhasNormais();
var xml6 = gerarXmlNFe(base(l6, 1296.58));
check('XML sem ICMS10', !/<ICMS10>/.test(xml6));
check('XML: CST 00 mantido', /<CST>00<\/CST>/.test(xml6));
check('XML: ICMSTot vBCST 0.00', /<vBCST>0\.00<\/vBCST>/.test(xml6));
check('XML: ICMSTot vST 0.00', /<vST>0\.00<\/vST>/.test(xml6));
check('XML: vNF = vProd (sem ST, sem IPI) = 1296.58', /<vNF>1296\.58<\/vNF>/.test(xml6));
check('XML: vICMS 155.59 (12% manual)', /<vICMS>155\.59<\/vICMS>/.test(xml6));
check('CST 10 sem dados de ST -> erro (evita rejeição 225)', (function () {
  try { gerarXmlNFe(base((function () { var x = linhasSt(); x[0].cst_icms = '10'; delete x[0].vbcst; delete x[0].vicmsst; delete x[0].picmsst; return x; })(), 1296.58)); return false; }
  catch (e) { return /CST 10/.test(e.message); }
})());

console.log('');
if (falhas) { console.error('*** ' + falhas + ' FALHA(S) ***'); process.exit(1); }
console.log('*** TODOS OS TESTES PASSARAM — ST soma no vNF (1635.00 exato), vProd intocado e fluxo sem ST intacto ***');
