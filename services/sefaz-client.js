/**
 * services/sefaz-client.js — Comunicacao direta com a SEFAZ (NF-e 4.00)
 * =====================================================================
 * Autorizacao propria com certificado A1 (mTLS + SOAP 1.2).
 *
 * Fluxo:
 *   1. assinarNFe()            -> XML assinado
 *   2. NFeAutorizacao4         -> envia lote (indSinc=1, sincrono)
 *   3. cStat 100               -> autorizada; monta o nfeProc
 *      cStat 103/105 (lote em processamento) -> NFeRetAutorizacao4 (polling)
 *   4. Retorna { autorizada, chave, protocolo, nfeProc, cStat, xMotivo }
 *
 * UF suportadas por autorizador: PR usa webservice proprio; demais UFs caem
 * no SVRS quando nao mapeadas explicitamente.
 */
var https = require('https');
var axios = require('axios');
var { carregarCertificado } = require('./nfe-cert');
var { assinarNFe, minify } = require('./nfe-signer');

var NS = 'http://www.portalfiscal.inf.br/nfe';

// Webservices por autorizador — [producao, homologacao]
var WS = {
  PR: {
    autorizacao: ['https://nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4'],
    retAutorizacao: ['https://nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4'],
    consulta: ['https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4'],
    status: ['https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4'],
  },
  SP: {
    autorizacao: ['https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx'],
    retAutorizacao: ['https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx'],
    consulta: ['https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx'],
    status: ['https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx'],
  },
  SVRS: {
    autorizacao: ['https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx'],
    retAutorizacao: ['https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx'],
    consulta: ['https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx'],
    status: ['https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx'],
  },
};

var CUF = { PR: '41', SP: '35', RS: '43', SC: '42', MG: '31', RJ: '33', BA: '29', GO: '52', MS: '50', MT: '51' };

function uf() { return String(process.env.NFE_UF || 'PR').toUpperCase(); }
function tpAmb() { return String(process.env.SIEG_TP_AMB || process.env.NFE_TP_AMB || '2'); }
function isHomolog() { return tpAmb() === '2'; }
function autorizador() { return WS[uf()] ? uf() : 'SVRS'; }
function endpoint(tipo) { return WS[autorizador()][tipo][isHomolog() ? 1 : 0]; }
function cUF() { return CUF[uf()] || '41'; }

function tag(xml, name) {
  var m = String(xml || '').match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? m[1].trim() : '';
}

function agent() {
  var cert = carregarCertificado();
  if (!cert) throw new Error('Certificado A1 nao configurado — impossivel abrir conexao mTLS com a SEFAZ.');
  return new https.Agent({
    pfx: cert.pfx,
    passphrase: cert.senha,
    // Alguns webservices estaduais ainda negociam TLS legado
    minVersion: 'TLSv1.2',
    keepAlive: true,
    rejectUnauthorized: process.env.NFE_TLS_INSECURE === '1' ? false : true,
  });
}

function envelope(servico, conteudo) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap12:Body>' +
    '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/' + servico + '">' +
    conteudo +
    '</nfeDadosMsg>' +
    '</soap12:Body></soap12:Envelope>';
}

async function soapPost(url, servico, conteudo, timeout) {
  var body = envelope(servico, conteudo);
  var resp = await axios.post(url, body, {
    httpsAgent: agent(),
    timeout: timeout || 60000,
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/' + servico,
      'User-Agent': 'AJL-Odoo-Middleware/1.0',
    },
    validateStatus: function (s) { return s < 600; },
    transformResponse: [function (d) { return d; }],
  });
  return { status: resp.status, xml: String(resp.data || '') };
}

/** Status do servico da SEFAZ — util para testar o certificado e a conexao. */
async function statusServico() {
  var cons = '<consStatServ xmlns="' + NS + '" versao="4.00">' +
    '<tpAmb>' + tpAmb() + '</tpAmb><cUF>' + cUF() + '</cUF><xServ>STATUS</xServ></consStatServ>';
  var r = await soapPost(endpoint('status'), 'NFeStatusServico4', cons, 30000);
  return {
    httpStatus: r.status,
    ambiente: tpAmb() === '2' ? 'homologacao' : 'producao',
    uf: uf(),
    autorizador: autorizador(),
    endpoint: endpoint('status'),
    cStat: tag(r.xml, 'cStat'),
    xMotivo: tag(r.xml, 'xMotivo'),
    online: tag(r.xml, 'cStat') === '107',
  };
}

function sanitizeNFe(xmlAssinado) {
  return minify(xmlAssinado).replace(/<\?xml[^>]*\?>/g, '');
}

/** Consulta o recibo do lote (assincrono). */
async function consultarRecibo(nRec) {
  var cons = '<consReciNFe xmlns="' + NS + '" versao="4.00">' +
    '<tpAmb>' + tpAmb() + '</tpAmb><nRec>' + nRec + '</nRec></consReciNFe>';
  var r = await soapPost(endpoint('retAutorizacao'), 'NFeRetAutorizacao4', cons, 45000);
  return r.xml;
}

/** Consulta a situacao da NF-e pela chave (usado como ultimo recurso). */
async function consultarChave(chave) {
  var cons = '<consSitNFe xmlns="' + NS + '" versao="4.00">' +
    '<tpAmb>' + tpAmb() + '</tpAmb><xServ>CONSULTAR</xServ><chNFe>' + chave + '</chNFe></consSitNFe>';
  var r = await soapPost(endpoint('consulta'), 'NFeConsultaProtocolo4', cons, 45000);
  return r.xml;
}

function extrairProtNFe(xml) {
  var m = String(xml || '').match(/<protNFe[\s\S]*?<\/protNFe>/i);
  return m ? m[0] : '';
}

function montarNfeProc(xmlNFeAssinado, protNFe) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<nfeProc xmlns="' + NS + '" versao="4.00">' +
    sanitizeNFe(xmlNFeAssinado) + protNFe +
    '</nfeProc>';
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/**
 * Assina e autoriza a NF-e na SEFAZ.
 * @param {string} xmlNFe XML <NFe> gerado (sem assinatura)
 */
async function autorizarNFe(xmlNFe) {
  var assinado = assinarNFe(xmlNFe);
  var chave = assinado.chave;
  var idLote = String(Date.now()).slice(-15);

  var enviNFe = '<enviNFe xmlns="' + NS + '" versao="4.00">' +
    '<idLote>' + idLote + '</idLote>' +
    '<indSinc>1</indSinc>' +
    sanitizeNFe(assinado.xml) +
    '</enviNFe>';

  console.log('[SEFAZ] Enviando NF-e ' + chave + ' | UF=' + uf() + ' | amb=' + tpAmb() +
    ' | ' + endpoint('autorizacao'));

  var r;
  try {
    r = await soapPost(endpoint('autorizacao'), 'NFeAutorizacao4', enviNFe, 90000);
  } catch (err) {
    return {
      autorizada: false, chave: chave, xmlAssinado: assinado.xml,
      cStat: '', xMotivo: 'Falha de comunicacao com a SEFAZ: ' + err.message,
      erro: err.message, endpoint: endpoint('autorizacao'),
    };
  }

  var respXml = r.xml;
  console.log('[SEFAZ] Resposta HTTP ' + r.status + ' (' + respXml.length + ' chars): ' + respXml.slice(0, 1200));

  var cStatLote = tag(respXml, 'cStat');
  var xMotivoLote = tag(respXml, 'xMotivo');
  var protNFe = extrairProtNFe(respXml);

  // Lote recebido em processamento -> consultar recibo
  if (!protNFe && (cStatLote === '103' || cStatLote === '105')) {
    var nRec = tag(respXml, 'nRec');
    for (var i = 0; i < 8 && nRec; i++) {
      await sleep(2500);
      var retXml = await consultarRecibo(nRec);
      console.log('[SEFAZ] Consulta recibo ' + nRec + ' tentativa ' + (i + 1) + ': ' + tag(retXml, 'cStat') + ' ' + tag(retXml, 'xMotivo'));
      protNFe = extrairProtNFe(retXml);
      if (protNFe) { respXml = retXml; break; }
      if (tag(retXml, 'cStat') !== '105') { respXml = retXml; break; }
    }
  }

  var cStat = protNFe ? tag(protNFe, 'cStat') : cStatLote;
  var xMotivo = protNFe ? tag(protNFe, 'xMotivo') : xMotivoLote;
  var nProt = protNFe ? tag(protNFe, 'nProt') : '';
  var autorizada = cStat === '100' || cStat === '150';

  var out = {
    autorizada: autorizada,
    chave: chave,
    protocolo: nProt,
    cStat: cStat,
    xMotivo: xMotivo,
    ambiente: tpAmb() === '2' ? 'homologacao' : 'producao',
    uf: uf(),
    endpoint: endpoint('autorizacao'),
    httpStatus: r.status,
    xmlAssinado: assinado.xml,
    respostaSefaz: respXml.slice(0, 6000),
    certificado: assinado.certInfo,
  };

  if (autorizada) {
    out.nfeProc = montarNfeProc(assinado.xml, protNFe);
    console.log('[SEFAZ] NF-e AUTORIZADA! chave=' + chave + ' protocolo=' + nProt);
  } else {
    out.erro = 'SEFAZ rejeitou: ' + (cStat || 's/cStat') + ' - ' + (xMotivo || 'sem motivo informado');
    console.error('[SEFAZ] ' + out.erro);
  }
  return out;
}

module.exports = {
  autorizarNFe,
  statusServico,
  consultarChave,
  consultarRecibo,
  montarNfeProc,
  endpoint,
  uf,
  tpAmb,
};
