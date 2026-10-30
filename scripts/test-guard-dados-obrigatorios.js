/**
 * Teste 30/10/2026 — guarda de dados obrigatorios (rejeicao 225 NFe 00073379 ANA FLAVIA).
 * Cenarios:
 *  1. Dest sem CPF/CNPJ + sem cMun (dados da fatura 1746 em 30/10) -> gerarXmlNFe THROW claro
 *  2. Dest MS Naviraí com city_ibge_code 5005707 -> XML sai <cMun>5005707</cMun>
 *  3. corrigirCmunNoXml corrige <cMun/> self-closed via tabela IBGE (MS/Navirai)
 *  4. Regressao: XML valido PR Curitiba continua gerando (sem throw)
 */
const { gerarXmlNFe } = require('../services/sieg-nfe-xml');
const { corrigirCmunNoXml } = require('../services/nfe-xml-sanitize');

const company = {
  cnpj_cpf: '22603750000190',
  legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL DISTRIBUIDORA',
  street: 'Avenida Juscelino Kubitschek de Oliveira',
  number: '7525', street2: 'Cidade Industrial',
  city: 'Curitiba', city_ibge_code: '4106902', state: 'PR', zip: '81450000',
  phone: '4133730076', inscr_est: '9069585890', crt: '1', state_ibge: '41',
};
const linha = {
  default_code: '1853', product_name: 'Chapa 2,30 GV', barcode: 'SEM GTIN',
  ncm: '73081000', cfop: '6102', uom: 'KG', qty: 3, price_unit: 6.98,
  price_subtotal: 20.94, orig: '0', csosn: '', cst_icms: '00',
  vbc_icms: '20.94', vicms: '1.47', picms: '7.00',
  cst_pis: '01', vbc_pis: '20.94', ppis: '1.65', vpis: '0.35',
  cst_cofins: '01', vbc_cofins: '20.94', pcofins: '7.60', vcofins: '1.59',
};
const pag = [{ tPag: '13', vPag: 17.10 }, { tPag: '13', vPag: 17.10 }];

let falhas = 0;
function check(label, cond, detalhe) {
  if (cond) console.log('  PASS  ' + label);
  else { falhas++; console.error('  FAIL  ' + label + (detalhe ? ' -> ' + detalhe : '')); }
}

// 1. dados INCOMPLETOS (como a fatura 1746 estava) -> throw
console.log('=== 1. dest sem documento e sem cMun -> BLOQUEIO claro ===');
const partnerRuim = {
  xNome: 'ANA FLAVIA IZIDORO BARBOSA',
  street: 'Rua Henrique Burakowski', number: '197', street2: 'Malhada',
  city: 'Naviraí', city_ibge_code: '', state: 'MS', zip: '83149899',
  phone: '5541991861748', inscr_est: '', email: 'ivaneliltda@gmail.com',
};
let threw = null;
try {
  gerarXmlNFe({ company, partner: partnerRuim, order: { name: 'S03729' }, lines: [linha], pagamentos: pag });
} catch (e) { threw = e; }
check('gerarXmlNFe lanca erro (nao envia XML rejeitavel)', !!threw);
check('mensagem cita documento do destinatario', threw && /documento|CPF|CNPJ/i.test(threw.message));
check('mensagem cita cMun', threw && /cMun/i.test(threw.message), threw && threw.message);

// 2. dados completos MS -> cMun 5005707
console.log('=== 2. dest Naviraí-MS com cMun correto -> XML OK ===');
const partnerOk = { ...partnerRuim, cnpj_cpf: '07526597601', city_ibge_code: '5005707', inscr_est: '' };
const xmlOk = gerarXmlNFe({ company, partner: partnerOk, order: { name: 'S03729' }, lines: [linha], pagamentos: pag });
check('<cMun>5005707</cMun> presente', xmlOk.includes('<cMun>5005707</cMun>'));
check('<CPF>07526597601</CPF> presente', xmlOk.includes('<CPF>07526597601</CPF>'));
check('sem placeholder CPF 00000000000', !xmlOk.includes('00000000000'));

// 3. sanitize corrige <cMun/> self-closed
console.log('=== 3. sanitize corrige <cMun/> self-closed (Naviraí/MS) ===');
const xmlComVazio = xmlOk.replace('<cMun>5005707</cMun>', '<cMun/>');
const fix = corrigirCmunNoXml(xmlComVazio);
check('correcao detectada (enderDest vazio -> 5005707)',
  fix.correcoes.some(c => c.tag === 'enderDest' && c.para === '5005707'), JSON.stringify(fix.correcoes));
check('XML corrigido tem cMun 5005707', fix.xml.includes('<cMun>5005707</cMun>'));

// 4. regressao: PR Curitiba (dados completos) nao quebra
console.log('=== 4. regressao: emitente+dest PR completos ===');
const partnerPR = { ...partnerOk, city_ibge_code: '4106902', city: 'Curitiba', state: 'PR', inscr_est: '9060000000' };
const xmlPR = gerarXmlNFe({ company, partner: partnerPR, order: { name: 'SO999' }, lines: [{ ...linha, cfop: '5102' }], pagamentos: pag });
check('XML PR gerado', xmlPR.includes('<cMun>4106902</cMun>'));

console.log(falhas === 0 ? '\nTODOS OS TESTES OK' : '\n' + falhas + ' FALHA(S)');
process.exit(falhas === 0 ? 0 : 1);
