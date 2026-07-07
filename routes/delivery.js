// ============================================================
// routes/delivery.js — Rotas de entrega TudoEntregue (ODOO -> TE)
// Protegidas por API Key (mesma chave unificada)
// ============================================================
const express = require('express');
const router = express.Router();
const { client: teClient, ORDER_TYPES, SITUATION_LABELS } = require('../services/tudoentregue');
const odooTe = require('../services/odoo-te');
const Mapper = require('../services/mapper-te');
const { apiKeyAuth } = require('../middleware/auth');

// Todas as rotas de delivery exigem API Key
router.use(apiKeyAuth);

// -------------------------------------------------------
// POST /api/v1/te/deliveries/send — Envia pedidos do ODOO ao TE
// Body: { orderIds?: number[], pickingIds?: number[], orderType?: 1|2|3|4|5 }
// -------------------------------------------------------
router.post('/deliveries/send', async (req, res, next) => {
  try {
    const { orderIds, pickingIds, orderType = 1 } = req.body;

    if (!orderIds?.length && !pickingIds?.length) {
      return res.status(400).json({ success: false, error: 'Informe orderIds ou pickingIds' });
    }

    // 1. Busca pedidos ODOO
    const pickings = [];
    const saleOrders = [];

    if (pickingIds?.length) {
      const found = await odooTe.read('stock.picking', pickingIds, [
        'id', 'name', 'partner_id', 'scheduled_date', 'move_line_count', 'origin',
      ]);
      pickings.push(...found);
    }

    if (orderIds?.length) {
      const soFields = odooTe.getStudioFields('sale.order');
      const found = await odooTe.read('sale.order', orderIds, [
        'id', 'name', 'state', 'partner_id', 'amount_total', 'note', ...soFields,
      ]);
      saleOrders.push(...found);
    }

    // 2. Busca parceiros
    const partnerIds = [
      ...pickings.map(p => p.partner_id?.[0]),
      ...saleOrders.map(o => o.partner_id?.[0]),
    ].filter(Boolean);

    const partners = partnerIds.length > 0
      ? await odooTe.read('res.partner', [...new Set(partnerIds)], [
          'id', 'name', 'cnpj_cpf', 'vat', 'phone', 'mobile', 'email',
          'street', 'street_number', 'street2', 'zip', 'city',
          'l10n_br_district', 'partner_latitude', 'partner_longitude',
          'state_id', 'country_id',
          ...odooTe.getStudioFields('res.partner'),
        ])
      : [];

    const partnerMap = {};
    partners.forEach(p => { partnerMap[p.id] = p; });

    // 3. Mapeia para entregas TE
    const teDeliveries = [];

    for (const so of saleOrders) {
      const partner = partnerMap[so.partner_id?.[0]] || {};
      const picking = pickings.find(p => p.origin === so.name) || null;
      const teDelivery = Mapper.odooToTeDelivery(so, partner, picking);
      teDelivery.OrderType = orderType;
      teDeliveries.push(teDelivery);
    }

    for (const picking of pickings) {
      if (saleOrders.some(so => so.name === picking.origin)) continue; // ja mapeado
      const partner = partnerMap[picking.partner_id?.[0]] || {};
      const fakeSo = { name: picking.origin || `WH-${picking.id}`, note: '', id: 0 };
      const teDelivery = Mapper.odooToTeDelivery(fakeSo, partner, picking);
      teDelivery.OrderType = orderType;
      teDeliveries.push(teDelivery);
    }

    if (teDeliveries.length === 0) {
      return res.json({ success: true, sent: 0, message: 'Nenhuma entrega para enviar' });
    }

    // 4. Envia ao TE em lotes de 50
    const results = [];
    const BATCH = 50;

    for (let i = 0; i < teDeliveries.length; i += BATCH) {
      const batch = teDeliveries.slice(i, i + BATCH);
      const result = await teClient.createDeliveries(batch);
      results.push(result);

      // 5. Marca como sincronizado no ODOO
      const batchOrderNums = batch.map(d => d.OrderNumber);

      const syncedSo = saleOrders.filter(so =>
        batchOrderNums.includes(so.name) || batchOrderNums.includes(`WH-${so.id}`)
      );
      const syncedPickings = pickings.filter(p =>
        batchOrderNums.includes(p.origin) || batchOrderNums.includes(`WH-${p.id}`)
      );

      if (syncedSo.length > 0) {
        await odooTe.markSaleOrdersSynced(syncedSo.map(s => s.id), batchOrderNums[0], orderType);
      }
      if (syncedPickings.length > 0) {
        await odooTe.markPickingsSynced(syncedPickings.map(p => p.id), batchOrderNums[0]);
      }
    }

    console.log(`[TE-DELIVERY] Enviadas ${teDeliveries.length} entregas ao TE`);
    res.json({
      success: true,
      sent: teDeliveries.length,
      batches: results.length,
      results,
    });
  } catch (err) {
    console.error('[TE-DELIVERY] Erro:', err.message);
    const status = err.isAxiosError ? (err.response?.status || 502) : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// POST /api/v1/te/deliveries/sync-unsynced — Busca pendentes e envia
// -------------------------------------------------------
router.post('/deliveries/sync-unsynced', async (req, res, next) => {
  try {
    const { limit = 50, orderType = 1 } = req.body;

    const saleOrders = await odooTe.getUnsyncedSaleOrders(limit);
    const pickings = await odooTe.getUnsyncedPickings(limit);

    if (saleOrders.length === 0 && pickings.length === 0) {
      return res.json({ success: true, sent: 0, message: 'Nenhum pedido pendente' });
    }

    // Delega para /send via redirect interno
    req.body = {
      orderIds: saleOrders.map(o => o.id),
      pickingIds: pickings.map(p => p.id),
      orderType,
    };
    return router.handle(req, res, next);
  } catch (err) {
    console.error('[TE-DELIVERY] Erro sync-unsynced:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// GET /api/v1/te/deliveries/status/:orderNumber — Consulta situacao no TE
// -------------------------------------------------------
router.get('/deliveries/status/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;

    const result = await teClient.getDeliveries({ orderNumber, page: 1 });
    const delivery = result?.Result?.[0] || null;

    if (!delivery) {
      return res.status(404).json({ success: false, error: `Entrega ${orderNumber} nao encontrada no TE` });
    }

    const mapped = Mapper.teToOdooPicking(delivery);

    // Atualiza no ODOO
    const picking = await odooTe.findPickingByTeId(orderNumber);
    if (picking) await odooTe.updatePickingTeData(picking.id, mapped);

    const saleOrder = await odooTe.findSaleOrderByTeId(orderNumber);
    if (saleOrder) {
      await odooTe.updateSaleOrderTeData(saleOrder.id, Mapper.teToOdooSaleOrder(delivery));
    }

    res.json({
      success: true,
      orderNumber,
      situation: mapped.situation,
      situationLabel: mapped.situationLabel,
      trackingCode: mapped.trackingCode,
      driverName: mapped.driverName,
      odooUpdated: !!(picking || saleOrder),
      raw: delivery,
    });
  } catch (err) {
    console.error('[TE-DELIVERY] Erro status:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// GET /api/v1/te/deliveries/occurrences/:orderNumber
// -------------------------------------------------------
router.get('/deliveries/occurrences/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;

    const result = await teClient.getDeliveriesWithOccurrence({ orderNumber, page: 1 });
    const delivery = result?.Result?.[0] || null;

    if (!delivery) {
      return res.status(404).json({ success: false, error: `Ocorrencia de ${orderNumber} nao encontrada` });
    }

    const mapped = Mapper.teToOdooPicking(delivery);

    res.json({
      success: true,
      orderNumber,
      occurrenceDescription: delivery.OccurrenceDescription || delivery.occurrenceDescription,
      occurrenceDate: delivery.OccurrenceDate || delivery.occurrenceDate,
      situation: mapped.situation,
      situationLabel: mapped.situationLabel,
      raw: delivery,
    });
  } catch (err) {
    console.error('[TE-DELIVERY] Erro occurrences:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// PUT /api/v1/te/deliveries/edit — Edita entregas no TE
// -------------------------------------------------------
router.put('/deliveries/edit', async (req, res) => {
  try {
    const { deliveries } = req.body;
    if (!deliveries?.length) {
      return res.status(400).json({ success: false, error: 'Informe o array "deliveries"' });
    }

    const result = await teClient.editDeliveries(deliveries);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[TE-DELIVERY] Erro edit:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// DELETE /api/v1/te/deliveries/cancel — Cancela entregas no TE
// -------------------------------------------------------
router.delete('/deliveries/cancel', async (req, res) => {
  try {
    const { orders } = req.body;
    if (!orders?.length) {
      return res.status(400).json({ success: false, error: 'Informe o array "orders" com OrderNumber e OrderType' });
    }

    const result = await teClient.cancelDeliveries(orders);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[TE-DELIVERY] Erro cancel:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// GET /api/v1/te/deliveries/situations — Lista situacoes
// -------------------------------------------------------
router.get('/deliveries/situations', async (req, res) => {
  try {
    const situations = await teClient.getSituations();
    res.json({ success: true, situations });
  } catch (err) {
    console.error('[TE-DELIVERY] Erro situations:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// GET /api/v1/te/deliveries/pull — Puxa status e atualiza ODOO
// -------------------------------------------------------
router.get('/deliveries/pull', async (req, res) => {
  try {
    const { dateFrom, dateTo, situation } = req.query;

    const params = { page: 1 };
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo) params.dateTo = dateTo;
    if (situation) params.situation = parseInt(situation, 10);

    const allDeliveries = await teClient.fetchAllPages('/api/Entregas', params);

    let updated = 0;
    let notFound = 0;

    for (const d of allDeliveries) {
      const orderNum = d.OrderNumber || d.orderNumber;
      const picking = await odooTe.findPickingByTeId(orderNum);

      if (picking) {
        const mapped = Mapper.teToOdooPicking(d);
        await odooTe.updatePickingTeData(picking.id, mapped);
        updated++;
      } else {
        const so = await odooTe.findSaleOrderByTeId(orderNum);
        if (so) {
          await odooTe.updateSaleOrderTeData(so.id, Mapper.teToOdooSaleOrder(d));
          updated++;
        } else {
          notFound++;
        }
      }
    }

    res.json({
      success: true,
      totalFetched: allDeliveries.length,
      updatedInOdoo: updated,
      notFoundInOdoo: notFound,
    });
  } catch (err) {
    console.error('[TE-DELIVERY] Erro pull:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;