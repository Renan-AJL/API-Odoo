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

// ============================================================
// MOTORISTA: Mapa nome -> telefone (configurar os telefones)
// ============================================================
// Mapeamento dos motoristas do Odoo (selection key) para telefone TE
// Formato: telefone com DDD (ex: '41999999999')
// IMPORTANTE: Preencha os telefones reais dos motoristas
const MOTORISTA_PHONE_MAP = {
  'ADRIANO':       '',
  'EDUARDO':       '',
  'EMERSON':       '',
  'FELIX':         '',
  'GIAN':          '',
  'HAIME':         '',
  'HUGTHON':       '',
  'Leonardo | Active': '',
  'LUCAS':         '',
  'Lucas Mateus':  '',
  'LUIS':          '',
  'MARCOS':        '',
  'MARCOS2':       '',
  'PAULO':         '',
  'ROBERTO':       '',
  'STRADA PINHAIS':'',
  'WELINGTON':     '',
  'WELINGTON2':    '',
};

// ============================================================
// STATUS LABELS para /orders/situation (codigo diferente do /api/Entregas)
// ============================================================
const SITUATION_ORDER_LABELS = {
  0:  'Nao Enviada',
  1:  'Envio Solicitado',
  2:  'Enviada ao Motorista - Aguardando Confirmacao',
  3:  'Enviada ao Motorista - Confirmada',
  4:  'Enviada ao Motorista - Recusada',
  5:  'Finalizada pelo Motorista',
  6:  'Finalizada pelo Cliente',
  7:  'Operacao Finalizada',
  8:  'Operacao Cancelada',
  9:  'Cancelamento Enviado ao Motorista',
  11: 'Transferida',
};

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
// HTML CARD BUILDERS
// ============================================================

function buildDeliveryStatusCard(delivery, trackingData, situationData) {
  const sitCode = delivery.Situation ?? delivery.situation ?? null;
  const sitLabel = SITUATION_LABELS[sitCode] || `Situacao ${sitCode}`;
  const sitColor = SITUATION_ORDER_COLORS[sitCode] || '#607d8b';
  const trackingCode = delivery.TrackingCode || delivery.trackingCode || '';
  const driverName = delivery.DriverName || delivery.driverName || '';
  const driverPhone = delivery.DriverPhone || delivery.driverPhone || '';
  const orderNum = delivery.OrderNumber || delivery.orderNumber || '';
  const custName = delivery.CustomerName || delivery.customerName || '';
  const docNum = delivery.DocumentNumber || delivery.documentNumber || '';
  const scheduled = delivery.ScheduledDate || delivery.scheduledDate || '';
  const deliveredDate = delivery.DeliveredDate || delivery.deliveredDate || '';
  const occDesc = delivery.OccurrenceDescription || delivery.occurrenceDescription || '';

  // Build timeline from situationData.Status[]
  let timelineHtml = '';
  const statuses = situationData?.Status || [];
  if (statuses.length > 0) {
    timelineHtml = `
      <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e0e0e0;">
        <div style="font-size: 11px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Historico de Status</div>
        ${statuses.map((s, i) => {
          const sLabel = SITUATION_ORDER_LABELS[s.Status] || `Status ${s.Status}`;
          const sColor = SITUATION_ORDER_COLORS[s.Status] || '#607d8b';
          const sDate = s.Date ? formatDate(s.Date) : '';
          const isFirst = i === 0;
          return `
          <div style="display: flex; gap: 10px; align-items: flex-start; margin-bottom: ${isFirst ? '8px' : '6px'};">
            <div style="min-width: 10px; min-height: 10px; width: 10px; height: 10px; border-radius: 50%; background: ${sColor}; margin-top: 4px; ${isFirst ? 'box-shadow: 0 0 0 3px ' + sColor + '33;' : 'opacity: 0.6;'}"></div>
            <div style="flex: 1;">
              <div style="font-size: 12px; color: #333; font-weight: ${isFirst ? '600' : '400'};">${sLabel}</div>
              ${sDate ? `<div style="font-size: 10px; color: #999; margin-top: 2px;">${sDate}</div>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  // Tracking statuses from /tracking
  let trackingHtml = '';
  const trackStatuses = trackingData?.TrackingStatus || [];
  if (trackStatuses.length > 0) {
    trackingHtml = `
      <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e0e0e0;">
        <div style="font-size: 11px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Ocorrencias</div>
        ${trackStatuses.map(ts => {
          const isOk = ts.Status === 'check';
          const icon = isOk ? '&#10003;' : '&#9888;';
          const color = isOk ? '#4caf50' : '#ff9800';
          const tsDate = ts.Date ? formatDate(ts.Date) : '';
          const images = (ts.AttachmentsImagesUrls || []).filter(Boolean);
          return `
          <div style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; padding: 8px; background: ${isOk ? '#f1f8e9' : '#fff3e0'}; border-radius: 6px;">
            <div style="color: ${color}; font-size: 16px; font-weight: bold; min-width: 20px; text-align: center;">${icon}</div>
            <div style="flex: 1;">
              <div style="font-size: 12px; color: #333;">${ts.Description || ''}</div>
              ${tsDate ? `<div style="font-size: 10px; color: #999; margin-top: 2px;">${tsDate}</div>` : ''}
              ${images.length > 0 ? images.map(img => `<img src="${img}" style="max-width: 120px; max-height: 80px; border-radius: 4px; margin-top: 6px; margin-right: 4px; cursor: pointer;" />`).join('') : ''}
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  return `
<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; border: 1px solid #e0e0e0; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
  <!-- Header -->
  <div style="background: linear-gradient(135deg, #1565c0, #1e88e5); color: white; padding: 14px 16px; display: flex; align-items: center; gap: 10px;">
    <div style="font-size: 22px;">&#128666;</div>
    <div style="flex: 1;">
      <div style="font-size: 14px; font-weight: 700;">Status de Entrega</div>
      <div style="font-size: 11px; opacity: 0.85;">TudoEntregue</div>
    </div>
    <div style="background: ${sitColor}; color: white; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; text-transform: uppercase;">${sitLabel}</div>
  </div>
  <!-- Body -->
  <div style="padding: 14px 16px;">
    ${orderNum ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Pedido</span><span style="font-size: 12px; font-weight: 600; color: #333;">${orderNum}</span></div>` : ''}
    ${trackingCode ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Rastreio</span><span style="font-size: 12px; font-weight: 600; color: #1565c0;"><a href="https://app.tudoentregue.com.br/rastreamento/${trackingCode}" target="_blank" style="color: #1565c0; text-decoration: none;">${trackingCode}</a></span></div>` : ''}
    ${custName ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Cliente</span><span style="font-size: 12px; color: #333;">${custName}</span></div>` : ''}
    ${driverName ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Motorista</span><span style="font-size: 12px; color: #333;">${driverName}</span></div>` : ''}
    ${driverPhone ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Tel Motorista</span><span style="font-size: 12px; color: #333;"><a href="tel:+55${driverPhone}" style="color: #333; text-decoration: none;">${driverPhone}</a></span></div>` : ''}
    ${scheduled ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Agendamento</span><span style="font-size: 12px; color: #333;">${formatDate(scheduled)}</span></div>` : ''}
    ${deliveredDate ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Entregue em</span><span style="font-size: 12px; color: #4caf50; font-weight: 600;">${formatDate(deliveredDate)}</span></div>` : ''}
    ${occDesc ? `<div style="margin-top: 10px; padding: 8px 12px; background: #fff3e0; border-radius: 6px; border-left: 3px solid #ff9800;"><div style="font-size: 11px; color: #888; margin-bottom: 2px;">Ocorrencia</div><div style="font-size: 12px; color: #e65100;">${occDesc}</div></div>` : ''}
    ${timelineHtml}
    ${trackingHtml}
  </div>
  <!-- Footer -->
  <div style="background: #f5f5f5; padding: 8px 16px; font-size: 10px; color: #aaa; text-align: right;">Atualizado: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
</div>`;
}

function buildMotoristaCard(driverName, driverFromTe) {
  if (!driverFromTe) {
    return buildMotoristaNotFoundCard(driverName);
  }

  const phone = driverFromTe.PhoneNumber || '';
  const phoneCountry = driverFromTe.PhoneCountry || '55';
  const fullPhone = phone ? `+${phoneCountry} ${phone}` : 'N/A';
  const enable = driverFromTe.Enable;
  const lastAccess = driverFromTe.LastAccess || '';
  const appInstalled = driverFromTe.ApplicationInstallMobile;
  const email = driverFromTe.Email || '';
  const city = driverFromTe.City || '';
  const state = driverFromTe.State || '';

  const statusColor = enable ? '#4caf50' : '#f44336';
  const statusText = enable ? 'ATIVO' : 'INATIVO';
  const statusIcon = enable ? '&#10003;' : '&#10007;';
  const appIcon = appInstalled ? '&#9989;' : '&#10060;';
  const appText = appInstalled ? 'Instalado' : 'Nao Instalado';

  return `
<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; border: 1px solid #e0e0e0; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
  <!-- Header -->
  <div style="background: linear-gradient(135deg, #2e7d32, #43a047); color: white; padding: 14px 16px; display: flex; align-items: center; gap: 10px;">
    <div style="font-size: 22px;">&#128100;</div>
    <div style="flex: 1;">
      <div style="font-size: 14px; font-weight: 700;">Motorista TE</div>
      <div style="font-size: 11px; opacity: 0.85;">${driverName}</div>
    </div>
    <div style="background: ${statusColor}; color: white; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; text-transform: uppercase; display: flex; align-items: center; gap: 4px;">${statusIcon} ${statusText}</div>
  </div>
  <!-- Body -->
  <div style="padding: 14px 16px;">
    <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
      <span style="font-size: 11px; color: #888;">Telefone</span>
      <span style="font-size: 12px; font-weight: 600; color: #2e7d32;"><a href="tel:+${phoneCountry}${phone}" style="color: #2e7d32; text-decoration: none;">${fullPhone}</a></span>
    </div>
    <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
      <span style="font-size: 11px; color: #888;">Aplicativo</span>
      <span style="font-size: 12px; color: #333;">${appIcon} ${appText}</span>
    </div>
    ${lastAccess ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Ultimo Acesso</span><span style="font-size: 12px; color: #333;">${formatDate(lastAccess)}</span></div>` : ''}
    ${email ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">E-mail</span><span style="font-size: 12px; color: #333;">${email}</span></div>` : ''}
    ${(city || state) ? `<div style="display: flex; justify-content: space-between; margin-bottom: 10px;"><span style="font-size: 11px; color: #888;">Cidade</span><span style="font-size: 12px; color: #333;">${city}${state ? '/' + state : ''}</span></div>` : ''}
    ${!enable ? `<div style="margin-top: 10px; padding: 8px 12px; background: #ffebee; border-radius: 6px; border-left: 3px solid #f44336;"><div style="font-size: 12px; color: #c62828;">Motorista inativo no TudoEntregue</div></div>` : ''}
    ${enable && !appInstalled ? `<div style="margin-top: 10px; padding: 8px 12px; background: #fff3e0; border-radius: 6px; border-left: 3px solid #ff9800;"><div style="font-size: 12px; color: #e65100;">Aplicativo nao instalado. SMS com link de download enviado.</div></div>` : ''}
  </div>
  <!-- Footer -->
  <div style="background: #f5f5f5; padding: 8px 16px; font-size: 10px; color: #aaa; text-align: right;">Atualizado: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
</div>`;
}

function buildMotoristaNotFoundCard(driverName) {
  return `
<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; border: 1px solid #e0e0e0; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
  <div style="background: linear-gradient(135deg, #e65100, #ff9800); color: white; padding: 14px 16px; display: flex; align-items: center; gap: 10px;">
    <div style="font-size: 22px;">&#128100;</div>
    <div style="flex: 1;">
      <div style="font-size: 14px; font-weight: 700;">Motorista TE</div>
      <div style="font-size: 11px; opacity: 0.85;">${driverName}</div>
    </div>
    <div style="background: #f44336; color: white; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px;">NAO ENCONTRADO</div>
  </div>
  <div style="padding: 14px 16px;">
    <div style="padding: 10px 12px; background: #fff3e0; border-radius: 6px; border-left: 3px solid #ff9800;">
      <div style="font-size: 12px; color: #e65100;">Motorista nao encontrado no TudoEntregue. Configure o telefone no mapa MOTORISTA_PHONE_MAP para cadastro automatico.</div>
    </div>
  </div>
  <div style="background: #f5f5f5; padding: 8px 16px; font-size: 10px; color: #aaa; text-align: right;">Atualizado: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
</div>`;
}

function buildErrorCard(title, message) {
  return `
<div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; border: 1px solid #e0e0e0; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
  <div style="background: linear-gradient(135deg, #c62828, #e53935); color: white; padding: 14px 16px; display: flex; align-items: center; gap: 10px;">
    <div style="font-size: 22px;">&#9888;</div>
    <div style="font-size: 14px; font-weight: 700;">${title}</div>
  </div>
  <div style="padding: 14px 16px;">
    <div style="font-size: 12px; color: #c62828;">${message}</div>
  </div>
  <div style="background: #f5f5f5; padding: 8px 16px; font-size: 10px; color: #aaa; text-align: right;">${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
</div>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

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
    const cardHtml = buildDeliveryStatusCard(deliveryData, trackingData, situationData);

    // 6. Tambem atualiza campos padrao do TE
    if (deliveryData) {
      const mapped = Mapper.teToOdooPicking(deliveryData);
      const soMapped = Mapper.teToOdooSaleOrder(deliveryData);
      await odooTe.updateSaleOrderTeData(saleOrderId, soMapped);
    }

    // 7. Grava card no campo HTML
    await odooTe.updateSaleOrderStatusHtml(saleOrderId, cardHtml);

    console.log(`[TE-DELIVERY-STATUS] Card atualizado: SO ${orderName} (${saleOrderId})`);
    res.json({
      success: true,
      orderName,
      teOrderId,
      trackingCode,
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
// POST /api/v1/te/sync-motorista — Sincroniza motorista com TE
// Body: { saleOrderId: number }
// ============================================================
router.post('/sync-motorista', async (req, res) => {
  try {
    const { saleOrderId } = req.body;
    if (!saleOrderId) {
      return res.status(400).json({ success: false, error: 'Informe saleOrderId' });
    }

    // 1. Busca sale order e o motorista selecionado
    const so = await odooTe.findSaleOrderById(saleOrderId);
    if (!so) {
      return res.status(404).json({ success: false, error: `Sale Order ${saleOrderId} nao encontrada` });
    }

    const f = odooTe.FIELDS['sale.order'];
    const motoristaKey = so[f.teMotorista];
    if (!motoristaKey) {
      const noCard = buildErrorCard('Motorista nao Selecionado', 'Selecione um motorista no campo Motorista do pedido.');
      await odooTe.updateSaleOrderStatusHtml(saleOrderId, noCard);
      return res.json({ success: false, error: 'Nenhum motorista selecionado', card: noCard });
    }

    // 2. Busca lista de motoristas do TE
    let customerData = null;
    try {
      customerData = await teClient.getCustomers(true);
    } catch (err) {
      console.error('[TE-SYNC-MOTORISTA] Erro ao buscar motoristas TE:', err.message);
    }

    // 3. Procura motorista pelo nome na lista do TE
    let driverFromTe = null;
    if (customerData?.Driver && Array.isArray(customerData.Driver)) {
      driverFromTe = customerData.Driver.find(d => {
        const teName = (d.Name || '').toUpperCase().trim();
        const odooName = motoristaKey.toUpperCase().trim();
        return teName === odooName || teName.includes(odooName) || odooName.includes(teName);
      });
    }

    // 4. Se nao encontrou, tenta cadastrar no TE (se tiver telefone no mapa)
    if (!driverFromTe) {
      const phone = MOTORISTA_PHONE_MAP[motoristaKey] || '';
      if (phone) {
        console.log(`[TE-SYNC-MOTORISTA] Cadastrando ${motoristaKey} no TE (tel: ${phone})`);
        try {
          const customerDoc = config.empresa.cnpj;
          await teClient.addDriver(customerDoc, motoristaKey, '55', phone);

          // Busca novamente para confirmar
          await new Promise(r => setTimeout(r, 2000));
          const updatedCustomerData = await teClient.getCustomers(true);
          if (updatedCustomerData?.Driver) {
            driverFromTe = updatedCustomerData.Driver.find(d => {
              const teName = (d.Name || '').toUpperCase().trim();
              const odooName = motoristaKey.toUpperCase().trim();
              return teName === odooName || teName.includes(odooName) || odooName.includes(teName);
            });
          }
        } catch (err) {
          console.error(`[TE-SYNC-MOTORISTA] Erro ao cadastrar ${motoristaKey}:`, err.message);
        }
      }
    }

    // 5. Monta card HTML do motorista
    const motoristaCard = buildMotoristaCard(motoristaKey, driverFromTe);

    // 6. Le o HTML atual do campo e concatena (novo status em cima, antigo embaixo)
    const existingHtml = so[f.teStatusHtml] || '';
    let finalHtml = motoristaCard;
    if (existingHtml && existingHtml.includes('Motorista TE')) {
      // Remove cards de motorista antigos e coloca o novo em cima
      // Divide em blocos de cards (cada card comeca com <div)
      finalHtml = motoristaCard + '\n' + existingHtml;
    } else if (existingHtml) {
      // Tem card de entrega mas nao de motorista — coloca motorista em cima
      finalHtml = motoristaCard + '\n' + existingHtml;
    }

    // 7. Grava no campo HTML
    await odooTe.updateSaleOrderStatusHtml(saleOrderId, finalHtml);

    console.log(`[TE-SYNC-MOTORISTA] Motorista ${motoristaKey} sincronizado: SO ${so.name} (${saleOrderId})`);
    res.json({
      success: true,
      motorista: motoristaKey,
      foundInTe: !!driverFromTe,
      driverData: driverFromTe || null,
      card: motoristaCard,
    });
  } catch (err) {
    console.error('[TE-SYNC-MOTORISTA] Erro:', err.message);
    try {
      await odooTe.updateSaleOrderStatusHtml(req.body.saleOrderId, buildErrorCard('Erro ao Sincronizar Motorista', err.message));
    } catch {}
    const status = err.isAxiosError ? (err.response?.status || 502) : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = router;