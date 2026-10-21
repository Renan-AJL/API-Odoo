// Teste DIFAL (cStat 694): ICMSUFDest por item + totais vFCPUFDest/vICMSUFDest
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'TESTE';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '41999999999';
process.env.NFE_IBSCBS = 'false';

var { gerarXmlNFe } = require('../services/sieg-nfe-xml');

function base(overrides) {
  var d = JSON.parse(JSON.stringify({
    company: {
      cnpj_cpf: '22603750000352', legal_name: 'AJL COMERCIO ATACADISTA LTDA', name: 'AJL - Ponta Grossa',
      inscr_est: '9093593925', street: 'Av. Visc. de Taunay', number: 'S/N', street2: 'Contorno',
      city: 'Ponta Grossa', state: 'PR', zip: '84052000', city_ibge_code: '4119905',
      state_ibge: '41', crt: '3', phone: '4232265590',
    },
    partner: {
      cnpj_cpf: '08560165940', legal_name: 'DJONATA VIEIRA', xNome: 'Djonata vieira',
      inscr_est: '', street: 'Rua Carlos Goertler', number: 'S/N', street2: 'Serra Alta',
      city: 'São Bento do Sul', state: 'SC', zip: '89291880', city_ibge_code: '4215802',
      is_consumer: true,
    },
    order: {
      name: 'NFe 00072944', number: '72944',
      date_order: new Date().toISOString(), amount_total: 8376,
      note: 'Venda.', sale_order_number: 'S01387',
    },
    lines: [{
      cProd: '1497', product_name: '1497 - Bobininha 0,43 Nacional (Padrão - MT)', ncm: '72123000', cfop: '6102',
      uom: 'MT', qty: 240, price_unit: 34.9, price_subtotal: 8376,
      cst_icms: '00', mod_bc: '3', orig: '0', vbc_icms: '8376.00', vicms: '1005.12', picms: '12',
      cst_pis: '01', vbc_pis: '8376.00', ppis: '1.65', vpis: '138.20',
      cst_cofins: '01', vbc_cofins: '8376.00', pcofins: '7.60', vcofins: '636.58',
    }],
    pagamentos: [{ indPag: '0', tPag: '15', vPag: '8376.00' }],
    config: { serie: '100', tpAmb: '2', natOp: 'Venda de produtos', mod: '55' },
  }));
  if (overrides.partner) Object.assign(d.partner, overrides.partner);
  if (overrides.company) Object.assign(d.company, overrides.company);
  if (overrides.lines) d.lines = overrides.lines;
  return d;
}

var falhas = 0;
function check(nome, cond, extra) {
  console.log((cond ? '  OK   ' : '  FALHA') + ' — ' + nome + (extra ? ' | ' + extra : ''));
  if (!cond) falhas++;
}

console.log('=== CENARIO 1: PR -> SC, CPF consumidor (indIEDest=9) — DIFAL obrigatorio ===');
var xml1 = gerarXmlNFe(base({}));
check('ICMSUFDest presente', xml1.includes('<ICMSUFDest>'));
check('ICMSUFDest FORA do grupo <ICMS> (apos </ICMS>, apos COFINS) — fix rejeicao 225',
  /<\/COFINS><ICMSUFDest>[\s\S]*?<\/ICMSUFDest>(<IBSCBS>)?<\/imposto>/.test(xml1.replace(/\n/g, '')));
check('NADA entre </ICMS00> e </ICMS> (ICMSUFDest nao dentro do ICMS)',
  /<ICMS><ICMS00>[\s\S]*?<\/ICMS00><\/ICMS>/.test(xml1.replace(/\n/g, '')));
check('vBCUFDest=8376.00', xml1.includes('<vBCUFDest>8376.00</vBCUFDest>'));
check('pICMSUFDest=17.00 (tabela SC)', xml1.includes('<pICMSUFDest>17.00</pICMSUFDest>'));
check('pICMSInter=12.00', xml1.includes('<pICMSInter>12.00</pICMSInter>'));
// FIX rejeicao 816 (NT 2019.001/LC 190/2020): partilha da ORIGEM = 0% desde 2019,
// portanto vICMSUFRemet = 0.00 e DIFAL integral (pICMSInterPart=100.00) para a UF destino.
// pICMSInterPart e validado pela rejeicao 699 contra o ano da emissao (2026 => 100.00).
check('pICMSInterPart=100.00 (rejeicao 699: 2026 => 100.00)', xml1.includes('<pICMSInterPart>100.00</pICMSInterPart>'));
check('vFCPUFDest=0.00', xml1.includes('<vFCPUFDest>0.00</vFCPUFDest>'));
check('vICMSUFDest=418.80 (8376 x 5% — DIFAL integral UF destino)', xml1.includes('<vICMSUFDest>418.80</vICMSUFDest>'));
check('vICMSUFRemet item=0.00 (fix rejeicao 816)', /<vICMSUFDest>418\.80<\/vICMSUFDest><vICMSUFRemet>0\.00<\/vICMSUFRemet>/.test(xml1.replace(/\n/g, '')));
check('ICMSTot vICMSUFRemet=0.00', /<vICMSUFDest>418\.80<\/vICMSUFDest>\s*<vICMSUFRemet>0\.00<\/vICMSUFRemet>/.test(xml1));
check('ICMSTot com vICMSUFDest=418.80', /<ICMSTot>[\s\S]*<vICMSUFDest>418.80<\/vICMSUFDest>/.test(xml1));
check('ordem XSD: vICMSDeson -> vFCPUFDest -> vICMSUFDest -> vICMSUFRemet -> vFCP',
  /<vICMSDeson>0\.00<\/vICMSDeson>\s*<vFCPUFDest>0\.00<\/vFCPUFDest>\s*<vICMSUFDest>418\.80<\/vICMSUFDest>\s*<vICMSUFRemet>0\.00<\/vICMSUFRemet>\s*<vFCP>0\.00<\/vFCP>/.test(xml1));
check('vICMS origem mantido 1005.12', xml1.includes('<vICMS>1005.12</vICMS>'));
check('vNF inalterado 8376.00', xml1.includes('<vNF>8376.00</vNF>'));

console.log('\n=== CENARIO 2: destino COM IE (contribuinte, indIEDest=1) — SEM DIFAL ===');
var xml2 = gerarXmlNFe(base({ partner: { inscr_est: '9093593925', cnpj_cpf: '12345678000199', is_consumer: false } }));
check('ICMSUFDest AUSENTE', !xml2.includes('<ICMSUFDest>'));
check('ICMSTot sem vICMSUFDest>0', /<ICMSTot>[\s\S]*<vICMSUFDest>0\.00<\/vICMSUFDest>/.test(xml2));

console.log('\n=== CENARIO 3: operacao INTERNA PR -> PR, CPF — SEM DIFAL ===');
var xml3 = gerarXmlNFe(base({ partner: { state: 'PR', city: 'Curitiba', city_ibge_code: '4106902', zip: '81270230' } }));
check('ICMSUFDest AUSENTE', !xml3.includes('<ICMSUFDest>'));

console.log('\n=== CENARIO 4: PR -> MA (7%, tabela MA=22) — DIFAL 15% ===');
var linhasMA = JSON.parse(JSON.stringify(base({}).lines));
linhasMA[0].picms = '7'; linhasMA[0].vicms = '586.32'; // emissor reescreve pICMS p/ 7% em N/NE
var xml4 = gerarXmlNFe(base({ partner: { state: 'MA', city: 'Sao Luis', city_ibge_code: '2111300', zip: '65010000' }, lines: linhasMA }));
check('pICMSUFDest=22.00', xml4.includes('<pICMSUFDest>22.00</pICMSUFDest>'));
check('pICMSInter=7.00', xml4.includes('<pICMSInter>7.00</pICMSInter>'));
check('vICMSUFDest=1256.40 (8376 x 15% — integral UF destino)', xml4.includes('<vICMSUFDest>1256.40</vICMSUFDest>'));
check('vICMSUFRemet=0.00 (fix rejeicao 816)', /<vICMSUFDest>1256\.40<\/vICMSUFDest><vICMSUFRemet>0\.00<\/vICMSUFRemet>/.test(xml4.replace(/\n/g, '')));
check('pICMSInterPart=100.00 (cenario MA)', xml4.includes('<pICMSInterPart>100.00</pICMSInterPart>'));

console.log('\n' + (falhas === 0 ? 'TODOS OS CHECKS OK' : falhas + ' CHECK(S) FALHARAM'));
process.exit(falhas === 0 ? 0 : 1);
