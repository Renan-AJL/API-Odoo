/**
 * services/itau-auth.js - v6.1
 */
const axios = require('axios');
const config = require('../config');

let tokenCache = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt) {
    console.log('[ITAU-AUTH] Token do cache (expira em ' + Math.round((tokenCache.expiresAt - now) / 1000) + 's)');
    return tokenCache.accessToken;
  }

  console.log('[ITAU-AUTH] Solicitando novo token OAuth2...');
  console.log('[ITAU-AUTH] URL:', config.itau.tokenUrl);

  const mtls = config.createMtlsConfig();
  console.log('[ITAU-AUTH] mTLS:', mtls.hasMtls ? 'SIM (' + config.mtls.cert.length + ' chars)' : 'NAO');

  const httpsAgent = mtls.hasMtls ? new (require('https').Agent)({ cert: mtls.cert, key: mtls.key }) : undefined;

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', config.itau.clientId);
    params.append('client_secret', config.itau.clientSecret);

    const response = await axios.post(config.itau.tokenUrl, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-itau-flowID': '1',
        'x-itau-correlationID': String(Date.now()),
        'Accept': 'application/json',
      },
      httpsAgent,
      timeout: 30000,
    });

    if (response.data && response.data.access_token) {
      tokenCache.accessToken = response.data.access_token;
      tokenCache.expiresAt = now + ((response.data.expires_in || 1800) * 1000) - 300000;
      console.log('[ITAU-AUTH] Token obtido com sucesso!');
      return response.data.access_token;
    } else {
      throw new Error('Resposta sem access_token: ' + JSON.stringify(response.data));
    }
  } catch (error) {
    console.error('[ITAU-AUTH] ERRO ao obter token:');
    if (error.response) {
      console.error('[ITAU-AUTH] Status:', error.response.status);
      console.error('[ITAU-AUTH] Data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('[ITAU-AUTH] Error:', error.message);
    }
    tokenCache.accessToken = null;
    tokenCache.expiresAt = 0;
    throw new Error('Falha OAuth2 Itau: ' + (error.response && error.response.data ? error.response.data.error_description || error.response.data.error : error.message));
  }
}

function getAuthHeaders(accessToken) {
  return {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-itau-apikey': config.itau.clientId,
  };
}

function invalidateToken() {
  console.log('[ITAU-AUTH] Cache de token invalidado.');
  tokenCache.accessToken = null;
  tokenCache.expiresAt = 0;
}

function getTokenStatus() {
  const now = Date.now();
  return {
    hasToken: tokenCache.accessToken,
    isValid: tokenCache.accessToken && now < tokenCache.expiresAt,
    expiresAt: tokenCache.expiresAt > 0 ? new Date(tokenCache.expiresAt).toISOString() : null,
    expiresIn: tokenCache.expiresAt > now ? Math.round((tokenCache.expiresAt - now) / 1000) + 's' : 'expirado',
  };
}

module.exports = { getAccessToken, getAuthHeaders, invalidateToken, getTokenStatus };
