/**
 * services/odoo-te.js - Odoo XML-RPC client para TudoEntregue
 * Usa XML-RPC (igual odoo-push.js) pois JSON-RPC nao funciona no Odoo SaaS
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');
var logger = require('../utils/logger');

// ============================================================
// FIELDS mapping — usado por delivery.js (delivery-status, send-invoice)
// ============================================================
var FIELDS = {
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
    teSituation:    'x_studio_te_situacao',
    teLastSync:     'x_studio_te_last_sync',
    teError:        'x_studio_te_error',
    teWebhook:      'x_studio_te_webhook_received',
    teDeliveryType: 'x_studio_te_tipo_pedido',
    teStatusHtml:   'x_studio_status_de_entrega_te',
    teMotorista:    'x_studio_motorista',
  },
  'stock.picking': {
    teSync:            'x_studio_te_sync',
    teOrderId:         'x_studio_te_order_id',
    teTrackingCode:    'x_studio_te_rastreio',
    teSituation:       'x_studio_te_situacao',
    teDriverName:      'x_studio_te_nome_motorista',
    teDriverPhone:     'x_studio_te_fone_motorista',
    teOccurrences:     'x_studio_te_ocorrencias',
    teProofUrl:        'x_studio_te_url_comprovante',
    teLastWebhook:     'x_studio_te_ultimo_webhook',
    teSituationTarget: 'x_studio_te_estado_destino',
  },
  'account.move': {
    teOrderId:      'x_studio_te_order_id',
    teTrackingCode: 'x_studio_te_tracking_code',
    teSituation:    'x_studio_te_situacao',
  },
};

// ============================================================
// Campos nativos por modelo (100% seguros no Odoo SaaS)
// ============================================================
var PARTNER_FIELDS = [
  'id', 'name', 'city', 'state_id', 'zip', 'phone', 'email',
  'street', 'street2', 'country_id', 'vat',
];
var PARTNER_OPTIONAL_FIELDS = [
  'cnpj_cpf', 'number', 'district', 'l10n_br_district',
  'l10n_br_city_id', 'mobile', 'partner_latitude', 'partner_longitude',
  'street_number',
  'x_studio_te_codigo', 'x_studio_te_razao_social',
  'x_studio_te_cnpj_cpf', 'x_studio_te_inscricao_estadual',
  'x_studio_te_telefone', 'x_studio_te_email', 'x_studio_te_logradouro',
  'x_studio_te_numero', 'x_studio_te_complemento', 'x_studio_te_bairro',
  'x_studio_te_municipio', 'x_studio_te_uf', 'x_studio_te_cep',
  'x_studio_te_latitude', 'x_studio_te_longitude',
];
var PRODUCT_FIELDS = ['id', 'name', 'weight', 'volume', 'default_code', 'qty_available'];
var ORDER_LINE_FIELDS = ['id', 'name', 'product_id', 'product_uom_qty', 'price_unit', 'price_subtotal', 'price_total'];
var SALE_ORDER_FIELDS = ['id', 'name', 'partner_id', 'state', 'amount_total', 'note'];
var SALE_ORDER_CUSTOM_FIELDS = [
  'x_studio_te_sync', 'x_studio_te_order_id', 'x_studio_te_situacao',
  'x_studio_te_situacao_desc', 'x_studio_te_tipo_pedido', 'x_studio_te_data_entrega',
  'x_studio_te_valor_frete', 'x_studio_te_peso_total', 'x_studio_te_qtd_volumes',
  'x_studio_te_observacao', 'x_studio_te_protocolo_coleta', 'x_studio_te_data_coleta',
  'x_studio_te_nome_motorista', 'x_studio_te_placa_veiculo', 'x_studio_te_rastreio',
  'x_studio_status_de_entrega_te', 'x_studio_motorista',
];
var PICKING_FIELDS = [
  'id', 'name', 'partner_id', 'sale_id', 'state', 'picking_type_code',
  'scheduled_date', 'origin', 'note', 'move_ids',
];
var PICKING_CUSTOM_FIELDS = [
  'x_studio_te_sync', 'x_studio_te_order_id', 'x_studio_te_situacao',
  'x_studio_te_situacao_desc', 'x_studio_te_tipo_pedido', 'x_studio_te_data_entrega',
  'x_studio_te_valor_frete', 'x_studio_te_peso_total', 'x_studio_te_qtd_volumes',
  'x_studio_te_observacao', 'x_studio_te_protocolo_coleta', 'x_studio_te_data_coleta',
  'x_studio_te_nome_motorista', 'x_studio_te_placa_veiculo', 'x_studio_te_rastreio',
  'x_studio_te_ocorrencias', 'x_studio_te_url_comprovante', 'x_studio_te_fone_motorista',
  'x_studio_te_estado_destino', 'x_studio_te_ultimo_webhook',
  'x_studio_motorista',
];
var INVOICE_FIELDS = ['id', 'name', 'state', 'move_type', 'partner_id', 'invoice_date', 'amount_total', 'payment_state'];
var INVOICE_CUSTOM_FIELDS = ['x_studio_te_sync', 'x_studio_te_order_id', 'x_studio_status_de_entrega_te'];
var INVOICE_LINE_FIELDS = ['id', 'name', 'product_id', 'quantity', 'price_unit', 'price_subtotal'];

var OPTIONAL_FIELDS = {
  'res.partner': PARTNER_OPTIONAL_FIELDS,
  'sale.order': SALE_ORDER_CUSTOM_FIELDS,
  'stock.picking': PICKING_CUSTOM_FIELDS,
  'account.move': INVOICE_CUSTOM_FIELDS,
};

// ============================================================
// XML-RPC connection (singleton)
// ============================================================
var _cached = null;

function getConn() {
  if (_cached && _cached.uid) return _cached;
  var odooConfig = config.odoo;
  var base = odooConfig.url.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  var common = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
  var models = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });
  _cached = { uid: null, common: common, models: models, db: odooConfig.db, password: odooConfig.password };
  return _cached;
}

function authenticate() {
  return new Promise(function(resolve, reject) {
    var conn = getConn();
    conn.common.methodCall('authenticate', [conn.db, config.odoo.user, conn.password, {}], function(err, uid) {
      if (err) { reject(new Error('Auth Odoo falhou: ' + (err.message || JSON.stringify(err)))); }
      else if (uid === false || uid === null) { reject(new Error('Auth Odoo: credenciais invalidas (UID=false)')); }
      else { conn.uid = uid; logger.info('[ODOO-TE] Autenticado. UID: ' + uid); resolve(uid); }
    });
  });
}

function ensureAuth() {
  var conn = getConn();
  if (conn.uid) return Promise.resolve(conn.uid);
  return authenticate();
}

function executeKw(model, method, args, kwargs) {
  return new Promise(function(resolve, reject) {
    ensureAuth().then(function(uid) {
      var conn = getConn();
      var params = [conn.db, uid, conn.password, model, method, args || []];
      if (kwargs) params.push(kwargs);
      conn.models.methodCall('execute_kw', params, function(err, result) {
        if (err) { reject(new Error(model + '.' + method + ': ' + (err.message || JSON.stringify(err)))); }
        else { resolve(result); }
      });
    }).catch(reject);
  });
}

// ============================================================
// Safe read/write — tenta com x_studio, fallback sem
// ============================================================
var _customFieldsCache = {};

async function safeReadCustom(model, ids, nativeFields, customFields) {
  try {
    return await executeKw(model, 'read', [ids], { fields: nativeFields.concat(customFields) });
  } catch (err) {
    if (err.message && (err.message.indexOf('Invalid field') !== -1 || err.message.indexOf('KeyError') !== -1)) {
      if (!_customFieldsCache[model]) {
        _customFieldsCache[model] = { available: false, checked: true };
        logger.warn('[ODOO-TE] Campos x_studio_* nao encontrados em ' + model + '. Usando campos nativos.');
      }
      return await executeKw(model, 'read', [ids], { fields: nativeFields });
    }
    throw err;
  }
}

async function safeWriteCustom(model, ids, vals) {
  var customVals = {};
  var nativeVals = {};
  Object.keys(vals).forEach(function(k) {
    if (k.indexOf('x_studio_') === 0) customVals[k] = vals[k];
    else nativeVals[k] = vals[k];
  });
  if (Object.keys(nativeVals).length > 0) await executeKw(model, 'write', [ids, nativeVals]);
  if (Object.keys(customVals).length > 0) {
    try { await executeKw(model, 'write', [ids, customVals]); }
    catch (err) {
      if (err.message && (err.message.indexOf('Invalid field') !== -1 || err.message.indexOf('KeyError') !== -1)) {
        if (!_customFieldsCache[model] || !_customFieldsCache[model].warned) {
          logger.warn('[ODOO-TE] Campo x_studio_* nao existe em ' + model + '. Gravacao ignorada.');
          if (!_customFieldsCache[model]) _customFieldsCache[model] = {};
          _customFieldsCache[model].warned = true;
        }
      } else throw err;
    }
  }
}

// ============================================================
// Compatibilidade com delivery.js — wrappers read/searchRead/write/getStudioFields
// ============================================================
async function read(model, ids, fields) {
  return await executeKw(model, 'read', [ids], { fields: fields });
}

async function searchRead(model, domain, fields, limit, offset, order) {
  var kwargs = { fields: fields, limit: limit || 0, offset: offset || 0 };
  if (order) kwargs.order = order;
  var ids = await executeKw(model, 'search', [domain], kwargs);
  if (!ids || !ids.length) return [];
  return await executeKw(model, 'read', [ids], { fields: fields });
}

async function write(model, ids, values) {
  await safeWriteCustom(model, ids, values);
}

function getStudioFields(model) {
  return Object.values(FIELDS[model] || {});
}

// ============================================================
// SALE.ORDER — busca por ID, status HTML, motorista
// ============================================================
async function findSaleOrderById(orderId) {
  var orders = await safeReadCustom('sale.order', [orderId], SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS);
  return orders ? orders[0] : null;
}

async function readSaleOrder(orderId) {
  return findSaleOrderById(orderId);
}

async function readSaleOrderFull(orderId) {
  return findSaleOrderById(orderId);
}

async function updateSaleOrderStatusHtml(orderId, html) {
  await safeWriteCustom('sale.order', [orderId], { x_studio_status_de_entrega_te: html });
}

async function updateSaleOrderMotorista(orderId, motoristaKey) {
  await safeWriteCustom('sale.order', [orderId], { x_studio_motorista: motoristaKey });
}

async function updateSaleOrderTeData(orderId, data) {
  await safeWriteCustom('sale.order', [orderId], data);
  logger.info('[ODOO-TE] Sale Order ' + orderId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function markSaleOrdersSynced(orderIds, teOrderId, orderType) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  if (orderType) vals.x_studio_te_tipo_pedido = orderType;
  await safeWriteCustom('sale.order', orderIds, vals);
  logger.info('[ODOO-TE] ' + orderIds.length + ' sale.order(s) sync | te_order_id=' + teOrderId);
}

async function markSaleOrderError(orderId, errorMessage) {
  await safeWriteCustom('sale.order', [orderId], {
    x_studio_te_sync: false,
    x_studio_te_situacao_desc: errorMessage,
  });
}

// ============================================================
// STOCK.PICKING
// ============================================================
async function readPicking(pickingId) {
  var pickings = await safeReadCustom('stock.picking', [pickingId], PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
  return pickings ? pickings[0] : null;
}

async function findDeliveryPicking(saleOrderId) {
  var ids = await executeKw('stock.picking', 'search', [
    ['sale_id', '=', saleOrderId], ['picking_type_code', '=', 'outgoing'],
  ], { limit: 1 });
  if (!ids || !ids.length) return null;
  var pickings = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
  return pickings ? pickings[0] : null;
}

async function updatePickingTeData(pickingId, data) {
  await safeWriteCustom('stock.picking', [pickingId], data);
  logger.info('[ODOO-TE] Picking ' + pickingId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function markPickingsSynced(pickingIds, teOrderId) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await safeWriteCustom('stock.picking', pickingIds, vals);
  logger.info('[ODOO-TE] ' + pickingIds.length + ' picking(s) sync | te_order_id=' + teOrderId);
}

// ============================================================
// ACCOUNT.MOVE (faturas)
// ============================================================
async function findSaleOrderByInvoice(invoiceId) {
  console.log('[ODOO-TE] findSaleOrderByInvoice: invoiceId=' + invoiceId);

  // Estrategia 1: sale.order.invoice_ids
  try {
    var saleIds = await executeKw('sale.order', 'search', [['invoice_ids', 'in', [invoiceId]]]);
    if (saleIds && saleIds.length) {
      var orders = await executeKw('sale.order', 'read', [saleIds], { fields: ['id', 'name'] });
      if (orders && orders[0]) { console.log('[ODOO-TE] Estrategia 1 (invoice_ids) encontrou: ' + orders[0].name); return orders[0]; }
    }
    console.log('[ODOO-TE] Estrategia 1 (invoice_ids): sem resultados');
  } catch (err) { console.warn('[ODOO-TE] Estrategia 1 falhou: ' + err.message); }

  // Estrategia 2: sale_order_ids da fatura (campo computado)
  try {
    var invData = await executeKw('account.move', 'read', [[invoiceId]], { fields: ['id', 'partner_id', 'sale_order_ids'] });
    var inv = invData && invData[0];
    console.log('[ODOO-TE] Fatura lida: id=' + (inv ? inv.id : 'null') + ', partner=' + JSON.stringify(inv ? inv.partner_id : null) + ', sale_order_ids=' + JSON.stringify(inv ? inv.sale_order_ids : null));
    if (inv && inv.sale_order_ids && inv.sale_order_ids.length) {
      var soId = Array.isArray(inv.sale_order_ids[0]) ? inv.sale_order_ids[0][0] : inv.sale_order_ids[0];
      var orders = await executeKw('sale.order', 'read', [[soId]], { fields: ['id', 'name'] });
      if (orders && orders[0]) { console.log('[ODOO-TE] Estrategia 2 (sale_order_ids) encontrou: ' + orders[0].name); return orders[0]; }
    }
    console.log('[ODOO-TE] Estrategia 2 (sale_order_ids): sem resultados');
  } catch (err) { console.warn('[ODOO-TE] Estrategia 2 falhou: ' + err.message); }

  // Estrategia 3: account.move.line -> sale_line_ids -> order_id
  try {
    var invData = await executeKw('account.move', 'read', [[invoiceId]], { fields: ['line_ids'] });
    var inv = invData && invData[0];
    var lineIds = (inv && inv.line_ids) || [];
    console.log('[ODOO-TE] Estrategia 3: ' + lineIds.length + ' linhas da fatura');
    if (lineIds.length) {
      var lines = await executeKw('account.move.line', 'read', [lineIds], { fields: ['sale_line_ids'] });
      if (lines) {
        for (var i = 0; i < lines.length; i++) {
          var sli = lines[i].sale_line_ids;
          if (sli && sli.length) {
            var saleLineId = Array.isArray(sli[0]) ? sli[0][0] : sli[0];
            var saleLines = await executeKw('sale.order.line', 'read', [[saleLineId]], { fields: ['order_id'] });
            if (saleLines && saleLines[0] && saleLines[0].order_id) {
              var orderId = Array.isArray(saleLines[0].order_id) ? saleLines[0].order_id[0] : saleLines[0].order_id;
              var orders = await executeKw('sale.order', 'read', [[orderId]], { fields: ['id', 'name'] });
              if (orders && orders[0]) { console.log('[ODOO-TE] Estrategia 3 (lines) encontrou: ' + orders[0].name); return orders[0]; }
            }
          }
        }
      }
    }
    console.log('[ODOO-TE] Estrategia 3 (lines): sem resultados');
  } catch (err) { console.warn('[ODOO-TE] Estrategia 3 falhou: ' + err.message); }

  // NOTA: Estrategia 4 (partner_id fallback) removida — achava vendas nao
  // relacionadas ao mesmo cliente. Para send-invoice sem venda vinculada,
  // o fluxo correto e usar as linhas da fatura diretamente.

  console.error('[ODOO-TE] Nenhuma estrategia encontrou sale.order para invoice ' + invoiceId);
  return null;
}

async function markInvoiceSynced(invoiceIds, teOrderId) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await safeWriteCustom('account.move', invoiceIds, vals);
  logger.info('[ODOO-TE] ' + invoiceIds.length + ' fatura(s) sync | te_order_id=' + teOrderId);
}

async function updateInvoiceStatusHtml(invoiceId, html) {
  await safeWriteCustom('account.move', [invoiceId], { x_studio_status_de_entrega_te: html });
}

// ============================================================
// INVOICE HELPERS (send-invoice sem sale.order)
// ============================================================
async function readInvoiceFull(invoiceId) {
  try {
    var results = await safeReadCustom('account.move', [invoiceId], INVOICE_FIELDS, INVOICE_CUSTOM_FIELDS);
    return results ? results[0] : null;
  } catch (err) {
    logger.warn('[ODOO-TE] readInvoiceFull falhou: ' + err.message);
    return null;
  }
}

async function getInvoiceLines(invoiceId) {
  try {
    var ids = await executeKw('account.move.line', 'search', [
      ['move_id', '=', invoiceId], ['product_id', '!=', false],
    ]);
    if (!ids || !ids.length) return [];
    return await executeKw('account.move.line', 'read', [ids], { fields: INVOICE_LINE_FIELDS });
  } catch (err) {
    logger.warn('[ODOO-TE] getInvoiceLines falhou: ' + err.message);
    return [];
  }
}

// ============================================================
// RES.PARTNER
// ============================================================
async function getPartner(partnerId) {
  var partners = await safeReadCustom('res.partner', [partnerId], PARTNER_FIELDS, PARTNER_OPTIONAL_FIELDS);
  return partners ? partners[0] : null;
}

// ============================================================
// SALE.ORDER.LINE + PRODUCT
// ============================================================
async function getSaleOrderLines(saleOrderId) {
  try {
    var ids = await executeKw('sale.order.line', 'search', [['order_id', '=', saleOrderId]]);
    if (!ids || !ids.length) return [];
    return await executeKw('sale.order.line', 'read', [ids], { fields: ORDER_LINE_FIELDS });
  } catch (err) {
    logger.warn('[ODOO-TE] Erro lendo sale.order.line: ' + err.message);
    return [];
  }
}

async function getProducts(productIds) {
  if (!productIds || !productIds.length) return {};
  try {
    var products = await executeKw('product.product', 'read', [productIds], { fields: PRODUCT_FIELDS });
    var map = {};
    if (products) products.forEach(function(p) { map[p.id] = p; });
    return map;
  } catch (err) {
    logger.warn('[ODOO-TE] Erro lendo produtos: ' + err.message);
    return {};
  }
}

// ============================================================
// RES.COMPANY
// ============================================================
async function getCompany() {
  try {
    var ids = await executeKw('res.company', 'search', [[]], { limit: 1 });
    if (!ids || !ids.length) return null;
    // Tenta com campos opcionais primeiro
    try {
      return (await executeKw('res.company', 'read', [ids], {
        fields: ['name', 'street', 'street2', 'city', 'state_id', 'zip', 'country_id',
                 'phone', 'email', 'partner_id', 'vat', 'district', 'number'],
      }))[0] || null;
    } catch (err) {
      // Fallback: campos nativos garantidos
      return (await executeKw('res.company', 'read', [ids], {
        fields: ['name', 'street', 'street2', 'city', 'state_id', 'zip', 'country_id', 'phone', 'email', 'partner_id', 'vat'],
      }))[0] || null;
    }
  } catch (err) {
    logger.warn('[ODOO-TE] Erro lendo res.company: ' + err.message);
    return null;
  }
}

// ============================================================
// CHATTER
// ============================================================
async function postChatter(model, recordId, body) {
  try {
    await executeKw('mail.message', 'create', [{ model: model, res_id: recordId, body: body }]);
    logger.info('[ODOO-TE] Chatter postado em ' + model + ' ' + recordId);
  } catch (err) {
    logger.error('[ODOO-TE] Falha chatter ' + model + ' ' + recordId + ': ' + err.message);
  }
}

// ============================================================
// UNSYNCED (auto-sync legacy)
// ============================================================
var _syncFieldChecked = { 'stock.picking': false, 'sale.order': false, 'account.move': false };
async function safeSearchWithSync(model, baseDomain) {
  var domain = baseDomain.concat([['x_studio_te_sync', '=', false]]);
  try { return await executeKw(model, 'search', [domain]); }
  catch (err) {
    if (err.message && (err.message.indexOf('Invalid field') !== -1 || err.message.indexOf('KeyError') !== -1)) {
      if (!_syncFieldChecked[model]) { _syncFieldChecked[model] = true; logger.error('[ODOO-TE] Campo x_studio_te_sync NAO EXISTE em ' + model); }
      return [];
    }
    throw err;
  }
}
async function getUnsyncedPickings() {
  var ids = await safeSearchWithSync('stock.picking', [['picking_type_code', '=', 'outgoing'], ['state', 'in', ['assigned', 'confirmed']]]);
  if (!ids || !ids.length) return [];
  return await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS) || [];
}
async function getUnsyncedSaleOrders() {
  var ids = await safeSearchWithSync('sale.order', [['state', 'in', ['sale', 'done']]]);
  if (!ids || !ids.length) return [];
  return await safeReadCustom('sale.order', ids, SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS) || [];
}
async function getUnsyncedInvoices() {
  var ids = await safeSearchWithSync('account.move', [['move_type', '=', 'out_invoice'], ['state', '=', 'posted']]);
  if (!ids || !ids.length) return [];
  return await safeReadCustom('account.move', ids, INVOICE_FIELDS, INVOICE_CUSTOM_FIELDS) || [];
}

// ============================================================
// FIND BY TE ID (webhook)
// ============================================================
async function findPickingByTeId(teOrderId) {
  try {
    var ids = await executeKw('stock.picking', 'search', [['x_studio_te_order_id', '=', String(teOrderId)]]);
    if (!ids || !ids.length) return null;
    var pickings = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
    return pickings ? pickings[0] : null;
  } catch (err) {
    if (err.message && err.message.indexOf('Invalid field') !== -1) return null;
    throw err;
  }
}
async function findSaleOrderByTeId(teOrderId) {
  try {
    var ids = await executeKw('sale.order', 'search', [['x_studio_te_order_id', '=', String(teOrderId)]]);
    if (!ids || !ids.length) return null;
    var orders = await safeReadCustom('sale.order', ids, SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS);
    return orders ? orders[0] : null;
  } catch (err) {
    if (err.message && err.message.indexOf('Invalid field') !== -1) return null;
    throw err;
  }
}
async function findPickingByOrderNumber(orderNumber) {
  if (!orderNumber) return null;
  try {
    var ids = await executeKw('stock.picking', 'search', [['origin', '=', String(orderNumber)], ['picking_type_code', '=', 'outgoing']], { limit: 1 });
    if (ids && ids.length) { var p = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS); return p ? p[0] : null; }
    ids = await executeKw('stock.picking', 'search', [['name', '=', String(orderNumber)]], { limit: 1 });
    if (ids && ids.length) { var p = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS); return p ? p[0] : null; }
    return null;
  } catch (err) { logger.warn('[ODOO-TE] findPickingByOrderNumber erro: ' + err.message); return null; }
}
async function findSaleOrderByOrderNumber(orderNumber) {
  if (!orderNumber) return null;
  try {
    var ids = await executeKw('sale.order', 'search', [['name', '=', String(orderNumber)]], { limit: 1 });
    if (!ids || !ids.length) return null;
    var orders = await safeReadCustom('sale.order', ids, SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS);
    return orders ? orders[0] : null;
  } catch (err) { logger.warn('[ODOO-TE] findSaleOrderByOrderNumber erro: ' + err.message); return null; }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  // Compatibilidade com delivery.js atual
  read: read,
  searchRead: searchRead,
  write: write,
  getStudioFields: getStudioFields,
  FIELDS: FIELDS,
  // Sale Order
  findSaleOrderById: findSaleOrderById,
  readSaleOrder: readSaleOrder,
  readSaleOrderFull: readSaleOrderFull,
  updateSaleOrderStatusHtml: updateSaleOrderStatusHtml,
  updateSaleOrderMotorista: updateSaleOrderMotorista,
  updateSaleOrderTeData: updateSaleOrderTeData,
  markSaleOrdersSynced: markSaleOrdersSynced,
  markSaleOrderError: markSaleOrderError,
  // Picking
  readPicking: readPicking,
  findDeliveryPicking: findDeliveryPicking,
  updatePickingTeData: updatePickingTeData,
  markPickingsSynced: markPickingsSynced,
  // Invoice
  findSaleOrderByInvoice: findSaleOrderByInvoice,
  markInvoiceSynced: markInvoiceSynced,
  updateInvoiceStatusHtml: updateInvoiceStatusHtml,
  readInvoiceFull: readInvoiceFull,
  getInvoiceLines: getInvoiceLines,
  // Partner
  getPartner: getPartner,
  // Produtos
  getSaleOrderLines: getSaleOrderLines,
  getProducts: getProducts,
  // Empresa
  getCompany: getCompany,
  // Chatter
  postChatter: postChatter,
  // Webhook find
  findPickingByTeId: findPickingByTeId,
  findSaleOrderByTeId: findSaleOrderByTeId,
  findPickingByOrderNumber: findPickingByOrderNumber,
  findSaleOrderByOrderNumber: findSaleOrderByOrderNumber,
  // Auto-sync
  getUnsyncedPickings: getUnsyncedPickings,
  getUnsyncedSaleOrders: getUnsyncedSaleOrders,
  getUnsyncedInvoices: getUnsyncedInvoices,
  // Low-level
  executeKw: executeKw,
  safeWriteCustom: safeWriteCustom,
};
