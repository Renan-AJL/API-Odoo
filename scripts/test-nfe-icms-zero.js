// Teste ICMS 0% (CST 40) — rejeicao 225 NFe 00073368 (STEELALLOY, CFOP 5901 industrializacao)
// Causa raiz: gerador emitia modBC/vBC/pICMS/vICMS dentro de ICMS40 — XSD permite SOMENTE orig+CST.
// Fix: (a) sieg-nfe-xml.js bloco minimal p/ CST 40/41/50/51; (b) sieg-odoo-emit.js manual 0%
//      zera vbc_icms e limpa csosn/difal (ICMS 0% vale em QUALQUER saida).
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'TESTE';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '41999999999';
process.env.NFE_IBSCBS = 'true'; // producao emite com IBSCBS (igual XML real da 73368)

var { gerarXmlNFe } = require('../services/sieg-nfe-xml');

function base(overrides) {
  var d = JSON.parse(JSON.stringify({
    company: {
      cnpj_cpf: '22603750000190', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
      name: 'AJL - Matriz', inscr_est: '9093593925', street: 'Rua Anselmo de Lima Filho', number: 'S/N',
      street2: 'Cidade Industrial', city: 'Curitiba', state: 'PR', zip: '81290250',
      city_ibge_code: '4106902', state_ibge: '41', crt: '3', phone: '4133500000',
    },
    partner: {
      cnpj_cpf: '81721805000126', legal_name: 'STEELALLOY INDUSTRIA E COMERCIO DE FITAS DE ACO LTDA',
      xNome: 'STEELALLOY INDUSTRIA E COMERCIO DE FITAS DE ACO LTDA',
      inscr_est: '9093593925', street: 'Rua Anselmo de Lima Filho', number: 'S/N',
      street2: 'Cidade Industrial', city: 'Curitiba', state: 'PR', zip: '81290250',
      city_ibge_code: '4106902', ind_ie_dest: 1,
    },
    order: {
      name: 'NFe 00073368', number: '73368',
      date_order: new Date().toISOString(), amount_total: 58038,
      note: 'Envio para industrializacao por pedido.', sale_order_number: 'S00000',
      icms_aliquota: 'ICMS informado manualmente: 0%',
    },
    lines: [{
      cProd: '2466', product_name: 'Bobina 2,70 GI', ncm: '72112320', cfop: '5901',
      uom: 'KG', qty: 11380, price_unit: 5.1, price_subtotal: 58038,
      // estado da linha APOS bloco ICMS MANUAL 0% (fix sieg-odoo-emit.js):
      cst_icms: '40', mod_bc: '3', orig: '0', csosn: '',
      vbc_icms: '0.00', vicms: '0.00', picms: '0.00',
      cst_pis: '01', vbc_pis: '58038.00', ppis: '1.65', vpis: '957.63',
      cst_cofins: '01', vbc_cofins: '58038.00', pcofins: '7.60', vcofins: '4410.89',
    }],
    pagamentos: [{ indPag: '0', tPag: '90', vPag: '58038.00' }],
    config: { serie: '100', tpAmb: '2', natOp: 'Envio para industrialização por pedido', mod: '55' },
  }));
  if (overrides && overrides.lines) d.lines = overrides.lines;
  if (overrides && overrides.partner) Object.assign(d.partner, overrides.partner);
  return d;
}

var falhas = 0;
function check(nome, cond, extra) {
  console.log((cond ? '  OK   ' : '  FALHA') + ' — ' + nome + (extra ? ' | ' + extra : ''));
  if (!cond) falhas++;
}

console.log('=== CENARIO 1 (caso real 73368): CST 40 — ICMS 0% manual, CFOP 5901 ===');
var xml1 = gerarXmlNFe(base({}));
xml1compact = xml1.replace(/\n/g, '');
check('ICMS40 presente', xml1.includes('<ICMS40>'));
check('ICMS40 = SOMENTE orig+CST (bloco minimal)',
  /<ICMS><ICMS40><orig>0<\/orig><CST>40<\/CST><\/ICMS40><\/ICMS>/.test(xml1compact));
check('SEM modBC dentro de ICMS40 (causa da rejeicao 225)',
  !/<ICMS40>[^<]*<modBC>/.test(xml1compact));
check('SEM vBC dentro de ICMS40',
  !/<ICMS40>[\s\S]*?<vBC>[\s\S]*?<\/ICMS40>/.test(xml1compact));
check('ICMSTot vBC = 0.00 (soma dos itens zerada)', xml1.includes('<vBC>0.00</vBC>'));
check('ICMSTot vICMS = 0.00', /<total>\s*<ICMSTot>[\s\S]*?<vICMS>0\.00<\/vICMS>/.test(xml1));
check('vNF = 58038.00', xml1.includes('<vNF>58038.00</vNF>'));
check('PIS CST 01 mantido (957.63)', xml1.includes('<vPIS>957.63</vPIS>'));
check('COFINS CST 01 mantida (4410.89)', xml1.includes('<vCOFINS>4410.89</vCOFINS>'));
check('CFOP 5901', xml1.includes('<CFOP>5901</CFOP>'));

console.log('=== CENARIO 2: CST 41 (nao tributada) — mesmo bloco minimal ===');
var l41 = [{ ...base({}).lines[0], cst_icms: '41' }];
var xml2 = gerarXmlNFe(base({ lines: l41 })).replace(/\n/g, '');
check('CST 41 -> grupo ICMS40 (XSD nao tem tag ICMS41) = orig+CST minimal',
  /<ICMS><ICMS40><orig>0<\/orig><CST>41<\/CST><\/ICMS40><\/ICMS>/.test(xml2));

console.log('=== CENARIO 3: CST 50/51 — bloco minimal (XSD) ===');
var l50 = [{ ...base({}).lines[0], cst_icms: '50' }];
var xml3 = gerarXmlNFe(base({ lines: l50 })).replace(/\n/g, '');
check('CST 50 -> grupo ICMS40 (XSD nao tem tag ICMS50) = orig+CST minimal', /<ICMS40><orig>0<\/orig><CST>50<\/CST><\/ICMS40>/.test(xml3));
var l51 = [{ ...base({}).lines[0], cst_icms: '51' }];
var xml3b = gerarXmlNFe(base({ lines: l51 })).replace(/\n/g, '');
check('ICMS51 = orig+CST minimal (diferimento, demais opcionais)',
  /<ICMS51><orig>0<\/orig><CST>51<\/CST><\/ICMS51>/.test(xml3b));

console.log('=== CENARIO 4 (regressao): CST 00 tributado mantem bloco completo ===');
var l00 = [{ ...base({}).lines[0], cst_icms: '00', mod_bc: '3', vbc_icms: '58038.00', vicms: '6964.56', picms: '12' }];
var xml4 = gerarXmlNFe(base({ lines: l00 })).replace(/\n/g, '');
check('ICMS00 com modBC/vBC/pICMS/vICMS',
  /<ICMS00><orig>0<\/orig><CST>00<\/CST><modBC>3<\/modBC><vBC>58038\.00<\/vBC><pICMS>12\.00<\/pICMS><vICMS>6964\.56<\/vICMS><\/ICMS00>/.test(xml4));

console.log('=== CENARIO 5 (regressao): CSOSN 102 continua com branch CSOSN ===');
var lsn = [{ ...base({}).lines[0], cst_icms: '', csosn: '102' }];
var xml5 = gerarXmlNFe(base({ lines: lsn })).replace(/\n/g, '');
check('ICMSSN102 emitido', /<ICMSSN102><orig>0<\/orig><CSOSN>102<\/CSOSN><\/ICMSSN102>/.test(xml5));

require('fs').writeFileSync('/tmp/nfe_icms0_teste.xml', xml1);
console.log('\nXML cenario 1 salvo em /tmp/nfe_icms0_teste.xml (para validacao XSD via python)');
process.exit(falhas ? 1 : 0);
