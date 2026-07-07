/**
 * routes/webhook-te.js - Webhook receptor do TudoEntregue
 * POST /webhook/tudoentregue
 * Autenticacao via headers AppKey/RequesterKey (nao usa apiKeyAuth)
 * Sempre retorna 200 para evitar retries do TE
 *
 * O TE envia "WebHook Padra Ocorrencia" contendo:
 *   Customer, Driver, OrderType, OrderID, OrderNumber, OrderDescription,
 *   Documents, Occurrences, Status, LoadSeparation
 */
var express = require('express');
var router = express.Router();
var config = require('../config');
var logger = require('../utils/logger');
var odooTe = require('../services/odoo-te');
var mapper = require('../services/mapper-te');

function teAuth(req, res, next) {
  // Express lowercases todos os headers
  var appKey = req.headers['appkey'];
  var reqKey = req.headers['requesterkey'];

  if (appKey === config.tudoentregue.appKey && reqKey === config.tudoentregue.requesterKey) {
    return next();
  }

  // Log detalhado para debug
  var headerKeys = Object.keys(req.headers).filter(function(h) {
    return h.includes('key') || h.includes('app') || h.includes('requester');
  });
  logger.warn('[TE-WEBHOOK] Auth falhou. Headers relevantes: ' + JSON.stringify(headerKeys));
  logger.warn('[TE-WEBHOOK] Recebido appkey: ' + (appKey ? '***' + String(appKey).slice(-4) : 'vazio') + ' | Esperado: ***' + (config.tudoentregue.appKey || '').slice(-4));
  logger.warn('[TE-WEBHOOK] Recebido requesterkey: ' + (reqKey ? '***' + String(reqKey).slice(-4) : 'vazio') + ' | Esperado: ***' + (config.tudoentregue.requesterKey || '').slice(-4));

  // Retorna 200 para evitar retries
  return res.status(200).json({ received: true, auth: false });
}

router.post('/tudoentregue', teAuth, async function(req, res) {
  // Sempre 200 imediato
  res.status(200).json({ received: true });
  logger.info('[TE-WEBHOOK] Payload recebido');

  try {
    var deliveries = mapper.normalizeWebhookPayload(req.body);
    if (!deliveries.length) {
      logger.warn('[TE-WEBHOOK] Payload vazio ou nao reconhecido');
      return;
    }

    for (var i = 0; i < deliveries.length; i++) {
      var d = deliveries[i];
      var orderId = d.OrderID;
      if (!orderId) continue;

      logger.info('[TE-WEBHOOK] OrderID=' + orderId + ' | Pedido=' + (d.OrderNumber || '') + ' | Status=' + getStatusDesc(d));

      // Busca no Odoo pelo te_order_id (que guardamos como o OrderID do TE)
      var picking = await odooTe.findPickingByTeId(String(orderId));
      var saleOrder = await odooTe.findSaleOrderByTeId(String(orderId));

      // Mapeia dados do webhook para campos Odoo
      var odooData = mapper.teWebhookToOdoo(d);

      if (picking) {
        await odooTe.updatePickingTeData(picking.id, odooData);
        var msg = mapper.chatterWebhookMessage(d);
        await odooTe.postChatter('stock.picking', picking.id, msg);
      } else {
        logger.warn('[TE-WEBHOOK] Picking nao encontrado para OrderID=' + orderId);
      }

      if (saleOrder) {
        var soData = Object.assign({}, odooData);
        await odooTe.updateSaleOrderTeData(saleOrder.id, soData);
        var soMsg = mapper.chatterWebhookMessage(d);
        await odooTe.postChatter('sale.order', saleOrder.id, soMsg);
      }
    }
  } catch (err) {
    logger.error('[TE-WEBHOOK] Erro: ' + err.message);
  }
});

function getStatusDesc(d) {
  if (d.Status && d.Status.length) {
    var last = d.Status[d.Status.length - 1];
    return last.Status + ' - ' + (last.StatusDescription || '');
  }
  return 'N/A';
}

module.exports = router;