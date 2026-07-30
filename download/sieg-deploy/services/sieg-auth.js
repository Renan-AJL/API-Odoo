/**
 * services/sieg-auth.js — SIEG Authentication v5.0 (FINAL)
 * 
 * Documentacao oficial: integracoes.sieg.com/sistema-externo/docs/guia-de-uso
 * 
 * AUTENTICACAO EM DOIS NIVEIS:
 *   Nivel 1 - JWT: Identifica o sistema externo
 *     POST /api/v1/create-jwt
 *     Headers: X-Client-Id + X-Secret-Key
 *     Validade: 24 horas
 * 
 *   Nivel 2 - OAuth 2.0: Autoriza acesso a dados de cliente especifico
 *     Header: X-OAuth-Token
 *     Necessario para rotas que acessam dados de clientes
 * 
 * Todas as requisicoes precisam:
 *   Authorization: Bearer {jwt_token}
 *   X-OAuth-Token: {oauth_token} (quando acesso a dados de cliente)
 */
const axios = require('axios');

const SIEG_JWT_URL = 'https://api.sieg.com/api/v1/create-jwt';

// In-memory cache
let _jwtCache = {
  token: null,
  expiresAt: 0,
};

let _oauthCache = {
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
    };
  } catch (e) {
    return {
      clientId: process.env.SIEG_CLIENT_ID,
      clientSecret: process.env.SIEG_CLIENT_SECRET,
    };
  }
}

/**
 * Gerar JWT via headers X-Client-Id + X-Secret-Key
 * Documentacao: integracoes.sieg.com/sistema-externo/docs/guia-de-uso
 */
async function createJwt() {
  var creds = getCredentials();
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('[SIEG-AUTH] SIEG_CLIENT_ID e SIEG_CLIENT_SECRET nao configurados');
  }

  console.log('[SIEG-AUTH] Gerando JWT... (Client: ***' + creds.clientId.slice(-4) + ')');

  try {
    var resp = await axios.post(SIEG_JWT_URL, null, {
      headers: {
        'X-Client-Id': creds.clientId,
        'X-Secret-Key': creds.clientSecret,
        'Content-Length': '0',
      },
      timeout: 15000,
    });

    var data = resp.data;
    var token = extractToken(data);

    if (!token) {
      console.error('[SIEG-AUTH] Resposta sem token:', JSON.stringify(data).slice(0, 300));
      throw new Error('[SIEG-AUTH] Resposta do create-jwt nao contem token');
    }

    // Cache por 24h (menos 5 min de buffer)
    _jwtCache.token = token;
    _jwtCache.expiresAt = Date.now() + (24 * 60 * 60 * 1000) - (5 * 60 * 1000);

    console.log('[SIEG-AUTH] JWT obtido! Expira:', new Date(_jwtCache.expiresAt).toISOString());
    console.log('[SIEG-AUTH] Token:', token.substring(0, 50) + '...');

    return { token: token, raw: data };
  } catch (err) {
    var errMsg = err.response?.data || err.message;
    var errStr = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
    console.error('[SIEG-AUTH] Falha ao gerar JWT:', errStr);
    throw new Error('[SIEG-AUTH] Falha ao gerar JWT: ' + errStr);
  }
}

/**
 * Obter headers de autenticacao para chamadas API
 * 
 * Para endpoints de sistema (send-xml, emitir-nfse, gerarDanfeViaXml):
 *   - Authorization: Bearer {jwt}
 * 
 * Para endpoints de dados de cliente (listar, baixar-xml, etc.):
 *   - Authorization: Bearer {jwt}
 *   - X-OAuth-Token: {oauth_token}
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
  };

  // Para rotas que acessam dados de cliente, adicionar OAuth
  if (options.requireOAuth && _oauthCache.accessToken) {
    headers['X-OAuth-Token'] = _oauthCache.accessToken;
  }

  return headers;
}

/**
 * Extrair token JWT da resposta (tenta varios campos)
 */
function extractToken(data) {
  if (!data) return null;
  if (typeof data === 'string' && data.length > 20) return data;
  return data.token || data.jwt || data.access_token || data.accessToken || data.Token || data.Jwt || null;
}

/**
 * Set OAuth token (obtido via fluxo OAuth ou configuracao)
 */
function setOAuthToken(accessToken, refreshToken, expiresIn) {
  _oauthCache.accessToken = accessToken;
  _oauthCache.refreshToken = refreshToken || null;
  _oauthCache.expiresAt = Date.now() + ((expiresIn || 3600) * 1000) - 60000;
  console.log('[SIEG-AUTH] OAuth token configurado');
}

/**
 * Get current auth state
 */
function getTokenState() {
  return {
    hasJwt: !!_jwtCache.token,
    jwtExpiresAt: _jwtCache.expiresAt,
    jwtExpired: Date.now() >= _jwtCache.expiresAt,
    jwtPreview: _jwtCache.token ? _jwtCache.token.substring(0, 30) + '...' : null,
    hasOAuth: !!_oauthCache.accessToken,
  };
}

function invalidateCache() {
  _jwtCache.token = null;
  _jwtCache.expiresAt = 0;
}

module.exports = {
  createJwt,
  getAuthHeaders,
  setOAuthToken,
  getTokenState,
  invalidateCache,
};
