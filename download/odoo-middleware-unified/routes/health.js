/**
 * routes/health.js - Health Check UNIFICADO
 */
const express = require('express');
const router = express.Router();
const config = require('../config');

router.get('/', async (req, res) => {
  try {
    const { getTokenStatus } = require('../services/itau-auth');
    const tokenStatus = getTokenStatus();
    res.json({
      success: true,
      service: 'odoo-middleware-unified',
      version: '1.0.0',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      modules: {
        itau: {
          status: 'loaded',
          token: tokenStatus,
          ambiente: config.itau.clientId ? (config.mockMode ? 'MOCK' : 'producao') : 'nao_configurado',
          odoo_push: config.odoo.enabled ? 'ATIVO' : 'DESATIVADO',
          mTLS: config.createMtlsConfig().hasMtls ? 'SIM' : 'NAO',
        },
        cnpja: {
          status: 'loaded',
          api: config.cnpjaApiBase,
          commercial: config.cnpjaUsingCommercial,
          has_token: !!config.cnpjaApiToken,
          ie_sources: {
            cnpja_comercial: config.cnpjaUsingCommercial,
            consultar_io: !!process.env.CONSULTAR_IO_TOKEN,
            nfe_cadastro: 'disponivel',
          },
        },
      },
      rate_limit: config.rateLimitPerMinute + ' req/min',
    });
  } catch (err) {
    res.status(500).json({ success: false, status: 'erro', mensagem: err.message });
  }
});

module.exports = router;