// Teste DEVOLUÇÃO DE REMESSA DE TRANSFERÊNCIA (AJL 05/11/2026) — Ivaiporã -> Matriz
// CFOP 5902 (l10n_br.operation.type id 159 returnOfTransferShipmentAJL, l10n_br_cfop_code 5902).
// Modelo de negócio: Matriz transferiu p/ Ivaiporã (NF-e 73526, CFOP 5152, chave
// 41261122603750000190551000000735261123604358); a filial devolve UMA PARTE e a
// NF de devolução REFERENCIA a NF-e de transferência (<NFref><refNFe> no <ide>).
// Saída esperada (v1.2.22): natOp pelo nome do tipo, tPag 90 sem cobr, indPres 0,
// finNFe 1, infCpl só com a referência, CFOP 5902 (interno PR->PR).
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'AJL TI';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '4133730076';
process.env.NFE_IBSCBS = 'false';

var { gerarXmlNFe } = require('../services/sieg-nfe-xml');
var { ufDaChave, endpoint } = require('../services/sefaz-client');
var { cnpjEmitenteDoXml } = require('../services/nfe-signer');

var CHAVE_TRANSF = '41261122603750000190551000000735261123604358'; // NF-e 73526 (Matriz -> Ivaiporã)

// infCpl devolução — MESMA expressão do fluxo (sieg-odoo-emit.js isDevolucaoTransf)
function infCplDevolucao(refs) {
  var devRefs = (String(refs || '').match(/\d{44}/g) || []).map(function (ck) {
    var serieD = ck.substring(22, 25).replace(/^0+(?=\d)/, '');
    var nnumD = ck.substring(25, 34).replace(/^0+(?=\d)/, '');
    var aammD = ck.substring(2, 6);
    var mesAnoD = aammD.substring(2, 4) + '/20' + aammD.substring(0, 2);
    var grpD = (ck.match(/.{1,4}/g) || []).join(' ');
    return 'NFe Ref.: série: ' + serieD + ' número: ' + nnumD +
      ' emit: ' + (ck.substring(6, 20).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')) +
      ' em ' + mesAnoD + ' [' + grpD + ']';
  }).join(' | ');
  return 'Devolução de remessa de transferência' + (devRefs ? '. ' + devRefs : '');
}
var INFCPL = infCplDevolucao(CHAVE_TRANSF);

var dados = {
  company: { // emitente AJL - Ivaiporã
    cnpj_cpf: '22603750000271', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    name: 'AJL - Ivaiporã', inscr_est: '9093594069',
    street: 'Rua Max Arthur Greipel', number: 'S/N', street2: 'Parque Industrial Porfirio Basso',
    city: 'Ivaiporã', state: 'PR', zip: '86872010', city_ibge_code: '4111506',
    state_ibge: '41', crt: '3', phone: '4133730076',
  },
  partner: { // destinatário Matriz (mesmo CNPJ raiz)
    cnpj_cpf: '22603750000190', xNome: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    inscr_est: '9069585890', street: 'AV JUSCELINO KUBITSCHEK DE OLIVEIRA', number: '7525',
    street2: 'CIDADE INDUSTRIAL', city: 'CURITIBA', state: 'PR', zip: '81350160',
    city_ibge_code: '4106902', ind_ie_dest: 1,
  },
  order: {
    name: 'NFe 00073150', number: '73150',
    date_order: '2026-11-05T12:00:00Z', amount_total: 17449.46,
    note: '', sale_order_number: '',
  },
  lines: [{ // 1 de 2 bobinas devolvidas (a transferência foram 2x R$ 16.900,20)
    cProd: '1058', product_name: 'BOBINA 0,43 GL', ncm: '72104910',
    cfop: '5902', uom: 'UN', qty: 1, price_unit: 16900.20, price_subtotal: 16900.20,
    cst_icms: '00', mod_bc: '3', orig: '0', csosn: '',
    vbc_icms: '16900.20', vicms: '2028.02', picms: '12',
    cst_pis: '01', vbc_pis: '16900.20', ppis: '1.65', vpis: '278.85',
    cst_cofins: '01', vbc_cofins: '16900.20', pcofins: '7.60', vcofins: '1284.42',
    cst_ipi: '50', vbc_ipi: '16900.20', pipi: '3.25', vipi: '549.26', cenq: '999',
  }],
  pagamentos: [{ tPag: '90', vPag: '0.00' }], // devolução sem pagamento (fluxo isTransferencia)
  duplicatas: [],
  config: {
    serie: '100', tpAmb: '1',
    natOp: 'Devolução de remessa de transferência', // nome do tipo de operação (v1.2.22)
    mod: '55', indPres: '0', modFrete: '9',
    nfrefChaves: CHAVE_TRANSF,
  },
  order2: null,
};
dados.order.infCpl = INFCPL;

var falhas = 0;
function check(nome, cond, extra) {
  console.log((cond ? '  OK   ' : '  FALHA') + ' — ' + nome + (extra ? ' | ' + extra : ''));
  if (!cond) falhas++;
}

console.log('=== DEVOLUÇÃO Ivaiporã->Matriz (CFOP 5902, ref. NF-e 73526) ===');
var xml = gerarXmlNFe(dados);
var xc = xml.replace(/\n/g, '');
check('natOp = nome do tipo (com acentos)', xml.includes('<natOp>Devolução de remessa de transferência</natOp>'));
check('natOp NÃO é a fixa da transferência', !xml.includes('Transferencia de mercadoria adquirida'));
check('CFOP 5902', xml.includes('<CFOP>5902</CFOP>'));
check('NFref = chave da transferência 73526', xc.includes('<NFref><refNFe>' + CHAVE_TRANSF + '</refNFe></NFref>'));
check('NFref DENTRO do </ide> (ordem XSD)', /<\/NFref><\/ide>/.test(xc) || /<\/NFref>\s*<\/ide>/.test(xc.trim()));
check('1 NFref no total', (xc.match(/<NFref>/g) || []).length === 1);
check('tPag 90 (sem pagamento)', xml.includes('<tPag>90</tPag>'));
check('vPag 0.00', /<detPag>\s*<tPag>90<\/tPag>\s*<vPag>0\.00<\/vPag>\s*<\/detPag>/.test(xml));
check('SEM <cobr> (devolução sem duplicatas)', !xml.includes('<cobr>'));
check('indPres 0', xml.includes('<indPres>0</indPres>'));
check('finNFe 1 (normal; devolução fiscal é pelo CFOP)', xml.includes('<finNFe>1</finNFe>'));
check('emit Ivaiporã CNPJ ...00271', /<emit>[\s\S]*?<CNPJ>22603750000271<\/CNPJ>/.test(xc));
check('emit IE 9093594069', /<emit>[\s\S]*?<IE>9093594069<\/IE>/.test(xc));
check('emit cMun 4111506 (Ivaiporã PR)', /<enderEmit>[\s\S]*?<cMun>4111506<\/cMun>[\s\S]*?<UF>PR<\/UF>/.test(xc));
check('dest Matriz CNPJ ...00190', /<dest>[\s\S]*?<CNPJ>22603750000190<\/CNPJ>/.test(xc));
check('infCpl com a referência da 73526', xml.includes('NFe Ref.: série: 100 número: 73526 emit: 22.603.750/0001-90 em 11/2026'));
check('infCpl SEM template Rep:/LOCAL DE ENTREGA', !xml.includes('LOCAL DE ENTREGA') && !xml.includes('Rep: '));
check('ICMS00 12% vICMS 2028.02', /<ICMS00><orig>0<\/orig><CST>00<\/CST><modBC>3<\/modBC><vBC>16900\.20<\/vBC><pICMS>12\.00<\/pICMS><vICMS>2028\.02<\/vICMS><\/ICMS00>/.test(xc));
check('vNF = vProd + IPI = 17449.46', xml.includes('<vNF>17449.46</vNF>'));
var chaveD = (xc.match(/Id="NFe(\d{44})"/) || [])[1] || '';
check('chave com cUF 41 (PR)', chaveD.slice(0, 2) === '41', chaveD);
check('chave com CNPJ da Ivaiporã (pos 7-20)', chaveD.slice(6, 20) === '22603750000271');
check('chave serie 100 / nNF 73150', chaveD.slice(22, 25) === '100' && chaveD.slice(25, 34) === '000073150', chaveD.slice(22, 34));
check('ufDaChave(41) -> SEFAZ PR', ufDaChave(chaveD) === 'PR' && endpoint('autorizacao', 'PR').indexOf('sefa.pr.gov.br') > 0);
check('cnpjEmitenteDoXml deriva a Ivaiporã', cnpjEmitenteDoXml(xml) === '22603750000271');

console.log('\n=== REGRESSÃO: transferência normal 5152/6152 intocada ===');
var d2 = JSON.parse(JSON.stringify(dados));
d2.company.cnpj_cpf = '22603750000514'; // FLN SC (modelo autorizado)
d2.company.city_ibge_code = '4205407'; d2.company.state_ibge = '42';
d2.company.inscr_est = '264096223';
d2.partner.cnpj_cpf = '22603750000190'; d2.partner.city_ibge_code = '4106902';
d2.order.number = '14'; d2.order.name = 'NFe 00000014';
d2.lines[0].cfop = '6152';
d2.config.natOp = 'Transferencia de mercadoria adquirida/recebida de';
d2.config.nfrefChaves = CHAVE_TRANSF + ' 42260917469701010644550020002514961203108064';
var xml2 = gerarXmlNFe(d2);
var x2 = xml2.replace(/\n/g, '');
check('natOp fixa da transferência preservada', xml2.includes('<natOp>Transferencia de mercadoria adquirida/recebida de</natOp>'));
check('CFOP 6152', xml2.includes('<CFOP>6152</CFOP>'));
check('2 NFrefs aceitas na transferência normal', (x2.match(/<NFref>/g) || []).length === 2);

require('fs').writeFileSync('/tmp/nfe_devolucao_5902.xml', xml);
console.log('\nXML devolução salvo em /tmp/nfe_devolucao_5902.xml (validação XSD via python)');
process.exit(falhas ? 1 : 0);
