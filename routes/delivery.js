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
const config = require('../config');

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

const SITUATION_ORDER_COLORS = {
  0:  '#9e9e9e',  // cinza - Aguardando
  1:  '#2196f3',  // azul - Em Rota
  3:  '#4caf50',  // verde - Entregue
  5:  '#f44336',  // vermelho - Nao Entregue
  6:  '#ff9800',  // laranja - Parcial
  8:  '#b71c1c',  // vermelho escuro - Cancelada
  9:  '#ff5722',  // laranja escuro - Atrasada
  10: '#0097a7',  // teal - Em Separacao
  11: '#9c27b0',  // roxo - Transferida
  12: '#1b5e20',  // verde escuro - Baixada
  // /orders/situation codes (usados no timeline)
  2:  '#42a5f5',  // azul claro
  4:  '#e53935',  // vermelho
  7:  '#1b5e20',  // verde escuro - Operacao Finalizada
};

// ============================================================
// HTML CARD BUILDER — Um card com tudo que vem do TE
// ============================================================

// Labels para /orders/situation (codigo diferente do /api/Entregas)
const SIT_ORDER_LABELS = {
  0: 'Nao Enviada', 1: 'Envio Solicitado',
  2: 'Enviada ao Motorista - Aguardando',
  3: 'Enviada ao Motorista - Confirmada',
  4: 'Enviada ao Motorista - Recusada',
  5: 'Finalizada pelo Motorista', 6: 'Finalizada pelo Cliente',
  7: 'Operacao Finalizada', 8: 'Operacao Cancelada',
  9: 'Cancelamento ao Motorista', 11: 'Transferida',
};

function fmtDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return dateStr; }
}

function buildTeCard(delivery, trackingData, situationData) {
  // Dados da entrega
  const sitCode = delivery.Situation ?? delivery.situation ?? null;
  const sitLabel = SITUATION_LABELS[sitCode] || ("Situacao " + sitCode);
  const sitColor = SITUATION_ORDER_COLORS[sitCode] || '#607d8b';
  const trackingCode = delivery.TrackingCode || delivery.trackingCode || '';
  const orderNum = delivery.OrderNumber || delivery.orderNumber || '';
  const custName = delivery.CustomerName || delivery.customerName || '';
  const scheduled = delivery.ScheduledDate || delivery.scheduledDate || '';
  const deliveredDate = delivery.DeliveredDate || delivery.deliveredDate || '';
  const occDesc = delivery.OccurrenceDescription || delivery.occurrenceDescription || '';
  const proofUrl = delivery.ProofUrl || delivery.proofUrl || '';

  // Motorista — vem do /api/Entregas
  let driverName = delivery.DriverName || delivery.driverName || '';
  let driverPhone = delivery.DriverPhone || delivery.driverPhone || '';

  // Motorista — complementa do /orders/situation (telefone completo com pais)
  const sitDriver = situationData?.Driver;
  if (sitDriver) {
    if (!driverName && sitDriver.Name) driverName = sitDriver.Name;
    if (!driverPhone && sitDriver.PhoneNumber) {
      const pc = sitDriver.PhoneCountry || '55';
      driverPhone = '+' + pc + ' ' + sitDriver.PhoneNumber;
    }
  }

  // Motorista — complementa do /tracking (nome + foto)
  const trackOrder = trackingData?.Order;
  const trackDriver = trackOrder?.Driver;
  if (trackDriver) {
    if (!driverName && trackDriver.Name) driverName = trackDriver.Name;
  }

  // --- Linhas de informacao ---
  const row = (label, value, color, href) => {
    if (!value) return '';
    const valHtml = href
      ? '<a href="' + href + '" target="_blank" style="color:' + (color || '#333') + ';text-decoration:none;">' + value + '</a>'
      : '<span style="color:' + (color || '#333') + ';">' + value + '</span>';
    return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<span style="font-size:11px;color:#888;">' + label + '</span>' +
      '<span style="font-size:12px;font-weight:500;">' + valHtml + '</span></div>';
  };

  // --- Bloco do motorista (destacado) ---
  let motoristaHtml = '';
  if (driverName) {
    const phoneLink = driverPhone ? ('tel:' + driverPhone.replace(/[^0-9+]/g, '')) : '';
    const driverPhoto = trackDriver?.PictureUrl || '';
    motoristaHtml =
      '<div style="margin-top:10px;padding:12px;background:linear-gradient(135deg,#e8f5e9,#f1f8e9);border-radius:8px;border:1px solid #c8e6c9;">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          (driverPhoto
            ? '<img src="' + driverPhoto + '" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid #43a047;" />'
            : '<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#2e7d32,#43a047);display:flex;align-items:center;justify-content:center;color:white;font-size:18px;">&#128100;</div>') +
          '<div style="flex:1;">' +
            '<div style="font-size:13px;font-weight:700;color:#1b5e20;">' + driverName + '</div>' +
            (driverPhone
              ? '<div style="font-size:11px;color:#555;"><a href="' + phoneLink + '" style="color:#2e7d32;text-decoration:none;font-weight:600;">' + driverPhone + '</a></div>'
              : '') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // --- Timeline de status (do /orders/situation) ---
  let timelineHtml = '';
  const statuses = situationData?.Status || [];
  if (statuses.length > 0) {
    const items = statuses.map((s, i) => {
      const label = SIT_ORDER_LABELS[s.Status] || ('Status ' + s.Status);
      const color = SITUATION_ORDER_COLORS[s.Status] || '#607d8b';
      const date = s.Date ? fmtDate(s.Date) : '';
      const first = (i === 0);
      return '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:' + (first ? '8' : '5') + 'px;">' +
        '<div style="min-width:10px;min-height:10px;width:10px;height:10px;border-radius:50%;background:' + color + ';margin-top:4px;' +
          (first ? 'box-shadow:0 0 0 3px ' + color + '33;' : 'opacity:0.5;') + '"></div>' +
        '<div style="flex:1;">' +
          '<div style="font-size:12px;color:#333;font-weight:' + (first ? '600' : '400') + ';">' + label + '</div>' +
          (date ? '<div style="font-size:10px;color:#999;margin-top:1px;">' + date + '</div>' : '') +
        '</div></div>';
    }).join('');
    timelineHtml = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0;">' +
      '<div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Historico</div>' +
      items + '</div>';
  }

  // --- Ocorrencias com fotos (do /tracking) ---
  let occHtml = '';
  const trackStatuses = trackingData?.TrackingStatus || [];
  if (trackStatuses.length > 0) {
    const occItems = trackStatuses.map(ts => {
      const ok = (ts.Status === 'check');
      const icon = ok ? '&#10003;' : '&#9888;';
      const color = ok ? '#4caf50' : '#ff9800';
      const date = ts.Date ? fmtDate(ts.Date) : '';
      const images = (ts.AttachmentsImagesUrls || []).filter(Boolean);
      return '<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;padding:8px;background:' +
        (ok ? '#f1f8e9' : '#fff3e0') + ';border-radius:6px;">' +
        '<div style="color:' + color + ';font-size:16px;font-weight:bold;min-width:20px;text-align:center;">' + icon + '</div>' +
        '<div style="flex:1;">' +
          '<div style="font-size:12px;color:#333;">' + (ts.Description || '') + '</div>' +
          (date ? '<div style="font-size:10px;color:#999;margin-top:2px;">' + date + '</div>' : '') +
          (images.length > 0
            ? '<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">' +
                images.map(img => '<img src="' + img + '" style="max-width:120px;max-height:80px;border-radius:4px;cursor:pointer;" />').join('') +
              '</div>'
            : '') +
        '</div></div>';
    }).join('');
    occHtml = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0;">' +
      '<div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Ocorrencias</div>' +
      occItems + '</div>';
  }

  // --- Ocorrencia principal (do /api/Entregas) ---
  let mainOccHtml = '';
  if (occDesc) {
    mainOccHtml = '<div style="margin-top:10px;padding:8px 12px;background:#fff3e0;border-radius:6px;border-left:3px solid #ff9800;">' +
      '<div style="font-size:11px;color:#888;margin-bottom:2px;">Ocorrencia</div>' +
      '<div style="font-size:12px;color:#e65100;">' + occDesc + '</div></div>';
  }

  // --- Comprovante ---
  let proofHtml = '';
  if (proofUrl) {
    proofHtml = '<div style="margin-top:10px;text-align:center;">' +
      '<a href="' + proofUrl + '" target="_blank" style="display:inline-block;padding:8px 20px;background:#1565c0;color:white;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">&#128196; Ver Comprovante de Entrega</a></div>';
  }

  return '<div style="font-family:\'Segoe UI\',Arial,sans-serif;max-width:480px;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">' +
    '<div style="background:linear-gradient(135deg,#1565c0,#1e88e5);color:white;padding:14px 16px;display:flex;align-items:center;gap:10px;">' +
      '<div style="font-size:22px;">&#128666;</div>' +
      '<div style="flex:1;"><div style="font-size:14px;font-weight:700;">TudoEntregue</div>' +
      '<div style="font-size:11px;opacity:0.85;">Status de Entrega</div></div>' +
      '<div style="background:' + sitColor + ';color:white;font-size:10px;font-weight:700;padding:4px 12px;border-radius:20px;text-transform:uppercase;">' + sitLabel + '</div>' +
    '</div>' +
    '<div style="padding:14px 16px;">' +
      row('Pedido', orderNum) +
      (trackingCode ? row('Rastreio', trackingCode, '#1565c0', 'https://app.tudoentregue.com.br/rastreamento/' + trackingCode) : '') +
      row('Cliente', custName) +
      row('Agendamento', fmtDate(scheduled)) +
      (deliveredDate ? row('Entregue em', fmtDate(deliveredDate), '#4caf50') : '') +
      motoristaHtml +
      mainOccHtml +
      timelineHtml +
      occHtml +
      proofHtml +
    '</div>' +
    '<div style="background:#f5f5f5;padding:8px 16px;font-size:10px;color:#aaa;text-align:right;">Atualizado: ' +
      new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</div>' +
  '</div>';
}

function buildErrorCard(title, message) {
  return '<div style="font-family:\'Segoe UI\',Arial,sans-serif;max-width:480px;border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">' +
    '<div style="background:linear-gradient(135deg,#c62828,#e53935);color:white;padding:14px 16px;display:flex;align-items:center;gap:10px;">' +
    '<div style="font-size:22px;">&#9888;</div>' +
    '<div style="font-size:14px;font-weight:700;">' + title + '</div></div>' +
    '<div style="padding:14px 16px;"><div style="font-size:12px;color:#c62828;">' + message + '</div></div>' +
    '<div style="background:#f5f5f5;padding:8px 16px;font-size:10px;color:#aaa;text-align:right;">' +
    new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</div></div>';
}

// ============================================================
// POST /api/v1/te/send-invoice — Envia fatura ao TE (botao Odoo)
// Body: { invoice_id: number, sale_order_id?: number }
// Funciona COM ou SEM sale.order vinculada
// ============================================================
router.post('/send-invoice', async (req, res) => {
  console.log('[TE-SEND-INVOICE] Body recebido: ' + JSON.stringify(req.body));
  const invId = req.body.invoice_id || req.body.id;
  if (!invId) return res.status(400).json({ success: false, error: 'invoice_id obrigatorio' });

  try {
    // 1. Le a fatura completa
    const invoice = await odooTe.readInvoiceFull(invId);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Fatura ' + invId + ' nao encontrada' });
    }
    console.log('[TE-SEND-INVOICE] Fatura: ' + invoice.name + ' (id=' + invoice.id + ', partner=' + JSON.stringify(invoice.partner_id) + ')');

    // 2. Le o partner da fatura
    const partnerId = invoice.partner_id ? (Array.isArray(invoice.partner_id) ? invoice.partner_id[0] : invoice.partner_id) : null;
    if (!partnerId) {
      return res.status(400).json({ success: false, error: 'Fatura sem parceiro' });
    }
    const partnerArr = await odooTe.read('res.partner', [partnerId], [
      'id', 'name', 'cnpj_cpf', 'vat', 'phone', 'mobile', 'email',
      'street', 'street_number', 'street2', 'zip', 'city',
      'l10n_br_district', 'partner_latitude', 'partner_longitude', 'state_id', 'country_id',
      ...odooTe.getStudioFields('res.partner'),
    ]);
    const partnerData = Array.isArray(partnerArr) ? partnerArr[0] : partnerArr;

    // 3. Tenta encontrar a venda (3 vias)
    let saleOrder = null;
    let saleFull = null;
    let picking = null;

    // 3a. Se Odoo enviou sale_order_id diretamente no body
    if (req.body.sale_order_id) {
      console.log('[TE-SEND-INVOICE] sale_order_id direto: ' + req.body.sale_order_id);
      saleOrder = await odooTe.findSaleOrderById(req.body.sale_order_id);
    }

    // 3b. Busca automatica via relacao invoice -> sale.order
    if (!saleOrder) {
      saleOrder = await odooTe.findSaleOrderByInvoice(invId);
    }

    // 4. Se tem venda, busca dados completos (picking, linhas, motorista)
    let orderLines = [];
    let productsMap = {};

    if (saleOrder) {
      console.log('[TE-SEND-INVOICE] Venda encontrada: ' + saleOrder.name + ' (id=' + saleOrder.id + ')');
      saleFull = await odooTe.readSaleOrderFull(saleOrder.id);
      picking = await odooTe.findDeliveryPicking(saleOrder.id);
      if (picking) {
        console.log('[TE-SEND-INVOICE] Picking: ' + picking.name + ' (id=' + picking.id + ')');
      } else {
        console.log('[TE-SEND-INVOICE] Picking nao encontrado, usando fatura como base');
      }
      orderLines = await odooTe.getSaleOrderLines(saleOrder.id);
    } else {
      console.log('[TE-SEND-INVOICE] Venda NAO encontrada. Fluxo direto fatura->TE (sem motorista, sem picking)');
      // Usa linhas da fatura como orderLines
      try {
        orderLines = await odooTe.getInvoiceLines(invId);
        console.log('[TE-SEND-INVOICE] ' + orderLines.length + ' linhas da fatura com produto');
      } catch (err) {
        console.warn('[TE-SEND-INVOICE] Erro lendo linhas da fatura: ' + err.message);
      }
    }

    // 5. Busca produtos das linhas
    const productIds = [];
    orderLines.forEach(function(line) {
      if (line.product_id && line.product_id[0]) productIds.push(line.product_id[0]);
    });
    if (productIds.length) productsMap = await odooTe.getProducts(productIds);

    // 6. Le dados da empresa (remetente)
    const company = await odooTe.getCompany();

    // 7. Mapeia para TE (picking sera sintetico pelo mapper se null)
    const delivery = Mapper.odooToTeDelivery({
      picking: picking,
      partner: partnerData,
      saleOrder: saleFull || saleOrder,
      invoice: invoice,
      company: company,
      companyCnpj: config.empresa.cnpj,
      orderLines: orderLines,
      productsMap: productsMap,
    });
    if (!delivery) {
      return res.status(500).json({ success: false, error: 'Falha no mapeamento dos dados' });
    }

    // 8. Chatter: enviando (so em account.move + se tiver, sale.order/picking)
    var chatterMsg = '<b>TudoEntregue</b><br/>';
    chatterMsg += 'Enviando ao TudoEntregue...<br/>';
    chatterMsg += 'Pedido: ' + delivery.OrderNumber + '<br/>';
    chatterMsg += 'Destinatario: ' + (delivery.DestinationAddress.Name || '') + '<br/>';
    chatterMsg += 'CNPJ/CPF: ' + (delivery.DestinationAddress.DocumentNumber || '') + '<br/>';
    chatterMsg += 'Cidade: ' + (delivery.DestinationAddress.City || '') + '/' + (delivery.DestinationAddress.State || '') + '<br/>';
    chatterMsg += 'CEP: ' + (delivery.DestinationAddress.ZipCode || '');
    if (delivery.Weight) chatterMsg += '<br/>Peso: ' + delivery.Weight + ' kg';
    if (delivery.Volume) chatterMsg += ' | Volumes: ' + delivery.Volume;
    if (delivery.Documents && delivery.Documents.length) {
      chatterMsg += '<br/>NF: ' + (delivery.Documents[0].DocumentNumber || '');
    }
    if (!saleOrder) {
      chatterMsg += '<br/><i>Sem sale.order vinculada — fluxo direto fatura</i>';
    }
    await odooTe.postChatter('account.move', invId, chatterMsg);
    if (picking) await odooTe.postChatter('stock.picking', picking.id, chatterMsg);
    if (saleOrder) await odooTe.postChatter('sale.order', saleOrder.id, chatterMsg);

    // 9. Envia ao TE
    console.log('[TE-SEND-INVOICE] Enviando ao TE...');
    const teResult = await teClient.createDeliveries([delivery]);
    const teResp = Array.isArray(teResult) ? teResult[0] : teResult;

    // 10. Grava retorno
    if (teResp) {
      const odooData = Mapper.teCreateToOdoo(teResp);
      await odooTe.markInvoiceSynced([invId], teResp.OrderID || null);
      if (picking) {
        if (Object.keys(odooData).length) await odooTe.updatePickingTeData(picking.id, odooData);
        await odooTe.markPickingsSynced([picking.id], teResp.OrderID || null);
      }
      if (saleOrder) {
        if (Object.keys(odooData).length) await odooTe.updateSaleOrderTeData(saleOrder.id, odooData);
        await odooTe.markSaleOrdersSynced([saleOrder.id], teResp.OrderID || null);
      }

      var resultMsg = Mapper.chatterCreateMessage(teResp, delivery);
      await odooTe.postChatter('account.move', invId, resultMsg);
      if (picking) await odooTe.postChatter('stock.picking', picking.id, resultMsg);
      if (saleOrder) await odooTe.postChatter('sale.order', saleOrder.id, resultMsg);

      res.json({
        success: true,
        invoice_id: invId,
        sale: saleOrder ? saleOrder.name : null,
        picking: picking ? picking.name : null,
        te_order_id: teResp.OrderID,
        te_received: teResp.Received,
        te_tracking: teResp.TrackingCode,
      });
    } else {
      await odooTe.postChatter('account.move', invId, '<b>TudoEntregue - ERRO</b><br/>TE nao retornou dados.');
      res.status(502).json({ success: false, error: 'TE nao retornou dados' });
    }
  } catch (err) {
    console.error('[TE-SEND-INVOICE] Erro:', err.message);
    try {
      await odooTe.postChatter('account.move', invId, '<b>TudoEntregue - ERRO</b><br/>' + err.message);
    } catch {}
    const status = err.isAxiosError ? (err.response?.status || 502) : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/v1/te/delivery-status — Busca status TE e grava card HTML
// Body: { saleOrderId: number }
// ============================================================
router.post('/delivery-status', async (req, res) => {
  try {
    const { saleOrderId } = req.body;
    if (!saleOrderId) {
      return res.status(400).json({ success: false, error: 'Informe saleOrderId' });
    }

    // 1. Busca sale order no Odoo
    const so = await odooTe.findSaleOrderById(saleOrderId);
    if (!so) {
      return res.status(404).json({ success: false, error: `Sale Order ${saleOrderId} nao encontrada` });
    }

    const f = odooTe.FIELDS['sale.order'];
    const orderName = so.name;
    const teOrderId = so[f.teOrderId];
    const trackingCode = so[f.teTrackingCode];

    if (!teOrderId && !trackingCode) {
      // Nenhuma entrega enviada ao TE ainda
      const noCard = buildErrorCard(
        'Sem Entrega TE',
        `Pedido ${orderName} ainda nao foi enviado ao TudoEntregue. Envie a entrega primeiro.`
      );
      await odooTe.updateSaleOrderStatusHtml(saleOrderId, noCard);
      return res.json({ success: true, message: 'Pedido ainda nao enviado ao TE', card: noCard });
    }

    // 2. Busca dados no TE — /api/Entregas (dados completos da entrega)
    let deliveryData = null;
    if (teOrderId) {
      const result = await teClient.getDeliveries({ orderNumber: teOrderId, page: 1 });
      deliveryData = result?.Result?.[0] || null;
    }

    // 3. Busca situacao detalhada — /orders/situation
    let situationData = null;
    if (teOrderId) {
      try {
        situationData = await teClient.getOrderSituation({
          orderType: 1,
          orderID: teOrderId,
        });
      } catch (err) {
        console.warn(`[TE-DELIVERY-STATUS] /orders/situation falhou: ${err.message}`);
      }
    }

    // 4. Busca tracking detalhado (ocorrencias com fotos)
    let trackingData = null;
    if (trackingCode) {
      try {
        trackingData = await teClient.getTracking(trackingCode);
      } catch (err) {
        console.warn(`[TE-DELIVERY-STATUS] /tracking falhou: ${err.message}`);
      }
    }

    // 5. Monta card HTML
    const cardHtml = buildTeCard(deliveryData || {}, trackingData, situationData);

    // 6. Tambem atualiza campos padrao do TE
    if (deliveryData) {
      const mapped = Mapper.teToOdooPicking(deliveryData);
      const soMapped = Mapper.teToOdooSaleOrder(deliveryData);
      await odooTe.updateSaleOrderTeData(saleOrderId, soMapped);
    }

    // 7. Atualiza campo de motorista (selection) a partir do TE
    let motoristaAtualizado = null;
    if (deliveryData) {
      const driverName = deliveryData.DriverName || deliveryData.driverName || '';
      if (driverName) {
        motoristaAtualizado = matchMotoristaSelection(driverName);
        if (motoristaAtualizado) {
          await odooTe.updateSaleOrderMotorista(saleOrderId, motoristaAtualizado);
          console.log(`[TE-DELIVERY-STATUS] Motorista: ${driverName} -> ${motoristaAtualizado}`);
        }
      }
    }

    // 8. Grava card no campo HTML
    await odooTe.updateSaleOrderStatusHtml(saleOrderId, cardHtml);

    console.log(`[TE-DELIVERY-STATUS] Card atualizado: SO ${orderName} (${saleOrderId})`);
    res.json({
      success: true,
      orderName,
      teOrderId,
      trackingCode,
      motorista: motoristaAtualizado || null,
      hasDeliveryData: !!deliveryData,
      hasSituationData: !!situationData,
      hasTrackingData: !!trackingData,
      card: cardHtml,
    });
  } catch (err) {
    console.error('[TE-DELIVERY-STATUS] Erro:', err.message);
    // Grava card de erro no campo
    try {
      await odooTe.updateSaleOrderStatusHtml(req.body.saleOrderId, buildErrorCard('Erro ao Buscar Status', err.message));
    } catch {}
    const status = err.isAxiosError ? (err.response?.status || 502) : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ============================================================
// MATCH MOTORISTA — Faz match do nome do TE com as opcoes do campo selection
// O campo x_studio_motorista e um selection com 17 opcoes (key/label)
// ============================================================
const MOTORISTA_OPTIONS = [
  'adelson', 'anderlucio', 'antonio', 'carlos', 'daniel',
  'diego', 'eduardo', 'fellipe', 'gerson', 'glauber',
  'henrique', 'italo', 'jeferson', 'joao_pedro', 'lucas',
  'matheus', 'rafael',
];

function matchMotoristaSelection(driverNameFromTe) {
  if (!driverNameFromTe) return null;
  const name = driverNameFromTe.toUpperCase().trim();
  // Remove sufixos comuns como "MOTORISTA", "FRETE", etc
  const cleanName = name
    .replace(/\b(MOTORISTA|FRETE|ENTREGAS|MOTOBOY)\b/g, '')
    .replace(/[^A-ZÀ-Ú\s]/g, '')
    .trim();
  const parts = cleanName.split(/\s+/).filter(Boolean);

  // Tenta match exato com a key ou com o primeiro/ultimo nome
  for (const key of MOTORISTA_OPTIONS) {
    const keyUpper = key.toUpperCase();
    if (name.includes(keyUpper) || keyUpper.includes(name)) return key;
  }
  // Tenta match com qualquer parte do nome
  for (const part of parts) {
    if (part.length < 3) continue;
    for (const key of MOTORISTA_OPTIONS) {
      if (key.toUpperCase() === part || part.includes(key.toUpperCase())) return key;
    }
  }
  return null;
}

module.exports = router;