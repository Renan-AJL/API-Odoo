/**
 * Teste 30/10/2026 — NOME DO CLIENTE na NF-e / NFS-e (demanda Marcus)
 *
 * Regra nova: <dest><xNome> e <toma><xNome> usam o NOME DO CADASTRO
 * (res.partner.name -> objeto partner.xNome), NAO a Razao Social (legal_name).
 * Emitente/prestador continua com Razao Social (regra SEFAZ).
 */
const { gerarXmlNFe } = require('../services/sieg-nfe-xml');
const { gerarXmlDPS } = require('../services/sieg-nfse-xml');

// Simula exatamente o objeto partner normalizado pelo sieg-odoo-emit.js:
//   legal_name: p.legal_name || p.name,  xNome: p.name
const partnerMisto = {
  cnpj_cpf: '16859095000133',
  // Razao social DIFERENTE do nome do cadastro (caso reportado por Marcus):
  legal_name: 'CAMARGO VIDAL E FRANCA LTDA ME',
  // Nome do cliente no cadastro do Odoo (res.partner.name) — DEVE sair na NF:
  xNome: 'CAMARGO VIDAL DISTRIBUIDORA',
  street: 'Rua Agenor Antonio Rodrigues',
  number: '685',
  street2: 'Sitio Cercado',
  city: 'Curitiba',
  city_ibge_code: '4106902',
  state: 'PR',
  zip: '81920210',
  phone: '4130192616',
  inscr_est: '9060761873',
  email: 'comercial@zardogabbardo.com.br',
};

const company = {
  cnpj_cpf: '22603750000190',
  legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  name: 'AJL DISTRIBUIDORA',
  street: 'Avenida Juscelino Kubitschek de Oliveira',
  number: '7525',
  street2: 'Cidade Industrial',
  city: 'Curitiba',
  city_ibge_code: '4106902',
  state: 'PR',
  zip: '81450000',
  phone: '4133730076',
  inscr_est: '9069585890',
  crt: '1',
  state_ibge: '41',
};

const base = {
  company,
  partner: partnerMisto,
  order: { name: 'SO045', number: '45', date_order: '2026-10-30T10:00:00-03:00', amount_total: 187.50 },
  lines: [{
    default_code: '123', product_name: 'TRINCO 20 CM R/E GV', barcode: 'SEM GTIN',
    ncm: '83015000', cfop: '5102', uom: 'UN', qty: 15, price_unit: 12.50,
    price_subtotal: 187.50, csosn: '103', orig: '0',
  }],
  duplicatas: [{ dVenc: '2026-11-27', vDup: 187.50 }],
  pagamentos: [{ tPag: '15', vPag: 187.50 }],
};

let falhas = 0;
function checar(label, cond, detalhe) {
  if (cond) console.log('  PASS  ' + label);
  else { falhas++; console.error('  FAIL  ' + label + (detalhe ? ' -> ' + detalhe : '')); }
}

console.log('=== 1) NF-e: destinatario usa NOME DO CADASTRO ===');
const xml = gerarXmlNFe(base);
const emitNome = (xml.match(/<emit>[\s\S]*?<xNome>([^<]+)<\/xNome>/) || [])[1] || '';
const destNome = (xml.match(/<dest>[\s\S]*?<xNome>([^<]+)<\/xNome>/) || [])[1] || '';
console.log('  emit.xNome = ' + emitNome);
console.log('  dest.xNome = ' + destNome);
checar('dest.xNome = nome do cadastro', destNome === 'CAMARGO VIDAL DISTRIBUIDORA', destNome);
checar('dest.xNome NAO e a razao social', destNome.indexOf('LTDA ME') < 0, destNome);
checar('emit.xNome = razao social AJL (mantido)', emitNome.indexOf('AJL COMERCIO ATACADISTA') === 0, emitNome);

console.log('=== 2) NF-e: fallback se xNome vazio (robustez) ===');
const xml2 = gerarXmlNFe({ ...base, partner: { ...partnerMisto, xNome: '' } });
const destNome2 = (xml2.match(/<dest>[\s\S]*?<xNome>([^<]+)<\/xNome>/) || [])[1] || '';
console.log('  dest.xNome (fallback) = ' + destNome2);
checar('fallback = legal_name quando xNome vazio', destNome2 === 'CAMARGO VIDAL E FRANCA LTDA ME', destNome2);

console.log('=== 3) NFS-e: tomador usa NOME DO CADASTRO ===');
const xml3 = gerarXmlDPS({
  company, partner: partnerMisto,
  order: { name: 'SO045', number: '45', date_order: '2026-10-30T10:00:00-03:00', note: 'FRETE TESTE' },
  service: { cTribNac: '140101', xDescServ: 'FRETE TESTE' },
  config: { serie: '100' },
});
const tomaNome = (xml3.match(/<toma>[\s\S]*?<xNome>([^<]+)<\/xNome>/) || [])[1] || '';
console.log('  toma.xNome = ' + tomaNome);
checar('toma.xNome = nome do cadastro', tomaNome === 'CAMARGO VIDAL DISTRIBUIDORA', tomaNome);

console.log('');
if (falhas) { console.error('*** ' + falhas + ' FALHA(S) ***'); process.exit(1); }
console.log('*** TODOS OS TESTES PASSARAM — NF sai com o Nome do cliente do cadastro ***');
