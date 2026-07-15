/**
 * services/odoo-te.js - Odoo XML-RPC client para TudoEntregue
 * Usa XML-RPC (igual odoo-push.js) pois JSON-RPC nao funciona no Odoo SaaS
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');
var logger = require('../utils/logger');

// Campos 100% nativos do Odoo (existem em qualquer instalacao)
var PARTNER_FIELDS = [
  'id', 'name', 'city', 'state_id', 'zip', 'phone', 'email',
  'street', 'street2', 'country_id',
];

// Todos os campos opcionais do partner (extended + x_studio)
var PARTNER_OPTIONAL_FIELDS = [
  'vat', 'cnpj_cpf', 'number', 'district', 'l10n_br_city_id',
  'x_studio_te_codigo', 'x_studio_te_razao_social',
  'x_studio_te_cnpj_cpf', 'x_studio_te_inscricao_estadual',
  'x_studio_te_telefone', 'x_studio_te_email', 'x_studio_te_logradouro',
  'x_studio_te_numero', 'x_studio_te_complemento', 'x_studio_te_bairro',
  'x_studio_te_municipio', 'x_studio_te_uf', 'x_studio_te_cep',
  'x_studio_te_latitude', 'x_studio_te_longitude',
];

var MOVE_FIELDS = [
  'id', 'name', 'product_id', 'product_uom_qty', 'quantity_done',
  'description_picking', 'sale_line_id',
];

var PRODUCT_FIELDS = [
  'id', 'name', 'weight', 'volume', 'default_code', 'qty_available',
];

var ORDER_LINE_FIELDS = [
  'id', 'name', 'product_id', 'product_uom_qty', 'price_unit',
  'price_subtotal', 'price_total',
];

var SALE_ORDER_FIELDS = [
  'id', 'name', 'partner_id', 'state', 'amount_total',
];

var SALE_ORDER_CUSTOM_FIELDS = [
  'x_studio_te_sync', 'x_studio_te_order_id', 'x_studio_te_situacao',
  'x_studio_te_situacao_desc', 'x_studio_te_tipo_pedido', 'x_studio_te_data_entrega',
  'x_studio_te_valor_frete', 'x_studio_te_peso_total', 'x_studio_te_qtd_volumes',
  'x_studio_te_observacao', 'x_studio_te_protocolo_coleta', 'x_studio_te_data_coleta',
  'x_studio_te_nome_motorista', 'x_studio_te_placa_veiculo', 'x_studio_te_rastreio',
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
];

// Mapeamento de campos opcionais por modelo (segundo nivel do safeReadCustom)
var OPTIONAL_FIELDS = {
  'res.partner': PARTNER_OPTIONAL_FIELDS,
  'sale.order': SALE_ORDER_CUSTOM_FIELDS,
  'stock.picking': PICKING_CUSTOM_FIELDS,
};

// --- XML-RPC connection (singleton) ---
var _cached = null; // { uid, common, models }

function getConn() {
  if (_cached && _cached.uid) return _cached;

  var odooConfig = config.odoo;
  var base = odooConfig.url.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');

  var common = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
  var models = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });

  _cached = {
    uid: null,
    common: common,
    models: models,
    db: odooConfig.db,
    password: odooConfig.password,
  };
  return _cached;
}

function authenticate() {
  return new Promise(function(resolve, reject) {
    var conn = getConn();
    conn.common.methodCall('authenticate', [conn.db, config.odoo.user, conn.password, {}], function(err, uid) {
      if (err) {
        reject(new Error('Auth Odoo falhou: ' + (err.message || JSON.stringify(err))));
      } else if (uid === false || uid === null) {
        reject(new Error('Auth Odoo: credenciais invalidas (UID=false)'));
      } else {
        conn.uid = uid;
        logger.info('[ODOO-TE] Autenticado. UID: ' + uid);
        resolve(uid);
      }
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
        if (err) {
          reject(new Error(model + '.' + method + ': ' + (err.message || JSON.stringify(err))));
        } else {
          resolve(result);
        }
      });
    }).catch(reject);
  });
}

// --- Safe read: tenta ler campos customizados, se falhar le so os nativos ---
var _customFieldsCache = {}; // cache: model -> { available: bool, missingFields: [] }

async function safeReadCustom(model, ids, nativeFields, customFields) {
  // Tenta ler campos nativos + customizados
  try {
    var allFields = nativeFields.concat(customFields);
    return await executeKw(model, 'read', [ids], { fields: allFields });
  } catch (err) {
    // Se falhou por campo invalido, tenta sem os customizados
    if (err.message && (err.message.indexOf('Invalid field') !== -1 || err.message.indexOf('KeyError') !== -1)) {
      // Descobre quais campos faltam (para log e cache)
      if (!_customFieldsCache[model]) {
        _customFieldsCache[model] = { available: false, checked: true };
        logger.warn('[ODOO-TE] Campos x_studio_* nao encontrados em ' + model + '. Funcionando com campos nativos. Crie os campos no Odoo Studio se precisar de dados TE adicionais.');
      }
      return await executeKw(model, 'read', [ids], { fields: nativeFields });
    }
    throw err;
  }
}

// --- Safe write: escreve campos customizados, ignora erros de campo faltante ---
async function safeWriteCustom(model, ids, vals) {
  // Filtra campos x_studio_* dos vals
  var customVals = {};
  var nativeVals = {};
  Object.keys(vals).forEach(function(k) {
    if (k.indexOf('x_studio_') === 0) {
      customVals[k] = vals[k];
    } else {
      nativeVals[k] = vals[k];
    }
  });

  // Escreve campos nativos
  if (Object.keys(nativeVals).length > 0) {
    await executeKw(model, 'write', [ids, nativeVals]);
  }

  // Tenta escrever campos customizados, ignora se nao existem
  if (Object.keys(customVals).length > 0) {
    try {
      await executeKw(model, 'write', [ids, customVals]);
    } catch (err) {
      if (err.message && (err.message.indexOf('Invalid field') !== -1 || err.message.indexOf('KeyError') !== -1)) {
        if (!_customFieldsCache[model] || !_customFieldsCache[model].warned) {
          logger.warn('[ODOO-TE] Campos x_studio_* nao existem em ' + model + '. Gravacao de dados TE ignorada. Crie os campos no Odoo Studio.');
          if (!_customFieldsCache[model]) _customFieldsCache[model] = {};
          _customFieldsCache[model].warned = true;
        }
      } else {
        throw err;
      }
    }
  }
}

// --- Safe search com campo x_studio_te_sync ---
var _syncFieldChecked = { 'stock.picking': false, 'sale.order': false, 'account.move': false };

async function safeSearchWithSync(model, baseDomain) {
  var domain = baseDomain.concat([['x_studio_te_sync', '=', false]]);
  try {
    return await executeKw(model, 'search', [domain]);
  } catch (err) {
    if (err.message && (err.message.indexOf('Invalid field') !== -1 || err.message.indexOf('KeyError') !== -1)) {
      if (!_syncFieldChecked[model]) {
        _syncFieldChecked[model] = true;
        logger.error('[ODOO-TE] ============================================================');
        logger.error('[ODOO-TE] Campo x_studio_te_sync NAO EXISTE em ' + model + '!');
        logger.error('[ODOO-TE] Crie este campo (checkbox) no Odoo Studio ANTES de usar o auto-sync.');
        logger.error('[ODOO-TE] Sem ele, nao e possivel evitar reenvio de pedidos ja enviados.');
        logger.error('[ODOO-TE] Auto-sync DESATIVADO para ' + model + ' ate o campo ser criado.');
        logger.error('[ODOO-TE] ============================================================');
      }
      // Retorna vazio - NAO faz fallback pois re-enviaria tudo
      return [];
    }
    throw err;
  }
}

// --- Public API ---

async function getUnsyncedPickings() {
  var ids = await safeSearchWithSync('stock.picking', [
    ['picking_type_code', '=', 'outgoing'],
    ['state', 'in', ['assigned', 'confirmed']],
  ]);
  if (!ids || !ids.length) return [];
  var pickings = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
  return pickings || [];
}

async function getUnsyncedSaleOrders() {
  var ids = await safeSearchWithSync('sale.order', [
    ['state', 'in', ['sale', 'done']],
  ]);
  if (!ids || !ids.length) return [];
  var orders = await safeReadCustom('sale.order', ids, SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS);
  return orders || [];
}

async function markPickingsSynced(pickingIds, teOrderId) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await safeWriteCustom('stock.picking', pickingIds, vals);
  logger.info('[ODOO-TE] ' + pickingIds.length + ' picking(s) sync | te_order_id=' + teOrderId);
}

async function markSaleOrdersSynced(orderIds, teOrderId) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await safeWriteCustom('sale.order', orderIds, vals);
  logger.info('[ODOO-TE] ' + orderIds.length + ' sale.order(s) sync | te_order_id=' + teOrderId);
}

async function readPicking(pickingId) {
  var pickings = await safeReadCustom('stock.picking', [pickingId], PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
  return pickings ? pickings[0] : null;
}

async function readSaleOrder(orderId) {
  var orders = await safeReadCustom('sale.order', [orderId], SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS);
  return orders ? orders[0] : null;
}

async function findPickingByTeId(teOrderId) {
  try {
    var ids = await executeKw('stock.picking', 'search', [[
      ['x_studio_te_order_id', '=', String(teOrderId)],
    ]]);
    if (!ids || !ids.length) return null;
    var pickings = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
    return pickings ? pickings[0] : null;
  } catch (err) {
    if (err.message && err.message.indexOf('Invalid field') !== -1) {
      logger.warn('[ODOO-TE] Campo x_studio_te_order_id nao existe em stock.picking - nao e possivel correlacionar webhook com picking');
      return null;
    }
    throw err;
  }
}

async function findSaleOrderByTeId(teOrderId) {
  try {
    var ids = await executeKw('sale.order', 'search', [[
      ['x_studio_te_order_id', '=', String(teOrderId)],
    ]]);
    if (!ids || !ids.length) return null;
    var orders = await safeReadCustom('sale.order', ids, SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS);
    return orders ? orders[0] : null;
  } catch (err) {
    if (err.message && err.message.indexOf('Invalid field') !== -1) {
      logger.warn('[ODOO-TE] Campo x_studio_te_order_id nao existe em sale.order - nao e possivel correlacionar webhook');
      return null;
    }
    throw err;
  }
}

/**
 * Busca picking pelo numero do pedido (origin ou name)
 * Fallback para webhooks de pedidos criados diretamente no TE
 */
async function findPickingByOrderNumber(orderNumber) {
  if (!orderNumber) return null;
  try {
    // Tenta pelo campo origin (que costuma ter o nome do sale order)
    var ids = await executeKw('stock.picking', 'search', [[
      ['origin', '=', String(orderNumber)],
      ['picking_type_code', '=', 'outgoing'],
    ]], { limit: 1 });
    if (ids && ids.length) {
      var pickings = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
      return pickings ? pickings[0] : null;
    }
    // Tenta pelo campo name do proprio picking
    ids = await executeKw('stock.picking', 'search', [[
      ['name', '=', String(orderNumber)],
    ]], { limit: 1 });
    if (ids && ids.length) {
      var pickings = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
      return pickings ? pickings[0] : null;
    }
    return null;
  } catch (err) {
    logger.warn('[ODOO-TE] findPickingByOrderNumber erro: ' + err.message);
    return null;
  }
}

/**
 * Busca sale.order pelo nome do pedido
 * Fallback para webhooks de pedidos criados diretamente no TE
 */
async function findSaleOrderByOrderNumber(orderNumber) {
  if (!orderNumber) return null;
  try {
    var ids = await executeKw('sale.order', 'search', [[
      ['name', '=', String(orderNumber)],
    ]], { limit: 1 });
    if (!ids || !ids.length) return null;
    var orders = await safeReadCustom('sale.order', ids, SALE_ORDER_FIELDS, SALE_ORDER_CUSTOM_FIELDS);
    return orders ? orders[0] : null;
  } catch (err) {
    logger.warn('[ODOO-TE] findSaleOrderByOrderNumber erro: ' + err.message);
    return null;
  }
}

async function updatePickingTeData(pickingId, data) {
  await safeWriteCustom('stock.picking', [pickingId], data);
  logger.info('[ODOO-TE] Picking ' + pickingId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function updateSaleOrderTeData(orderId, data) {
  await safeWriteCustom('sale.order', [orderId], data);
  logger.info('[ODOO-TE] Sale Order ' + orderId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function getPartner(partnerId) {
  var partners = await safeReadCustom('res.partner', [partnerId], PARTNER_FIELDS, PARTNER_OPTIONAL_FIELDS);
  return partners ? partners[0] : null;
}

// --- Faturas (account.move) ---

var INVOICE_FIELDS = [
  'id', 'name', 'state', 'move_type', 'partner_id',
  'invoice_date', 'amount_total', 'payment_state',
];

var INVOICE_CUSTOM_FIELDS = [
  'x_studio_te_sync', 'x_studio_te_order_id',
];

/**
 * Busca faturas de saida postadas (NF emitida) que ainda nao foram enviadas ao TE
 */
async function getUnsyncedInvoices() {
  var ids = await safeSearchWithSync('account.move', [
    ['move_type', '=', 'out_invoice'],
    ['state', '=', 'posted'],
  ]);
  if (!ids || !ids.length) return [];
  var invoices = await safeReadCustom('account.move', ids, INVOICE_FIELDS, INVOICE_CUSTOM_FIELDS);
  return invoices || [];
}

/**
 * Dado um invoice_id, encontra o sale.order relacionado
 * account.move.line -> sale_line_ids -> order_id
 */
async function findSaleOrderByInvoice(invoiceId) {
  try {
    // Tenta busca direta: sale.order onde invoice_ids contem esta fatura
    var saleIds = await executeKw('sale.order', 'search', [[
      ['invoice_ids', 'in', [invoiceId]],
    ]]);
    if (saleIds && saleIds.length) {
      var orders = await executeKw('sale.order', 'read', [saleIds], { fields: ['id', 'name'] });
      return orders ? orders[0] : null;
    }
  } catch (err) {
    // invoice_ids pode nao existir, tenta via linhas
    logger.warn('[ODOO-TE] Busca direta invoice->sale falhou, tentando via linhas: ' + err.message);
  }

  // Fallback: via account.move.line -> sale_line_ids -> order_id
  try {
    var lineIds = await executeKw('account.move.line', 'search', [[
      ['move_id', '=', invoiceId],
      ['sale_line_ids', '!=', false],
    ]]);
    if (lineIds && lineIds.length) {
      var lines = await executeKw('account.move.line', 'read', [lineIds.slice(0, 1)], { fields: ['sale_line_ids'] });
      if (lines && lines[0] && lines[0].sale_line_ids && lines[0].sale_line_ids.length) {
        var saleLineId = lines[0].sale_line_ids[0];
        // order_id vem do sale.order.line
        var saleLines = await executeKw('sale.order.line', 'read', [[saleLineId]], { fields: ['order_id'] });
        if (saleLines && saleLines[0] && saleLines[0].order_id) {
          var orderId = saleLines[0].order_id[0];
          var orders = await executeKw('sale.order', 'read', [[orderId]], { fields: ['id', 'name'] });
          return orders ? orders[0] : null;
        }
      }
    }
  } catch (err) {
    logger.warn('[ODOO-TE] Busca via linhas tambem falhou: ' + err.message);
  }

  return null;
}

/**
 * Dado um sale_order_id, encontra o picking de entrega relacionado
 */
async function findDeliveryPicking(saleOrderId) {
  var ids = await executeKw('stock.picking', 'search', [[
    ['sale_id', '=', saleOrderId],
    ['picking_type_code', '=', 'outgoing'],
  ]], { limit: 1 });
  if (!ids || !ids.length) return null;
  var pickings = await safeReadCustom('stock.picking', ids, PICKING_FIELDS, PICKING_CUSTOM_FIELDS);
  return pickings ? pickings[0] : null;
}

async function markInvoiceSynced(invoiceIds, teOrderId) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await safeWriteCustom('account.move', invoiceIds, vals);
  logger.info('[ODOO-TE] ' + invoiceIds.length + ' fatura(s) sync | te_order_id=' + teOrderId);
}

/**
 * Le as stock.move de um picking (itens da entrega)
 */
async function getStockMoves(pickingId) {
  try {
    var ids = await executeKw('stock.move', 'search', [[
      ['picking_id', '=', pickingId],
    ]]);
    if (!ids || !ids.length) return [];
    var moves = await executeKw('stock.move', 'read', [ids], { fields: MOVE_FIELDS });
    return moves || [];
  } catch (err) {
    logger.warn('[ODOO-TE] Erro lendo stock.move: ' + err.message);
    return [];
  }
}

/**
 * Le as linhas do pedido de venda (sale.order.line)
 * Cada linha tem product_id, product_uom_qty, name, preco, etc.
 */
async function getSaleOrderLines(saleOrderId) {
  try {
    var ids = await executeKw('sale.order.line', 'search', [[
      ['order_id', '=', saleOrderId],
    ]]);
    if (!ids || !ids.length) return [];
    var lines = await executeKw('sale.order.line', 'read', [ids], { fields: ORDER_LINE_FIELDS });
    return lines || [];
  } catch (err) {
    logger.warn('[ODOO-TE] Erro lendo sale.order.line: ' + err.message);
    return [];
  }
}

/**
 * Le dados do produto (peso, volume)
 */
async function getProducts(productIds) {
  if (!productIds || !productIds.length) return {};
  try {
    var products = await executeKw('product.product', 'read', [productIds], { fields: PRODUCT_FIELDS });
    var map = {};
    if (products) {
      products.forEach(function(p) { map[p.id] = p; });
    }
    return map;
  } catch (err) {
    logger.warn('[ODOO-TE] Erro lendo produtos: ' + err.message);
    return {};
  }
}

/**
 * Le dados da empresa (res.company) para SourceAddress (remetente/matriz)
 */
async function getCompany() {
  try {
    var ids = await executeKw('res.company', 'search', [[], 1]);
    if (!ids || !ids.length) return null;
    var companies = await executeKw('res.company', 'read', [ids], {
      fields: ['name', 'street', 'street2', 'city', 'state_id', 'zip', 'country_id',
               'phone', 'email', 'partner_id', 'vat', 'l10n_br_cnpj_cpf', 'district', 'number'],
    });
    return companies ? companies[0] : null;
  } catch (err) {
    logger.warn('[ODOO-TE] Erro lendo res.company: ' + err.message);
    return null;
  }
}

async function postChatter(model, recordId, body) {
  try {
    // Cria mensagem diretamente - campos minimos para funcionar no Odoo SaaS
    await executeKw('mail.message', 'create', [{
      model: model,
      res_id: recordId,
      body: body,
    }]);
    logger.info('[ODOO-TE] Chatter postado em ' + model + ' ' + recordId);
  } catch (err) {
    logger.error('[ODOO-TE] Falha chatter ' + model + ' ' + recordId + ': ' + err.message);
  }
}

module.exports = {
  getUnsyncedPickings: getUnsyncedPickings,
  getUnsyncedSaleOrders: getUnsyncedSaleOrders,
  getUnsyncedInvoices: getUnsyncedInvoices,
  findSaleOrderByInvoice: findSaleOrderByInvoice,
  findDeliveryPicking: findDeliveryPicking,
  markPickingsSynced: markPickingsSynced,
  markSaleOrdersSynced: markSaleOrdersSynced,
  markInvoiceSynced: markInvoiceSynced,
  findPickingByTeId: findPickingByTeId,
  findSaleOrderByTeId: findSaleOrderByTeId,
  findPickingByOrderNumber: findPickingByOrderNumber,
  findSaleOrderByOrderNumber: findSaleOrderByOrderNumber,
  updatePickingTeData: updatePickingTeData,
  updateSaleOrderTeData: updateSaleOrderTeData,
  executeKw: executeKw,
  getPartner: getPartner,
  getStockMoves: getStockMoves,
  getSaleOrderLines: getSaleOrderLines,
  getProducts: getProducts,
  getCompany: getCompany,
  postChatter: postChatter,
  readPicking: readPicking,
  readSaleOrder: readSaleOrder,
};