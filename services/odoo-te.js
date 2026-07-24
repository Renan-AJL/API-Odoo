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

  // -------------------------------------------------------
  // HELPERS PARA SEND-INVOICE
  // -------------------------------------------------------

  async findSaleOrderByInvoice(invoiceId) {
    console.log('[ODOO-TE] findSaleOrderByInvoice: invoiceId=' + invoiceId);

    // Estrategia 1: Tenta busca direta: sale.order onde invoice_ids contem esta fatura
    try {
      const saleIds = await this.searchRead(
        'sale.order',
        [['invoice_ids', 'in', [invoiceId]]],
        ['id', 'name']
      );
      if (saleIds.length > 0) {
        console.log('[ODOO-TE] Estrategia 1 (invoice_ids) encontrou: ' + saleIds[0].name + ' (id=' + saleIds[0].id + ')');
        return saleIds[0];
      }
      console.log('[ODOO-TE] Estrategia 1 (invoice_ids): sem resultados');
    } catch (err) {
      console.warn('[ODOO-TE] Estrategia 1 falhou: ' + err.message);
    }

    // Estrategia 2: Tenta ler sale_order_ids da propria fatura (campo computado do modulo sale)
    try {
      const invData = await this.read('account.move', [invoiceId], ['id', 'partner_id', 'sale_order_ids']);
      const inv = Array.isArray(invData) ? invData[0] : invData;
      console.log('[ODOO-TE] Fatura lida: id=' + inv.id + ', partner=' + JSON.stringify(inv.partner_id) + ', sale_order_ids=' + JSON.stringify(inv.sale_order_ids));
      if (inv.sale_order_ids && inv.sale_order_ids.length > 0) {
        const soId = Array.isArray(inv.sale_order_ids[0]) ? inv.sale_order_ids[0][0] : inv.sale_order_ids[0];
        const orders = await this.searchRead('sale.order', [['id', '=', soId]], ['id', 'name']);
        if (orders.length > 0) {
          console.log('[ODOO-TE] Estrategia 2 (sale_order_ids) encontrou: ' + orders[0].name + ' (id=' + orders[0].id + ')');
          return orders[0];
        }
      }
      console.log('[ODOO-TE] Estrategia 2 (sale_order_ids): sem resultados');
    } catch (err) {
      console.warn('[ODOO-TE] Estrategia 2 falhou: ' + err.message);
    }

    // Estrategia 3: Via account.move.line -> sale_line_ids -> order_id
    try {
      const invData = await this.read('account.move', [invoiceId], ['line_ids']);
      const inv = Array.isArray(invData) ? invData[0] : invData;
      const lineIds = inv.line_ids || [];
      console.log('[ODOO-TE] Estrategia 3: lendo ' + lineIds.length + ' linhas da fatura');
      if (lineIds.length) {
        // Le as linhas em batch
        const lines = await this.read('account.move.line', lineIds, ['sale_line_ids']);
        const linesArr = Array.isArray(lines) ? lines : [lines];
        for (const line of linesArr) {
          const sli = line.sale_line_ids;
          if (sli && sli.length > 0) {
            const saleLineId = Array.isArray(sli[0]) ? sli[0][0] : sli[0];
            const saleLines = await this.read('sale.order.line', [saleLineId], ['order_id']);
            const slArr = Array.isArray(saleLines) ? saleLines : [saleLines];
            if (slArr.length > 0 && slArr[0].order_id) {
              const orderId = Array.isArray(slArr[0].order_id) ? slArr[0].order_id[0] : slArr[0].order_id;
              const orders = await this.searchRead('sale.order', [['id', '=', orderId]], ['id', 'name']);
              if (orders.length > 0) {
                console.log('[ODOO-TE] Estrategia 3 (lines) encontrou: ' + orders[0].name + ' (id=' + orders[0].id + ')');
                return orders[0];
              }
            }
          }
        }
      }
      console.log('[ODOO-TE] Estrategia 3 (lines): sem resultados');
    } catch (err) {
      console.warn('[ODOO-TE] Estrategia 3 falhou: ' + err.message);
    }

    // Estrategia 4: Fallback via partner_id — busca sale.order mais recente do mesmo cliente
    try {
      const invData = await this.read('account.move', [invoiceId], ['partner_id']);
      const inv = Array.isArray(invData) ? invData[0] : invData;
      const partnerId = inv.partner_id ? (Array.isArray(inv.partner_id) ? inv.partner_id[0] : inv.partner_id) : null;
      if (partnerId) {
        console.log('[ODOO-TE] Estrategia 4: buscando sale.order por partner_id=' + partnerId);
        const orders = await this.searchRead(
          'sale.order',
          [['partner_id', '=', partnerId], ['state', 'in', ['sale', 'done']]],
          ['id', 'name', 'state'],
          5, 0, 'id desc'
        );
        if (orders.length > 0) {
          console.log('[ODOO-TE] Estrategia 4 (partner) encontrou ' + orders.length + ' pedidos. Usando mais recente: ' + orders[0].name + ' (id=' + orders[0].id + ')');
          return orders[0];
        }
        console.log('[ODOO-TE] Estrategia 4 (partner): sem pedidos para este cliente');
      }
    } catch (err) {
      console.warn('[ODOO-TE] Estrategia 4 falhou: ' + err.message);
    }

    console.error('[ODOO-TE] Nenhuma estrategia encontrou sale.order para invoice ' + invoiceId);
    return null;
  }

  async findDeliveryPicking(saleOrderId) {
    const pickings = await this.searchRead(
      'stock.picking',
      [['sale_id', '=', saleOrderId], ['picking_type_code', '=', 'outgoing']],
      ['id', 'name', 'partner_id', 'state', 'picking_type_code', 'scheduled_date', 'origin', 'note'],
      1
    );
    return pickings.length > 0 ? pickings[0] : null;
  }

  async readPicking(pickingId) {
    const f = FIELDS['stock.picking'];
    const results = await this.searchRead(
      'stock.picking', [['id', '=', pickingId]],
      ['id', 'name', 'partner_id', 'sale_id', 'state', 'picking_type_code', 'scheduled_date', 'origin', 'note',
       f.teSync, f.teOrderId, f.teSituation, f.teDriverName, f.teDriverPhone]
    );
    return results.length > 0 ? results[0] : null;
  }

  async readSaleOrderFull(orderId) {
    const f = FIELDS['sale.order'];
    const results = await this.searchRead(
      'sale.order', [['id', '=', orderId]],
      ['id', 'name', 'state', 'partner_id', 'amount_total', 'note',
       f.teSync, f.teOrderId, f.teTrackingCode, f.teSituation,
       f.teMotorista, f.teDeliveryType, f.teLastSync, f.teError]
    );
    return results.length > 0 ? results[0] : null;
  }

  async getSaleOrderLines(saleOrderId) {
    return this.searchRead(
      'sale.order.line',
      [['order_id', '=', saleOrderId]],
      ['id', 'name', 'product_id', 'product_uom_qty', 'price_unit', 'price_subtotal']
    );
  }

  async getProducts(productIds) {
    if (!productIds || !productIds.length) return {};
    const products = await this.read('product.product', productIds,
      ['id', 'name', 'weight', 'volume', 'default_code']
    );
    const map = {};
    if (Array.isArray(products)) {
      products.forEach(p => { map[p.id] = p; });
    }
    return map;
  }

  async getCompany() {
    const companies = await this.searchRead(
      'res.company', [],
      ['name', 'street', 'street2', 'city', 'state_id', 'zip', 'country_id',
       'phone', 'email', 'partner_id', 'vat', 'l10n_br_cnpj_cpf', 'district', 'number'],
      1
    );
    return companies.length > 0 ? companies[0] : null;
  }

  async postChatter(model, recordId, body) {
    try {
      await this._jsonRpc('mail.message', 'create', {
        model: model,
        res_id: recordId,
        body: body,
      });
      console.log('[ODOO-TE] Chatter postado em ' + model + ' ' + recordId);
    } catch (err) {
      console.error('[ODOO-TE] Falha chatter: ' + err.message);
    }
  }

  async markInvoiceSynced(invoiceIds, teOrderId) {
    const vals = { x_studio_te_sync: true };
    if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
    return this.write('account.move', invoiceIds, vals);
  }
}

module.exports = new OdooTeClient();
module.exports.FIELDS = FIELDS;