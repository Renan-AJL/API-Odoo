/**
 * services/sieg-api.js — Comunicação com API SIEG (up.sieg.com)
 * 
 * Doc oficial: https://ajuda.sieg.com/hc/pt-br/articles/integracao-api-sieg
 * 
 * Autenticação: api_key como query parameter
 * URL base: https://up.sieg.com
 * 
 * Endpoints:
 *   - EnviarXml: POST /EnviarXml?api_key={key}  body: {"Xml": "base64"}
 */
const axios = require('axios');
const { gerarXmlNFe } = require('./sieg-nfe-xml');
const { gerarXmlDPS } = require('./sieg-nfse-xml');
const config = require('../config');

const SIEG_BASE = 'https://up.sieg.com';

/**
 * Enviar NF-e XML ao SIEG via API up.sieg.com
 */
async function enviarNFe(dadosOdoo) {
  const xml = gerarXmlNFe(dadosOdoo);
  console.log('[SIEG-API] Enviando NF-e XML (' + xml.length + ' chars) via up.sieg.com');

  const apiKey = config.sieg && config.sieg.apiKey;
  if (!apiKey) throw new Error('[SIEG-API] SIEG_API_KEY nao configurada no Render');

  const url = SIEG_BASE + '/EnviarXml?api_key=' + encodeURIComponent(apiKey);
  const resp = await axios.post(url, {
    Xml: Buffer.from(xml, 'utf-8').toString('base64'),
  }, { timeout: 60000 });

  const result = resp.data;
  console.log('[SIEG-API] Resposta EnviarXml:', JSON.stringify(result).slice(0, 500));

  // SIEG up.sieg.com retorna "Importado com sucesso" ou erro
  var sucesso = (resp.status === 200 && (typeof result === 'string' && result.indexOf('sucesso') >= 0))
    || (result && (result.status === 200 || result.Status === 200 || result.sucesso));

  return {
    sucesso: !!sucesso,
    xmlEnviado: xml,
    resposta: result,
    status: resp.status,
  };
}

/**
 * Emitir NFS-e via SIEG (mesmo endpoint EnviarXml)
 */
async function emitirNFSe(dadosOdoo) {
  const xml = gerarXmlDPS(dadosOdoo);
  console.log('[SIEG-API] Emitindo NFS-e DPS (' + xml.length + ' chars) via up.sieg.com');

  const apiKey = config.sieg && config.sieg.apiKey;
  if (!apiKey) throw new Error('[SIEG-API] SIEG_API_KEY nao configurada no Render');

  const url = SIEG_BASE + '/EnviarXml?api_key=' + encodeURIComponent(apiKey);
  const resp = await axios.post(url, {
    Xml: Buffer.from(xml, 'utf-8').toString('base64'),
  }, { timeout: 60000 });

  const result = resp.data;
  console.log('[SIEG-API] Resposta EnviarXml NFS-e:', JSON.stringify(result).slice(0, 500));

  var sucesso = (resp.status === 200 && (typeof result === 'string' && result.indexOf('sucesso') >= 0))
    || (result && (result.status === 200 || result.Status === 200 || result.sucesso));

  return {
    sucesso: !!sucesso,
    xmlEnviado: xml,
    resposta: result,
    status: resp.status,
  };
}

/**
 * Emitir nota fiscal (auto-detect NF-e ou NFS-e)
 */
async function emitirNota(dadosOdoo) {
  let tipo = dadosOdoo.tipo;
  if (!tipo) {
    tipo = (dadosOdoo.service && dadosOdoo.lines?.every(l => l.detailed_type === 'service')) ? 'nfse' : 'nfe';
  }

  let resultado;
  if (tipo === 'nfse') {
    resultado = await emitirNFSe(dadosOdoo);
  } else {
    resultado = await enviarNFe(dadosOdoo);
  }

  resultado.tipo = tipo;
  return resultado;
}

module.exports = {
  enviarNFe,
  emitirNFSe,
  emitirNota,
};
