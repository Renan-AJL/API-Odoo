/**
 * test-transf-ipi-piscofins.js — Transferência FLN->Matriz com IPI/PIS/COFINS (17/11/2026)
 *  A) Fonte: buildLineData recebe ctx e aplica IPI CST 50 na transferência
 *  B) Fonte: BC do PIS/COFINS = vBC - vICMS nas transferências 6152 (modelo NF 14)
 *  C) DANFE: VALOR DO PIS / VALOR DA COFINS visíveis no bloco CALCULO DO IMPOSTO
 *  D) Matemática NF 00000017: vProd 51148 | ICMS 12% 6137.76 | IPI 3.25% 1662.31
 *     | BC PIS/COFINS 45010.24 -> PIS 742.67 / COFINS 3420.78 | vNF 52810.31
 *     (batendo com o DANFE modelo NF 253634 e o XML modelo NF 14)
 *  E) XML: paridade total com o modelo (IPITrib CST 50, PIS/COFINS CST 01 BC 45010.24)
 * Execução: node scripts/test-transf-ipi-piscofins.js
 */
var path = require('path');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
var emitSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-odoo-emit.js'), 'utf8');
var danfeSrc = fs.readFileSync(path.join(ROOT, 'services/danfe-pdf.js'), 'utf8');
var gerarXmlNFe = require(path.join(ROOT, 'services/sieg-nfe-xml.js')).gerarXmlNFe;

var PASS = 0, FAIL = 0;
function ok(nome, cond, extra) {
  if (!cond) { console.error('  [FALHA] ' + nome + (extra ? ' — ' + extra : '')); FAIL++; process.exitCode = 1; return; }
  PASS++;
  console.log('  [OK] ' + nome + (extra ? ' — ' + extra : ''));
}
var r2 = function (n) { return Math.round((parseFloat(n) || 0) * 100) / 100; };

console.log('== A. Fonte: IPI CST 50 na transferência (buildLineData com ctx) ==');
ok('call site passa ctx {isTransferencia, isInterstate}', emitSrc.indexOf('isTransferencia: isTransferencia, isInterstate: isInterstate') >= 0);
ok('buildLineData aceita ctx', emitSrc.indexOf('async function buildLineData(client, db, uid, pwd, line, icmsInternoPR, ctx)') >= 0);
ok('tax_ids com IPI -> CST 50 na transferência', emitSrc.indexOf("cstIpi = ctx.isTransferencia ? '50' : '00';") >= 0);
ok('fallback sem CST também respeita transferência', (emitSrc.match(/cstIpi = ctx\.isTransferencia \? '50' : '00';/g) || []).length >= 2);

console.log('== B. Fonte: BC PIS/COFINS exclui ICMS na 6152 ==');
ok('bloco 6d transferência interestadual presente', emitSrc.indexOf('6d. TRANSFERÊNCIA INTERESTADUAL') >= 0);
ok("gate CFOP 6152 + CST 00", emitSrc.indexOf("pCfopB === '6152' && String(pldB.cst_icms) === '00'") >= 0);
ok('BC = vBC - vICMS', emitSrc.indexOf('pBcPisB = round2(pVbcB - pVicmsB)') >= 0);
ok('vPIS/vCOFINS recalculados sobre a BC reduzida', emitSrc.indexOf('pldB.vpis = String(round2(pBcPisB * pPpisB / 100))') >= 0 && emitSrc.indexOf('pldB.vcofins = String(round2(pBcPisB * pPcofB / 100))') >= 0);

console.log('== C. DANFE: PIS/COFINS de volta no CÁLCULO DO IMPOSTO ==');
ok("campo 'VALOR DO PIS' no danfe", danfeSrc.indexOf("'VALOR DO PIS'") >= 0);
ok("campo 'VALOR DA COFINS' no danfe", danfeSrc.indexOf("'VALOR DA COFINS'") >= 0);
ok('valores lidos do ICMSTot (vPIS/vCOFINS)', danfeSrc.indexOf("tag(total, 'vPIS')") >= 0 && danfeSrc.indexOf("tag(total, 'vCOFINS')") >= 0);

console.log('== D. Matemática da NF 00000017 (BGL 043, 6.730 kg x 7.60) ==');
var vProd = 51148.00;
var vICMS = r2(vProd * 0.12);
ok('vICMS = 6137.76 (12%)', Math.abs(vICMS - 6137.76) < 0.005, String(vICMS));
var vIPI = r2(vProd * 0.0325);
ok('vIPI = 1662.31 (3,25%)', Math.abs(vIPI - 1662.31) < 0.005, String(vIPI));
var bcPis = r2(vProd - vICMS);
ok('BC PIS/COFINS = vProd - vICMS = 45010.24', Math.abs(bcPis - 45010.24) < 0.005, String(bcPis));
var vPIS = r2(bcPis * 0.0165);
var vCOFINS = r2(bcPis * 0.076);
ok('vPIS = 742.67', Math.abs(vPIS - 742.67) < 0.005, String(vPIS));
ok('vCOFINS = 3420.78', Math.abs(vCOFINS - 3420.78) < 0.005, String(vCOFINS));
var vNF = r2(vProd + vIPI);
ok('vNF = vProd + IPI = 52810.31 (modelo DANFE NF 253634)', Math.abs(vNF - 52810.31) < 0.005, String(vNF));
// paridade com o XML modelo NF 14 (20894.94 / ICMS 2507.39)
var bcPis14 = r2(20894.94 - 2507.39);
ok('modelo NF 14: BC PIS = 18387.55', Math.abs(bcPis14 - 18387.55) < 0.005, String(bcPis14));
ok('modelo NF 14: vPIS = 303.39 / vCOFINS = 1397.45', Math.abs(r2(bcPis14 * 0.0165) - 303.39) < 0.005 && Math.abs(r2(bcPis14 * 0.076) - 1397.45) < 0.005);

console.log('== E. XML: valores que o emissor agora produz (shaped lineData) ==');
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'AJL TI';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '4133730076';
process.env.NFE_IBSCBS = 'false';
var dados = {
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
    name: 'NFe 00000017', number: '17',
    date_order: '2026-11-17T12:00:00Z', amount_total: 52810.31,
    note: '', sale_order_number: '',
  },
  lines: [{
    cProd: '000000000000010773', product_name: 'BGL 043 x 1200 ASTM A792 AZ150 MTL 6a8t', ncm: '72106100',
    cfop: '6152', uom: 'KG', qty: 6730, price_unit: 7.6, price_subtotal: 51148.00,
    cst_icms: '00', mod_bc: '3', orig: '0', csosn: '',
    vbc_icms: '51148.00', vicms: '6137.76', picms: '12',
    cst_pis: '01', vbc_pis: '45010.24', ppis: '1.65', vpis: '742.67',
    cst_cofins: '01', vbc_cofins: '45010.24', pcofins: '7.60', vcofins: '3420.78',
    cst_ipi: '50', vbc_ipi: '51148.00', pipi: '3.25', vipi: '1662.31', cenq: '999',
  }],
  pagamentos: [{ tPag: '90', vPag: '0.00' }],
  duplicatas: [],
  config: { serie: '1', tpAmb: '1', natOp: 'Transferencia de mercadoria adquirida/recebida de', mod: '55', indPres: '0', modFrete: '9' },
};
var xml = gerarXmlNFe(dados);
var xc = xml.replace(/\n/g, '');
require('fs').writeFileSync('/tmp/nfe_transf17_v129.xml', xml);
var pisBlk = (xc.match(/<PIS[\s\S]*?<\/PIS>/) || [''])[0];
var cofBlk = (xc.match(/<COFINS[\s\S]*?<\/COFINS>/) || [''])[0];
console.log('  PIS   =>', pisBlk);
console.log('  COFINS=>', cofBlk);
ok('IPITrib CST 50 com vBC/pIPI/vIPI do modelo', /<IPITrib><CST>50<\/CST><vBC>51148\.00<\/vBC><pIPI>3\.2500<\/pIPI><vIPI>1662\.31<\/vIPI><\/IPITrib>/.test(xc));
ok('PIS CST 01 BC 45010.24 -> vPIS 742.67', /<PISAliq><CST>01<\/CST><vBC>45010\.24<\/vBC><pPIS>1\.65<\/pPIS><vPIS>742\.67<\/vPIS><\/PISAliq>/.test(xc));
ok('COFINS CST 01 BC 45010.24 -> vCOFINS 3420.78', /<COFINSAliq><CST>01<\/CST><vBC>45010\.24<\/vBC><pCOFINS>7\.60<\/pCOFINS><vCOFINS>3420\.78<\/vCOFINS><\/COFINSAliq>/.test(xc));
ok('ICMS00 12% BC 51148.00 vICMS 6137.76', /<ICMS00><orig>0<\/orig><CST>00<\/CST><modBC>3<\/modBC><vBC>51148\.00<\/vBC><pICMS>12\.00<\/pICMS><vICMS>6137\.76<\/vICMS><\/ICMS00>/.test(xc));
ok('vNF = 52810.31', xc.indexOf('<vNF>52810.31</vNF>') >= 0);
ok('vIPI total = 1662.31', xc.indexOf('<vIPI>1662.31</vIPI>') >= 0);
ok('tPag 90 e sem cobr (transferência)', xc.indexOf('<tPag>90</tPag>') >= 0 && !xc.includes('<cobr>'));
ok('CFOP 6152', xc.indexOf('<CFOP>6152</CFOP>') >= 0);

console.log('\nResultado: ' + PASS + ' OK, ' + FAIL + ' FALHA' + (FAIL ? ' (EXIT 1)' : ''));
