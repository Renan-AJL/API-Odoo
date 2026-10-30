/**
 * Teste 30/10/2026 — cBenef para rejeicao 930 (NFe 00073368 STEELALLOY, CFOP 5901)
 *
 * Regras: SEFAZ PR exige cBenef para CST 40/41/50 (NT 2019.001 regra 930_N12-85).
 * Literal "SEM CBENEF" desativado 01/07/2026; regras 929/946 (producao 06/04/2026)
 * validam o codigo contra a tabela da UF. Remessa p/ industrializacao por conta e
 * ordem do adquirente no PR = CST 41 + cBenef PR800044 (tabela oficial SEFAZ-PR).
 * Posicao no XML: <prod> entre NCM e CFOP (NT 2025.002 / XSD atual).
 */
const { gerarXmlNFe } = require('../services/sieg-nfe-xml');

const company = {
  cnpj_cpf: '22603750000190',
  legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL DISTRIBUIDORA',
  street: 'Avenida Juscelino Kubitschek de Oliveira',
  number: '7525', street2: 'Cidade Industrial',
  city: 'Curitiba', city_ibge_code: '4106902', state: 'PR', zip: '81450000',
  phone: '4133730076', inscr_est: '9069585890', crt: '1', state_ibge: '41',
};
const partner = {
  cnpj_cpf: '16859095000133',
  xNome: 'STEELALLOY INDUSTRIA E COMERCIO DE FITAS DE ACO LTDA',
  legal_name: 'STEELALLOY INDUSTRIA E COMERCIO DE FITAS DE ACO LTDA',
  street: 'Rua Teste', number: '100', street2: 'Bairro',
  city: 'Curitiba', city_ibge_code: '4106902', state: 'PR', zip: '81020490',
  phone: '4100000000', inscr_est: '9060000000', email: 'teste@teste.com.br',
};
const base = {
  company, partner,
  order: { name: 'SO999', number: '999', date_order: '2026-10-30T12:00:00-03:00', amount_total: 58038.0 },
  lines: [{
    default_code: '2466', product_name: 'Bobina 2,70 GI', barcode: 'SEM GTIN',
    ncm: '72112320', cfop: '5901', uom: 'KG', qty: 11380, price_unit: 5.10,
    price_subtotal: 58038.00, orig: '0', csosn: '', cst_icms: '41',
    cbenef: 'PR800044', vbc_icms: '0.00', vicms: '0.00', picms: '0.00',
    cst_pis: '01', vbc_pis: '58038.00', ppis: '1.65', vpis: '957.63',
    cst_cofins: '01', vbc_cofins: '58038.00', pcofins: '7.60', vcofins: '4410.89',
  }],
  pagamentos: [{ tPag: '90', vPag: 58038.00 }],
};

let falhas = 0;
function check(label, cond, detalhe) {
  if (cond) console.log('  PASS  ' + label);
  else { falhas++; console.error('  FAIL  ' + label + (detalhe ? ' -> ' + detalhe : '')); }
}

console.log('=== cBenef no <prod> entre NCM e CFOP (NT 2025.002) ===');
const xml = gerarXmlNFe(base);
const compact = xml.replace(/\s+/g, ' ');
check('<cBenef>PR800044 presente', xml.includes('<cBenef>PR800044</cBenef>'));
check('posicao correta: NCM -> cBenef -> CFOP',
  /<NCM>72112320<\/NCM>\s*<cBenef>PR800044<\/cBenef>\s*<CFOP>5901<\/CFOP>/.test(xml));
check('ICMS40 minimal com CST 41 (XSD nao tem tag ICMS41 — grupo compartilhado 40/41/50)',
  /<ICMS><ICMS40><orig>0<\/orig><CST>41<\/CST><\/ICMS40><\/ICMS>/.test(compact));
check('vBC total = 0.00 (sem base)', /<vBC>0\.00<\/vBC>/.test(xml));

console.log('=== regressao: sem cbenef na linha -> XML sem <cBenef> ===');
const sem = gerarXmlNFe({ ...base, lines: [{ ...base.lines[0], cbenef: undefined, cst_icms: '40' }] });
check('sem <cBenef> quando linha nao tem codigo', !sem.includes('<cBenef>'));

console.log('');
if (falhas) { console.error('*** ' + falhas + ' FALHA(S) ***'); process.exit(1); }
console.log('*** TODOS OS TESTES PASSARAM — cBenef aplicado conforme tabela SEFAZ-PR ***');
