/**
 * services/nfe-cancelamento.js — Cancelamento de NF-e na SEFAZ (NT2011.002)
 * ===========================================================================
 * Fluxo:
 *  1. Monta o evento de cancelamento (evCancNFe) com justificativa
 *  2. Assina com o certificado A1 da empresa (XMLDSig RSA-SHA1)
 *  3. Envia via SOAP para NFeRecepcaoEvento4
 *  4. Retorna cStat 135 (cancelada) ou erro
 *
 * Endpoint SEFAZ PR:
 *   Prod: https://nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4
 *   Hom:  https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4
 */
'use strict';
var { SignedXml } = require('xml-crypto');
var { carregarCertificado } = require('./nfe-cert');
var { soapPost, endpoint, uf, tpAmb, cUF } = require('./sefaz-client');
var { minify } = require('./nfe-signer');

var C14N      = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
var ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
var SHA1      = 'http://www.w3.org/2000/09/xmldsig#sha1';
var RSA_SHA1  = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';

/** Formata data-hora no padrão SEFAZ: YYYY-MM-DDTHH:MM:SS-03:00
 *  O servidor pode estar em UTC (Render). Converte UTC -> BRT (UTC-3) explicitamente.
 */
function dhEvento() {
  // Pega o timestamp UTC e subtrai 3h para obter horário de Brasília
  var d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate())
    + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
    + '-03:00';
}

/** Extrai tag do XML de resposta */
function tag(xml, name) {
  var m = xml && xml.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1] : '';
}

/**
 * Cancela uma NF-e autorizada na SEFAZ.
 * @param {object} opts
 * @param {string} opts.chave     - Chave de acesso de 44 dígitos
 * @param {string} opts.protocolo - Número do protocolo de autorização (nProt)
 * @param {string} opts.cnpj      - CNPJ do emitente (14 dígitos, sem pontuação)
 * @param {string} opts.justificativa - Justificativa (15-255 chars)
 * @returns {Promise<{sucesso:boolean, cStat:string, xMotivo:string, nProt:string, dhRecbto:string}>}
 */
async function cancelarNFe(opts) {
  var chave       = String(opts.chave || '').replace(/\D/g, '').slice(0, 44);
  var protocolo   = String(opts.protocolo || '');
  var cnpj        = String(opts.cnpj || '').replace(/\D/g, '').slice(0, 14);
  var justificativa = String(opts.justificativa || 'Cancelamento solicitado pelo emitente').trim();

  if (chave.length !== 44)  throw new Error('Chave de acesso inválida (' + chave.length + ' dígitos, esperado 44)');
  if (!protocolo)           throw new Error('Número do protocolo de autorização é obrigatório');
  if (!cnpj || cnpj.length !== 14) throw new Error('CNPJ do emitente inválido');
  if (justificativa.length < 15)  throw new Error('Justificativa mínima: 15 caracteres');
  if (justificativa.length > 255) justificativa = justificativa.slice(0, 255);

  var cert = carregarCertificado();
  if (!cert) throw new Error('Certificado digital A1 não configurado');
  if (cert.info && cert.info.expirado) throw new Error('Certificado expirado em ' + cert.info.validoAte);

  var nSeqEvento = '1';
  var dhEv       = dhEvento();
  var idEvento   = 'ID110111' + chave + nSeqEvento.padStart(2, '0');

  // -------- Montar XML do evento --------
  var xmlEvento = minify(
    '<evento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">' +
    '<infEvento Id="' + idEvento + '">' +
      '<cOrgao>' + cUF() + '</cOrgao>' +
      '<tpAmb>' + tpAmb() + '</tpAmb>' +
      '<CNPJ>' + cnpj + '</CNPJ>' +
      '<chNFe>' + chave + '</chNFe>' +
      '<dhEvento>' + dhEv + '</dhEvento>' +
      '<tpEvento>110111</tpEvento>' +
      '<nSeqEvento>' + nSeqEvento + '</nSeqEvento>' +
      '<verEvento>1.00</verEvento>' +
      '<detEvento versao="1.00">' +
        '<descEvento>Cancelamento</descEvento>' +
        '<nProt>' + protocolo + '</nProt>' +
        '<xJust>' + justificativa + '</xJust>' +
      '</detEvento>' +
    '</infEvento>' +
    '</evento>'
  );

  // -------- Assinar o evento --------
  var sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certPem,
    signatureAlgorithm: RSA_SHA1,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({
    xpath: "//*[local-name(.)='infEvento']",
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA1,
    uri: '#' + idEvento,
  });
  sig.computeSignature(xmlEvento, {
    location: { reference: "//*[local-name(.)='infEvento']", action: 'after' },
  });
  var xmlAssinado = sig.getSignedXml();

  // -------- Montar lote de eventos --------
  var idLote = Date.now().toString().slice(-15);
  var xmlLote = minify(
    '<envEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">' +
    '<idLote>' + idLote + '</idLote>' +
    xmlAssinado +
    '</envEvento>'
  );

  // -------- URL do endpoint --------
  var baseUrl = endpoint('cancelamento');
  console.log('[NFE-CANCEL] Enviando cancelamento chave=' + chave + ' prot=' + protocolo + ' -> ' + baseUrl);

  // -------- Enviar via SOAP --------
  var respRaw = await soapPost(baseUrl, 'NFeRecepcaoEvento4', xmlLote, 30000);
  var respXml = typeof respRaw === 'string' ? respRaw : (respRaw && respRaw.xml ? String(respRaw.xml) : '');
  console.log('[NFE-CANCEL] HTTP status=' + (respRaw && respRaw.status) + ' xml_len=' + respXml.length);

  // cStat do lote (128 = processado) — o resultado real fica dentro de <retEvento>
  var cStatLote = tag(respXml, 'cStat');
  var xMotivoLote = tag(respXml, 'xMotivo');
  console.log('[NFE-CANCEL] cStat lote: ' + cStatLote + ' - ' + xMotivoLote);

  // Extrair bloco <retEvento> para pegar o cStat individual do evento
  var retEventoMatch = respXml.match(/<retEvento[\s\S]*?<\/retEvento>/);
  var retEventoXml = retEventoMatch ? retEventoMatch[0] : respXml;

  var cStat   = tag(retEventoXml, 'cStat');
  var xMotivo = tag(retEventoXml, 'xMotivo');
  var nProt   = tag(retEventoXml, 'nProt');
  var dhRecbto = tag(retEventoXml, 'dhRecbto');

  // cStat 135 = Evento registrado e vinculado à NF-e (cancelamento confirmado)
  // cStat 155 = Cancelamento homologado (também aceito)
  var sucesso = cStat === '135' || cStat === '155';
  console.log('[NFE-CANCEL] Resultado evento: cStat=' + cStat + ' - ' + xMotivo + (nProt ? ' nProt=' + nProt : ''));

  return { sucesso, cStat, xMotivo, nProt, dhRecbto };
}

module.exports = { cancelarNFe };
