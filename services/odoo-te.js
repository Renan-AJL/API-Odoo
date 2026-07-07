/**
 * services/odoo-te.js - Odoo XML-RPC client para TudoEntregue
 * Usa XML-RPC (igual odoo-push.js) pois JSON-RPC nao funciona no Odoo SaaS
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');
var logger = require('../utils/logger');

var PARTNER_FIELDS = [
  'id', 'name', 'city', 'state_id', 'zip', 'phone', 'mobile', 'email', 'cnpj_cpf', 'vat',
  'x_studio_te_codigo', 'x_studio_te_razao_social',
  'x_studio_te_cnpj_cpf', 'x_studio_te_inscricao_estadual',
  'x_studio_te_telefone', 'x_studio_te_email', 'x_studio_te_logradouro',
  'x_studio_te_numero', 'x_studio_te_complemento', 'x_studio_te_bairro',
  'x_studio_te_municipio', 'x_studio_te_uf', 'x_studio_te_cep',
  'x_studio_te_latitude', 'x_studio_te_longitude',
];

var SALE_ORDER_FIELDS = [
  'id', 'name', 'partner_id', 'state', 'x_studio_te_sync',
  'x_studio_te_order_id', 'x_studio_te_situacao', 'x_studio_te_situacao_desc',
  'x_studio_te_tipo_pedido', 'x_studio_te_data_entrega',
  'x_studio_te_valor_frete', 'x_studio_te_peso_total',
  'x_studio_te_qtd_volumes', 'x_studio_te_observacao',
  'x_studio_te_protocolo_coleta', 'x_studio_te_data_coleta',
  'x_studio_te_nome_motorista', 'x_studio_te_placa_veiculo',
  'x_studio_te_rastreio',
];

var PICKING_FIELDS = [
  'id', 'name', 'partner_id', 'sale_id', 'state', 'picking_type_code',
  'x_studio_te_sync', 'x_studio_te_order_id', 'x_studio_te_situacao',
  'x_studio_te_situacao_desc', 'x_studio_te_tipo_pedido',
  'x_studio_te_data_entrega', 'x_studio_te_valor_frete',
  'x_studio_te_peso_total', 'x_studio_te_qtd_volumes',
  'x_studio_te_observacao', 'x_studio_te_protocolo_coleta',
  'x_studio_te_data_coleta', 'x_studio_te_nome_motorista',
  'x_studio_te_placa_veiculo', 'x_studio_te_rastreio',
  'scheduled_date', 'origin', 'note',
];

var FIELDS = {
  'res.partner': PARTNER_FIELDS,
  'sale.order': SALE_ORDER_FIELDS,
  'stock.picking': PICKING_FIELDS,
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

// --- Public API ---

async function getUnsyncedPickings() {
  var ids = await executeKw('stock.picking', 'search', [[
    ['picking_type_code', '=', 'outgoing'],
    ['state', 'in', ['assigned', 'confirmed']],
    ['x_studio_te_sync', '=', false],
  ]]);
  if (!ids || !ids.length) return [];
  var pickings = await executeKw('stock.picking', 'read', [ids], { fields: PICKING_FIELDS });
  return pickings || [];
}

async function getUnsyncedSaleOrders() {
  var ids = await executeKw('sale.order', 'search', [[
    ['state', 'in', ['sale', 'done']],
    ['x_studio_te_sync', '=', false],
  ]]);
  if (!ids || !ids.length) return [];
  var orders = await executeKw('sale.order', 'read', [ids], { fields: SALE_ORDER_FIELDS });
  return orders || [];
}

async function markPickingsSynced(pickingIds, teOrderId) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await executeKw('stock.picking', 'write', [pickingIds, vals]);
  logger.info('[ODOO-TE] ' + pickingIds.length + ' picking(s) sync | te_order_id=' + teOrderId);
}

async function markSaleOrdersSynced(orderIds, teOrderId) {
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await executeKw('sale.order', 'write', [orderIds, vals]);
  logger.info('[ODOO-TE] ' + orderIds.length + ' sale.order(s) sync | te_order_id=' + teOrderId);
}

async function readPicking(pickingId) {
  var pickings = await executeKw('stock.picking', 'read', [[pickingId]], { fields: PICKING_FIELDS });
  return pickings ? pickings[0] : null;
}

async function readSaleOrder(orderId) {
  var orders = await executeKw('sale.order', 'read', [[orderId]], { fields: SALE_ORDER_FIELDS });
  return orders ? orders[0] : null;
}

async function findPickingByTeId(teOrderId) {
  var ids = await executeKw('stock.picking', 'search', [[
    ['x_studio_te_order_id', '=', String(teOrderId)],
  ]]);
  if (!ids || !ids.length) return null;
  var pickings = await executeKw('stock.picking', 'read', [ids], { fields: PICKING_FIELDS });
  return pickings ? pickings[0] : null;
}

async function findSaleOrderByTeId(teOrderId) {
  var ids = await executeKw('sale.order', 'search', [[
    ['x_studio_te_order_id', '=', String(teOrderId)],
  ]]);
  if (!ids || !ids.length) return null;
  var orders = await executeKw('sale.order', 'read', [ids], { fields: SALE_ORDER_FIELDS });
  return orders ? orders[0] : null;
}

async function updatePickingTeData(pickingId, data) {
  await executeKw('stock.picking', 'write', [[pickingId], data]);
  logger.info('[ODOO-TE] Picking ' + pickingId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function updateSaleOrderTeData(orderId, data) {
  await executeKw('sale.order', 'write', [[orderId], data]);
  logger.info('[ODOO-TE] Sale Order ' + orderId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function getPartner(partnerId) {
  var partners = await executeKw('res.partner', 'read', [[partnerId]], { fields: PARTNER_FIELDS });
  return partners ? partners[0] : null;
}

async function postChatter(model, recordId, body) {
  try {
    await executeKw('mail.message', 'create', [{
      model: model,
      res_id: recordId,
      body: body,
      message_type: 'comment',
      subtype_xmlid: 'mail.mt_note',
    }]);
    logger.info('[ODOO-TE] Chatter postado em ' + model + ' ' + recordId);
  } catch (err) {
    logger.error('[ODOO-TE] Falha chatter ' + model + ' ' + recordId + ': ' + err.message);
  }
}

module.exports = {
  getUnsyncedPickings: getUnsyncedPickings,
  getUnsyncedSaleOrders: getUnsyncedSaleOrders,
  markPickingsSynced: markPickingsSynced,
  markSaleOrdersSynced: markSaleOrdersSynced,
  findPickingByTeId: findPickingByTeId,
  findSaleOrderByTeId: findSaleOrderByTeId,
  updatePickingTeData: updatePickingTeData,
  updateSaleOrderTeData: updateSaleOrderTeData,
  getPartner: getPartner,
  postChatter: postChatter,
  readPicking: readPicking,
  readSaleOrder: readSaleOrder,
  FIELDS: FIELDS,
};