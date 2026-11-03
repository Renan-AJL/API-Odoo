/**
 * Teste 04/11/2026 — CFOP 6905 REMESSA DESTINADA A ARMAZENAGEM
 *
 * Modelo autorizado (anexo do cliente): NFe 41260922603750000190550010000719281022473776
 * cStat 100 SEFAZ-PR — natOp 'Remessa Destinado a Armazenagem', CFOP 6905 (PR->SC),
 * ICMS00 12%, IPI IPINT CST 51 (cEnq 999), PIS/COFINS 01 (1,65/7,60), IBSCBS
 * 000/000001, idDest 2, indFinal 0, indPres 3 + indIntermed 0, tPag 90/vPag 0.00
 * SEM cobr/dup/boletos, modFrete 3 + transporta (proprio emitente).
 *
 * Tipo de Operacao Odoo: id 157 'Remessa Destinado a Armazenagem'
 * (tech generalStorageShippingOutboundAJL, l10n_br_cfop_code 5905 — o middleware
 * troca 5905->6905 quando interestadual, mesmo ramo generico do 5910/6910).
 */
const { gerarXmlNFe } = require('../services/sieg-nfe-xml');
const { detectarArmazenagem } = require('../services/sieg-odoo-emit');

const company = {
  cnpj_cpf: '22603750000190',
  legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E F',
  street: 'Av. Juscelino Kubitschek de Oliveira', number: '7525', street2: 'CIC',
  city: 'Curitiba', city_ibge_code: '4106902', state: 'PR', zip: '81020490',
  phone: '4133730076', inscr_est: '9069585890', crt: '3', state_ibge: '41',
};
const partner = {
  cnpj_cpf: '39815253000582',
  xNome: 'COFERVIL IND COM FERROS VITORIA LTDA',
  legal_name: 'COFERVIL IND COM FERROS VITORIA LTDA',
  street: 'ROD OLIVIO NOBREGA', number: '0', street2: 'ROCIO PEQUENO',
  city: 'SAO FRANCISCO DO SUL', city_ibge_code: '4216206', state: 'SC', zip: '89240000',
  phone: '4734440000', inscr_est: '258905867', email: 'cofervil@teste.com.br',
};
const linha = {
  default_code: '2467',
  product_name: 'Bobina Laminada a Quente Nao ligado 0203052210 Leilao JUL20262301',
  barcode: 'SEM GTIN', ncm: '72104910', cfop: '6905', uom: 'TO',
  qty: 3.6, price_unit: 3068.1806, price_subtotal: 11045.45, orig: '0',
  cst_icms: '00', mod_bc: '3', vbc_icms: '11045.45', picms: '12', vicms: '1325.45',
  cst_ipi: '51',
  cst_pis: '01', vbc_pis: '11045.45', ppis: '1.65', vpis: '182.25',
  cst_cofins: '01', vbc_cofins: '11045.45', pcofins: '7.60', vcofins: '839.45',
};
// emitData como o processOne monta com o ramo ARMAZENAGEM ativo:
// natOp = nome do Tipo de Operacao (id 157), indPres 3, tPag 90/vPag 0.00, duplicatas []
const armazenagem = {
  company, partner,
  order: {
    name: 'NFe 00071928', number: '71928',
    date_order: '2026-11-04T12:00:00-03:00', amount_total: 11045.45,
    peso_liquido: 3.6,
  },
  lines: [linha],
  pagamentos: [{ tPag: '90', vPag: '0.00' }],
  duplicatas: [],
  config: {
    natOp: 'Remessa Destinado a Armazenagem',
    indPres: '3',
    serie: '100',
    modFrete: '3',
    transporta: {
      cnpj: '22603750000190',
      xNome: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
      ie: '9069585890',
      xEnder: 'AV JUSCELINO KUBITSCHEK DE OLIVEIRA, 7525 - CIDADE INDUSTRIAL',
      xMun: 'CURITIBA', UF: 'PR',
    },
    qVol: 0,
  },
};

let falhas = 0;
function check(label, cond, detalhe) {
  if (cond) console.log('  PASS  ' + label);
  else { falhas++; console.error('  FAIL  ' + label + (detalhe ? ' -> ' + detalhe : '')); }
}

console.log('=== detectarArmazenagem (rede tripla: tech / cfop / nome) ===');
check('tech do tipo AJL (id 157)', detectarArmazenagem({ tech: 'generalStorageShippingOutboundAJL', cfop: '5905', nome: 'Remessa Destinado a Armazenagem' }) === true);
check('tech nativo do modulo (id 25)', detectarArmazenagem({ tech: 'generalStorageShippingOutbound', cfop: '', nome: 'Shipment to general warehouse' }) === true);
check('so pelo CFOP 5905 do cadastro', detectarArmazenagem({ tech: 'qualquer', cfop: '5905', nome: 'x' }) === true);
check('so pelo nome armazenagem', detectarArmazenagem({ tech: '', cfop: '', nome: 'Remessa p/ Armazenagem externa' }) === true);
check('venda normal NAO pega', detectarArmazenagem({ tech: 'standardSales', cfop: '', nome: 'Sale of goods' }) === false);
check('bonificacao 5910 NAO pega', detectarArmazenagem({ tech: 'giftThroughOtherEstablishment', cfop: '5910', nome: 'Remessa em bonificação, doação ou brinde' }) === false);
check('transferencia 5152 NAO pega', detectarArmazenagem({ tech: 'itemTransferShippingOutbound', cfop: '5152', nome: 'Transfer of goods' }) === false);
check('vazio/sem tipo NAO pega', detectarArmazenagem({}) === false && detectarArmazenagem(null) === false);

console.log('=== XML ARMAZENAGEM — paridade com modelo cStat 100 ===');
const xml = gerarXmlNFe(armazenagem);
const compact = xml.replace(/\s+/g, ' ');
check('natOp EXATA do modelo', xml.includes('<natOp>Remessa Destinado a Armazenagem</natOp>'));
check('CFOP 6905', xml.includes('<CFOP>6905</CFOP>'));
check('ICMS00: vBC 11045.45 / pICMS 12 / vICMS 1325.45',
  /<ICMS00><orig>0<\/orig><CST>00<\/CST><modBC>3<\/modBC><vBC>11045\.45<\/vBC><pICMS>12(\.0+)?<\/pICMS><vICMS>1325\.45<\/vICMS><\/ICMS00>/.test(compact));
check('IPI IPINT CST 51 com cEnq 999', /<IPI><cEnq>999<\/cEnq><IPINT><CST>51<\/CST><\/IPINT><\/IPI>/.test(compact));
check('PIS 01 1,65% vPIS 182.25', /<PISAliq><CST>01<\/CST><vBC>11045\.45<\/vBC><pPIS>1\.65(\.0+)?<\/pPIS><vPIS>182\.25<\/vPIS><\/PISAliq>/.test(compact));
check('COFINS 01 7,60% vCOFINS 839.45', /<COFINSAliq><CST>01<\/CST><vBC>11045\.45<\/vBC><pCOFINS>7\.60(\.0+)?<\/pCOFINS><vCOFINS>839\.45<\/vCOFINS><\/COFINSAliq>/.test(compact));
check('IBSCBS 000/000001 presente (modelo tem)', xml.includes('<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib>') || /<IBSCBS>\s*<CST>000<\/CST>\s*<cClassTrib>000001<\/cClassTrib>/.test(xml));
check('idDest 2 (PR->SC)', xml.includes('<idDest>2</idDest>'));
check('indFinal 0', xml.includes('<indFinal>0</indFinal>'));
check('indPres 3 (modelo)', xml.includes('<indPres>3</indPres>'));
check('indIntermed 0 (obrigatorio p/ indPres 3)', xml.includes('<indIntermed>0</indIntermed>'));
check('tpNF 1 / finNFe 1', xml.includes('<tpNF>1</tpNF>') && xml.includes('<finNFe>1</finNFe>'));
check('cMunFG 4106902 (Curitiba)', xml.includes('<cMunFG>4106902</cMunFG>'));
check('pag: tPag 90 / vPag 0.00', /<detPag>\s*<tPag>90<\/tPag>\s*<vPag>0\.00<\/vPag>\s*<\/detPag>/.test(compact));
check('SEM bloco cobr (remessa nao tem duplicatas)', !xml.includes('<cobr>'));
check('SEM texto "Pagamento a vista" no infCpl', !xml.includes('Pagamento a vista'));
check('vNF = 11045.45 (IPI 51 nao soma)', /<vNF>11045\.45<\/vNF>/.test(xml));
check('modFrete 3 (modelo)', xml.includes('<modFrete>3</modFrete>'));
check('transporta = AJL (proprio emitente)', /<transporta>\s*<CNPJ>22603750000190<\/CNPJ>/.test(compact));
check('dest COFERVIL SC IE 258905867', compact.includes('<CNPJ>39815253000582</CNPJ>') && xml.includes('<IE>258905867</IE>'));
check('emit matriz Curitiba', compact.includes('<CNPJ>22603750000190</CNPJ>') && xml.includes('<cMun>4106902</cMun>'));

console.log('=== regressao: VENDA NORMAL sem o ramo armazenagem ===');
const venda = {
  company, partner,
  order: { name: 'NFe 00071929', number: '71929', date_order: '2026-11-04T12:00:00-03:00', amount_total: 11045.45 },
  lines: [linha],
  pagamentos: [{ indPag: '0', tPag: '01', vPag: '11045.45' }],
  duplicatas: [{ dVenc: '2026-12-04', vDup: 11045.45 }],
  config: { natOp: 'Venda de Mercadoria', serie: '100' },
};
const xmlVenda = gerarXmlNFe(venda);
check('venda: indPres default 9', xmlVenda.includes('<indPres>9</indPres>'));
check('venda: "Pagamento a vista" presente (comportamento atual mantido)', xmlVenda.includes('Pagamento a vista'));
check('venda: cobr COM duplicata', xmlVenda.includes('<cobr>') && xmlVenda.includes('<vDup>11045.45</vDup>'));
check('venda: detPag tPag 01', /<tPag>01<\/tPag>/.test(xmlVenda.replace(/\s+/g, ' ')));
check('venda: CFOP 6905 da linha mantido (interesse definido por fatura)', xmlVenda.includes('<CFOP>6905</CFOP>'));

console.log('\nXML salvo em /tmp/nfe_6905_teste.xml (inspecao/XSD)');
require('fs').writeFileSync('/tmp/nfe_6905_teste.xml', xml);

if (falhas) { console.error('\n*** ' + falhas + ' FALHA(S) ***'); process.exit(1); }
console.log('\n*** TODOS OS CHECKS OK — CFOP 6905 igual ao modelo, venda normal intacta ***');
