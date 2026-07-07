/**
 * services/odoo-te.js - Odoo JSON-RPC client para TudoEntregue
 * Le/gravas campos x_studio_te_* nos modelos:
 *   res.partner, sale.order, stock.picking, purchase.order, account.move
 */
var config = require('../config');
var logger = require('../utils/logger');
var OdooClient = require('./odoo-api').OdooClient;

// Campos TE por modelo
var PARTNER_FIELDS = [
  'id', 'name', 'x_studio_te_codigo', 'x_studio_te_razao_social',
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

function getClient() {
  var c = new OdooClient();
  return c;
}

async function ensureAuth(client) {
  if (!client.uid) {
    await client.authenticate();
  }
}

/**
 * Busca pickings de saida nao sincronizados com TE
 */
async function getUnsyncedPickings() {
  var client = getClient();
  await ensureAuth(client);
  var ids = await client.execute('stock.picking', 'search', [[
    ['picking_type_code', '=', 'outgoing'],
    ['state', 'in', ['assigned', 'confirmed']],
    ['x_studio_te_sync', '=', false],
  ]]);
  if (!ids.length) return [];
  var pickings = await client.execute('stock.picking', 'read', [ids], { fields: PICKING_FIELDS });
  return pickings || [];
}

/**
 * Busca sale.orders nao sincronizados com TE
 */
async function getUnsyncedSaleOrders() {
  var client = getClient();
  await ensureAuth(client);
  var ids = await client.execute('sale.order', 'search', [[
    ['state', 'in', ['sale', 'done']],
    ['x_studio_te_sync', '=', false],
  ]]);
  if (!ids.length) return [];
  var orders = await client.execute('sale.order', 'read', [ids], { fields: SALE_ORDER_FIELDS });
  return orders || [];
}

/**
 * Marca pickings como sincronizados + grava te_order_id
 */
async function markPickingsSynced(pickingIds, teOrderId) {
  var client = getClient();
  await ensureAuth(client);
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await client.execute('stock.picking', 'write', [pickingIds, vals]);
  logger.info('[ODOO-TE] ' + pickingIds.length + ' picking(s) marcado(s) como sync | te_order_id=' + teOrderId);
}

/**
 * Marca sale orders como sincronizados + grava te_order_id
 */
async function markSaleOrdersSynced(orderIds, teOrderId) {
  var client = getClient();
  await ensureAuth(client);
  var vals = { x_studio_te_sync: true };
  if (teOrderId) vals.x_studio_te_order_id = String(teOrderId);
  await client.execute('sale.order', 'write', [orderIds, vals]);
  logger.info('[ODOO-TE] ' + orderIds.length + ' sale.order(s) marcado(s) como sync | te_order_id=' + teOrderId);
}

/**
 * Busca picking pelo te_order_id
 */
async function findPickingByTeId(teOrderId) {
  var client = getClient();
  await ensureAuth(client);
  var ids = await client.execute('stock.picking', 'search', [[
    ['x_studio_te_order_id', '=', String(teOrderId)],
  ]]);
  if (!ids.length) return null;
  var pickings = await client.execute('stock.picking', 'read', [ids], { fields: PICKING_FIELDS });
  return pickings ? pickings[0] : null;
}

/**
 * Busca sale.order pelo te_order_id
 */
async function findSaleOrderByTeId(teOrderId) {
  var client = getClient();
  await ensureAuth(client);
  var ids = await client.execute('sale.order', 'search', [[
    ['x_studio_te_order_id', '=', String(teOrderId)],
  ]]);
  if (!ids.length) return null;
  var orders = await client.execute('sale.order', 'read', [ids], { fields: SALE_ORDER_FIELDS });
  return orders ? orders[0] : null;
}

/**
 * Atualiza campos TE de um picking
 */
async function updatePickingTeData(pickingId, data) {
  var client = getClient();
  await ensureAuth(client);
  await client.execute('stock.picking', 'write', [[pickingId], data]);
  logger.info('[ODOO-TE] Picking ' + pickingId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

/**
 * Atualiza campos TE de um sale.order
 */
async function updateSaleOrderTeData(orderId, data) {
  var client = getClient();
  await ensureAuth(client);
  await client.execute('sale.order', 'write', [[orderId], data]);
  logger.info('[ODOO-TE] Sale Order ' + orderId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

/**
 * Le dados do parceiro
 */
async function getPartner(partnerId) {
  var client = getClient();
  await ensureAuth(client);
  var partners = await client.execute('res.partner', 'read', [[partnerId]], { fields: PARTNER_FIELDS });
  return partners ? partners[0] : null;
}

/**
 * Posta mensagem no chatter de um registro (mail.thread)
 */
async function postChatter(model, recordId, body) {
  var client = getClient();
  await ensureAuth(client);
  try {
    await client.execute(model, 'message_post', [[recordId], Object.assign({}, {
      body: body,
      message_type: 'notification',
      subtype_xmlid: 'mail.mt_note',
    })]);
    logger.info('[ODOO-TE] Chatter postado em ' + model + ' ' + recordId);
  } catch (err) {
    logger.error('[ODOO-TE] Falha ao postar chatter em ' + model + ' ' + recordId + ': ' + err.message);
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
  FIELDS: FIELDS,
};