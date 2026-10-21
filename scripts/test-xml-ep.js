// Teste do gerarXmlNFe com ENTRADA + PARCELAMENTO (demanda 8) + obs_nfe
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'TESTE';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '41999999999';
process.env.NFE_IBSCBS = 'false'; // simplifica o XML p/ leitura do teste

var { gerarXmlNFe } = require('../services/sieg-nfe-xml');

var data = {
  company: {
    cnpj_cpf: '22603750000190', legal_name: 'AJL FERRO E ACO LTDA', name: 'AJL',
    inscr_est: '9069585890', street: 'Avenida Juscelino Kubitschek de Oliveira',
    number: '7525', street2: 'Cidade Industrial', city: 'Curitiba', state: 'PR',
    zip: '81270230', city_ibge_code: '4106902', state_ibge: '41', crt: '3',
    phone: '4133445566', email: 'vendas@ajl.com.br',
  },
  partner: {
    cnpj_cpf: '12345678000199', legal_name: 'CLIENTE TESTE LTDA', xNome: 'CLIENTE TESTE',
    inscr_est: '12345678', street: 'Rua Teste', number: '100', street2: 'Centro',
    city: 'Londrina', state: 'PR', zip: '86000000', city_ibge_code: '4113700',
    is_consumer: false,
  },
  order: {
    name: 'NFe 00072910', number: '72910',
    date_order: new Date().toISOString(), // dhEmi = agora (hora BR -03:00)
    amount_total: 53030.03,
    note: 'Venda conforme orcamento.',
    obs_nfe: 'Entrada de R$ 13.030,03 no PIX + 4 parcelas mensais de R$ 10.000,00 (boleto).',
    sale_order_number: 'S01800',
    forma_pagamento: 'ENTRADA + PARCELAMENTO',
    forma_pagamento_label: 'Entrada R$ 13030.03 + 4 parcelas mensais de R$ 10000.00 (valor financiado: R$ 40000.00)',
    icms_aliquota: '12',
    boleto_detalhes: [
      { parcela: '1/4', valor: '10000.00', vencimento: '2026-11-19', nosso_numero: '', linha_digitavel: '' },
      { parcela: '2/4', valor: '10000.00', vencimento: '2026-12-19', nosso_numero: '', linha_digitavel: '' },
      { parcela: '3/4', valor: '10000.00', vencimento: '2027-01-18', nosso_numero: '', linha_digitavel: '' },
      { parcela: '4/4', valor: '10000.00', vencimento: '2027-02-17', nosso_numero: '', linha_digitavel: '' },
    ],
    duplicatas: [
      { dVenc: '2026-11-19', vDup: '10000.00' },
      { dVenc: '2026-12-19', vDup: '10000.00' },
      { dVenc: '2027-01-18', vDup: '10000.00' },
      { dVenc: '2027-02-17', vDup: '10000.00' },
    ],
  },
  lines: [{
    cProd: 'P001', product_name: 'PERFIL DE ACO 6M', ncm: '72166100', cfop: '5102',
    uom: 'UN', qty: 10, price_unit: 5303.003, price_subtotal: 53030.03,
    cst_icms: '00', mod_bc: '3', orig: '0', vbc_icms: '53030.03', vicms: '6363.60', picms: '12',
    cst_pis: '01', vbc_pis: '53030.03', ppis: '1.65', vpis: '875.00',
    cst_cofins: '01', vbc_cofins: '53030.03', pcofins: '7.60', vcofins: '4030.29',
  }],
  pagamentos: [
    { indPag: '0', tPag: '01', vPag: '13030.03' },
    { indPag: '1', tPag: '13', vPag: '10000.00' },
    { indPag: '1', tPag: '13', vPag: '10000.00' },
    { indPag: '1', tPag: '13', vPag: '10000.00' },
    { indPag: '1', tPag: '13', vPag: '10000.00' },
  ],
  duplicatas: [
    { dVenc: '2026-11-19', vDup: '10000.00' },
    { dVenc: '2026-12-19', vDup: '10000.00' },
    { dVenc: '2027-01-18', vDup: '10000.00' },
    { dVenc: '2027-02-17', vDup: '10000.00' },
  ],
  config: { serie: '100', tpAmb: '2', natOp: 'Venda de Mercadoria', mod: '55' },
};

var xml = gerarXmlNFe(data);

// Verificacoes
function check(label, cond) { console.log(cond ? 'OK  ' : 'FALHA', '-', label); }
var detPagCount = (xml.match(/<detPag>/g) || []).length;
check('5 detPag (1 entrada + 4 parcelas)', detPagCount === 5);
check('entrada tPag 01 a vista', xml.indexOf('<tPag>01</tPag>') >= 0 && xml.indexOf('<indPag>0</indPag>') >= 0);
check('4 boletos tPag 13 a prazo', (xml.match(/<tPag>13<\/tPag>/g) || []).length === 4 && (xml.match(/<indPag>1<\/indPag>/g) || []).length >= 4);
check('4 duplicatas no cobr', (xml.match(/<dup>/g) || []).length === 4);
check('obs_nfe no infCpl', xml.indexOf('Entrada de R$ 13.030,03 no PIX') >= 0);
check('forma label E+P no infCpl', xml.indexOf('Entrada R$ 13030.03') >= 0);
check('dhEmi com offset -03:00', /<dhEmi>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00<\/dhEmi>/.test(xml));
check('IE emitente no XML', xml.indexOf('<IE>9069585890</IE>') >= 0);
check('pICMS 12.00 por linha', xml.indexOf('<pICMS>12.00</pICMS>') >= 0);
check('vNF 53030.03', xml.indexOf('<vNF>53030.03</vNF>') >= 0);
check('vPag soma = vNF (entrada+parcelas)', (xml.match(/<vPag>/g) || []).length === 5);

// Mostra blocos-chave
var mPag = xml.match(/<pag>[\s\S]*?<\/pag>/);
console.log('\n=== BLOCO pag ===\n' + (mPag ? mPag[0] : '(não encontrado)'));
var mInf = xml.match(/<infAdic>[\s\S]*?<\/infAdic>/);
console.log('\n=== BLOCO infAdic ===\n' + (mInf ? mInf[0] : '(não encontrado)'));
