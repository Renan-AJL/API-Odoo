// Teste DEVOLUÇÃO DE MERCADORIA RECEBIDA EM TRANSFERÊNCIA (AJL 12/11/2026, v1.2.29)
// CFOP 5209 (l10n_br.operation.type "5.209 - DEVOLUÇÃO DE MERCADORIA RECEBIDA EM
// TRANSFERÊNCIA" id 174, l10n_br_cfop_code 5209) — demanda fatura PRV-FAT3365
// (duplicada da NFe 00073163, transferência Ivaiporã -> Matriz CFOP 5152 de 11/11).
// Regra SEFAZ N_328: CFOP de devolução (grupo x.2xx) EXIGE finNFe=4 — com finNFe=1
// a SEFAZ-PR rejeitou 4x com "328 - CFOP de devolução de mercadoria para NF-e que
// não é de devolução ou de retorno de mercadoria" (11/11/2026 15:36–17:12).
// Saída esperada (v1.2.29): CFOP 5209, finNFe 4, natOp do tipo SEM prefixo
// "5.209 - ", NFref da transferência original, tPag 90 sem cobr, indPres 0,
// ICMS40 CST 41 (PR→PR, regra contador v1.2.23), IPI/PIS/COFINS mantidos.
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'AJL TI';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '4133730076';
process.env.NFE_IBSCBS = 'false';

var fs = require('fs');
var { gerarXmlNFe } = require('../services/sieg-nfe-xml');

var CHAVE_TRANSF = '41261122603750000271551000000731631997994078'; // NFe 00073163 (transferência 5152 Ivaiporã->Matriz)

// infCpl devolução — MESMA expressão do fluxo (sieg-odoo-emit.js isDevolucaoTransf)
function infCplDevolucao(refs, texto) {
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
  return texto + (devRefs ? '. ' + devRefs : '');
}

var dados = {
  company: { // emitente AJL - Ivaiporã
    cnpj_cpf: '22603750000271', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    name: 'AJL - Ivaiporã', inscr_est: '9093594069',
    street: 'Rua Max Arthur Greipel', number: 'S/N', street2: 'Parque Industrial Porfirio Basso',
    city: 'Ivaiporã', state: 'PR', zip: '86872010', city_ibge_code: '4111506',
    state_ibge: '41', crt: '3', phone: '4133730076',
  },
  partner: { // destinatário Matriz
    cnpj_cpf: '22603750000190', xNome: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    inscr_est: '9069585890', street: 'AV JUSCELINO KUBITSCHEK DE OLIVEIRA', number: '7525',
    street2: 'CIDADE INDUSTRIAL', city: 'CURITIBA', state: 'PR', zip: '81350160',
    city_ibge_code: '4106902', ind_ie_dest: 1,
  },
  order: {
    name: 'NFe 00073164', number: '73164',
    date_order: '2026-11-11T20:00:00Z', amount_total: 30216,
    note: '', sale_order_number: '',
  },
  lines: [{ // Bobina 0,43 GL (produto 1058) — mesma da transferência original
    cProd: '1058', product_name: 'BOBINA 0,43 GL', ncm: '72104910',
    cfop: '5209', uom: 'UN', qty: 6295, price_unit: 4.8, price_subtotal: 30216,
    cst_icms: '41', mod_bc: '3', orig: '0', csosn: '',
    vbc_icms: '0.00', vicms: '0.00', picms: '0.00',
    cst_pis: '01', vbc_pis: '30216', ppis: '1.65', vpis: '498.56',
    cst_cofins: '01', vbc_cofins: '30216', pcofins: '7.60', vcofins: '2296.42',
    cst_ipi: '50', vbc_ipi: '30216', pipi: '3.25', vipi: '982.02', cenq: '999',
  }],
  pagamentos: [{ tPag: '90', vPag: '0.00' }], // devolução sem pagamento (isTransferencia)
  duplicatas: [],
  config: {
    serie: '100', tpAmb: '1',
    natOp: 'DEVOLUÇÃO DE MERCADORIA RECEBIDA EM TRANSFERÊNCIA', // nome do tipo SEM prefixo (v1.2.29)
    mod: '55', indPres: '0', indIntermed: '0', modFrete: '9',
    finNFe: '4', // v1.2.29 — regra SEFAZ 328 (CFOP x.2xx exige devolução)
    nfrefChaves: CHAVE_TRANSF,
  },
  order2: null,
};
dados.order.infCpl = infCplDevolucao(CHAVE_TRANSF, 'Devolução de mercadoria recebida em transferência');

var falhas = 0;
function check(nome, cond, extra) {
  console.log((cond ? '  OK   ' : '  FALHA') + ' — ' + nome + (extra ? ' | ' + extra : ''));
  if (!cond) falhas++;
}

// ============ 0) FONTES: a lógica do fluxo contém as regras novas ============
console.log('=== FONTE sieg-odoo-emit.js (v1.2.29) ===');
var fonte = fs.readFileSync(require('path').join(__dirname, '../services/sieg-odoo-emit.js'), 'utf8');
check('isDevolucaoTransf inclui 5209', /isDevolucaoTransf = opTypeCfop === '5902' \|\| opTypeCfop === '6902' \|\|\s*\n\s*opTypeCfop === '5209' \|\| opTypeCfop === '6209'/.test(fonte));
check('finNFe=4 no grupo x.2xx (5201-5210/6201-6210)', /\/\^\[56\]\(20\|21\)\\d\$\/\.test\(opTypeCfop\)/.test(fonte));
check('natOp devolução usa nome SEM prefixo numérico', /opTypeNameNatOp/.test(fonte) && /replace\(\^\\d\\\.\d\{3\}/.test(fonte.replace(/\\'/g, "'")) || fonte.includes("replace(/^\\d\\.\\d{3}"));
check('infCpl 5209 = devolução de mercadoria recebida em transferência', fonte.includes("'Devolução de mercadoria recebida em transferência'"));
check('5902/6902 mantém finNFe=1 (fora do grupo x.2xx)', !/finNFe = '4'[\s\S]{0,120}6902/.test(fonte));

// ============ 1) XML 5209 ============
console.log('\n=== DEVOLUÇÃO 5209 Ivaiporã->Matriz (ref. NFe 00073163) ===');
var xml = gerarXmlNFe(dados);
var xc = xml.replace(/\n/g, '');
check('natOp = nome do tipo SEM prefixo "5.209 - "', xml.includes('<natOp>DEVOLUÇÃO DE MERCADORIA RECEBIDA EM TRANSFERÊNCIA</natOp>') && !xml.includes('<natOp>5.209'));
check('CFOP 5209', xml.includes('<CFOP>5209</CFOP>'));
check('finNFe 4 (devolução de mercadoria — regra 328)', xc.includes('<finNFe>4</finNFe>') && !xc.includes('<finNFe>1</finNFe>'));
check('NFref = chave da transferência 73163', xc.includes('<NFref><refNFe>' + CHAVE_TRANSF + '</refNFe></NFref>'));
check('NFref DENTRO do </ide> (ordem XSD)', /<\/NFref><\/ide>/.test(xc) || /<\/NFref>\s*<\/ide>/.test(xc.trim()));
check('tPag 90 (sem pagamento)', xml.includes('<tPag>90</tPag>'));
check('SEM <cobr> (devolução sem duplicatas)', !xml.includes('<cobr>'));
check('indPres 0 + indIntermed 0', xc.includes('<indPres>0</indPres>') && xc.includes('<indIntermed>0</indIntermed>'));
check('ICMS40 CST 41 (PR→PR sem ICMS, regra contador)', xc.includes('<ICMS40><orig>0</orig><CST>41</CST></ICMS40>'));
check('ICMSTot vBC 0.00 e vICMS 0.00', xc.includes('<vBC>0.00</vBC>') && xc.includes('<vICMS>0.00</vICMS>'));
check('IPI mantido (CST 50 suspensão 3,25%)', /<IPITrib><CST>50<\/CST><vBC>30216\.00<\/vBC><pIPI>3\.2500<\/pIPI><vIPI>982\.02<\/vIPI><\/IPITrib>/.test(xc));
check('PIS/COFINS mantidos (01)', xc.includes('<vPIS>498.56</vPIS>') && xc.includes('<vCOFINS>2296.42</vCOFINS>'));
check('infCpl com o texto de devolução + referência', xml.includes('Devolução de mercadoria recebida em transferência. NFe Ref.: série: 100 número: 73163'));
check('infCpl SEM template Rep:/LOCAL DE ENTREGA', !xml.includes('LOCAL DE ENTREGA') && !xml.includes('Rep: '));
check('emit Ivaiporã CNPJ ...00271', /<emit>[\s\S]*?<CNPJ>22603750000271<\/CNPJ>/.test(xc));
check('dest Matriz CNPJ ...00190', /<dest>[\s\S]*?<CNPJ>22603750000190<\/CNPJ>/.test(xc));
var chaveD = (xc.match(/Id="NFe(\d{44})"/) || [])[1] || '';
check('chave com cUF 41 / CNPJ Ivaiporã / serie 100 nNF 73164',
  chaveD.slice(0, 2) === '41' && chaveD.slice(6, 20) === '22603750000271' &&
  chaveD.slice(22, 25) === '100' && chaveD.slice(25, 34) === '000073164', chaveD);

// ============ 2) REGRESSÃO 5902: finNFe continua 1 ============
console.log('\n=== REGRESSÃO: devolução 5902 (v1.2.22) intocada ===');
var d2 = JSON.parse(JSON.stringify(dados));
d2.lines[0].cfop = '5902';
d2.config.finNFe = undefined;      // fluxo 5902 NÃO seta finNFe
d2.config.natOp = 'Devolução de remessa de transferência';
d2.order.infCpl = infCplDevolucao(CHAVE_TRANSF, 'Devolução de remessa de transferência');
var xml2 = gerarXmlNFe(d2);
var x2 = xml2.replace(/\n/g, '');
check('5902 sai com finNFe 1 (padrão, já autorizado na SEFAZ)', x2.includes('<finNFe>1</finNFe>'));
check('5902 sai com CFOP 5902', xml2.includes('<CFOP>5902</CFOP>'));
check('5902 natOp preservada', xml2.includes('<natOp>Devolução de remessa de transferência</natOp>'));

// ============ 3) REGRESSÃO: transferência normal 5152 ============
console.log('\n=== REGRESSÃO: transferência normal 5152 intocada ===');
var d3 = JSON.parse(JSON.stringify(dados));
d3.lines[0].cfop = '5152';
d3.lines[0].cst_icms = '41'; d3.lines[0].vbc_icms = '0.00'; d3.lines[0].vicms = '0.00'; d3.lines[0].picms = '0.00';
d3.config.finNFe = undefined;
d3.config.natOp = 'Transferencia de mercadoria adquirida/recebida de';
d3.config.nfrefChaves = '';
d3.order.infCpl = '';
var xml3 = gerarXmlNFe(d3);
var x3 = xml3.replace(/\n/g, '');
check('5152 sai com finNFe 1', x3.includes('<finNFe>1</finNFe>'));
check('5152 sai com CFOP 5152', xml3.includes('<CFOP>5152</CFOP>'));

// ============ 4) GATE finNFe=4 por CFOP (tabela do fluxo) ============
console.log('\n=== GATE finNFe=4 (regex /^[56](20|21)\\d$/) ===');
var re = /^[56](20|21)\d$/;
['5209', '6209', '5202', '6202', '5210'].forEach(function (c) { check('CFOP ' + c + ' -> finNFe=4', re.test(c)); });
['5152', '6152', '5902', '6902', '5905', '5910', '5101'].forEach(function (c) { check('CFOP ' + c + ' -> NÃO entra (finNFe 1)', !re.test(c)); });

fs.writeFileSync('/tmp/nfe_devolucao_5209.xml', xml);
console.log('\nXML 5209 salvo em /tmp/nfe_devolucao_5209.xml (validação XSD via python)');
process.exit(falhas ? 1 : 0);
