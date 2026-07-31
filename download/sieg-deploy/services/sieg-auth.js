/**
 * services/sieg-auth.js — SIEG Authentication v6.0
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
 *     1. Redirecionar usuario para: https://app.sieg.com/AuthorizeAccess.aspx
 *        ?clientId={CLIENT_ID}&state={STATE}&accessLevel=write
 *     2. SIEG redireciona para callback com token temporario (10min)
 *     3. Trocar token temporario por token definitivo (30 dias)
 *     4. Refresh a cada 30 dias
 * 
 * TODAS as requisicoes a API precisam:
 *   Authorization: Bearer {jwt_token}
 *   X-OAuth-Token: {oauth_definitive_token}
 */
const axios = require('axios');

const SIEG_JWT_URL = 'https://api.sieg.com/api/v1/create-jwt';
const SIEG_OAUTH_AUTHORIZE_URL = 'https://app.sieg.com/AuthorizeAccess.aspx';

// In-memory cache
var _jwtCache = {
  token: null,
  expiresAt: 0,
};

var _oauthCache = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
};

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
    headers: {
      'X-Client-Id': creds.clientId,
      'X-Secret-Key': creds.clientSecret,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': '0',
    },
    timeout: 15000,
  });

  // A SIEG retorna o JWT como STRING PURA (nao como objeto JSON)
  var token = extractToken(resp.data);

  if (!token) {
    console.error('[SIEG-AUTH] Resposta sem token:', JSON.stringify(resp.data).slice(0, 300));
    throw new Error('[SIEG-AUTH] Resposta do create-jwt nao contem token');
  }

  // Cache por 24h (menos 5 min de buffer)
  _jwtCache.token = token;
  _jwtCache.expiresAt = Date.now() + (24 * 60 * 60 * 1000) - (5 * 60 * 1000);

  console.log('[SIEG-AUTH] JWT obtido! Expira:', new Date(_jwtCache.expiresAt).toISOString());
  console.log('[SIEG-AUTH] Token:', token.substring(0, 50) + '...');

  return { token: token };
}

/**
 * Obter headers completos para chamadas API SIEG
 * 
 * Conforme documentacao, TODAS as requisicoes precisam de:
 *   Authorization: Bearer {jwt}
 *   X-OAuth-Token: {oauth_token}
 */
async function getAuthHeaders(options) {
  options = options || {};

  // Garantir JWT valido
  if (!_jwtCache.token || Date.now() >= _jwtCache.expiresAt) {
    await createJwt();
  }

  var headers = {
    'Authorization': 'Bearer ' + _jwtCache.token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Adicionar X-OAuth-Token (obrigatorio para acessar dados de cliente)
  if (_oauthCache.accessToken) {
    headers['X-OAuth-Token'] = _oauthCache.accessToken;
  }

  // Adicionar X-API-Key se configurado
  var creds = getCredentials();
  if (creds.apiKey) {
    headers['X-API-Key'] = creds.apiKey;
  }

  return headers;
}

/**
 * Extrair token JWT da resposta
 * A SIEG pode retornar: string pura OU { Token: "..." } OU { token: "..." }
 */
function extractToken(data) {
  if (!data) return null;
  // Caso mais comum: resposta e string JWT pura
  if (typeof data === 'string' && data.length > 20) return data;
  // Caso alternativo: objeto com campo Token
  if (typeof data === 'object') {
    return data.Token || data.token || data.jwt || data.access_token || data.accessToken || null;
  }
  return null;
}

/**
 * Gerar URL de autorizacao OAuth 2.0
 * O usuario deve visitar esta URL, fazer login na SIEG, e autorizar o acesso.
 * Apos autorizacao, a SIEG redireciona para callbackUrl com o token temporario.
 * 
 * @param {string} state - Identificador interno (para correlacionar o retorno)
 * @param {string} accessLevel - 'read' | 'write' | 'fullAccess'
 */
function getOAuthAuthorizeUrl(state, accessLevel) {
  var creds = getCredentials();
  accessLevel = accessLevel || 'write';
  state = state || 'odoo-' + Date.now();
  
  var url = SIEG_OAUTH_AUTHORIZE_URL + 
    '?clientId=' + encodeURIComponent(creds.clientId) +
    '&state=' + encodeURIComponent(state) +
    '&accessLevel=' + encodeURIComponent(accessLevel);
  
  console.log('[SIEG-AUTH] URL OAuth:', url);
  return { url: url, state: state };
}

/**
 * Trocar token temporario por token definitivo
 * Chamado pelo callback OAuth quando o SIEG redireciona de volta
 * 
 * @param {string} tempToken - Token temporario recebido no callback
 * @returns {Object} { accessToken, refreshToken, expiresIn }
 */
async function exchangeTempToken(tempToken) {
  var headers = await getAuthHeaders({ skipOAuth: true });
  
  // TODO: endpoint exato do generate-token sera preenchido quando usuario enviar a doc
  // Conforme documentacao: o token temporario (10min) deve ser trocado por definitivo (30 dias)
  var generateTokenUrl = 'https://api.sieg.com/api/v1/generate-token';
  
  console.log('[SIEG-AUTH] Trocando token temporario por definitivo...');
  
  var resp = await axios.post(generateTokenUrl, {
    temporaryToken: tempToken,
  }, { headers, timeout: 15000 });

  var data = resp.data;
  console.log('[SIEG-AUTH] Resposta generate-token:', JSON.stringify(data).slice(0, 300));

  var accessToken = data.access_token || data.accessToken || data.token || data.Token;
  var refreshToken = data.refresh_token || data.refreshToken;
  var expiresIn = data.expires_in || data.expiresIn || (30 * 24 * 3600); // default 30 dias

  if (!accessToken) {
    throw new Error('[SIEG-AUTH] Resposta do generate-token nao contem access_token');
  }

  setOAuthToken(accessToken, refreshToken, expiresIn);

  return {
    accessToken: accessToken,
    refreshToken: refreshToken,
    expiresIn: expiresIn,
  };
}

/**
 * Renovar token OAuth definitivo (antes dos 30 dias)
 */
async function refreshOAuthToken() {
 if (!_oauthCache.refreshToken) {
    throw new Error('[SIEG-AUTH] Nao ha refresh token. Faca o fluxo OAuth novamente.');
  }

  var headers = await getAuthHeaders({ skipOAuth: true });
  
  // TODO: endpoint exato do refresh sera preenchido quando usuario enviar a doc
  var refreshUrl = 'https://api.sieg.com/api/v1/refresh';
  
  console.log('[SIEG-AUTH] Renovando token OAuth...');
  
  var resp = await axios.post(refreshUrl, {
    refreshToken: _oauthCache.refreshToken,
  }, { headers, timeout: 15000 });

  var data = resp.data;
  var accessToken = data.access_token || data.accessToken || data.token || data.Token;
  var refreshToken = data.refresh_token || data.refreshToken || _oauthCache.refreshToken;
  var expiresIn = data.expires_in || data.expiresIn || (30 * 24 * 3600);

  if (!accessToken) {
    throw new Error('[SIEG-AUTH] Resposta do refresh nao contem access_token');
  }

  setOAuthToken(accessToken, refreshToken, expiresIn);
  console.log('[SIEG-AUTH] Token OAuth renovado! Expira:', new Date(_oauthCache.expiresAt).toISOString());

  return { accessToken: accessToken, expiresIn: expiresIn };
}

/**
 * Configurar OAuth token manualmente (persistencia)
 */
function setOAuthToken(accessToken, refreshToken, expiresIn) {
  _oauthCache.accessToken = accessToken;
  _oauthCache.refreshToken = refreshToken || null;
  _oauthCache.expiresAt = Date.now() + ((expiresIn || 2592000) * 1000) - 86400000; // 1 dia de buffer
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
      hasRefreshToken: !!_oauthCache.refreshToken,
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
  getOAuthAuthorizeUrl,
  exchangeTempToken,
  refreshOAuthToken,
  setOAuthToken,
  getTokenState,
  invalidateCache,
};
