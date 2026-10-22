// Gera XML NF-e (homologacao) completo p/ testar o DANFE remoto com coluna ALQ ICMS
process.env.NFE_RESP_TEC_CNPJ = '22603750000190';
process.env.NFE_RESP_TEC_CONTATO = 'TI AJL';
process.env.NFE_RESP_TEC_EMAIL = 'ti@ajl.com.br';
process.env.NFE_RESP_TEC_FONE = '41999999999';
process.env.NFE_IBSCBS = 'false';

var fs = require('fs');
var { gerarXmlNFe } = require('../services/sieg-nfe-xml');

var data = require('./test-xml-ep-data.js');
var nfe = gerarXmlNFe(data);

// Extrai a chave do Id p/ montar o protNFe (tira a declaracao XML interna)
var nfeSemDecl = nfe.replace(/<\?xml[^>]*\?>\s*/, '');
var m = nfeSemDecl.match(/Id="NFe(\d{44})"/);
var chave = m[1];
var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">\n'
  + nfeSemDecl + '\n<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>1</verAplic><chNFe>' + chave
  + '</chNFe><dhRecbto>2026-10-21T10:00:00-03:00</dhRecbto><nProt>141260000000000</nProt><cStat>100</cStat>'
  + '<xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>\n</nfeProc>';

fs.writeFileSync('/tmp/nfe_teste_ep.xml', xml);
console.log('XML salvo: /tmp/nfe_teste_ep.xml (' + xml.length + ' chars) chave=' + chave);
