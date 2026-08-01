/**
 * services/sieg-auth.js — SIEG Authentication v7.0
 * 
 * Documentacao oficial SIEG (Sistemas Externos):
 *   https://integracoes.sieg.com/sistema-externo/docs
 * 
 * AUTENTICACAO EM DOIS NIVEIS:
 *   Nivel 1 - JWT: Identifica o sistema externo (Software House)
 *     POST https://api.sieg.com/api/v1/create-jwt
 *     Headers: X-Client-Id + X-Secret-Key
 *     Resposta: JWT string pura (24h validade)
 * 
 *   Nivel 2 - OAuth 2.0: Autoriza acesso a dados do cliente (empresa)
 *     1. Usuario abre: https://app.sieg.com/AuthorizeAccess.aspx
 *        ?clientId={CLIENT_ID}&state={STATE}&accessLevel=write
 *     2. SIEG redireciona para callback com token temporario (10min)
 *     3. POST /api/v1/oauth/generate-token (AccessToken + State + RedirectUri)
 *        Headers: X-Client-Id + X-Secret-Key
 *        Response: { IsSuccess, Data: { AccessToken definitive } }
 *     4. Token definitivo: 30 dias, renovar via /api/v1/oauth/refresh
 * 
 * TODAS as requisicoes a API precisam:
 *   Authorization: Bearer {jwt_token}
 *   X-OAuth-Token: {oauth_definitive_token}
 */
const axios = require('axios');

const SIEG_JWT_URL = 'https://api.sieg.com/api/v1/create-jwt';
const SIEG_OAUTH_AUTHORIZE_URL = 'https://app.sieg.com/AuthorizeAccess.aspx';
const SIEG_OAUTH_GENERATE = 'https://api.sieg.com/api/v1/oauth/generate-token';
const SIEG_OAUTH_REFRESH = 'https://api.sieg.com/api/v1/oauth/refresh';
const SIEG_OAUTH_REVOKE = 'https://api.sieg.com/api/v1/oauth/revoke';

// In-memory cache
var _jwtCache = { token: null, expiresAt: 0 };
var _oauthCache = { accessToken: null, refreshToken: null, expiresAt: 0 };

function getCredentials() {
  try {
    var config = require('../config');
    return {
      clientId: config.sieg && config.sieg.clientId,
      clientSecret: config.sieg && config.sieg.clientSecret,
      apiKey: config.sieg && config.sieg.apiKey,
      callbackUrl: config.sieg && config.sieg.callbackUrl,
    };
  } catch (e) {
    return {
      clientId: process.env.SIEG_CLIENT_ID,
      clientSecret: process.env.SIEG_CLIENT_SECRET,
      apiKey: process.env.SIEG_API_KEY,
      callbackUrl: process.env.SIEG_CALLBACK_URL,
    };
  }
}

/**
 * Headers base para autenticacao do sistema (Client ID + Secret Key)
 * Usados nos endpoints de JWT e OAuth (generate-token, refresh, revoke)
 */
function getSystemHeaders() {
  var creds = getCredentials();
  return {
    'X-Client-Id': creds.clientId,
    'X-Secret-Key': creds.clientSecret,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

/**
 * Gerar JWT via headers X-Client-Id + X-Secret-Key
 * Resposta da SIEG: string JWT pura (NAO e um objeto JSON)
 */
async function createJwt() {
  var creds = getCredentials();
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('[SIEG-AUTH] SIEG_CLIENT_ID e SIEG_CLIENT_SECRET nao configurados');
  }

  console.log('[SIEG-AUTH] Gerando JWT... (Client: ***' + creds.clientId.slice(-4) + ')');

  var resp = await axios.post(SIEG_JWT_URL, null, {
    headers: getSystemHeaders(),
    timeout: 15000,
  });

  var token = extractToken(resp.data);
  if (!token) {
    console.error('[SIEG-AUTH] Resposta sem token:', JSON.stringify(resp.data).slice(0, 300));
    throw new Error('[SIEG-AUTH] Resposta do create-jwt nao contem token');
  }

  _jwtCache.token = token;
  _jwtCache.expiresAt = Date.now() + (24 * 60 * 60 * 1000) - (5 * 60 * 1000);

  console.log('[SIEG-AUTH] JWT obtido! Expira:', new Date(_jwtCache.expiresAt).toISOString());
  return { token: token };
}

/**
 * Obter headers completos para chamadas API SIEG
 * 
 * Conforme documentacao, TODAS as requisicoes precisam de:
 *   Authorization: Bearer {jwt}
 *   X-OAuth-Token: {oauth_token}
 */
async function getAuthHeaders() {
  // Garantir JWT valido
  if (!_jwtCache.token || Date.now() >= _jwtCache.expiresAt) {
    await createJwt();
  }

  var headers = {
    'Authorization': 'Bearer ' + _jwtCache.token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // X-OAuth-Token (obrigatorio para acessar dados de cliente)
  if (_oauthCache.accessToken) {
    headers['X-OAuth-Token'] = _oauthCache.accessToken;
  }

  // X-API-Key se configurado (alguns endpoints pedem)
  var creds = getCredentials();
  if (creds.apiKey) {
    headers['X-API-Key'] = creds.apiKey;
  }

  return headers;
}

/**
 * Extrair token JWT da resposta
 */
function extractToken(data) {
  if (!data) return null;
  if (typeof data === 'string' && data.length > 20) return data;
  if (typeof data === 'object') {
    return data.Token || data.token || data.jwt || data.access_token || data.accessToken || null;
  }
  return null;
}

/**
 * Gerar URL de autorizacao OAuth 2.0
 * O usuario deve visitar esta URL, fazer login na SIEG, e autorizar.
 * Apos autorizacao, a SIEG redireciona para callbackUrl com o token temporario.
 */
function getOAuthAuthorizeUrl(state, accessLevel) {
  var creds = getCredentials();
  accessLevel = accessLevel || 'write';
  state = state || 'odoo-' + Date.now();
  
  var url = SIEG_OAUTH_AUTHORIZE_URL + 
    '?clientId=' + encodeURIComponent(creds.clientId) +
    '&state=' + encodeURIComponent(state) +
    '&accessLevel=' + encodeURIComponent(accessLevel);
  
  return { url: url, state: state };
}

/**
 * Trocar token temporario por token definitivo
 * 
 * Endpoint: POST /api/v1/oauth/generate-token
 * Headers: X-Client-Id + X-Secret-Key (NAO usa JWT Bearer!)
 * Body: { AccessToken: <temp>, State: <state>, RedirectUri: <url> }
 * Response: { IsSuccess, Data: { ... }, ... }
 * 
 * @param {string} tempToken - Token temporario recebido no callback
 * @param {string} state - State usado na autorizacao
 * @param {string} redirectUri - URL de callback configurada no SIEG
 */
async function exchangeTempToken(tempToken, state, redirectUri) {
  console.log('[SIEG-AUTH] Trocando token temporario por definitivo...');
  
  var resp = await axios.post(SIEG_OAUTH_GENERATE, {
    AccessToken: tempToken,
    State: state || '',
    RedirectUri: redirectUri || '',
  }, {
    headers: getSystemHeaders(),
    timeout: 15000,
  });

  var result = resp.data;
  console.log('[SIEG-AUTH] Resposta generate-token:', JSON.stringify(result).slice(0, 500));

  if (!result.IsSuccess) {
    throw new Error('[SIEG-AUTH] generate-token falhou: ' + (result.ErrorMessage || 'erro desconhecido'));
  }

  // O token definitivo esta dentro de result.Data
  var data = result.Data || {};
  var accessToken = data.AccessToken || data.accessToken || data.Token || data.token || 
                   (typeof data === 'string' ? data : null);
  var refreshToken = data.RefreshToken || data.refreshToken || null;

  if (!accessToken) {
    console.error('[SIEG-AUTH] Data completo:', JSON.stringify(data));
    throw new Error('[SIEG-AUTH] Resposta do generate-token nao contem access_token em Data');
  }

  setOAuthToken(accessToken, refreshToken, 30 * 24 * 3600);

  return {
    accessToken: accessToken,
    refreshToken: refreshToken,
    expiresIn: 30 * 24 * 3600,
  };
}

/**
 * Renovar token OAuth definitivo (antes dos 30 dias)
 * 
 * Endpoint: POST /api/v1/oauth/refresh
 * Headers: X-Client-Id + X-Secret-Key
 * Body: { Token: <definitive_token> }
 */
async function refreshOAuthToken() {
  if (!_oauthCache.accessToken) {
    throw new Error('[SIEG-AUTH] Nao ha OAuth token. Faca o fluxo OAuth novamente.');
  }

  console.log('[SIEG-AUTH] Renovando token OAuth...');
  
  var resp = await axios.post(SIEG_OAUTH_REFRESH, {
    Token: _oauthCache.accessToken,
  }, {
    headers: getSystemHeaders(),
    timeout: 15000,
  });

  var result = resp.data;
  console.log('[SIEG-AUTH] Resposta refresh:', JSON.stringify(result).slice(0, 500));

  if (!result.IsSuccess) {
    throw new Error('[SIEG-AUTH] refresh falhou: ' + (result.ErrorMessage || 'erro desconhecido'));
  }

  var data = result.Data || {};
  var accessToken = data.AccessToken || data.accessToken || data.Token || data.token ||
                   (typeof data === 'string' ? data : null);

  if (!accessToken) {
    throw new Error('[SIEG-AUTH] Resposta do refresh nao contem access_token em Data');
  }

  setOAuthToken(accessToken, null, 30 * 24 * 3600);
  console.log('[SIEG-AUTH] Token OAuth renovado!');

  return { accessToken: accessToken, expiresIn: 30 * 24 * 3600 };
}

/**
 * Revogar token OAuth
 */
async function revokeOAuthToken() {
  if (!_oauthCache.accessToken) return;

  try {
    await axios.post(SIEG_OAUTH_REVOKE, {
      Token: _oauthCache.accessToken,
    }, {
      headers: getSystemHeaders(),
      timeout: 15000,
    });
    console.log('[SIEG-AUTH] Token OAuth revogado.');
  } catch (err) {
    console.error('[SIEG-AUTH] Erro ao revogar:', err.message);
  }

  _oauthCache.accessToken = null;
  _oauthCache.refreshToken = null;
  _oauthCache.expiresAt = 0;
}

/**
 * Configurar OAuth token manualmente (persistencia / restauracao)
 */
function setOAuthToken(accessToken, refreshToken, expiresIn) {
  _oauthCache.accessToken = accessToken;
  _oauthCache.refreshToken = refreshToken || null;
  _oauthCache.expiresAt = Date.now() + ((expiresIn || 2592000) * 1000) - 86400000;
  console.log('[SIEG-AUTH] OAuth token configurado. Expira:', new Date(_oauthCache.expiresAt).toISOString());
}

/**
 * Verificar estado atual dos tokens
 */
function getTokenState() {
  return {
    jwt: {
      hasToken: !!_jwtCache.token,
      expiresAt: _jwtCache.expiresAt ? new Date(_jwtCache.expiresAt).toISOString() : null,
      isExpired: _jwtCache.expiresAt ? Date.now() >= _jwtCache.expiresAt : true,
      preview: _jwtCache.token ? _jwtCache.token.substring(0, 30) + '...' : null,
    },
    oauth: {
      hasToken: !!_oauthCache.accessToken,
      expiresAt: _oauthCache.expiresAt ? new Date(_oauthCache.expiresAt).toISOString() : null,
      isExpired: _oauthCache.expiresAt ? Date.now() >= _oauthCache.expiresAt : true,
      preview: _oauthCache.accessToken ? _oauthCache.accessToken.substring(0, 30) + '...' : null,
    },
  };
}

function invalidateCache() {
  _jwtCache.token = null;
  _jwtCache.expiresAt = 0;
}

module.exports = {
  createJwt,
  getAuthHeaders,
  getSystemHeaders,
  getOAuthAuthorizeUrl,
  exchangeTempToken,
  refreshOAuthToken,
  revokeOAuthToken,
  setOAuthToken,
  getTokenState,
  invalidateCache,
};

// === AUTO-INIT: Carregar OAuth token do config/env na startup ===
(function initOAuthFromConfig() {
  var creds = getCredentials();
  if (creds.apiKey) {
    console.log('[SIEG-AUTH] API Key configurada: ***' + creds.apiKey.slice(-4));
  }
  // Carregar OAuth token da env var (SIEG_OAUTH_TOKEN)
  var oauthFromEnv = (function() {
    try { return require('../config').sieg && require('../config').sieg.oauthToken; } catch(e) { return process.env.SIEG_OAUTH_TOKEN; }
  })();
  if (oauthFromEnv) {
    _oauthCache.accessToken = oauthFromEnv;
    _oauthCache.expiresAt = Date.now() + (29 * 24 * 3600 * 1000); // ~29 dias
    console.log('[SIEG-AUTH] OAuth token carregado da config: ***' + oauthFromEnv.slice(-4));
  }
  if (creds.clientId) {
    console.log('[SIEG-AUTH] Client ID configurado: ***' + creds.clientId.slice(-4));
  }
})();
