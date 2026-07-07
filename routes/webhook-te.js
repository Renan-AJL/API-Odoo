// ============================================================
// routes/webhook-te.js — Recebe webhooks do TudoEntregue
// NAO usa apiKeyAuth — o TE autentica via headers AppKey/RequesterKey
// ============================================================
const express = require('express');
const router = express.Router();
const config = require('../config');
const odooTe = require('../services/odoo-te');
const Mapper = require('../services/mapper-te');
const { SITUATION_LABELS } = require('../services/tudoentregue');

// -------------------------------------------------------
// Validacao de headers TE (AppKey + RequesterKey)
// -------------------------------------------------------
function teWebhookAuth(req, res, next) {
  const appKey = req.headers['appkey'] || req.headers['AppKey'];
  const requesterKey = req.headers['requesterkey'] || req.headers['RequesterKey'];

  const expectedAppKey = config.tudoentregue.appKey;
  const expectedRequesterKey = config.tudoentregue.requesterKey;

  // Se nao esta configurado, aceita tudo (dev)
  if (!expectedAppKey && !expectedRequesterKey) {
    console.warn('[TE-WEBHOOK] TE nao configurado, aceitando webhook sem validacao');
    return next();
  }

  if (appKey !== expectedAppKey || requesterKey !== expectedRequesterKey) {
    console.warn('[TE-WEBHOOK] Autenticacao falhou', {
      appKey: appKey ? '***' : 'ausente',
      requesterKey: requesterKey ? '***' : 'ausente',
    });
    return res.status(401).json({ error: 'Autenticacao webhook falhou' });
  }

  next();
}

// -------------------------------------------------------
// POST /api/v1/te/webhook/tudoentregue
// -------------------------------------------------------
router.post('/webhook/tudoentregue', teWebhookAuth, async (req, res) => {
  try {
    const payload = req.body;

    console.log(`[TE-WEBHOOK] Recebido: ${Array.isArray(payload) ? 'array[' + payload.length + ']' : 'object'}`);

    const deliveries = Mapper.normalizeWebhookPayload(payload);
    const results = [];

    for (const d of deliveries) {
      const result = await processWebhookDelivery(d);
      results.push(result);
    }

    // Sempre 200 para o TE nao retry
    res.json({ success: true, processed: results.length, results });
  } catch (err) {
    console.error('[TE-WEBHOOK] Erro:', err.message, err.stack);
    res.status(200).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// Processamento individual
// -------------------------------------------------------
async function processWebhookDelivery(delivery) {
  const { orderNumber, situation, trackingCode, driverName, driverPhone } = delivery;

  if (!orderNumber) {
    return { orderNumber: 'desconhecido', status: 'ignored', reason: 'sem OrderNumber' };
  }

  const situationLabel = situation !== null && situation !== undefined
    ? (SITUATION_LABELS[situation] || `Situacao ${situation}`)
    : null;

  console.log(`[TE-WEBHOOK] ${orderNumber} -> situacao ${situation} (${situationLabel})`);

  // 1. Tenta stock.picking
  const picking = await odooTe.findPickingByTeId(orderNumber);
  if (picking) {
    const mapped = Mapper.teToOdooPicking(delivery.raw || delivery);
    await odooTe.updatePickingTeData(picking.id, mapped);
    console.log(`[TE-WEBHOOK] Picking ${picking.name} (id=${picking.id}) atualizado`);
  }

  // 2. Tenta sale.order
  const saleOrder = await odooTe.findSaleOrderByTeId(orderNumber);
  if (saleOrder) {
    await odooTe.updateSaleOrderTeData(saleOrder.id, {
      situation,
      situationLabel,
      trackingCode,
      trackingUrl: Mapper._buildTrackingUrl(delivery.raw || delivery),
      webhookReceived: true,
    });
    console.log(`[TE-WEBHOOK] Sale Order ${saleOrder.name} (id=${saleOrder.id}) atualizado`);

    // Se for compra, atualiza tambem
    const purchaseOrder = await odooTe.findPurchaseOrderByTeId(orderNumber);
    if (purchaseOrder) {
      await odooTe.updatePurchaseOrderTeData(purchaseOrder.id, { situation, trackingCode });
    }
  }

  const found = !!(picking || saleOrder);
  if (!found) {
    console.warn(`[TE-WEBHOOK] ${orderNumber} nao encontrado no ODOO`);
  }

  return {
    orderNumber,
    situation,
    situationLabel,
    trackingCode,
    driverName,
    pickingUpdated: !!picking,
    saleOrderUpdated: !!saleOrder,
    found,
  };
}

module.exports = router;