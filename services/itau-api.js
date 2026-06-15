const axios = require('axios');
const https = require('https');
const config = require('../config');

async function callBolecode(accessToken, endpoint, payload) {
  const mtls = config.createMtlsConfig();
  const baseUrl = config.itau.bolecodeBaseUrl;
  const url = baseUrl + endpoint;

  // api.itau.com.br usa OAuth2 bearer + x-itau-apikey (sem mTLS)
  // secure.api.itau usa mTLS
  const useMtls = mtls.hasMtls && baseUrl.includes('secure.api.itau');
  const httpsAgent = useMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;

  console.log('[ITAU-API] BoleCode POST', url);
  console.log('[ITAU-API] mTLS para BoleCode:', useMtls ? 'SIM' : 'NAO (OAuth2 only)');

  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json; charset=utf-8',
    'Accept': 'application/json',
    'x-itau-apikey': config.itau.clientId,
    'x-itau-correlationID': String(Date.now()),
  };
  try {
    const response = await axios.post(url, payload, { headers, httpsAgent, timeout: 30000 });
    return response.data;
  } catch (error) {
    if (error.response) {
      const msg = JSON.stringify(error.response.data);
      console.error('[ITAU-API] ERRO ' + error.response.status + ':', msg);
      throw new Error('BoleCode ' + error.response.status + ': ' + msg);
    }
    throw new Error('BoleCode conexao: ' + error.message);
  }
}

/**
 * GET request ao BoleCode (para consultas)
 */
async function callBolecodeGet(accessToken, endpoint) {
  const mtls = config.createMtlsConfig();
  const baseUrl = config.itau.bolecodeBaseUrl;
  const url = baseUrl + endpoint;

  const useMtls = mtls.hasMtls && baseUrl.includes('secure.api.itau');
  const httpsAgent = useMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;

  console.log('[ITAU-API] BoleCode GET', url);
  console.log('[ITAU-API] mTLS para BoleCode GET:', useMtls ? 'SIM' : 'NAO');

  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Accept': 'application/json',
    'x-itau-apikey': config.itau.clientId,
    'x-itau-correlationID': String(Date.now()),
  };
  try {
    const response = await axios.get(url, { headers, httpsAgent, timeout: 30000 });
    return response.data;
  } catch (error) {
    if (error.response) {
      const msg = JSON.stringify(error.response.data);
      console.error('[ITAU-API] ERRO GET ' + error.response.status + ':', msg);
      throw new Error('BoleCode GET ' + error.response.status + ': ' + msg);
    }
    throw new Error('BoleCode conexao: ' + error.message);
  }
}

/**
 * PUT/GET request ao PIX Itau (para cobranca PIX, webhook, etc.)
 */
async function callPix(method, endpoint, payload) {
  const { getAccessToken } = require('./itau-auth');
  const accessToken = await getAccessToken();
  const mtls = config.createMtlsConfig();
  const baseUrl = config.itau.pixBaseUrl;
  const url = baseUrl + endpoint;

  const useMtls = mtls.hasMtls && baseUrl.includes('secure.api.itau');
  const httpsAgent = useMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;

  console.log('[ITAU-API] PIX ' + method, url);
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json; charset=utf-8',
    'Accept': 'application/json',
    'x-itau-apikey': config.itau.clientId,
    'x-itau-correlationID': String(Date.now()),
  };
  try {
    let response;
    if (method === 'GET') {
      response = await axios.get(url, { headers, httpsAgent, timeout: 30000 });
    } else {
      response = await axios.put(url, payload, { headers, httpsAgent, timeout: 30000 });
    }
    return response.data;
  } catch (error) {
    if (error.response) {
      const msg = JSON.stringify(error.response.data);
      console.error('[ITAU-API] ERRO PIX ' + method + ' ' + error.response.status + ':', msg);
      throw new Error('PIX ' + method + ' ' + error.response.status + ': ' + msg);
    }
    throw new Error('PIX ' + method + ' conexao: ' + error.message);
  }
}

module.exports = { callBolecode, callBolecodeGet, callPix };