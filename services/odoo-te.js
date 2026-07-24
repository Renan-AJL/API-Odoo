// ============================================================
// services/odoo-te.js — Client JSON-RPC do Odoo para campos TE
// Reusa as credenciais ja existentes em config/ (odoo.url, odoo.db, etc)
// ============================================================
const axios = require('axios');
const config = require('../config');
const { retryWithBackoff } = require('../utils/retry');

// Nomes dos campos Studio (x_studio_) usados no ODOO
const FIELDS = {
  'res.partner': {
    teCustomerId:   'x_studio_id_cliente_te',
    teSendSms:      'x_studio_enviar_sms',
    teSendEmail:    'x_studio_enviar_email',
  },
  'sale.order': {
    teSync:         'x_studio_te_sync',
    teOrderId:      'x_studio_te_order_id',
    teTrackingCode: 'x_studio_te_tracking_code',
    teTrackingUrl:  'x_studio_te_tracking_url',
    teSituation:    'x_studio_te_situation',
    teLastSync:     'x_studio_te_last_sync',
    teError:        'x_studio_te_error',
    teWebhook:      'x_studio_te_webhook_received',
    teDeliveryType: 'x_studio_te_delivery_type',
    teStatusHtml:   'x_studio_status_de_entrega_te',
    teMotorista:    'x_studio_motorista',
  },
  'stock.picking': {
    teSync:            'x_studio_te_sync',
    teOrderId:         'x_studio_te_order_id',
    teTrackingCode:    'x_studio_te_tracking_code',
    teSituation:       'x_studio_te_situation',
    teDriverName:      'x_studio_te_motorista',
    teDriverPhone:     'x_studio_te_fone_motorista',
    teOccurrences:     'x_studio_te_ocorrencias',
    teProofUrl:        'x_studio_te_url_comprovante',
    teLastWebhook:     'x_studio_te_ultimo_webhook',
    teSituationTarget: 'x_studio_te_estado_destino',
  },
  'purchase.order': {
    teSync:         'x_studio_te_sync',
    teOrderId:      'x_studio_te_order_id',
    teTrackingCode: 'x_studio_te_tracking_code',
    teSituation:    'x_studio_te_situation',
    teLastSync:     'x_studio_te_last_sync',
  },
  'account.move': {
    teOrderId:      'x_studio_te_order_id',
    teTrackingCode: 'x_studio_te_tracking_code',
    teSituation:    'x_studio_te_situation',
  },
};

class OdooTeClient {
  constructor() {
    this.baseUrl = config.odoo.url.replace(/\/+$/, '');
    this.db = config.odoo.db;
    this.apiKey = config.odoo.password; // ODOO_API_KEY
    this.uid = null;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // -------------------------------------------------------
  // Autenticacao
  // -------------------------------------------------------
  async authenticate() {
    try {
      const result = await this._jsonRpc('common', 'authenticate', {
        db: this.db,
        login: '__system__',
        password: this.apiKey,
      });
      this.uid = result;
      console.log(`[ODOO-TE] Autenticado: uid=${this.uid}`);
      return this.uid;
    } catch (err) {
      console.warn('[ODOO-TE] Auth via authenticate falhou, usando fallback uid=1');
      this.uid = 1;
      return this.uid;
    }
  }

  // -------------------------------------------------------
  // JSON-RPC generico
  // -------------------------------------------------------
  async _jsonRpc(model, method, args = {}, kwargs = {}) {
    const payload = {
      jsonrpc: '2.0',
      method: 'call',
      id: Date.now(),
      params: {
        service: 'object',
        method: 'execute_kw',
        args: [
          this.db,
          this.uid || 1,
          this.apiKey,
          model,
          method,
          typeof args === 'object' && !Array.isArray(args) ? [args] : args,
          kwargs,
        ],
      },
    };

    const { data } = await retryWithBackoff(
      () => this.httpClient.post('/jsonrpc', payload),
      {
        maxRetries: 3,
        shouldRetry: (err) => {
          const s = err.response?.status;
          return !s || s >= 500;
        },
      }
    );

    if (data.error) {
      console.error(`[ODOO-TE] RPC Error: ${data.error.message || JSON.stringify(data.error)}`);
      throw new Error(data.error.message || 'Erro ODOO RPC');
    }

    return data.result;
  }

  // -------------------------------------------------------
  // CRUD
  // -------------------------------------------------------
  async searchRead(model, domain = [], fields = [], limit = 0, offset = 0, order = '') {
    const kwargs = { fields, limit, offset };
    if (order) kwargs.order = order;
    return this._jsonRpc(model, 'search_read', domain, kwargs);
  }

  async read(model, ids, fields = []) {
    return this._jsonRpc(model, 'read', ids, { fields });
  }

  async write(model, ids, values) {
    const result = await this._jsonRpc(model, 'write', ids, values);
    console.log(`[ODOO-TE] Write ${model}: ids=${JSON.stringify(ids)}`);
    return result;
  }

  // -------------------------------------------------------
  // Helpers
  // -------------------------------------------------------
  getStudioFields(model) {
    return Object.values(FIELDS[model] || {});
  }

  // -------------------------------------------------------
  // SALE.ORDER
  // -------------------------------------------------------
  async findSaleOrderByTeId(teOrderId) {
    const f = FIELDS['sale.order'];
    const results = await this.searchRead(
      'sale.order',
      [[f.teOrderId, '=', teOrderId]],
      ['id', 'name', 'state', 'partner_id', f.teSync, f.teSituation, f.teTrackingCode]
    );
    return results.length > 0 ? results[0] : null;
  }

  async updateSaleOrderTeData(orderId, teData) {
    const f = FIELDS['sale.order'];
    const values = {
      [f.teLastSync]: new Date().toISOString(),
      [f.teSync]: true,
    };
    if (teData.situation !== undefined) values[f.teSituation] = teData.situation;
    if (teData.situationLabel) values[`${f.teSituation}_label`] = teData.situationLabel;
    if (teData.trackingCode) values[f.teTrackingCode] = teData.trackingCode;
    if (teData.trackingUrl) values[f.teTrackingUrl] = teData.trackingUrl;
    if (teData.error) values[f.teError] = teData.error;
    if (teData.webhookReceived !== undefined) values[f.teWebhook] = teData.webhookReceived;

    return this.write('sale.order', [orderId], values);
  }

  async markSaleOrdersSynced(orderIds, teOrderId, orderType) {
    const f = FIELDS['sale.order'];
    return this.write('sale.order', orderIds, {
      [f.teSync]: true,
      [f.teOrderId]: teOrderId,
      [f.teLastSync]: new Date().toISOString(),
      [f.teDeliveryType]: orderType,
      [f.teError]: false,
    });
  }

  async markSaleOrderError(orderId, errorMessage) {
    const f = FIELDS['sale.order'];
    return this.write('sale.order', [orderId], {
      [f.teSync]: false,
      [f.teError]: errorMessage,
      [f.teLastSync]: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------
  // STOCK.PICKING
  // -------------------------------------------------------
  async findPickingByTeId(teOrderId) {
    const f = FIELDS['stock.picking'];
    const results = await this.searchRead(
      'stock.picking',
      [[f.teOrderId, '=', teOrderId]],
      ['id', 'name', 'state', 'partner_id', f.teSync, f.teSituation, f.teTrackingCode]
    );
    return results.length > 0 ? results[0] : null;
  }

  async updatePickingTeData(pickingId, teData) {
    const f = FIELDS['stock.picking'];
    const values = {
      [f.teLastWebhook]: new Date().toISOString(),
      [f.teSync]: true,
    };
    if (teData.situation !== undefined) values[f.teSituation] = teData.situation;
    if (teData.trackingCode) values[f.teTrackingCode] = teData.trackingCode;
    if (teData.driverName) values[f.teDriverName] = teData.driverName;
    if (teData.driverPhone) values[f.teDriverPhone] = teData.driverPhone;
    if (teData.occurrences && teData.occurrences.length > 0) {
      values[f.teOccurrences] = JSON.stringify(teData.occurrences);
    }
    if (teData.proofUrl) values[f.teProofUrl] = teData.proofUrl;
    if (teData.odooState) values[f.teSituationTarget] = teData.odooState;

    return this.write('stock.picking', [pickingId], values);
  }

  async markPickingsSynced(pickingIds, teOrderId) {
    const f = FIELDS['stock.picking'];
    return this.write('stock.picking', pickingIds, {
      [f.teSync]: true,
      [f.teOrderId]: teOrderId,
    });
  }

  // -------------------------------------------------------
  // PURCHASE.ORDER
  // -------------------------------------------------------
  async findPurchaseOrderByTeId(teOrderId) {
    const f = FIELDS['purchase.order'];
    const results = await this.searchRead(
      'purchase.order',
      [[f.teOrderId, '=', teOrderId]],
      ['id', 'name', 'state', 'partner_id', f.teSync, f.teSituation]
    );
    return results.length > 0 ? results[0] : null;
  }

  async updatePurchaseOrderTeData(orderId, teData) {
    const f = FIELDS['purchase.order'];
    const values = {
      [f.teLastSync]: new Date().toISOString(),
      [f.teSync]: true,
    };
    if (teData.situation !== undefined) values[f.teSituation] = teData.situation;
    if (teData.trackingCode) values[f.teTrackingCode] = teData.trackingCode;
    return this.write('purchase.order', [orderId], values);
  }

  // -------------------------------------------------------
  // ACCOUNT.MOVE
  // -------------------------------------------------------
  async updateInvoiceTeData(moveId, teData) {
    const f = FIELDS['account.move'];
    const values = {};
    if (teData.teOrderId) values[f.teOrderId] = teData.teOrderId;
    if (teData.trackingCode) values[f.teTrackingCode] = teData.trackingCode;
    if (teData.situation !== undefined) values[f.teSituation] = teData.situation;
    return this.write('account.move', [moveId], values);
  }

  // -------------------------------------------------------
  // RES.PARTNER
  // -------------------------------------------------------
  async findPartnerByDocument(document) {
    const cleaned = (document || '').replace(/\D/g, '');
    if (!cleaned) return null;

    const f = FIELDS['res.partner'];
    let results = await this.searchRead(
      'res.partner',
      [['cnpj_cpf', '=', cleaned]],
      ['id', 'name', 'cnpj_cpf', 'phone', 'mobile', 'email', 'street', 'street_number',
       'street2', 'zip', 'city', 'l10n_br_district', 'partner_latitude', 'partner_longitude',
       'state_id', 'country_id', 'vat',
       f.teCustomerId, f.teSendSms, f.teSendEmail]
    );

    if (results.length === 0) {
      results = await this.searchRead(
        'res.partner',
        [['vat', '=', cleaned]],
        ['id', 'name', 'vat', 'phone', 'mobile', 'email', 'street', 'street_number',
         'street2', 'zip', 'city', 'l10n_br_district', 'partner_latitude', 'partner_longitude',
         'state_id', 'country_id',
         f.teCustomerId, f.teSendSms, f.teSendEmail]
      );
    }

    return results.length > 0 ? results[0] : null;
  }

  // -------------------------------------------------------
  // Busca pedidos nao sincronizados
  // -------------------------------------------------------
  async getUnsyncedPickings(limit = 50) {
    const f = FIELDS['stock.picking'];
    return this.searchRead(
      'stock.picking',
      [
        ['picking_type_code', '=', 'outgoing'],
        ['state', 'in', ['assigned', 'confirmed']],
        [f.teSync, '=', false],
        [f.teOrderId, '=', false],
      ],
      [
        'id', 'name', 'state', 'partner_id', 'scheduled_date',
        'move_line_count', 'origin',
        f.teSync, f.teOrderId,
      ],
      limit
    );
  }

  async getUnsyncedSaleOrders(limit = 50) {
    const f = FIELDS['sale.order'];
    return this.searchRead(
      'sale.order',
      [
        ['state', 'in', ['sale', 'done']],
        [f.teSync, '=', false],
        [f.teOrderId, '=', false],
      ],
      [
        'id', 'name', 'state', 'partner_id', 'amount_total', 'note',
        f.teSync, f.teOrderId, f.teError,
      ],
      limit
    );
  }

  // -------------------------------------------------------
  // SALE.ORDER — HTML Status Card
  // -------------------------------------------------------
  async findSaleOrderById(orderId) {
    const f = FIELDS['sale.order'];
    const results = await this.searchRead(
      'sale.order',
      [['id', '=', orderId]],
      [
        'id', 'name', 'state', 'partner_id', 'amount_total',
        f.teSync, f.teOrderId, f.teTrackingCode, f.teSituation,
        f.teStatusHtml, f.teMotorista,
      ]
    );
    return results.length > 0 ? results[0] : null;
  }

  async updateSaleOrderStatusHtml(orderId, html) {
    const f = FIELDS['sale.order'];
    return this.write('sale.order', [orderId], {
      [f.teStatusHtml]: html,
    });
  }

  async updateSaleOrderMotorista(orderId, motoristaKey) {
    const f = FIELDS['sale.order'];
    return this.write('sale.order', [orderId], {
      [f.teMotorista]: motoristaKey,
    });
  }
}

module.exports = new OdooTeClient();
module.exports.FIELDS = FIELDS;