/**
 * Middleware de autenticacao UNIFICADO por API Key.
 * Todas as rotas protegidas usam a MESMA chave.
 * Odoo deve enviar o header X-API-Key com a chave configurada.
 */
const config = require('../config');

function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key']
    || (req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : '');

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Autenticacao necessaria. Envie o header X-API-Key.',
    });
  }

  if (apiKey !== config.middlewareApiKey) {
    return res.status(403).json({
      success: false,
      error: 'API Key invalida.',
    });
  }

  next();
}

module.exports = { apiKeyAuth };