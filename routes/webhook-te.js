/**
 * routes/webhook-te.js - Webhook receptor do TudoEntregue
 * POST /webhook/tudoentregue
 * Autenticacao via headers AppKey/RequesterKey (nao usa apiKeyAuth)
 * Sempre retorna 200 para evitar retries do TE
 */
var express = require('express');
var router = express.Router();
var config = require('../config');
var logger = require('../utils/logger');
var teApi = require('../services/tudoentregue');
var odooTe = require('../services/odoo-te');
var mapper = require('../services/mapper-te');

function teAuth(req, res, next) {
  var appKey = req.headers['appkey'] || req.headers['AppKey'];
  var reqKey = req.headers['requesterkey'] || req.headers['RequesterKey'];
  if (appKey === config.tudoentregue.appKey && reqKey === config.tudoentregue.requesterKey) {
    return next();
  }
  logger.warn('[TE-WEBHOOK] Autenticacao falhou - AppKey: ' + (appKey ? '***' + appKey.slice(-4) : 'vazio'));
  // Retorna 200 mesmo assim para evitar retries
  return res.status(200).json({ received: true, auth: false });
}

router.post('/tudoentregue', teAuth, async function(req, res) {
  // Sempre 200
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
      var teId = d.Id || d.id;
      if (!teId) continue;

      logger.info('[TE-WEBHOOK] Processando entrega TE ID=' + teId + ' situacao=' + (d.Situacao || d.situacao));

      // Busca picking e sale.order pelo te_order_id
      var picking = await odooTe.findPickingByTeId(teId);
      var saleOrder = await odooTe.findSaleOrderByTeId(teId);

      var pickingData = mapper.teToOdooPicking(d);
      var soData = mapper.teToOdooSaleOrder(d);

      if (picking) {
        await odooTe.updatePickingTeData(picking.id, pickingData);
        // Posta no chatter
        var situacaoDesc = d.SituacaoDescricao || d.situacaoDescricao || '';
        var msg = '<b>TudoEntregue - Atualizacao via Webhook</b><br/>';
        msg += 'TE ID: ' + teId + '<br/>';
        msg += 'Situacao: ' + situacaoDesc;
        if (d.NomeMotorista || d.nomeMotorista) msg += '<br/>Motorista: ' + (d.NomeMotorista || d.nomeMotorista);
        if (d.PlacaVeiculo || d.placaVeiculo) msg += '<br/>Placa: ' + (d.PlacaVeiculo || d.placaVeiculo);
        if (d.Rastreio || d.rastreio) msg += '<br/>Rastreio: ' + (d.Rastreio || d.rastreio);
        if (d.Ocorrencia || d.ocorrencia) msg += '<br/>Ocorrencia: ' + (d.Ocorrencia || d.ocorrencia);
        await odooTe.postChatter('stock.picking', picking.id, msg);
      } else {
        logger.warn('[TE-WEBHOOK] Picking nao encontrado para TE ID=' + teId);
      }

      if (saleOrder) {
        await odooTe.updateSaleOrderTeData(saleOrder.id, soData);
        var soMsg = '<b>TudoEntregue - Atualizacao</b><br/>TE ID: ' + teId + '<br/>Situacao: ' + (d.SituacaoDescricao || d.situacaoDescricao || '');
        await odooTe.postChatter('sale.order', saleOrder.id, soMsg);
      }
    }
  } catch (err) {
    logger.error('[TE-WEBHOOK] Erro processando webhook: ' + err.message);
  }
});

module.exports = router;