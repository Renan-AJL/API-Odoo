/**
 * routes/consultflex.js — ConsultFlex API routes
 * ====================================================
 * POST /api/v1/consultflex/consultar  — Consulta CPF/CNPJ
 * POST /api/v1/consultflex/consultar-odoo/:saleOrderId — Consulta e grava no Odoo
 *   Se cpfcnpj não informado no body, lê dos campos do sale.order (x_studio_cf_cpfcnpj, x_studio_cf_tipo_pessoa)
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

// Helper: Odoo XML-RPC authenticate
function odooAuth(oc) {
  return new Promise(function(ok, fail) {
    var base = oc.url.replace(/\/+$/, '');
    var host = base.replace('https://', '');
    var commonCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
    commonCli.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, r) {
      if (e || !r) return fail(e || new Error('Odoo auth failed'));
      ok({ uid: r, host: host });
    });
  });
}

// Helper: Odoo XML-RPC execute_kw
function odooExec(oc, host, uid, model, method, args, kwargs) {
  return new Promise(function(ok, fail) {
    var modelsCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });
    var params = [oc.db, uid, oc.password, model, method, args];
    if (kwargs) params.push(kwargs);
    modelsCli.methodCall('execute_kw', params, function(e, r) {
      if (e) return fail(e);
      ok(r);
    });
  });
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
// Se cpfcnpj/tipoPessoa não informados no body, lê dos campos do sale.order
// ============================================================
router.post('/consultar-odoo/:saleOrderId', apiKeyAuth, async function(req, res) {
  try {
    var saleOrderId = parseInt(req.params.saleOrderId);
    var cpfcnpj = req.body.cpfcnpj || '';
    var tipoPessoa = req.body.tipoPessoa || '';

    if (!saleOrderId) {
      return res.status(400).json({ success: false, error: 'saleOrderId é obrigatório' });
    }

    var oc = config.odoo;
    var odooHost = null;
    var odooUid = null;

    // 1. Authenticate to Odoo
    if (oc && oc.enabled && oc.url) {
      try {
        var authResult = await odooAuth(oc);
        odooUid = authResult.uid;
        odooHost = authResult.host;
      } catch (authErr) {
        console.error('[CONSULTFLEX] Erro auth Odoo:', authErr.message);
      }
    }

    // 2. If cpfcnpj not provided, read from Odoo sale.order fields
    if (!cpfcnpj && odooUid) {
      try {
        var fields = await odooExec(oc, odooHost, odooUid, 'sale.order', 'read', [
          [saleOrderId],
          ['x_studio_cf_cpfcnpj', 'x_studio_cf_tipo_pessoa', 'partner_id']
        ]);

        if (fields && fields.length > 0) {
          var rec = fields[0];
          cpfcnpj = rec.x_studio_cf_cpfcnpj || '';
          tipoPessoa = rec.x_studio_cf_tipo_pessoa || '';

          // Fallback: se não preencheu o campo custom, usa o CNPJ/CPF do partner
          if (!cpfcnpj && rec.partner_id && rec.partner_id.length > 0) {
            var partnerId = rec.partner_id[0];
            var partnerData = await odooExec(oc, odooHost, odooUid, 'res.partner', 'read', [
              [partnerId],
              ['vat', 'is_company']
            ]);
            if (partnerData && partnerData.length > 0) {
              cpfcnpj = (partnerData[0].vat || '').replace(/\D/g, '');
              tipoPessoa = partnerData[0].is_company ? 'J' : 'F';
            }
          }
        }
      } catch (readErr) {
        console.error('[CONSULTFLEX] Erro ao ler sale.order:', readErr.message);
      }
    }

    if (!cpfcnpj) {
      return res.status(400).json({ success: false, error: 'CPF/CNPJ não informado e não encontrado no sale.order' });
    }

    // 3. Consulta ConsultFlex
    var resultado = await consultarCredito({ cpfcnpj: cpfcnpj, tipoPessoa: tipoPessoa });
    var html = formatarRespostaHtml(resultado);

    // 4. Grava resultado no Odoo
    var odooUpdated = false;
    if (odooUid) {
      try {
        var nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        var writeVals = {
          'x_studio_resposta_consultflex': html,
        };

        // Try to write status/data fields if they exist
        try {
          var cfFields = await odooExec(oc, odooHost, odooUid, 'ir.model.fields', 'search_read', [
            [['model_id.model', '=', 'sale.order'], '|',
             ['name', '=', 'x_studio_cf_status'],
             ['name', '=', 'x_studio_cf_data_consulta']],
            ['name']
          ]);
          if (cfFields && cfFields.length > 0) {
            writeVals['x_studio_cf_status'] = 'concluido';
            writeVals['x_studio_cf_data_consulta'] = nowStr;
          }
        } catch (fieldErr) { /* ignore if fields don't exist */ }

        await odooExec(oc, odooHost, odooUid, 'sale.order', 'write', [
          [saleOrderId],
          writeVals
        ]);

        odooUpdated = true;
        console.log('[CONSULTFLEX] Resultado gravado no sale.order ID:', saleOrderId);
      } catch (odooErr) {
        console.error('[CONSULTFLEX] Erro ao gravar no Odoo:', odooErr.message);
      }
    }

    res.json({ success: true, data: resultado, html: html, odoo_updated: odooUpdated, cpfcnpj: cpfcnpj, tipoPessoa: tipoPessoa });
  } catch (err) {
    console.error('[CONSULTFLEX] Erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
