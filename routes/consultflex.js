/**
 * routes/consultflex.js — ConsultFlex API routes
 * ====================================================
 * POST /api/v1/consultflex/consultar  — Consulta CPF/CNPJ
 * POST /api/v1/consultflex/consultar-odoo/:saleOrderId — Consulta e grava no Odoo
 */
var express = require('express');
var router = express.Router();
var { consultarCredito, formatarRespostaHtml } = require('../services/consultflex');
var config = require('../config');
var xmlrpc = require('xmlrpc');

// API Key auth middleware
function apiKeyAuth(req, res, next) {
  var key = req.headers['x-api-key'] || req.query.api_key || '';
  if (key === config.middlewareApiKey) return next();
  return res.status(401).json({ error: 'Unauthorized — invalid API key' });
}

// ============================================================
// POST /api/v1/consultflex/consultar
// Body: { cpfcnpj, tipoPessoa, solicitante }
// Returns: { success, data, html }
// ============================================================
router.post('/consultar', apiKeyAuth, async function(req, res) {
  try {
    var cpfcnpj = req.body.cpfcnpj || '';
    var tipoPessoa = req.body.tipoPessoa || '';
    var solicitante = req.body.solicitante || '';

    if (!cpfcnpj) {
      return res.status(400).json({ success: false, error: 'cpfcnpj é obrigatório' });
    }

    var resultado = await consultarCredito({ cpfcnpj: cpfcnpj, tipoPessoa: tipoPessoa, solicitante: solicitante });
    var html = formatarRespostaHtml(resultado);

    res.json({ success: true, data: resultado, html: html });
  } catch (err) {
    console.error('[CONSULTFLEX] Erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/v1/consultflex/consultar-odoo/:saleOrderId
// Consulta CPF/CNPJ e grava resultado no sale.order do Odoo
// ============================================================
router.post('/consultar-odoo/:saleOrderId', apiKeyAuth, async function(req, res) {
  try {
    var saleOrderId = parseInt(req.params.saleOrderId);
    var cpfcnpj = req.body.cpfcnpj || '';
    var tipoPessoa = req.body.tipoPessoa || '';

    if (!saleOrderId || !cpfcnpj) {
      return res.status(400).json({ success: false, error: 'saleOrderId e cpfcnpj são obrigatórios' });
    }

    // 1. Consulta ConsultFlex
    var resultado = await consultarCredito({ cpfcnpj: cpfcnpj, tipoPessoa: tipoPessoa });
    var html = formatarRespostaHtml(resultado);

    // 2. Grava resultado no Odoo
    var oc = config.odoo;
    if (oc && oc.enabled && oc.url) {
      try {
        var base = oc.url.replace(/\/+$/, '');
        var host = base.replace('https://', '');
        var commonCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
        var modelsCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });

        var uid = await new Promise(function(ok, fail) {
          commonCli.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, r) {
            if (e || !r) return fail(e || new Error('auth failed'));
            ok(r);
          });
        });

        await new Promise(function(ok, fail) {
          modelsCli.methodCall('execute_kw', [oc.db, uid, oc.password, 'sale.order', 'write', [
            [saleOrderId],
            {
              'x_studio_cf_resultado_html': html,
              'x_studio_cf_status': 'concluido',
              'x_studio_cf_data_consulta': new Date().toISOString().replace('T', ' ').substring(0, 19),
            }
          ]], function(e, r) {
            if (e) return fail(e);
            ok(r);
          });
        });

        console.log('[CONSULTFLEX] Resultado gravado no sale.order ID:', saleOrderId);
      } catch (odooErr) {
        console.error('[CONSULTFLEX] Erro ao gravar no Odoo:', odooErr.message);
      }
    }

    res.json({ success: true, data: resultado, html: html, odoo_updated: true });
  } catch (err) {
    console.error('[CONSULTFLEX] Erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
