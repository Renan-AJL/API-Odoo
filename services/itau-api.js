const axios = require('axios');
const https = require('https');
const config = require('../config');

// === AJL 28/11/2026 (v1.2.49-itau-v3-gateway): fallback de host ===
// Migracao p/ credencial nova: PRIMARY = api.gateway.itau.com.br (gateway
// novo do e-mail IT-000267855); FALLBACK = secure.api.itau (legado, envs
// antigos). Regras:
//  - 403/404 no gateway novo -> tenta legado (rota/escopo nao existe aí)
//  - conexao caiu (ENOTFOUND/ECONNREFUSED/EAI_AGAIN/socket hang up) -> tenta
//    legado (a requisicao nao chegou no banco; seguro ate pra POST/PATCH)
//  - 401 -> NAO faz fallback (problema de token/credencial; o retry do
//    service invalida e reobtem o token)
//  - 5xx / timeout (ECONNABORTED) -> fallback so em GET (POST/PATCH podem
//    ter efetivado o registro no banco — re-tentar arriscaria duplicidade)
//  - sticky: host que funcionou e tentado primeiro nas chamadas seguintes
var _stickyBase = {};

function _parBases(kind, primary, fallback) {
  if (!fallback || fallback === primary) return [primary];
  if (_stickyBase[kind] === fallback) return [fallback, primary];
  return [primary, fallback];
}

function _podeFallback(method, err) {
  if (err && err.response && err.response.status) {
    var st = err.response.status;
    if (st === 403 || st === 404) return true;      // rota/escopo ausente nesse gateway
    if (st === 401) return false;                   // token — retry do service resolve
    if (st >= 500) return method === 'GET';         // GET idempotente pode re-tentar
    return false;
  }
  // sem resposta HTTP: timeout -> so GET; demais erros de conexao -> seguro
  var msg = String((err && err.message) || '');
  if (msg.indexOf('ECONNABORTED') >= 0 || msg.indexOf('timeout') >= 0) return method === 'GET';
  return true;
}

function _headers(accessToken, extra) {
  const h = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json; charset=utf-8',
    'Accept': 'application/json',
    'x-itau-apikey': config.itau.clientId,
    'x-itau-correlationID': String(Date.now()),
  };
  if (extra) Object.assign(h, extra);
  return h;
}

function _mtlsAgent() {
  const mtls = config.createMtlsConfig();
  return mtls.hasMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;
}

async function _tentar(method, url, payload, headers) {
  const httpsAgent = _mtlsAgent();
  if (method === 'GET') {
    return await axios.get(url, { headers, httpsAgent, timeout: 30000 });
  }
  if (method === 'PATCH') {
    return await axios.patch(url, payload || {}, { headers, httpsAgent, timeout: 30000 });
  }
  if (method === 'PUT') {
    return await axios.put(url, payload, { headers, httpsAgent, timeout: 30000 });
  }
  return await axios.post(url, payload, { headers, httpsAgent, timeout: 30000 });
}

// Executa method com fallback de host. Retorna response.data.
async function _comFallback(kind, method, primary, fallback, endpoint, payload, extraHeaders, accessToken) {
  const bases = _parBases(kind, primary, fallback);
  let ultimoErro = null;
  for (var i = 0; i < bases.length; i++) {
    const url = bases[i] + endpoint;
    console.log('[ITAU-API] ' + kind + ' ' + method, url + (i > 0 ? ' (fallback)' : ''));
    try {
      const response = await _tentar(method, url, payload, _headers(accessToken, extraHeaders));
      _stickyBase[kind] = bases[i];
      return response.data;
    } catch (error) {
      ultimoErro = error;
      if (error.response) {
        console.error('[ITAU-API] ERRO ' + kind + ' ' + method + ' ' + error.response.status + ':', JSON.stringify(error.response.data).substring(0, 600));
      } else {
        console.error('[ITAU-API] ERRO ' + kind + ' ' + method + ' conexao:', error.message);
      }
      if (i < bases.length - 1 && _podeFallback(method, error)) {
        console.warn('[ITAU-API] ' + kind + ': caindo p/ host de fallback');
        continue;
      }
      break;
    }
  }
  if (ultimoErro && ultimoErro.response) {
    const msg = JSON.stringify(ultimoErro.response.data);
    throw new Error(kind + ' ' + ultimoErro.response.status + ': ' + msg);
  }
  throw new Error(kind + ' conexao: ' + (ultimoErro ? ultimoErro.message : 'desconhecido'));
}

/**
 * POST ao BoleCode (emissao de boleto/bolecode)
 */
async function callBolecode(accessToken, endpoint, payload) {
  const mtls = config.createMtlsConfig();
  console.log('[ITAU-API] mTLS:', mtls.hasMtls ? 'SIM (' + config.mtls.cert.length + ' chars cert' + (config.mtls.ca ? ' + CA' : '') + ')' : 'NAO');
  return _comFallback('BoleCode', 'POST', config.itau.bolecodeBaseUrl, config.itau.bolecodeBaseUrlFallback, endpoint, payload, null, accessToken);
}

/**
 * PUT request ao BoleCode (para cancelamentos, etc.)
 */
async function callBolecodePut(accessToken, endpoint, payload) {
  return _comFallback('BoleCode PUT', 'PUT', config.itau.bolecodeBaseUrl, config.itau.bolecodeBaseUrlFallback, endpoint, payload, null, accessToken);
}

/**
 * GET request ao BoleCode (para consultas)
 */
async function callBolecodeGet(accessToken, endpoint) {
  return _comFallback('BoleCode GET', 'GET', config.itau.bolecodeBaseUrl, config.itau.bolecodeBaseUrlFallback, endpoint, null, null, accessToken);
}

/**
 * PUT/GET request ao PIX Itau (para cobranca PIX, webhook, etc.)
 */
async function callPix(method, endpoint, payload) {
  const { getAccessToken } = require('./itau-auth');
  const accessToken = await getAccessToken();
  return _comFallback('PIX', method === 'GET' ? 'GET' : 'PUT', config.itau.pixBaseUrl, config.itau.pixBaseUrlFallback, endpoint, payload, null, accessToken);
}

/**
 * PATCH request ao Cash Management Itau (para baixa/cancelamento de boletos)
 * Endpoint: /cash_management/v2/boletos/{idBoleto}/baixa
 */
async function callCashManagementPatch(accessToken, endpoint, body) {
  return _comFallback('CashMgmt', 'PATCH', config.itau.cashManagementBaseUrl, config.itau.cashManagementBaseUrlFallback, endpoint, body, { 'x-itau-flowID': 'boleto-baixa' }, accessToken);
}

module.exports = { callBolecode, callBolecodeGet, callBolecodePut, callPix, callCashManagementPatch };
