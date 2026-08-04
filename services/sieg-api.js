/**
 * services/sieg-api.js — Comunicacao com API SIEG
 * 
 * Documentacao: SIEG API para Sistemas Externos
 * 
 * Endpoints:
 *   - Enviar XMLs:    POST (XML em Base64)
 *   - Gerar DANFE:    POST /api/v1/gerarDanfeViaXml
 *   - Gerar DANFSE:   POST /api/v1/gerarDanfseViaXml
 * 
 * Headers obrigatorios em TODAS as requisicoes:
 *   Authorization: Bearer {jwt}
 *   X-OAuth-Token: {oauth_token}
 *   (X-API-Key se configurado)
 * 
 * Schema enviar XML:
 *   Request:  { "Xml": "<base64>" }
 *   Response: { IsSuccess, ErrorMessage, StatusCode, Data, IsFailure }
 */
const axios = require('axios');
const { getAuthHeaders } = require('./sieg-auth');
const { gerarXmlNFe } = require('./sieg-nfe-xml');
const { gerarXmlDPS } = require('./sieg-nfse-xml');

const SIEG_BASE = 'https://api.sieg.com';

/**
 * Enviar NF-e XML ao SIEG
 * A SIEG assina o XML com certificado, envia a SEFAZ e retorna resultado
 * 
 * Schema: { "Xml": "<xml em base64>" }
 * Response: { IsSuccess, Data, ErrorMessage, StatusCode, IsFailure }
 */
async function enviarNFe(dadosOdoo) {
  const xml = gerarXmlNFe(dadosOdoo);
  console.log('[SIEG-API] Enviando NF-e XML (' + xml.length + ' chars)');
  console.log('[SIEG-API] XML COMPLETO GERADO:\n' + xml);

  // Minificar XML: remover whitespace entre tags (o SIEG exige formato compacto)
  // Preserva espaços dentro de texto de tags (xNome, xLgr, infCpl, etc.)
  const xmlMin = xml.replace(/>\s+</g, '><');
  console.log('[SIEG-API] XML minificado: ' + xmlMin.length + ' chars (economia: ' + (xml.length - xmlMin.length) + ')');

  const headers = await getAuthHeaders();
  let resp;
  try {
    resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
      Xml: Buffer.from(xmlMin, 'utf-8').toString('base64'),
    }, { headers, timeout: 60000, validateStatus: function(s) { return s < 500; } });
  } catch (err) {
    console.error('[SIEG-API] Erro de conexao SIEG:', err.message);
    throw err;
  }

  const result = resp.data;
  const httpStatus = resp.status;
  console.log('[SIEG-API] Resposta send-xml HTTP ' + httpStatus + ':', JSON.stringify(result).slice(0, 2000));

  // Se 4xx (ex: 409), logar detalhes completos do erro SIEG
  if (httpStatus >= 400 && httpStatus < 500) {
    var errMsg = result.ErrorMessage || result.Message || result.message || '';
    var errDetail = result.ModelState || result.Errors || result.errors || null;
    console.error('[SIEG-API] *** ERRO SIEG HTTP ' + httpStatus + ' ***');
    console.error('[SIEG-API] ErrorMessage: ' + errMsg);
    if (errDetail) console.error('[SIEG-API] Detalhes: ' + JSON.stringify(errDetail).slice(0, 1000));
    console.error('[SIEG-API] Resposta completa: ' + JSON.stringify(result).slice(0, 3000));
  }

  // Verificar resultado no formato SIEG (PascalCase)
  var sucesso = !!(result.IsSuccess === true);

  return {
    sucesso: sucesso,
    httpStatus: httpStatus,
    xmlEnviado: xml,
    resposta: result,
    data: result.Data || null,
    erro: result.ErrorMessage || result.Message || null,
    statusCode: result.StatusCode || null,
  };
}

/**
 * Emitir NFS-e via SIEG
 * Envia DPS XML, SIEG processa e retorna resultado
 */
async function emitirNFSe(dadosOdoo) {
  const xml = gerarXmlDPS(dadosOdoo);
  console.log('[SIEG-API] Emitindo NFS-e DPS (' + xml.length + ' chars)');
  console.log('[SIEG-API] DPS XML gerado (primeiros 2000 chars):\n' + xml.substring(0, 2000));

  const headers = await getAuthHeaders();
  let resp;
  try {
    resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
      Xml: Buffer.from(xml, 'utf-8').toString('base64'),
    }, { headers, timeout: 60000, validateStatus: function(s) { return s < 500; } });
  } catch (err) {
    console.error('[SIEG-API] Erro de conexao SIEG:', err.message);
    throw err;
  }

  const result = resp.data;
  const httpStatus = resp.status;
  console.log('[SIEG-API] Resposta send-xml NFS-e HTTP ' + httpStatus + ':', JSON.stringify(result).slice(0, 2000));

  // Se 4xx, logar detalhes completos
  if (httpStatus >= 400 && httpStatus < 500) {
    var errMsg = result.ErrorMessage || result.Message || result.message || '';
    console.error('[SIEG-API] *** ERRO SIEG NFS-e HTTP ' + httpStatus + ' ***');
    console.error('[SIEG-API] ErrorMessage: ' + errMsg);
    console.error('[SIEG-API] Resposta completa: ' + JSON.stringify(result).slice(0, 3000));
  }

  var sucesso = !!(result.IsSuccess === true);

  return {
    sucesso: sucesso,
    httpStatus: httpStatus,
    xmlEnviado: xml,
    resposta: result,
    data: result.Data || null,
    erro: result.ErrorMessage || result.Message || null,
    statusCode: result.StatusCode || null,
  };
}

/**
 * Gerar DANFE (PDF) a partir do XML autorizado
 */
async function gerarDanfe(xmlAutorizado) {
  console.log('[SIEG-API] Gerando DANFE via XML (' + xmlAutorizado.length + ' chars)');

  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/gerarDanfeViaXml', {
    Xml: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
  }, { headers, timeout: 30000 });

  return resp.data;
}

/**
 * Gerar DANFSE (PDF) a partir do XML autorizado
 */
async function gerarDanfse(xmlAutorizado) {
  console.log('[SIEG-API] Gerando DANFSE via XML (' + xmlAutorizado.length + ' chars)');

  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/gerarDanfseViaXml', {
    Xml: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
  }, { headers, timeout: 30000 });

  return resp.data;
}

/**
 * Emitir nota fiscal (auto-detect NF-e ou NFS-e)
 * Funcao principal chamada pela rota e pelo polling
 */
async function emitirNota(dadosOdoo) {
  let tipo = dadosOdoo.tipo;
  if (!tipo) {
    tipo = (dadosOdoo.service && dadosOdoo.lines && dadosOdoo.lines.every(function(l) { return l.detailed_type === 'service'; })) ? 'nfse' : 'nfe';
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
      var xmlAutorizado = resultado.data;
      // Se data vier em base64, decodificar
      if (xmlAutorizado.length < 500 && xmlAutorizado.indexOf('<?xml') === -1) {
        xmlAutorizado = Buffer.from(xmlAutorizado, 'base64').toString('utf-8');
      }
      
      if (tipo === 'nfse') {
        resultado.pdfBase64 = (await gerarDanfse(xmlAutorizado));
      } else {
        resultado.pdfBase64 = (await gerarDanfe(xmlAutorizado));
      }
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
  gerarDanfe,
  gerarDanfse,
  emitirNota,
};
