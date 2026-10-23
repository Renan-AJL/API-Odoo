/**
 * test-nfe-texto.js — PADRÃO de saneamento TString da NF-e (services/nfe-texto.js)
 * Motivação: rejeição 225 (cvc-pattern-valid) na NFe 00073133 (EMBRASOLDAS) —
 * infCpl com zero-width space (U+200B do WhatsApp) e quebras de linha do
 * endereço 'ENTREGAR NA LOJA DE CONTENDA / RUA PARA, 132 / CONTENDA'.
 * Execução: node scripts/test-nfe-texto.js
 */
var path = require('path');
var assert = require('assert');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
var saneia = require(path.join(ROOT, 'services/nfe-texto.js')).saneiaTextoNFe;
var xmlSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-nfe-xml.js'), 'utf8');
var emitSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-odoo-emit.js'), 'utf8');
var gerarXmlNFe = require(path.join(ROOT, 'services/sieg-nfe-xml.js')).gerarXmlNFe;

var PASS = 0;
function ok(nome, cond, extra) {
  if (!cond) { console.error('  [FALHA] ' + nome + (extra ? ' — ' + extra : '')); process.exitCode = 1; return; }
  PASS++;
  console.log('  [OK] ' + nome + (extra ? ' — ' + extra : ''));
}

// Valida o pattern TString da SEFAZ: [!-\u00FF]{1}[ -\u00FF]{0,}[!-\u00FF]{1} | [!-\u00FF]{1}
function validaTString(s) {
  if (!s) return true;
  if (s.length !== s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').length) return false; // controles
  if (/[\u200B-\u200D\u2060\uFEFF\u00AD]/.test(s)) return false;                                     // invisíveis
  if (/[^\u0020-\u00FF]/.test(s)) return false;                                                      // fora do Latin-1
  if (/^ /.test(s) || / $/.test(s)) return false;                                                    // pontas com espaço
  return true;
}

console.log('== A. Caso REAL da NFe 00073133 (infCpl rejeitada) ==');
// texto montado pelo gerador: boletos + Pedido + obs da fatura (com zero-width e \n)
var obsFatura = '\u200BENTREGAR NA LOJA DE CONTENDA\n\nRUA PARA, 132\n\nCONTENDA';
var infCplIncidente =
  'Boleto 1/3: R$ 1070.05 Venc: 22/11/2026 | Boleto 2/3: R$ 1070.05 Venc: 22/12/2026' +
  ' | Boleto 3/3: R$ 1070.06 Venc: 21/01/2027. Pedido: S02302. ICMS 18%. ' + obsFatura;
var limpo = saneia(infCplIncidente);
ok('sem zero-width (U+200B removido)', limpo.indexOf('\u200B') === -1);
ok('sem quebra de linha', limpo.indexOf('\n') === -1);
ok('pontas sem espaço', !/^ | $/.test(limpo), JSON.stringify(limpo.slice(0, 60)) + '...' + JSON.stringify(limpo.slice(-40)));
ok('endereço preservado em 1 linha', limpo.indexOf('ENTREGAR NA LOJA DE CONTENDA RUA PARA, 132 CONTENDA') !== -1);
ok('boletos preservados', limpo.indexOf('Boleto 1/3: R$ 1070.05 Venc: 22/11/2026') === 0);
ok('valida TString SEFAZ', validaTString(limpo));
ok('conteúdo ≤ 2000', limpo.length <= 2000);

console.log('== B. Zero-width e invisíveis (todas as variantes) ==');
ok('U+200B removido', saneia('A\u200BB') === 'AB');
ok('U+200C/U+200D removidos', saneia('A\u200C\u200DB') === 'AB');
ok('BOM U+FEFF removido', saneia('\uFEFFBoleto 1/3') === 'Boleto 1/3');
ok('soft hyphen U+00AD removido', saneia('Entre\u00ADgar') === 'Entregar');
ok('U+2060 word-joiner removido', saneia('A\u2060B') === 'AB');

console.log('== C. Chars fora do Latin-1 (WhatsApp/Excel) ==');
ok('aspas tipográficas -> ASCII', saneia('" Casa " e \' la \'') === '" Casa " e \' la \'', saneia('" Casa " e \' la \''));
ok('travessão -> hífen', saneia('Rua Para \u2014 lado par') === 'Rua Para - lado par');
ok('reticências -> ...', saneia('pagando\u2026') === 'pagando...');
ok('bullet -> hífen', saneia('\u2022 item') === '- item');
ok('€ -> R$', saneia('total \u20AC') === 'total R$');
ok('emoji descartado', saneia('ok \uD83D\uDE00!') === 'ok !');
ok('acentos Latin-1 PRESERVADOS', saneia('Tração, Peças, Aço É Contração Õ') === 'Tração, Peças, Aço É Contração Õ');
ok('char exótico decompõe (Ć->C)', saneia('Bu\u0107ano') === 'Bucano');
ok('valida TString em todos', validaTString(saneia('" x "\u2014y\u2026')) && validaTString(saneia('\u2022Tração\u2014\u200B')));

console.log('== D. Controles/quebras/limites ==');
ok('\\n e \\t viram espaço', saneia('L1\nL2\tL3') === 'L1 L2 L3');
ok('espaços colapsados', saneia('A   B\u00A0\u00A0C') === 'A B C');
ok('teto 120 sem ponta suja', (function () {
  var out = saneia(Array(30).fill('PALAVRA').join(' '), 120);
  return out.length <= 120 && !/[\s,;:\-]$/.test(out);
})());
ok('teto 2000 sem ponta suja', (function () {
  var out = saneia(infCplIncidente + ' '.repeat(3000), 2000);
  return out.length <= 2000 && !/[\s,;:\-]$/.test(out);
})());
ok('vazio/nil -> vazio', saneia('') === '' && saneia(null) === '' && saneia(undefined) === '');

console.log('== E. xProd da linha real da 00073133 (WhatsApp no meio da obs) ==');
var mFn = emitSrc.match(/function buildXProdCompleto[\s\S]*?\n\}/);
assert(mFn, 'helper buildXProdCompleto encontrado na fonte');
var buildXProdCompleto = eval('(' + mFn[0] + ')');
var x1737 = buildXProdCompleto('1737 - Frisada U Ch 28 (0,43) POR METRO (Padrão - MT)',
  '[1737] 1737 - Frisada U Ch 28 (0,43) POR METRO (Padrão - MT)\n10 PEÇAS COM 1500\n\n\u200BENTREGAR NA LOJA DE CONTENDA\n\nRUA PARA, 132\n\nCONTENDA');
ok('xProd ≤ 120', x1737.length <= 120, String(x1737.length));
ok('xProd sem zero-width', x1737.indexOf('\u200B') === -1);
ok('xProd valida TString', validaTString(x1737), JSON.stringify(x1737));
ok('obs da linha presente', x1737.indexOf('10 PEÇAS COM 1500') !== -1);

console.log('== F. Padrão aplicado nos pontos certos (fonte) ==');
ok('esc() usa saneiaTextoNFe (ponto único)', xmlSrc.indexOf('return saneiaTextoNFe(String(s))') >= 0);
ok('xml requer nfe-texto.js', xmlSrc.indexOf("require('./nfe-texto')") >= 0);
ok('infCpl usa o padrão com teto 2000', xmlSrc.indexOf('saneiaTextoNFe(infCplText, 2000)') >= 0);
ok('esc deixa de ser só escape manual', xmlSrc.indexOf(".replace(/&/g, '&amp;')\n    .replace(/</g, '&lt;')") >= 0);

console.log('== G. XML REAL com a infCpl do incidente ==');
var company = {
  legal_name: 'AJL FERRO E ACO LTDA', name: 'AJL Ferro e Aço', cnpj_cpf: '41356791000100',
  inscr_est: '90553392', street: 'Rodovia do Xisto, 1000', number: '1000', street2: 'Fazenda Velha',
  city: 'Araucária', city_ibge_code: '4101804', state: 'PR', zip: '83703320', phone: '4130000000', crt: '1',
  state_ibge: '41',
};
var partner = {
  legal_name: 'EMBRASOLDAS LTDA', xNome: 'EMBRASOLDAS LTDA', cnpj_cpf: '13430636000115',
  street: 'Rua Antonio Candido Nascimento 102', number: '102', street2: 'Fazenda Velha',
  city: 'Araucária', city_ibge_code: '4101804', state: 'PR', zip: '83703320', indFinal: '0', indIEDest: '1',
};
var order = {
  number: '00073133', name: 'NFe 00073133', date_order: '2026-10-23T14:00:00',
  amount_total: 3210.16, note: '', obs_nfe: obsFatura, sale_order_number: 'S02302',
  forma_pagamento_label: 'BOLETO 30/60/90', forma_pagamento: 'BOLETO 30/60/90',
  boleto_detalhes: [
    { parcela: '1/3', valor: '1070.05', vencimento: '2026-11-22' },
    { parcela: '2/3', valor: '1070.05', vencimento: '2026-12-22' },
    { parcela: '3/3', valor: '1070.06', vencimento: '2027-01-21' },
  ],
  icms_aliquota: 18, duplicatas: [],
};
var lines = [{
  product_name: '[1737] 1737 - Frisada U Ch 28 (0,43) POR METRO (Padrão - MT)',
  xProd: buildXProdCompleto('1737 - Frisada U Ch 28 (0,43) POR METRO (Padrão - MT)',
    '[1737] 1737 - Frisada U Ch 28 (0,43) POR METRO (Padrão - MT)\n10 PEÇAS COM 1500\n\n\u200BENTREGAR NA LOJA DE CONTENDA\n\nRUA PARA, 132\n\nCONTENDA'),
  ncm: '73089090', cfop: '5102', uom: 'BR', qty: 15, price_unit: 37.0, price_subtotal: 555.0,
  cst_icms: '00', mod_bc: '3', orig: '0', vbc_icms: '555.00', vicms: '99.90', picms: '18',
  cst_pis: '01', vbc_pis: '555.00', ppis: '1.65', vpis: '9.16', cst_cofins: '01',
  vbc_cofins: '555.00', pcofins: '7.6', vcofins: '42.18', peso_unitario: 0,
}];
var xml = gerarXmlNFe({
  company: company, partner: partner, order: order, lines: lines,
  pagamentos: [{ indPag: '1', tPag: '15', vPag: '3210.16' }],
  duplicatas: [
    { dVenc: '2026-11-22', vDup: '1070.05' },
    { dVenc: '2026-12-22', vDup: '1070.05' },
    { dVenc: '2027-01-21', vDup: '1070.06' },
  ],
  config: { serie: '100', tpAmb: '2', natOp: 'Venda de Mercadoria', mod: '55' },
  tipo: 'nfe',
});
ok('XML gerado', xml && String(xml).indexOf('<infNFe') > 0);
if (xml) {
  var s = String(xml);
  var mInf = s.match(/<infCpl>([\s\S]*?)<\/infCpl>/);
  assert(mInf, 'infCpl presente no XML');
  var infCplXml = mInf[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  ok('infCpl do XML valida TString (pós-unescape)', validaTString(infCplXml), JSON.stringify(infCplXml.slice(0, 80)));
  ok('infCpl tem os 3 boletos com venc BR', infCplXml.indexOf('Boleto 3/3: R$ 1070.06 Venc: 21/01/2027') !== -1);
  ok('infCpl tem endereço limpo (sem zero-width/quebra)', infCplXml.indexOf('ENTREGAR NA LOJA DE CONTENDA RUA PARA, 132 CONTENDA') !== -1);
  ok('infCpl NÃO contém U+200B', infCplXml.indexOf('\u200B') === -1);
  var mXProd = s.match(/<xProd>([\s\S]*?)<\/xProd>/);
  var xProdXml = mXProd[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  ok('xProd valida TString', validaTString(xProdXml), JSON.stringify(xProdXml));
  ok('xNome do destinatário valida TString', validaTString(s.match(/<dest>[\s\S]*?<xNome>([\s\S]*?)<\/xNome>/)[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'")));
}

console.log('');
console.log('PASS: ' + PASS + ' checks');
if (process.exitCode) console.log('*** HOUVE FALHAS ***'); else console.log('*** TODOS OK ***');
