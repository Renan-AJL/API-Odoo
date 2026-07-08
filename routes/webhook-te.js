/**
 * routes/webhook-te.js - Webhook receptor do TudoEntregue
 * POST /webhook/tudoentregue
 * Autenticacao via headers AppKey/RequesterKey
 * SEMPRE retorna 200 para evitar retries do TE
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
  // Express lowercases todos os headers automaticamente
  var appKey = req.headers['appkey'];
  var reqKey = req.headers['requesterkey'];

  if (appKey && reqKey && appKey === config.tudoentregue.appKey && reqKey === config.tudoentregue.requesterKey) {
    return next();
  }

  // Log detalhado para debug - mostra TODOS os headers recebidos
  var allHeaderKeys = Object.keys(req.headers);
  var relevantKeys = allHeaderKeys.filter(function(h) {
    return h.indexOf('key') !== -1 || h.indexOf('app') !== -1 || h.indexOf('request') !== -1 || h.indexOf('auth') !== -1;
  });

  logger.warn('[TE-WEBHOOK] Auth falhou ou headers ausentes.');
  logger.warn('[TE-WEBHOOK] Todos os headers: ' + JSON.stringify(allHeaderKeys));
  logger.warn('[TE-WEBHOOK] Headers relevantes: ' + JSON.stringify(relevantKeys));
  logger.warn('[TE-WEBHOOK] Recebido appkey: ' + (appKey ? '***' + String(appKey).slice(-4) : 'AUSENTE') + ' | Esperado: ***' + (config.tudoentregue.appKey || '').slice(-4));
  logger.warn('[TE-WEBHOOK] Recebido requesterkey: ' + (reqKey ? '***' + String(reqKey).slice(-4) : 'AUSENTE') + ' | Esperado: ***' + (config.tudoentregue.requesterKey || '').slice(-4));
  logger.warn('[TE-WEBHOOK] TE AppKey configurado: ' + (config.tudoentregue.appKey ? 'SIM (' + config.tudoentregue.appKey.length + ' chars)' : 'NAO'));
  logger.warn('[TE-WEBHOOK] TE RequesterKey configurado: ' + (config.tudoentregue.requesterKey ? 'SIM (' + config.tudoentregue.requesterKey.length + ' chars)' : 'NAO'));

  // SEMPRE retorna 200 para o TE nao retry
  return res.status(200).json({ received: true, auth: false });
}

router.post('/tudoentregue', teAuth, async function(req, res) {
  // Sempre 200 imediato
  res.status(200).json({ received: true });
  logger.info('[TE-WEBHOOK] Payload recebido, processando...');

  try {
    var deliveries = mapper.normalizeWebhookPayload(req.body);
    if (!deliveries.length) {
      logger.warn('[TE-WEBHOOK] Payload vazio ou nao reconhecido. Body: ' + JSON.stringify(req.body).substring(0, 500));
      return;
    }

    for (var i = 0; i < deliveries.length; i++) {
      var d = deliveries[i];
      var orderId = d.OrderID;
      if (!orderId) {
        logger.warn('[TE-WEBHOOK] Entrega sem OrderID, ignorando');
        continue;
      }

      logger.info('[TE-WEBHOOK] OrderID=' + orderId + ' | Pedido=' + (d.OrderNumber || '') + ' | Status=' + getStatusDesc(d));

      // Busca no Odoo pelo te_order_id (que guardamos como o OrderID do TE)
      var picking = await odooTe.findPickingByTeId(String(orderId));
      var saleOrder = await odooTe.findSaleOrderByTeId(String(orderId));

      if (!picking && !saleOrder) {
        logger.warn('[TE-WEBHOOK] Nenhum registro encontrado para OrderID=' + orderId + ' (campos x_studio_te_order_id podem nao existir ainda)');
        continue;
      }

      // Mapeia dados do webhook para campos Odoo
      var odooData = mapper.teWebhookToOdoo(d);

      if (picking) {
        await odooTe.updatePickingTeData(picking.id, odooData);
        var msg = mapper.chatterWebhookMessage(d);
        await odooTe.postChatter('stock.picking', picking.id, msg);
        logger.info('[TE-WEBHOOK] Picking ' + picking.id + ' (' + picking.name + ') atualizado');
      }

      if (saleOrder) {
        var soData = Object.assign({}, odooData);
        await odooTe.updateSaleOrderTeData(saleOrder.id, soData);
        var soMsg = mapper.chatterWebhookMessage(d);
        await odooTe.postChatter('sale.order', saleOrder.id, soMsg);
        logger.info('[TE-WEBHOOK] Sale Order ' + saleOrder.id + ' (' + saleOrder.name + ') atualizado');
      }
    }
  } catch (err) {
    logger.error('[TE-WEBHOOK] Erro no processamento: ' + err.message);
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