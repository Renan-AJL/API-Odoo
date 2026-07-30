/**
 * services/sieg-auth.js — SIEG OAuth2 Token Management
 * Gerencia access_token e refresh_token para a API SIEG (engine)
 */
const axios = require('axios');
const config = require('../config');

const SIEG_TOKEN_URL = 'https://api.sieg.com/api/v1/oauth/generate-token';
const SIEG_REFRESH_URL = 'https://api.sieg.com/api/v1/oauth/refresh';
const SIEG_JWT_URL = 'https://api.sieg.com/api/v1/create-jwt';

// In-memory token store (safe for single-instance Render deploy)
let _tokenState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0, // Date.now() when token expires
};

// JWT token cache (server-to-server auth via clientId + clientSecret)
let _jwtCache = {
  token: null,
  expiresAt: 0,
};

/**
 * Exchange OAuth authorization code for tokens
 */
async function exchangeCode(code) {
  try {
    const resp = await axios.post(SIEG_TOKEN_URL, {
      accessToken: code,
      state: '',
      redirectUri: `${config.BASE_URL || 'https://odoo-api-tudoentregue.onrender.com'}/callback/sieg`,
    });
    const data = resp.data;
    _tokenState.accessToken = data.access_token || data.accessToken;
    _tokenState.refreshToken = data.refresh_token || data.refreshToken;
    _tokenState.expiresAt = Date.now() + ((data.expires_in || data.expiresIn || 3600) * 1000) - 60000; // 1min buffer
    console.log('[SIEG-AUTH] Token obtido com sucesso, expira em:', new Date(_tokenState.expiresAt).toISOString());
    return _tokenState;
  } catch (err) {
    console.error('[SIEG-AUTH] Erro ao trocar code por token:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Refresh the access token
 */
async function refreshToken() {
  if (!_tokenState.refreshToken) {
    throw new Error('[SIEG-AUTH] Nenhum refresh_token disponivel. Faca autorizacao OAuth primeiro.');
  }
  try {
    const resp = await axios.post(SIEG_REFRESH_URL, {
      token: _tokenState.refreshToken,
    });
    const data = resp.data;
    _tokenState.accessToken = data.access_token || data.accessToken;
    _tokenState.refreshToken = data.refresh_token || data.refreshToken || _tokenState.refreshToken;
    _tokenState.expiresAt = Date.now() + ((data.expires_in || data.expiresIn || 3600) * 1000) - 60000;
    console.log('[SIEG-AUTH] Token renovado com sucesso');
    return _tokenState;
  } catch (err) {
    console.error('[SIEG-AUTH] Erro ao renovar token:', err.response?.data || err.message);
    _tokenState.accessToken = null; // force re-auth
    throw err;
  }
}

/**
 * Get valid access token, refreshing if needed
 */
async function getAccessToken() {
  if (_tokenState.accessToken && Date.now() < _tokenState.expiresAt) {
    return _tokenState.accessToken;
  }
  // Try refresh
  if (_tokenState.refreshToken) {
    try {
      await refreshToken();
      return _tokenState.accessToken;
    } catch (e) {
      console.error('[SIEG-AUTH] Refresh falhou, necessario re-autorizar');
    }
  }
  throw new Error('[SIEG-AUTH] Sem token valido. Configure OAuth SIEG.');
}

/**
 * Create JWT for SIEG API (alternative auth method)
 */
async function createJwt() {
  const clientId = config.sieg && config.sieg.clientId;
  const clientSecret = config.sieg && config.sieg.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error('[SIEG-AUTH] SIEG_CLIENT_ID e SIEG_CLIENT_SECRET nao configurados');
  }

  // Try multiple field name formats — SIEG docs are inconsistent about casing
  var formats = [
    { ClientId: clientId, SecretKey: clientSecret },
    { clientId: clientId, secretKey: clientSecret },
    { client_id: clientId, client_secret: clientSecret },
  ];
  var lastErr = null;

  for (var i = 0; i < formats.length; i++) {
    var payload = formats[i];
    var keys = Object.keys(payload).join(', ');
    try {
      console.log('[SIEG-AUTH] Tentativa JWT #' + (i+1) + ' com campos: ' + keys + ' (ID=' + clientId.substring(0,8) + '...)');
      const resp = await axios.post(SIEG_JWT_URL, payload, { timeout: 15000 });
      const data = resp.data;
      const jwtToken = data.token || data.jwt || data.access_token || data.accessToken;
      if (jwtToken) {
        _jwtCache.token = jwtToken;
        _jwtCache.expiresAt = Date.now() + ((data.expires_in || data.expiresIn || 3600) * 1000) - 60000;
        console.log('[SIEG-AUTH] JWT obtido com sucesso (formato #' + (i+1) + '), expira em:', new Date(_jwtCache.expiresAt).toISOString());
      }
      return data;
    } catch (err) {
      console.error('[SIEG-AUTH] Formato #' + (i+1) + ' (' + keys + ') falhou:', err.response?.data || err.message);
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Get authorization headers for SIEG API calls
 */
async function getAuthHeaders() {
  // Strategy 1: Use cached JWT (server-to-server, no browser needed)
  if (_jwtCache.token && Date.now() < _jwtCache.expiresAt) {
    return {
      'Authorization': 'Bearer ' + _jwtCache.token,
      'Content-Type': 'application/json',
    };
  }
  // Strategy 2: Try to get new JWT via clientId + clientSecret
  if (config.sieg && config.sieg.clientId && config.sieg.clientSecret) {
    try {
      await createJwt();
      if (_jwtCache.token) {
        return {
          'Authorization': 'Bearer ' + _jwtCache.token,
          'Content-Type': 'application/json',
        };
      }
    } catch (jwtErr) {
      console.warn('[SIEG-AUTH] JWT falhou, tentando OAuth:', jwtErr.message);
    }
  }
  // Strategy 3: Fall back to OAuth token
  const token = await getAccessToken();
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  };
}

/**
 * Manual token setter (for initial setup / testing)
 */
function setTokens(accessToken, refreshToken, expiresIn = 3600) {
  _tokenState.accessToken = accessToken;
  _tokenState.refreshToken = refreshToken;
  _tokenState.expiresAt = Date.now() + (expiresIn * 1000) - 60000;
}

/**
 * Get current token state (for debugging)
 */
function getTokenState() {
  return {
    hasAccessToken: !!_tokenState.accessToken,
    hasRefreshToken: !!_tokenState.refreshToken,
    expiresAt: _tokenState.expiresAt,
    isExpired: Date.now() >= _tokenState.expiresAt,
    hasJwt: !!_jwtCache.token,
    jwtExpired: Date.now() >= _jwtCache.expiresAt,
    jwtExpiresAt: _jwtCache.expiresAt,
  };
}

module.exports = {
  exchangeCode,
  refreshToken,
  getAccessToken,
  getAuthHeaders,
  createJwt,
  setTokens,
  getTokenState,
};
