// Gera o XML do cenario 1 (caso real que falhou: PR -> SC consumidor final)
// e salva em download/ para validacao XSD com lxml.
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'TESTE';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '41999999999';
process.env.NFE_IBSCBS = 'false';

var { gerarXmlNFe } = require('../services/sieg-nfe-xml');

var data = {
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
    date_order: '2026-10-21T19:28:00Z', amount_total: 8376,
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
};

var xml = gerarXmlNFe(data);
require('fs').writeFileSync(__dirname + '/../download/test-nfe-difal-fix.xml', xml);
console.log('XML salvo em download/test-nfe-difal-fix.xml, len=' + xml.length);
var flat = xml.replace(/\n\s*/g, '');
var i = flat.indexOf('</COFINS><ICMSUFDest>');
var j = flat.indexOf('</ICMS00></ICMS>');
console.log('imposto trecho:', flat.substring(flat.indexOf('<imposto>'), flat.indexOf('</imposto>') + 10));
