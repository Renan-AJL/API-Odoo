/**
 * Teste 06/11/2026 — CST ICMS MANUAL (x_studio_cst_icms, v1.2.26)
 * Demanda: Remessa de Industrialização p/ Fornecedores (CFOP 5901) saía com ICMS
 * (NFe 00073549 CST 00, vICMS 197,25). Campo editável na fatura: 40/41/50 =>
 * NF sai SEM destaque (vBC/vICMS 0) + cBenef PR800044 (rejeição 930, tabela SEFAZ-PR).
 * Referência correta em produção: NFe 00073491 (ICMS manual 0% -> CST 41 + cBenef).
 */
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'AJL TI';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '4133730076';
delete process.env.NFE_CBENEF_INDUSTRIALIZACAO; // default PR800044

var { gerarXmlNFe } = require('../services/sieg-nfe-xml');
var { aplicarCstIcmsManualLinhas, CSTS_SEM_DESTAQUE } = require('../services/cst-icms-manual');

var companyPR = {
  cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL DISTRIBUIDORA', inscr_est: '9069585890',
  street: 'Avenida Juscelino Kubitschek de Oliveira', number: '7525', street2: 'Cidade Industrial',
  city: 'Curitiba', city_ibge_code: '4106902', state: 'PR', zip: '81450000',
  phone: '4133730076', crt: '3', state_ibge: '41',
};
var partner = {
  cnpj_cpf: '16859095000133', xNome: 'FORNECEDOR INDUSTRIALIZACAO LTDA',
  legal_name: 'FORNECEDOR INDUSTRIALIZACAO LTDA', inscr_est: '9060000000',
  street: 'Rua Teste', number: '100', street2: 'Bairro', city: 'Curitiba',
  city_ibge_code: '4106902', state: 'PR', zip: '81020490', phone: '4100000000',
  email: 'teste@teste.com.br',
};
function linhas() {
  return [{
    default_code: '2466', product_name: 'Bobina 2,70 GI', ncm: '72112320',
    cfop: '5901', uom: 'KG', qty: 11380, price_unit: 5.10, price_subtotal: 58038.00,
    orig: '0', csosn: '', cst_icms: '00', mod_bc: '3',
    vbc_icms: '58038.00', vicms: '6964.56', picms: '12.00',
    cst_pis: '01', vbc_pis: '58038.00', ppis: '1.65', vpis: '957.63',
    cst_cofins: '01', vbc_cofins: '58038.00', pcofins: '7.60', vcofins: '4410.89',
  }];
}
function base(lines) {
  return {
    company: companyPR, partner,
    order: { name: 'SO999', number: '999', date_order: '2026-11-06T12:00:00-03:00', amount_total: 58038.0 },
    lines: lines, pagamentos: [{ tPag: '90', vPag: 58038.00 }],
  };
}

var falhas = 0;
function check(label, cond, detalhe) {
  if (cond) console.log('  PASS  ' + label);
  else { falhas++; console.error('  FAIL  ' + label + (detalhe ? ' -> ' + detalhe : '')); }
}

console.log('=== 1) CST 41 (Remessa p/ Industrialização) ===');
var l1 = linhas();
var n1 = aplicarCstIcmsManualLinhas(l1, '41', 'PR');
check('1 linha transformada', n1 === 1, String(n1));
check('cst_icms = 41', l1[0].cst_icms === '41');
check('vBC = 0.00', l1[0].vbc_icms === '0.00');
check('vICMS = 0.00', l1[0].vicms === '0.00');
check('pICMS = 0.00', l1[0].picms === '0.00');
check('sem CSOSN', l1[0].csosn === '');
check('sem DIFAL', l1[0].difal === 0);
check('cBenef PR800044 (PR + rejeição 930)', l1[0].cbenef === 'PR800044', String(l1[0].cbenef));
var xml1 = gerarXmlNFe(base(l1));
var c1 = xml1.replace(/\s+/g, ' ');
check('XML: ICMS40 com CST 41', /<ICMS><ICMS40><orig>0<\/orig><CST>41<\/CST><\/ICMS40><\/ICMS>/.test(c1));
check('XML: cBenef entre NCM e CFOP', /<NCM>72112320<\/NCM>\s*<cBenef>PR800044<\/cBenef>\s*<CFOP>5901<\/CFOP>/.test(xml1));
check('XML: vICMS 0.00', /<vICMS>0\.00<\/vICMS>/.test(xml1));
check('XML: sem vICMS de R$ 6.964,56', !xml1.includes('6964.56'));

console.log('=== 2) CST 40 (isenta) e 50 (suspensão) ===');
var l2 = linhas(); aplicarCstIcmsManualLinhas(l2, '40', 'PR');
check('CST 40 aplicado', l2[0].cst_icms === '40' && l2[0].cbenef === 'PR800044');
var l3 = linhas(); aplicarCstIcmsManualLinhas(l3, '50', 'PR');
check('CST 50 aplicado', l3[0].cst_icms === '50' && l3[0].cbenef === 'PR800044');

console.log('=== 3) Empresa fora do PR: sem cBenef ===');
var l4 = linhas(); aplicarCstIcmsManualLinhas(l4, '41', 'SC');
check('cst 41 aplicado em SC', l4[0].cst_icms === '41');
check('SEM cBenef (código só validado p/ PR)', l4[0].cbenef === undefined, String(l4[0].cbenef));

console.log('=== 4) Vazio / inválido = fluxo automático intocado ===');
var l5 = linhas();
check('vazio -> 0 linhas tocadas', aplicarCstIcmsManualLinhas(l5, false, 'PR') === 0);
check('linha mantém CST 00 + ICMS', l5[0].cst_icms === '00' && l5[0].vicms === '6964.56');
var l6 = linhas();
check('\'00\' -> 0 linhas tocadas', aplicarCstIcmsManualLinhas(l6, '00', 'PR') === 0);
var l7 = linhas();
check('\'90\' (fora da lista) -> 0', aplicarCstIcmsManualLinhas(l7, '90', 'PR') === 0);
check('CSTS_SEM_DESTAQUE = 40/41/50', JSON.stringify(CSTS_SEM_DESTAQUE) === '["40","41","50"]');

console.log('=== 5) Regressão: XML automático (sem CST manual) continua com ICMS 12% ===');
var xml5 = gerarXmlNFe(base(linhas()));
check('XML automático tem vICMS 6964.56', xml5.includes('6964.56'));
check('XML automático CST 00', /<CST>00<\/CST>/.test(xml5));

console.log('');
if (falhas) { console.error('*** ' + falhas + ' FALHA(S) ***'); process.exit(1); }
console.log('*** TODOS OS TESTES PASSARAM — CST ICMS manual aplicado com cBenef e sem quebrar o fluxo automático ***');
