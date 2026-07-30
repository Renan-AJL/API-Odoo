/**
 * services/sieg-auth.js — SIEG JWT Authentication v3.0
 * 
 * O Swagger do SIEG mostra /api/v1/create-jwt com:
 *   - consumes: [] (sem body definido)
 *   - parameters: [] (sem params definidos)
 * 
 * Isso indica que a autenticacao pode ser via:
 *   1. Basic Auth header (Authorization: Basic base64(clientId:clientSecret))
 *   2. Query parameters (?ClientId=X&SecretKey=Y)
 *   3. Form-encoded body (mesmo sem consumes definido)
 *   4. JSON body com PascalCase (SecretKey/ClientId)
 *   5. JSON body com camelCase (secretKey/clientId)
 */
const axios = require('axios');

const SIEG_BASE = 'https://api.sieg.com';
const SIEG_JWT_URL = SIEG_BASE + '/api/v1/create-jwt';

// In-memory cache
let _jwtCache = {
  token: null,
  expiresAt: 0,
};

/**
 * Get clientId and clientSecret from config
 */
function getCredentials() {
  try {
    var config = require('../config');
    return {
      clientId: config.sieg && config.sieg.clientId,
      clientSecret: config.sieg && config.sieg.clientSecret,
    };
  } catch (e) {
    // Fallback to env vars
    return {
      clientId: process.env.SIEG_CLIENT_ID,
      clientSecret: process.env.SIEG_CLIENT_SECRET,
    };
  }
}

/**
 * Estrategia 1: Basic Auth Header
 * Authorization: Basic base64(clientId:clientSecret)
 */
async function tryBasicAuth(clientId, clientSecret) {
  console.log('[SIEG-AUTH] Tentativa 1: Basic Auth header...');
  var creds = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  var resp = await axios.post(SIEG_JWT_URL, null, {
    headers: {
      'Authorization': 'Basic ' + creds,
    },
    timeout: 15000,
  });
  return resp.data;
}

/**
 * Estrategia 2: Query Parameters
 * GET /api/v1/create-jwt?ClientId=X&SecretKey=Y
 */
async function tryQueryParams(clientId, clientSecret) {
  console.log('[SIEG-AUTH] Tentativa 2: Query parameters...');
  var resp = await axios.get(SIEG_JWT_URL, {
    params: {
      ClientId: clientId,
      SecretKey: clientSecret,
    },
    timeout: 15000,
  });
  return resp.data;
}

/**
 * Estrategia 3: Form-encoded POST
 * Content-Type: application/x-www-form-urlencoded
 */
async function tryFormEncoded(clientId, clientSecret) {
  console.log('[SIEG-AUTH] Tentativa 3: Form-encoded POST...');
  var params = new URLSearchParams();
  params.append('ClientId', clientId);
  params.append('SecretKey', clientSecret);
  var resp = await axios.post(SIEG_JWT_URL, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 15000,
  });
  return resp.data;
}

/**
 * Estrategia 4: JSON PascalCase (SecretKey/ClientId)
 */
async function tryJsonPascal(clientId, clientSecret) {
  console.log('[SIEG-AUTH] Tentativa 4: JSON PascalCase...');
  var resp = await axios.post(SIEG_JWT_URL, {
    ClientId: clientId,
    SecretKey: clientSecret,
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return resp.data;
}

/**
 * Estrategia 5: JSON camelCase (clientId/secretKey)
 */
async function tryJsonCamel(clientId, clientSecret) {
  console.log('[SIEG-AUTH] Tentativa 5: JSON camelCase...');
  var resp = await axios.post(SIEG_JWT_URL, {
    clientId: clientId,
    secretKey: clientSecret,
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return resp.data;
}

/**
 * Estrategia 6: Query params com camelCase
 */
async function tryQueryCamel(clientId, clientSecret) {
  console.log('[SIEG-AUTH] Tentativa 6: Query params camelCase...');
  var resp = await axios.get(SIEG_JWT_URL, {
    params: {
      clientId: clientId,
      secretKey: clientSecret,
    },
    timeout: 15000,
  });
  return resp.data;
}

/**
 * Extrair token JWT da resposta (tenta varios campos)
 */
function extractToken(data) {
  if (!data) return null;
  // Pode vir como string direta, ou dentro de um objeto
  if (typeof data === 'string' && data.length > 20) return data;
  return data.token || data.jwt || data.access_token || data.accessToken || data.Token || data.Jwt || null;
}

/**
 * Criar JWT tentando multiplas estrategias em sequencia
 * Para na primeira que funcionar.
 */
async function createJwt() {
  var creds = getCredentials();
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('[SIEG-AUTH] SIEG_CLIENT_ID e SIEG_CLIENT_SECRET nao configurados nas env vars');
  }

  console.log('[SIEG-AUTH] ClientId: ***' + creds.clientId.slice(-4) + ' | Tentando autenticacao...');

  var strategies = [
    tryBasicAuth,
    tryQueryParams,
    tryFormEncoded,
    tryJsonPascal,
    tryJsonCamel,
    tryQueryCamel,
  ];

  var lastError = null;
  for (var i = 0; i < strategies.length; i++) {
    try {
      var result = await strategies[i](creds.clientId, creds.clientSecret);
      console.log('[SIEG-AUTH] Estrategia ' + (i + 1) + ' retornou:', JSON.stringify(result).slice(0, 300));
      
      var token = extractToken(result);
      if (token) {
        // Estimar expiracao (padrao: 1h)
        var expiresIn = (result.expires_in || result.expiresIn || 3600);
        _jwtCache.token = token;
        _jwtCache.expiresAt = Date.now() + (expiresIn * 1000) - 60000;
        console.log('[SIEG-AUTH] JWT obtido com sucesso (estrategia ' + (i + 1) + ')! Expira:', new Date(_jwtCache.expiresAt).toISOString());
        console.log('[SIEG-AUTH] Token (primeiros 50 chars):', token.substring(0, 50) + '...');
        return { token: token, estrategia: i + 1, raw: result };
      }
      
      // Se a resposta veio mas nao tem token, pode ser sucesso com formato inesperado
      // Vamos logar e continuar tentando
      console.log('[SIEG-AUTH] Estrategia ' + (i + 1) + ' retornou resposta mas sem token reconhecido. Continuando...');
    } catch (err) {
      var errMsg = err.response?.data || err.message;
      console.log('[SIEG-AUTH] Estrategia ' + (i + 1) + ' falhou:', typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg).slice(0, 200));
      lastError = err;
    }
  }

  throw new Error('[SIEG-AUTH] Todas as 6 estrategias de auth falharam. Ultimo erro: ' + (lastError?.response?.data || lastError?.message));
}

/**
 * Get authorization headers for SIEG API calls
 */
async function getAuthHeaders() {
  // Return cached token if valid
  if (_jwtCache.token && Date.now() < _jwtCache.expiresAt) {
    return {
      'Authorization': 'Bearer ' + _jwtCache.token,
      'Content-Type': 'application/json',
    };
  }

  // Try to get new JWT
  var result = await createJwt();
  return {
    'Authorization': 'Bearer ' + result.token,
    'Content-Type': 'application/json',
  };
}

/**
 * Get current JWT state (for debugging)
 */
function getTokenState() {
  return {
    hasToken: !!_jwtCache.token,
    expiresAt: _jwtCache.expiresAt,
    isExpired: Date.now() >= _jwtCache.expiresAt,
    tokenPreview: _jwtCache.token ? _jwtCache.token.substring(0, 30) + '...' : null,
  };
}

/**
 * Invalidate cache (for testing / force re-auth)
 */
function invalidateCache() {
  _jwtCache.token = null;
  _jwtCache.expiresAt = 0;
}

module.exports = {
  createJwt,
  getAuthHeaders,
  getTokenState,
  invalidateCache,
};
