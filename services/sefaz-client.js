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

// ============================================================
// Bundle de CAs da ICP-Brasil para validacao TLS dos webservices da SEFAZ.
// Inclui: AC SOLUTI SSL EV G4 + AC Raiz Brasileira v10
// Validos ate: 01/07/2032. Atualizar se a SEFAZ trocar a cadeia.
// ============================================================
var ICP_BRASIL_CA_BUNDLE = [
  // AC SOLUTI SSL EV G4 (emitida pela AC Raiz Brasileira v10)
  '-----BEGIN CERTIFICATE-----\nMIIHtDCCBZygAwIBAgIJANjGl6F55VD+MA0GCSqGSIb3DQEBDQUAMIGYMQswCQYD\nVQQGEwJCUjETMBEGA1UECgwKSUNQLUJyYXNpbDE9MDsGA1UECww0SW5zdGl0dXRv\nIE5hY2lvbmFsIGRlIFRlY25vbG9naWEgZGEgSW5mb3JtYWNhbyAtIElUSTE1MDMG\nA1UEAwwsQXV0b3JpZGFkZSBDZXJ0aWZpY2Fkb3JhIFJhaXogQnJhc2lsZWlyYSB2\nMTAwHhcNMjMwMzIyMTgwOTExWhcNMzIwNzAxMTIwMDU5WjB3MQswCQYDVQQGEwJC\nUjETMBEGA1UEChMKSUNQLUJyYXNpbDE1MDMGA1UECxMsQXV0b3JpZGFkZSBDZXJ0\naWZpY2Fkb3JhIFJhaXogQnJhc2lsZWlyYSB2MTAxHDAaBgNVBAMTE0FDIFNPTFVU\nSSBTU0wgRVYgRzQwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDHv3Kv\noEPrNrzImIPn17GI5vdoVxghsm6EVLMUjnM4JdCpDED+0BqZF0kycyZaiWt7jqSR\nvcGm66RKzSGcHJlUgahp9qcXAmSwMn00pwvgBKb+4htp48vQc1/5MWpaBzQW4Di/\ntWvNkh9URtMyhtltf2u3s9r5vgF12ff7mCu3oj0bDBIaGs/a9EtMKoCfw/ziKUp7\n11JYu1fbIWVOgbW9iHE24oiE33LGLm+uToCWpjGL3n9D+q+ryfIYFoes6gPCYYSt\nudDUB9lfpe83IOVcVslL3DmYd2oEncGCogO3qzaMSH3OVLMO4Rg5edERpMw5U0tA\nMeyO0k5/tmnFfUM476lZl+ce2Ol56p7R2yjKxHJizeCOSmwDE5FXz7ll+Zq9C7QW\nUzoPQtyT739UGEeBRTAz4KsO77frCtdifGRvX3lMfI8qeMnfvf08BK9e2dRkCHwD\niv23Aw7QIixDS9PiSsMxObgjHwroEqAAN2Mwz1B1zAuzZVUH7k6MyQQ/II/GDUpT\njT4VKnhjdIfz5aEFHx7By2XjMkx1hyeONLS/2SoDnKitE9yY/PASqWDCPCpSoJ+x\nfEdyZvoawEbJfL+CMhU5I7IXgf9f7gibghIc2CG4bf6dfVAdPcGkYkcjw21dtq/G\n1V2dHpOX67BbihThAVr8Z7NTgVAv4nC6MPpAywIDAQABo4ICHzCCAhswggEHBgNV\nHSAEgf8wgfwwQwYFYEwBAQAwOjA4BggrBgEFBQcCARYsaHR0cDovL2FjcmFpei5p\nY3BicmFzaWwuZ292LmJyL0RQQ2FjcmFpei5wZGYwUAYGYEwBAYECMEYwRAYIKwYB\nBQUHAgEWOGh0dHA6Ly9jY2QuYWNzb2x1dGkuY29tLmJyL2RvY3MvZHBjLWFjLXNv\nbHV0aS1zc2wtZXYucGRmMFAGBmBMAQIBcDBGMEQGCCsGAQUFBwIBFjhodHRwOi8v\nY2NkLmFjc29sdXRpLmNvbS5ici9kb2NzL2RwYy1hYy1zb2x1dGktc3NsLWV2LnBk\nZjAHBgVngQwBATAIBgZngQwBAgIwQAYDVR0fBDkwNzA1oDOgMYYvaHR0cDovL2Fj\ncmFpei5pY3BicmFzaWwuZ292LmJyL0xDUmFjcmFpenYxMC5jcmwwHwYDVR0jBBgw\nFoAUdPN+//yfU3rxfOurPqSm2hi6RWMwHQYDVR0OBBYEFP4GuSyVfi/m0Lio8S+3\n8i6F1dfAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMB0GA1UdJQQW\nMBQGCCsGAQUFBwMBBggrBgEFBQcDAjBMBggrBgEFBQcBAQRAMD4wPAYIKwYBBQUH\nMAKGMGh0dHA6Ly9hY3JhaXouaWNwYnJhc2lsLmdvdi5ici9JQ1AtQnJhc2lsdjEw\nLmNydDANBgkqhkiG9w0BAQ0FAAOCAgEAABxayeHitwL18QeXSQvRZ2eiNb82IlYT\nuvER4JRMzZDWoamKOqmD7KXSSj+sdBThYiRkkNiVFiMn2qoYAdylI2I4w1npbxyr\nukfXQ7tadTEiMCFva0uHHw9lpBx+oyy9rcLM7qC5qquksyhC222Yt3WbqC6Fla+L\no3GlTOpogqexeyc9hgvAQxeMmq+xyDcjSLzKmmRmMKQ9y3w7wpufXTO/0K5uOLLZ\nsfyXZTw+MYYeIk2+GNv1qQBbWo3gmwlD1W0pJEHe+/KxiCRkDHpJY7Lk2Rm4bSDZ\nRr4Bn8bk/XJWpiu7Fm9b8piPKjTtstDYTzu40ccPRh9UCWDUz4nKF97dXjIgYf+a\nTA0vnKdlnpPUDeBVpfyXavhGf/akFh5AO7/v6xkzWOUlawn5g614mWhOQ6ITwmua\ny1spnpBO684d0bynFQfMoZGS5fdKoYKKDzp29xhBm3s9WD1f/oP79Ie0eDribpOv\nj3Xsjz72MTG4+UVxuv0OIYuXDc8x1foMzVOco6DxuLel6KG5RH+m0tWmX4ouCgBK\nTNUQC70AWHBa4PCF5YA7H8qVnH2EUBPo3rxOY0wN6GzyMbg9+D9l5e2Xcg7/ytqY\nBIBnZKLPjzS3OqUsM9UgUKGwcEnaHnmRxH8vyVEMGnoK1cZNf9uDM9sMGgQUzKwV\nwixwyINOM8U=\n-----END CERTIFICATE-----',
  // Autoridade Certificadora Raiz Brasileira v10 (self-signed, ITI)
  '-----BEGIN CERTIFICATE-----\nMIIGrDCCBJSgAwIBAgIJANLVi0S/gZNCMA0GCSqGSIb3DQEBDQUAMIGYMQswCQYD\nVQQGEwJCUjETMBEGA1UECgwKSUNQLUJyYXNpbDE9MDsGA1UECww0SW5zdGl0dXRv\nIE5hY2lvbmFsIGRlIFRlY25vbG9naWEgZGEgSW5mb3JtYWNhbyAtIElUSTE1MDMG\nA1UEAwwsQXV0b3JpZGFkZSBDZXJ0aWZpY2Fkb3JhIFJhaXogQnJhc2lsZWlyYSB2\nMTAwHhcNMTkwNzAxMTkxNTU5WhcNMzIwNzAxMTIwMDU5WjCBmDELMAkGA1UEBhMC\nQlIxEzARBgNVBAoMCklDUC1CcmFzaWwxPTA7BgNVBAsMNEluc3RpdHV0byBOYWNp\nb25hbCBkZSBUZWNub2xvZ2lhIGRhIEluZm9ybWFjYW8gLSBJVEkxNTAzBgNVBAMM\nLEF1dG9yaWRhZGUgQ2VydGlmaWNhZG9yYSBSYWl6IEJyYXNpbGVpcmEgdjEwMIIC\nIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAk3AxKl1ZtP0pNyjChqO7qNkn\n+/sClZeqiV/Kd7KnnbkDbI2y3VWcUG7feCE/deIxot6GH6JXncRG794UZl+4doD0\nD0/cEwBd4DvrDSZm0RT40xhmYYOTxZDJxv+coTHdmsT5aNmSkktfjzYX4HQHh/7M\nem+kTOpT/3E4K6B7KVs9HkOT7nXx5yU1qYbVWqI0qpJM9mOTSFx8C9HiKcHvLCvt\n1ioXKPAmFuHPkayOcXP2MXeb+VRNjWKU4E+L2t5uZPKVx1M/9i1DztlLb4K8OfYg\nGaPDUSF1sxnoGk5qZHLleO6KjCpmuQepmgsBvxi2YNO7X2YUwQQx1AXNSolgtkAR\n5gt+1WzxhbFUhItQqlhqxgWHefLmiT5T/Ctz/P2v+zSO4efkkIzsi1iwD+ypZvM2\nlnIvB24RcSN6jzmCahLPX4CwjwIK6JsSoMVxIhpZHCguUP4LXqP8IWUZ6WgS/4zB\n7B9E0EICl2rM1PRy+6ulv+ZOW256e8a0pijUB+hXM1msUq9L92476FAAX8va3sP7\n+Uut94+bGHmubcTLImWUPrxNT7QyrvE3FyHicfiHioeFL2oV4cXTLZrEq2wS8R4P\nKPdSzNn5Z9e2uMEGYQaSNO+OwvVycpIhOBOqrm12wJ9ZhWKtM5UOo34/o37r5ZBI\nTYXAGbhqQDB9mWXwH+0CAwEAAaOB9jCB8zBOBgNVHSAERzBFMEMGBWBMAQEAMDow\nOAYIKwYBBQUHAgEWLGh0dHA6Ly9hY3JhaXouaWNwYnJhc2lsLmdvdi5ici9EUENh\nY3JhaXoucGRmMEAGA1UdHwQ5MDcwNaAzoDGGL2h0dHA6Ly9hY3JhaXouaWNwYnJh\nc2lsLmdvdi5ici9MQ1JhY3JhaXp2MTAuY3JsMB8GA1UdIwQYMBaAFHTzfv/8n1N6\n8Xzrqz6kptoYukVjMB0GA1UdDgQWBBR0837//J9TevF866s+pKbaGLpFYzAPBgNV\nHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQ0FAAOCAgEA\neCNhBSuy/Ih/T+1VOtAJju85SrtoE3vET1qXASpmjQllDHG/ph7VFNRAkC+gha+B\nCbjoA5oJ/8wwl+Qdp1KGz6nXXFTLx3osU+kjm0srmBf9nyXHPqvFyvBeB0A7sYb7\nTmII9GKD20oCxsdkccR/oE/JuTaNnGq0GYZ2aDb5v62uLi21Y6P9UBiTxZqQ4ojW\nET6kXNjlK238jpXv17FR8Sg3VusCvX7Q8eJkavvHHZDeWck2fSA+ycAc2JeL2Z0B\nMSxGWpH32WM9J8+6XqCJUXHiWEV0zCE8wDYiYC+047pTxQI/gB/FcU7jvylh98DJ\nkQPHd/Tp6Og3ynlDA9n9uBbxYHVRZs9vsZ/7xTFaxRe+zk8dhgKgZ/3RrcMFB570\n2t8LFbyuUE/kQVY6rZ0QJ9qMWQ7VPLRwRhiMeU3k8WDJb/tBbOXHBqldTbWyQ+mp\nMEDWhbrzE/IED82wAuO23Tb05cYk2xC7+Izef8fSc3XdJDuPSbcDpWukzyCDtSEH\nisLiGEtIbYRiPsF3czlQPsnIEVoTTCWxHCH1zYR6zScSv18Qh69qVe2J40K5jZoP\nGEOhq/oKhVJQAdvAFW5Odp7mF3Tk9nivjjsctJSxY26LFiV5GRV+07SSse4ti0aO\njO5PLg5SWjfcOtBG2rz02EIvQAmLcb0kGBtfdj0lW/w=\n-----END CERTIFICATE-----',
];

var NS = 'http://www.portalfiscal.inf.br/nfe';

// Webservices por autorizador — [producao, homologacao]
var WS = {
  PR: {
    autorizacao: ['https://nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4'],
    retAutorizacao: ['https://nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4'],
    consulta: ['https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4'],
    status: ['https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4'],
    cancelamento: ['https://nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4', 'https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4'],
  },
  SP: {
    autorizacao: ['https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx'],
    retAutorizacao: ['https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx'],
    consulta: ['https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx'],
    status: ['https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx'],
    cancelamento: ['https://www.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx', 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx'],
  },
  SVRS: {
    autorizacao: ['https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx'],
    retAutorizacao: ['https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx'],
    consulta: ['https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx'],
    status: ['https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx'],
    cancelamento: ['https://nfe.svrs.rs.gov.br/ws/NfeRecepcaoEvento/NfeRecepcaoEvento4.asmx', 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRecepcaoEvento/NfeRecepcaoEvento4.asmx'],
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
  // Montar lista de CAs confiáveis para validar o certificado TLS do servidor SEFAZ:
  // 1. CAs do proprio certificado A1 (intermediarias ICP-Brasil do emitente)
  // 2. Bundle ICP_BRASIL_CA_BUNDLE embutido no codigo (AC SOLUTI SSL EV G4 + AC Raiz v10)
  // Isso resolve "self-signed certificate in certificate chain" em containers Linux
  // sem o bundle de CAs da ICP-Brasil instalado no OpenSSL do sistema.
  var extraCas = ICP_BRASIL_CA_BUNDLE.slice();
  if (cert.chainPem && cert.chainPem.length > 1) {
    for (var i = 1; i < cert.chainPem.length; i++) {
      if (extraCas.indexOf(cert.chainPem[i]) === -1) extraCas.push(cert.chainPem[i]);
    }
  }

  var opts = {
    minVersion: 'TLSv1.2',
    keepAlive: true,
    rejectUnauthorized: process.env.NFE_TLS_INSECURE === '1' ? false : true,
    ca: extraCas,
  };
  // Node 20+ com OpenSSL 3 nao suporta PFX com algoritmos legados (3DES/RC2/PBES2-AES).
  // Usamos PEM (key + cert + ca) extraidos previamente pelo nfe-cert.js.
  if (cert.privateKeyPem && cert.chainPem && cert.chainPem.length) {
    opts.key = cert.privateKeyPem;
    // chainPem ja contem [leaf, ca1, ca2, ...] — formato esperado pelo TLS
    opts.cert = cert.chainPem.join('');
    console.log('[SEFAZ] Agente mTLS criado com PEM (key + cert chain, ' + cert.chainPem.length + ' certificados, ' + opts.ca.length + ' CAs ICP-Brasil).');
  } else if (cert.privateKeyPem && cert.certPem) {
    opts.key = cert.privateKeyPem;
    opts.cert = cert.certPem;
    console.log('[SEFAZ] Agente mTLS criado com PEM (key + leaf cert, sem chain, ' + opts.ca.length + ' CAs ICP-Brasil).');
  } else {
    // Fallback: tenta PFX direto (funciona em Node < 20 ou certificados modernos)
    opts.pfx = cert.pfx;
    opts.passphrase = cert.senha;
    console.warn('[SEFAZ] PEM nao disponivel, usando PFX direto no https.Agent (pode falhar no Node 20+ com OpenSSL 3).');
  }
  return new https.Agent(opts);
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
  cUF,
  soapPost,
};
