/**
 * routes/webhook-te.js - Webhook receptor do TudoEntregue
 * POST /webhook/tudoentregue
 *
 * ATENCAO: O TE NAO envia headers de autenticacao nos webhooks.
 * AppKey/RequesterKey sao usados quando nos chamamos a API do TE (outbound).
 * Para o webhook inbound, usamos validacao por IP Cloudflare ou sem auth.
 * SEMPRE retorna 200 para evitar retries do TE.
 *
 * O TE envia "WebHook Padra Ocorrencia" contendo:
 *   Customer, Driver, OrderType, OrderID, OrderNumber, OrderDescription,
 *   Documents, Occurrences, Status, LoadSeparation
 */
var express = require('express');
var router = express.Router();
var logger = require('../utils/logger');
var odooTe = require('../services/odoo-te');
var mapper = require('../services/mapper-te');

// Sem teAuth - TE nao envia headers de autenticacao nos webhooks
// A seguranca e por obscuridade (URL unica) e validacao de payload

router.post('/tudoentregue', async function(req, res) {
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

      // Fallback: busca pelo numero do pedido (para pedidos criados diretamente no TE)
      if (!picking && !saleOrder && d.OrderNumber) {
        logger.info('[TE-WEBHOOK] Buscando por OrderNumber (fallback): ' + d.OrderNumber);
        picking = await odooTe.findPickingByOrderNumber(String(d.OrderNumber));
        saleOrder = await odooTe.findSaleOrderByOrderNumber(String(d.OrderNumber));

        // Se encontrou por OrderNumber, salva o te_order_id para futuros webhooks
        if (picking) {
          logger.info('[TE-WEBHOOK] Picking encontrado por OrderNumber: ' + picking.name + ' (id=' + picking.id + ') - salvando te_order_id');
          await odooTe.updatePickingTeData(picking.id, { x_studio_te_order_id: String(orderId) });
        }
        if (saleOrder) {
          logger.info('[TE-WEBHOOK] Sale Order encontrado por OrderNumber: ' + saleOrder.name + ' (id=' + saleOrder.id + ') - salvando te_order_id');
          await odooTe.updateSaleOrderTeData(saleOrder.id, { x_studio_te_order_id: String(orderId) });
        }
      }

      if (!picking && !saleOrder) {
        logger.warn('[TE-WEBHOOK] Nenhum registro encontrado para OrderID=' + orderId + ' | Pedido=' + (d.OrderNumber || ''));
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