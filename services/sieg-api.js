/**
 * services/sieg-api.js — Emissao fiscal
 * =====================================
 * NF-e (mod 55): emissao PROPRIA — o XML e assinado com o certificado A1 da
 * AJL e autorizado direto na SEFAZ (services/sefaz-client.js). O DANFE em PDF
 * eh gerado localmente (services/danfe-pdf.js). A SIEG deixa de ser necessaria
 * para emitir; continua opcional como cofre de XML (SIEG_IMPORT_XML=1).
 *
 * NFS-e: continua via SIEG (prefeitura/DPS).
 *
 * Variaveis de ambiente:
 *   NFE_EMISSAO_MODO   proprio (default) | sieg
 *   NFE_UF             UF do emitente (default PR)
 *   SIEG_TP_AMB        1=producao, 2=homologacao
 *   NFE_DANFE_PROVIDER local (default) | sieg
 *   SIEG_IMPORT_XML    1 = apos autorizar, importa o nfeProc no cofre SIEG
 */
const axios = require('axios');
const { getAuthHeaders } = require('./sieg-auth');
const { gerarXmlNFe } = require('./sieg-nfe-xml');
const { gerarXmlDPS } = require('./sieg-nfse-xml');
const { autorizarNFe } = require('./sefaz-client');
const { gerarDanfePdf } = require('./danfe-pdf');

const SIEG_BASE = 'https://api.sieg.com';

function modoEmissao() {
  return String(process.env.NFE_EMISSAO_MODO || 'proprio').toLowerCase();
}

/** Importa um XML ja autorizado (nfeProc) no cofre da SIEG — opcional. */
async function importarXmlSieg(xmlAutorizado) {
  const xmlMin = String(xmlAutorizado).replace(/>\s+</g, '><');
  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
    Xml: Buffer.from(xmlMin, 'utf-8').toString('base64'),
  }, { headers, timeout: 60000, validateStatus: function (s) { return s < 500; } });
  console.log('[SIEG-API] Import no cofre HTTP ' + resp.status + ': ' + JSON.stringify(resp.data).slice(0, 500));
  return { httpStatus: resp.status, resposta: resp.data };
}

/**
 * Emissao propria: gera XML -> assina com A1 -> autoriza na SEFAZ.
 * Retorna o mesmo formato de resultado consumido por sieg-odoo-emit.
 */
async function emitirNFePropria(dadosOdoo) {
  const xml = gerarXmlNFe(dadosOdoo);
  console.log('[NFE] Emissao propria — XML gerado (' + xml.length + ' chars)');

  let r;
  try {
    r = await autorizarNFe(xml);
  } catch (err) {
    console.error('[NFE] Falha antes do envio a SEFAZ: ' + err.message);
    return {
      sucesso: false,
      httpStatus: err.code === 'CERT_AUSENTE' || err.code === 'CERT_EXPIRADO' ? 422 : 500,
      xmlEnviado: xml,
      resposta: { xMotivo: err.message },
      data: null,
      erro: err.message,
      statusCode: err.code || null,
    };
  }

  const resultado = {
    sucesso: !!r.autorizada,
    httpStatus: 200,
    xmlEnviado: r.nfeProc || r.xmlAssinado || xml,
    xmlAssinado: r.xmlAssinado,
    nfeProc: r.nfeProc || null,
    resposta: {
      chNFe: r.chave,
      nProt: r.protocolo,
      cStat: r.cStat,
      xMotivo: r.xMotivo,
      ambiente: r.ambiente,
      uf: r.uf,
      endpoint: r.endpoint,
      respostaSefaz: r.respostaSefaz,
    },
    data: r.nfeProc || null,
    erro: r.autorizada ? null : (r.erro || r.xMotivo || 'NF-e nao autorizada'),
    statusCode: r.cStat || null,
  };

  // Cofre SIEG (opcional): guarda o XML autorizado
  if (resultado.sucesso && String(process.env.SIEG_IMPORT_XML || '') === '1') {
    try {
      resultado.cofreSieg = await importarXmlSieg(r.nfeProc);
    } catch (e) {
      console.error('[SIEG-API] Falha ao importar no cofre (nota continua autorizada): ' + e.message);
      resultado.cofreSieg = { erro: e.message };
    }
  }

  return resultado;
}

/**
 * Caminho legado: importa no SIEG um XML de NF-e ja assinado/autorizado.
 * So eh usado com NFE_EMISSAO_MODO=sieg.
 */
async function enviarNFeViaSieg(dadosOdoo) {
  const xml = gerarXmlNFe(dadosOdoo);
  const xmlMin = xml.replace(/>\s+</g, '><');

  if (xmlMin.indexOf('<Signature') === -1 || xmlMin.indexOf('<protNFe') === -1) {
    return {
      sucesso: false,
      httpStatus: 422,
      xmlEnviado: xml,
      resposta: null,
      data: null,
      erro: 'O endpoint SIEG /send-xml aceita apenas XML de NF-e ja assinado e autorizado (nfeProc). Use NFE_EMISSAO_MODO=proprio para emitir com o certificado A1.',
      statusCode: 422,
    };
  }

  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
    Xml: Buffer.from(xmlMin, 'utf-8').toString('base64'),
  }, { headers, timeout: 60000, validateStatus: function (s) { return s < 500; } });

  const result = resp.data || {};
  return {
    sucesso: result.IsSuccess === true,
    httpStatus: resp.status,
    xmlEnviado: xml,
    resposta: result,
    data: result.Data || null,
    erro: result.ErrorMessage || result.Message || null,
    statusCode: result.StatusCode || null,
  };
}

async function enviarNFe(dadosOdoo) {
  return modoEmissao() === 'sieg' ? enviarNFeViaSieg(dadosOdoo) : emitirNFePropria(dadosOdoo);
}

/**
 * Emitir NFS-e via SIEG (DPS)
 */
async function emitirNFSe(dadosOdoo) {
  const xml = gerarXmlDPS(dadosOdoo);
  console.log('[SIEG-API] Emitindo NFS-e DPS (' + xml.length + ' chars)');

  const headers = await getAuthHeaders();
  let resp;
  try {
    resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
      Xml: Buffer.from(xml, 'utf-8').toString('base64'),
    }, { headers, timeout: 60000, validateStatus: function (s) { return s < 500; } });
  } catch (err) {
    console.error('[SIEG-API] Erro de conexao SIEG:', err.message);
    throw err;
  }

  const result = resp.data;
  const httpStatus = resp.status;
  console.log('[SIEG-API] Resposta send-xml NFS-e HTTP ' + httpStatus + ':', JSON.stringify(result).slice(0, 2000));

  if (httpStatus >= 400 && httpStatus < 500) {
    console.error('[SIEG-API] *** ERRO SIEG NFS-e HTTP ' + httpStatus + ' *** ' + (result.ErrorMessage || result.Message || ''));
  }

  return {
    sucesso: !!(result.IsSuccess === true),
    httpStatus: httpStatus,
    xmlEnviado: xml,
    resposta: result,
    data: result.Data || null,
    erro: result.ErrorMessage || result.Message || null,
    statusCode: result.StatusCode || null,
  };
}

/**
 * DANFE (PDF) — local por padrao; SIEG apenas se NFE_DANFE_PROVIDER=sieg
 */
async function gerarDanfe(xmlAutorizado) {
  if (String(process.env.NFE_DANFE_PROVIDER || 'local').toLowerCase() === 'sieg') {
    const headers = await getAuthHeaders();
    const resp = await axios.post(SIEG_BASE + '/api/v1/gerarDanfeViaXml', {
      Xml: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
    }, { headers, timeout: 30000 });
    return resp.data;
  }
  const pdf = await gerarDanfePdf(xmlAutorizado);
  console.log('[DANFE] PDF gerado localmente (' + pdf.length + ' bytes)');
  return pdf.toString('base64');
}

/**
 * DANFSE (PDF) via SIEG
 */
async function gerarDanfse(xmlAutorizado) {
  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/gerarDanfseViaXml', {
    Xml: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
  }, { headers, timeout: 30000 });
  return resp.data;
}

/**
 * Emitir nota fiscal (auto-detect NF-e ou NFS-e)
 */
async function emitirNota(dadosOdoo) {
  let tipo = dadosOdoo.tipo;
  if (!tipo) {
    tipo = (dadosOdoo.service && dadosOdoo.lines && dadosOdoo.lines.every(function (l) { return l.detailed_type === 'service'; })) ? 'nfse' : 'nfe';
  }

  let resultado;
  if (tipo === 'nfse') {
    resultado = await emitirNFSe(dadosOdoo);
  } else {
    resultado = await enviarNFe(dadosOdoo);
  }
  resultado.tipo = tipo;

  // Se autorizado, gerar PDF
  if (resultado.sucesso && resultado.data) {
    try {
      let xmlAutorizado = resultado.data;
      if (typeof xmlAutorizado === 'string' && xmlAutorizado.length < 500 && xmlAutorizado.indexOf('<') === -1) {
        xmlAutorizado = Buffer.from(xmlAutorizado, 'base64').toString('utf-8');
      }
      resultado.pdfBase64 = tipo === 'nfse'
        ? await gerarDanfse(xmlAutorizado)
        : await gerarDanfe(xmlAutorizado);
      resultado.pdfGerado = true;
    } catch (errPdf) {
      console.error('[SIEG-API] Erro ao gerar PDF (nota ainda pode estar autorizada):', errPdf.message);
      resultado.pdfGerado = false;
      resultado.pdfErro = errPdf.message;
    }
  }

  return resultado;
}

module.exports = {
  enviarNFe,
  emitirNFSe,
  emitirNFePropria,
  importarXmlSieg,
  gerarDanfe,
  gerarDanfse,
  emitirNota,
};
