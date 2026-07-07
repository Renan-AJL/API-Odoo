// ============================================================
// services/mapper-te.js — Mapeamento bidirecional TE <-> ODOO
// ============================================================
const { SITUATION_LABELS, SITUATION_TO_ODOO_STATE, ORDER_TYPES } = require('./tudoentregue');

const Mapper = {
  // ============================================================
  // ODOO -> TudoEntregue
  // ============================================================

  /**
   * Converte sale.order + partner do ODOO para formato TE.
   */
  odooToTeDelivery(saleOrder, partner, picking = null) {
    const stateCode = partner.state_id ? (Array.isArray(partner.state_id) ? partner.state_id[1] || '' : '') : '';
    const uf = stateCode.substring(0, 2).toUpperCase();

    return {
      OrderNumber: saleOrder.name || String(saleOrder.id),
      OrderType: ORDER_TYPES.ENTREGA,
      CustomerName: partner.name || '',
      DocumentNumber: (partner.cnpj_cpf || partner.vat || '').replace(/\D/g, ''),
      ContactName: partner.name || '',
      Phone1: partner.phone || partner.mobile || '',
      Phone2: partner.mobile || '',
      Email: partner.email || '',
      ZipCode: (partner.zip || '').replace(/\D/g, ''),
      Address: partner.street || '',
      AddressNumber: partner.street_number || '',
      Complement: '',
      Neighborhood: partner.l10n_br_district || partner.street2 || '',
      City: partner.city || '',
      State: uf,
      Country: 'Brasil',
      Latitude: partner.partner_latitude || 0,
      Longitude: partner.partner_longitude || 0,
      ScheduledDate: picking?.scheduled_date
        ? new Date(picking.scheduled_date).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      ScheduledTimeStart: '08:00',
      ScheduledTimeEnd: '18:00',
      Description: saleOrder.note || `Pedido ODOO #${saleOrder.name}`,
      Quantity: picking?.move_line_count || 1,
      Volume: 1,
      Weight: 0,
      Value: saleOrder.amount_total || 0,
      SendSMS: false,
      SendEmail: false,
      VehicleTypeId: 0,
      CategoryId: 0,
      DeliveryMethodId: 0,
      Reference1: String(saleOrder.id),
      Reference2: partner.id ? String(partner.id) : '',
      Reference3: picking ? String(picking.id) : '',
    };
  },

  // ============================================================
  // TudoEntregue -> ODOO
  // ============================================================

  /**
   * Extrai dados do TE para atualizar stock.picking.
   */
  teToOdooPicking(teDelivery) {
    const situationCode = teDelivery.Situation ?? teDelivery.situation ?? null;
    const odooState = situationCode !== null
      ? (SITUATION_TO_ODOO_STATE[situationCode] || null)
      : null;

    return {
      situation: situationCode,
      situationLabel: situationCode !== null
        ? (SITUATION_LABELS[situationCode] || `Situacao ${situationCode}`)
        : null,
      trackingCode: teDelivery.TrackingCode || teDelivery.trackingCode || '',
      driverName: teDelivery.DriverName || teDelivery.driverName || '',
      driverPhone: teDelivery.DriverPhone || teDelivery.driverPhone || '',
      odooState,
      occurrences: teDelivery.Occurrences || [],
      proofUrl: teDelivery.ProofUrl || teDelivery.proofUrl || '',
      teOrderId: teDelivery.OrderNumber || teDelivery.orderNumber || '',
      orderType: teDelivery.OrderType || teDelivery.orderType,
      customerId: teDelivery.CustomerId || teDelivery.customerId,
    };
  },

  /**
   * Extrai dados do TE para atualizar sale.order.
   */
  teToOdooSaleOrder(teDelivery) {
    const situationCode = teDelivery.Situation ?? teDelivery.situation ?? null;
    return {
      situation: situationCode,
      situationLabel: situationCode !== null
        ? (SITUATION_LABELS[situationCode] || `Situacao ${situationCode}`)
        : null,
      trackingCode: teDelivery.TrackingCode || teDelivery.trackingCode || '',
      trackingUrl: this._buildTrackingUrl(teDelivery),
      teOrderId: teDelivery.OrderNumber || teDelivery.orderNumber || '',
    };
  },

  // ============================================================
  // HELPERS
  // ============================================================

  _buildTrackingUrl(teDelivery) {
    const code = teDelivery.TrackingCode || teDelivery.trackingCode;
    if (!code) return '';
    return `https://app.tudoentregue.com.br/rastreamento/${code}`;
  },

  /**
   * Normaliza payload do webhook TE (array ou objeto).
   */
  normalizeWebhookPayload(payload) {
    const deliveries = Array.isArray(payload) ? payload : [payload];
    return deliveries.map((d) => ({
      orderNumber: d.OrderNumber || d.orderNumber,
      orderType: d.OrderType || d.orderType,
      situation: d.Situation ?? d.situation,
      trackingCode: d.TrackingCode || d.trackingCode || '',
      driverName: d.DriverName || d.driverName || '',
      driverPhone: d.DriverPhone || d.driverPhone || '',
      customerId: d.CustomerId || d.customerId,
      customerName: d.CustomerName || d.customerName || '',
      occurrenceDescription: d.OccurrenceDescription || d.occurrenceDescription || '',
      occurrenceDate: d.OccurrenceDate || d.occurrenceDate || '',
      occurrences: d.Occurrences || [],
      proofUrl: d.ProofUrl || d.proofUrl || '',
      deliveredDate: d.DeliveredDate || d.deliveredDate || '',
      canceledDate: d.CanceledDate || d.canceledDate || '',
      raw: d,
    }));
  },
};

module.exports = Mapper;