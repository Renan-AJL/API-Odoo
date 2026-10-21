// Checagens extras: (1) IBSCBS ativo — ICMSUFDest deve ficar entre COFINS e IBSCBS;
// (2) linha CSOSN (Simples Nacional) com DIFAL — estrutura valida.
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'TESTE';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '41999999999';

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
    order: { name: 'NFe 00072944', number: '72944', date_order: '2026-10-21T19:28:00Z', amount_total: 8376, note: 'Venda.', sale_order_number: 'S01387' },
    lines: [{
      cProd: '1497', product_name: '1497 - Bobininha 0,43 Nacional', ncm: '72123000', cfop: '6102',
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
function check(nome, cond) {
  console.log((cond ? '  OK   ' : '  FALHA') + ' — ' + nome);
  if (!cond) falhas++;
}

// 1) IBSCBS ativo
process.env.NFE_IBSCBS = 'true';
var xmlIbs = gerarXmlNFe(base({}));
var flatIbs = xmlIbs.replace(/\n\s*/g, '');
check('IBSCBS: ordem </COFINS><ICMSUFDest>...<IBSCBS>',
  /<\/COFINS><ICMSUFDest>[\s\S]*?<\/ICMSUFDest><IBSCBS>/.test(flatIbs));
check('IBSCBS: imposto termina </IBSCBS></imposto>', flatIbs.includes('</IBSCBS></imposto>'));

// 2) CSOSN (Simples Nacional) com DIFAL
process.env.NFE_IBSCBS = 'false';
var linhasSn = JSON.parse(JSON.stringify(base({}).lines));
delete linhasSn[0].cst_icms; delete linhasSn[0].mod_bc; delete linhasSn[0].vbc_icms;
delete linhasSn[0].vicms; delete linhasSn[0].picms;
linhasSn[0].csosn = '102';
var xmlSn = gerarXmlNFe(base({ lines: linhasSn }));
var flatSn = xmlSn.replace(/\n\s*/g, '');
check('CSOSN: ICMSSN102 emitido', /<ICMS><ICMSSN102><orig>0<\/orig><CSOSN>102<\/CSOSN><\/ICMSSN102><\/ICMS>/.test(flatSn));
check('CSOSN: ICMSUFDest apos COFINS', /<\/COFINS><ICMSUFDest>[\s\S]*?<\/ICMSUFDest><\/imposto>/.test(flatSn));
check('CSOSN: vICMSUFDest=418.80 (tabela SC 17% - 12%)', flatSn.includes('<vICMSUFDest>418.80</vICMSUFDest>'));
check('CSOSN: vICMSUFRemet=0.00 (fix rejeicao 816)', flatSn.includes('<vICMSUFRemet>0.00</vICMSUFRemet>'));

console.log('\n' + (falhas === 0 ? 'EXTRAS OK' : falhas + ' FALHA(S)'));
process.exit(falhas === 0 ? 0 : 1);
