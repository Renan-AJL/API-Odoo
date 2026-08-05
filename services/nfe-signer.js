/**
 * services/nfe-signer.js — Assinatura digital XMLDSig da NF-e (A1)
 * ================================================================
 * Assina o grupo <infNFe> conforme o Manual de Orientacao do Contribuinte:
 *   - Canonicalizacao: C14N (REC-xml-c14n-20010315)
 *   - Transformacoes:  enveloped-signature + C14N
 *   - Digest:          SHA-1
 *   - Assinatura:      RSA-SHA1
 *   - Reference URI:   #NFe<chave de 44 digitos>
 *   - <Signature> fica logo apos </infNFe>, dentro de <NFe>
 */
var { SignedXml } = require('xml-crypto');
var { carregarCertificado } = require('./nfe-cert');

var C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
var ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
var SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
var RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';

/** Remove indentacao entre tags — a NF-e deve trafegar minificada. */
function minify(xml) {
  return String(xml).replace(/\r?\n\s*/g, '').replace(/>\s+</g, '><').trim();
}

/**
 * Assina um XML de NF-e (elemento raiz <NFe>).
 * @param {string} xmlNFe XML da NF-e nao assinado
 * @returns {{ xml: string, chave: string, certInfo: object }}
 */
function assinarNFe(xmlNFe) {
  var cert = carregarCertificado();
  if (!cert) {
    var err = new Error('Certificado digital A1 nao configurado. Envie o .pfx em POST /api/v1/nfe/certificado.');
    err.code = 'CERT_AUSENTE';
    throw err;
  }
  if (cert.info && cert.info.expirado) {
    var e2 = new Error('Certificado digital A1 expirado em ' + cert.info.validoAte + '. Renove antes de emitir.');
    e2.code = 'CERT_EXPIRADO';
    throw e2;
  }

  var xml = minify(xmlNFe);
  var m = xml.match(/Id="(NFe\d{44})"/);
  if (!m) throw new Error('infNFe sem atributo Id="NFe<chave>" — nao eh possivel assinar.');
  var idAttr = m[1];
  var chave = idAttr.slice(3);

  var sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certPem,
    signatureAlgorithm: RSA_SHA1,
    canonicalizationAlgorithm: C14N,
  });

  sig.addReference({
    xpath: "//*[local-name(.)='infNFe']",
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA1,
    uri: '#' + idAttr,
  });

  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='infNFe']", action: 'after' },
  });

  var assinado = sig.getSignedXml();

  // A SEFAZ nao aceita prefixo de namespace na Signature nem KeyInfo ausente
  if (assinado.indexOf('<Signature') === -1) {
    throw new Error('Falha ao gerar a assinatura digital (Signature ausente).');
  }
  if (assinado.indexOf('<X509Certificate>') === -1) {
    throw new Error('Assinatura gerada sem X509Certificate — a SEFAZ rejeitaria (rejeicao 297).');
  }

  console.log('[NFE-SIGN] NF-e ' + chave + ' assinada com o certificado de ' + (cert.info && cert.info.titular));
  return { xml: assinado, chave: chave, certInfo: cert.info };
}

module.exports = { assinarNFe, minify };
