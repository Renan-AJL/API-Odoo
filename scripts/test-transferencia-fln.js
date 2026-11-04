// Teste TRANSFERÊNCIA ENTRE LOJAS (AJL 04/11/2026) — Filial Florianópolis -> Matriz Curitiba
// Modelo: NF-e autorizada 42260922603750000514550010000000141081562740 (XML anexado pelo usuario)
//   emit AJL FERRO E ACO FILIAL FLORIANOPOLIS (CNPJ 22603750000514, IE 264096223, SC 4205407)
//   dest AJL COMERCIO ATACADISTA (CNPJ 22603750000190, IE 9069585890, PR 4106902)
//   CFOP 6152, natOp "Transferencia de mercadoria adquirida/recebida de", serie 1,
//   2x NFref (venda a ordem do fornecedor entregue em Curitiba), tPag 90, modFrete 9,
//   indPres 0 + indIntermed 0.
// 04/11 (v2): sem painel — a FLN emite via SIEG (EnviarXml, cert da filial no cofre);
// rota smoke: enviarNFe com viaSiegTransferencia cai no caminho SIEG (sem SIEG_API_KEY
// em ambiente de teste -> erro esperado 'SIEG_API_KEY nao configurada').
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'AJL TI';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '4133730076';
process.env.NFE_IBSCBS = 'false'; // transferência igual ao modelo (sem IBSCBS no XML de 09/2026)

var { gerarXmlNFe } = require('../services/sieg-nfe-xml');
var { enviarNFe, enviarNFeSiegTransferencia, baixarXmlsSieg } = require('../services/sieg-api');

// Chaves das NFs referenciadas no XML MODELO (fornecedor ARCELORMITTAL, venda a ordem -> Curitiba)
var REF1 = '42260917469701010644550020002514961203108064';
var REF2 = '42260917469701010644550020002514971012799043';
// Chave da NF de IDA (para o RETORNO Curitiba -> Florianópolis)
var CHAVE_IDA = '42260922603750000514550010000000141081562740';

function dadosTransferencia(overrides) {
  var d = {
    company: {
      cnpj_cpf: '22603750000514', legal_name: 'AJL FERRO E ACO FILIAL FLORIANOPOLIS',
      name: 'AJL FERRO E ACO FILIAL FLORIANOPOLIS', inscr_est: '264096223',
      street: 'AV PREF OSMAR CUNHA', number: '416', street2: 'SL 1108 CENTRO',
      city: 'FLORIANOPOLIS', state: 'SC', zip: '88015100',
      city_ibge_code: '4205407', state_ibge: '42', crt: '3', phone: '4133730076',
    },
    partner: {
      cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
      xNome: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
      inscr_est: '9069585890', street: 'AV JUSCELINO KUBITSCHEK DE OLIVEIRA', number: '7525',
      street2: 'CIDADE INDUSTRIAL', city: 'CURITIBA', state: 'PR', zip: '81350160',
      city_ibge_code: '4106902', ind_ie_dest: 1,
    },
    order: {
      name: 'NFe 00000014', number: '14',
      date_order: '2026-09-17T12:00:00Z', amount_total: 21574.03,
      note: '', sale_order_number: '',
    },
    lines: [{
      cProd: '2428', product_name: 'BZL BOBINA ZINCADA LEVE QC 2Q', ncm: '72104910',
      cfop: '6152', uom: 'KG', qty: 4026, price_unit: 5.19, price_subtotal: 20894.94,
      cst_icms: '00', mod_bc: '3', orig: '0', csosn: '',
      vbc_icms: '20894.94', vicms: '2507.39', picms: '12',
      cst_pis: '01', vbc_pis: '18387.55', ppis: '1.65', vpis: '303.39',
      cst_cofins: '01', vbc_cofins: '18387.55', pcofins: '7.60', vcofins: '1397.45',
      cst_ipi: '50', vbc_ipi: '20894.94', pipi: '3.25', vipi: '679.09', cenq: '999',
    }],
    pagamentos: [{ tPag: '90', vPag: '0.00' }],
    duplicatas: [],
    config: {
      serie: '1', tpAmb: '1', natOp: 'Transferencia de mercadoria adquirida/recebida de',
      mod: '55', indPres: '0', indIntermed: '0', modFrete: '9',
      nfrefChaves: REF1 + ' ' + REF2,
    },
  };
  if (overrides) Object.assign(d, overrides);
  return d;
}

var falhas = 0;
function check(nome, cond, extra) {
  console.log((cond ? '  OK   ' : '  FALHA') + ' — ' + nome + (extra ? ' | ' + extra : ''));
  if (!cond) falhas++;
}

console.log('=== CENARIO 1: IDA Floripa->Curitiba (paridade com o XML modelo) ===');
var xml = gerarXmlNFe(dadosTransferencia());
var xc = xml.replace(/\n/g, '');
check('natOp EXATA do modelo', xml.includes('<natOp>Transferencia de mercadoria adquirida/recebida de</natOp>'));
check('serie 1 (modelo)', xml.includes('<serie>1</serie>'));
check('nNF 14', xml.includes('<nNF>14</nNF>'));
check('emit CNPJ 22603750000514', xml.includes('<CNPJ>22603750000514</CNPJ>'));
check('emit IE 264096223', /<emit>[\s\S]*?<IE>264096223<\/IE>/.test(xml));
check('emit cMun 4205407 (Florianópolis SC)', /<enderEmit>[\s\S]*?<cMun>4205407<\/cMun>[\s\S]*?<UF>SC<\/UF>/.test(xc));
check('dest CNPJ 22603750000190', /<dest>[\s\S]*?<CNPJ>22603750000190<\/CNPJ>/.test(xc));
check('dest IE 9069585890', /<dest>[\s\S]*?<IE>9069585890<\/IE>/.test(xc));
check('CFOP 6152', xml.includes('<CFOP>6152</CFOP>'));
check('NFref 1 presente', xc.includes('<NFref><refNFe>' + REF1 + '</refNFe></NFref>'));
check('NFref 2 presente', xc.includes('<NFref><refNFe>' + REF2 + '</refNFe></NFref>'));
check('NFref DENTRO do </ide> (ordem XSD)', /<\/NFref><\/ide>/.test(xc) || /<\/NFref>\s*<\/ide>/.test(xc.trim()));
check('2 NFrefs no total', (xc.match(/<NFref>/g) || []).length === 2);
check('tPag 90 (sem pagamento)', xml.includes('<tPag>90</tPag>'));
check('vPag 0.00', /<detPag>\s*<tPag>90<\/tPag>\s*<vPag>0\.00<\/vPag>\s*<\/detPag>/.test(xml));
check('SEM <cobr> (transferência nao tem fatura/duplicatas)', !xml.includes('<cobr>'));
check('indPres 0 (modelo)', xml.includes('<indPres>0</indPres>'));
check('indIntermed 0 (modelo)', xml.includes('<indIntermed>0</indIntermed>'));
check('modFrete 9 sem transporta', /<transp>\s*<modFrete>9<\/modFrete>\s*<\/transp>/.test(xml));
check('ICMS00 12% vICMS 2507.39', /<ICMS00><orig>0<\/orig><CST>00<\/CST><modBC>3<\/modBC><vBC>20894\.94<\/vBC><pICMS>12\.00<\/pICMS><vICMS>2507\.39<\/vICMS><\/ICMS00>/.test(xc));
check('IPI CST 50 3,25% = 679.09', /<IPITrib><CST>50<\/CST><vBC>20894\.94<\/vBC><pIPI>3\.2500<\/pIPI><vIPI>679\.09<\/vIPI><\/IPITrib>/.test(xc));
check('PIS 303.39 / COFINS 1397.45', xml.includes('<vPIS>303.39</vPIS>') && xml.includes('<vCOFINS>1397.45</vCOFINS>'));
check('vNF = vProd + IPI = 21574.03', xml.includes('<vNF>21574.03</vNF>'));
var chaveC1 = (xc.match(/Id="NFe(\d{44})"/) || [])[1] || '';
check('chave com cUF 42 (SC)', chaveC1.slice(0, 2) === '42', chaveC1);
check('chave com CNPJ da filial (pos 7-20)', chaveC1.slice(6, 20) === '22603750000514');

console.log('\n=== CENARIO 2: RETORNO Curitiba->Floripa referencia a NF de ida ===');
var d2 = dadosTransferencia();
d2.company = {
  cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL COMERCIO ATACADISTA', inscr_est: '9069585890',
  street: 'AV JUSCELINO KUBITSCHEK DE OLIVEIRA', number: '7525', street2: 'CIDADE INDUSTRIAL',
  city: 'CURITIBA', state: 'PR', zip: '81350160', city_ibge_code: '4106902', state_ibge: '41', crt: '3', phone: '4133730076',
};
d2.partner = {
  cnpj_cpf: '22603750000514', xNome: 'AJL FERRO E ACO FILIAL FLORIANOPOLIS',
  legal_name: 'AJL FERRO E ACO FILIAL FLORIANOPOLIS', inscr_est: '264096223',
  street: 'AV PREF OSMAR CUNHA', number: '416', street2: 'CENTRO', city: 'FLORIANOPOLIS',
  state: 'SC', zip: '88015100', city_ibge_code: '4205407', ind_ie_dest: 1,
};
d2.order.number = '15'; d2.order.name = 'NFe 00000015';
d2.config.nfrefChaves = 'chave: ' + CHAVE_IDA; // texto livre (cola do financeiro)
var xml2 = gerarXmlNFe(d2);
var x2 = xml2.replace(/\n/g, '');
check('emit matriz PR 4106902', /<enderEmit>[\s\S]*?<cMun>4106902<\/cMun>[\s\S]*?<UF>PR<\/UF>/.test(x2));
check('dest filial SC', /<dest>[\s\S]*?<CNPJ>22603750000514<\/CNPJ>[\s\S]*?<IE>264096223<\/IE>/.test(x2));
check('NFref = chave da NF de IDA', x2.includes('<NFref><refNFe>' + CHAVE_IDA + '</refNFe></NFref>'));
check('1 NFref no total', (x2.match(/<NFref>/g) || []).length === 1);
check('CFOP 6152 (PR->SC interestadual)', xml2.includes('<CFOP>6152</CFOP>'));

console.log('\n=== CENARIO 3 (regressao): venda normal segue identica ===');
var d3 = {
  company: {
    cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA', name: 'AJL', inscr_est: '9069585890',
    street: 'Rua X', number: '1', street2: 'Bairro', city: 'CURITIBA', state: 'PR', zip: '81350160',
    city_ibge_code: '4106902', state_ibge: '41', crt: '3',
  },
  partner: {
    cnpj_cpf: '12345678000199', xNome: 'CLIENTE TESTE LTDA', inscr_est: '12345678',
    street: 'Rua Y', number: '2', street2: 'Centro', city: 'CURITIBA', state: 'PR', zip: '80000000',
    city_ibge_code: '4106902', ind_ie_dest: 1,
  },
  order: { name: 'NFe 00073368', number: '73368', date_order: '2026-11-04T12:00:00Z', amount_total: 100 },
  lines: [{
    cProd: 'P1', product_name: 'PRODUTO', ncm: '72104910', cfop: '5102', uom: 'UN',
    qty: 1, price_unit: 100, price_subtotal: 100,
    cst_icms: '00', mod_bc: '3', orig: '0', vbc_icms: '100.00', vicms: '12.00', picms: '12',
    cst_pis: '01', vbc_pis: '100.00', ppis: '1.65', vpis: '1.65',
    cst_cofins: '01', vbc_cofins: '100.00', pcofins: '7.60', vcofins: '7.60',
  }],
  pagamentos: [{ indPag: '0', tPag: '15', vPag: '100.00' }],
  duplicatas: [{ dVenc: '2026-12-04', vDup: '100.00' }],
  config: { serie: '100', tpAmb: '2', natOp: 'Venda de Mercadoria', mod: '55' },
};
var xml3 = gerarXmlNFe(d3);
var x3 = xml3.replace(/\n/g, '');
check('venda SEM NFref (campo vazio)', !x3.includes('<NFref>'));
check('venda indPres 9 + indIntermed 0 (cStat 434)', x3.includes('<indPres>9</indPres>') && x3.includes('<indIntermed>0</indIntermed>'));
check('venda COM cobr/duplicata', x3.includes('<cobr>') && x3.includes('<dVenc>2026-12-04</dVenc>'));
check('venda tPag 15 PIX', x3.includes('<tPag>15</tPag>'));
check('venda natOp padrao', x3.includes('<natOp>Venda de Mercadoria</natOp>'));

console.log('\n=== CENARIO 4: rota SIEG da transferencia (viaSiegTransferencia) ===');
check('enviarNFeSiegTransferencia exportada', typeof enviarNFeSiegTransferencia === 'function');
check('baixarXmlsSieg exportada', typeof baixarXmlsSieg === 'function');
var origKey = process.env.SIEG_API_KEY;
delete process.env.SIEG_API_KEY;
var d4 = dadosTransferencia();
d4.config.viaSiegTransferencia = true;
enviarNFe(d4).then(function (r) {
  check('rota: sem SIEG_API_KEY -> erro claro (chegou no caminho SIEG)',
    r && r.sucesso === false && String(r.erro || '').indexOf('SIEG_API_KEY') >= 0, String((r && r.erro) || '').slice(0, 120));
  process.env.SIEG_API_KEY = origKey;
  require('fs').writeFileSync('/tmp/nfe_transfer_teste.xml', xml);
  console.log('\nXML cenario 1 salvo em /tmp/nfe_transfer_teste.xml (validacao XSD via python)');
  process.exit(falhas ? 1 : 0);
}).catch(function (e) {
  check('rota enviarNFe (viaSiegTransferencia) sem excecao', false, e.message);
  process.env.SIEG_API_KEY = origKey;
  process.exit(falhas ? 1 : 0);
});
