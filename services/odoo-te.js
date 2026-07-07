/**
 * services/odoo-te.js - Odoo XML-RPC client para TudoEntregue
 * Usa XML-RPC (igual odoo-push.js) pois JSON-RPC nao funciona no Odoo SaaS
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');
var logger = require('../utils/logger');

// Apenas campos nativos do Odoo - campos x_studio_* serao lidos sob demanda
// pois podem nao existir se o usuario ainda nao os criou no Studio
var PARTNER_FIELDS = [
  'id', 'name', 'city', 'state_id', 'zip', 'phone', 'email', 'cnpj_cpf', 'vat',
  'street', 'street2', 'number', 'district', 'country_id', 'l10n_br_city_id',
];

// Campos x_studio para partner (endereco de entrega alternativo)
// Serao lidos separadamente com safeReadCustom
var PARTNER_CUSTOM_FIELDS = [
  'x_studio_te_codigo', 'x_studio_te_razao_social',
  'x_studio_te_cnpj_cpf', 'x_studio_te_inscricao_estadual',
  'x_studio_te_telefone', 'x_studio_te_email', 'x_studio_te_logradouro',
  'x_studio_te_numero', 'x_studio_te_complemento', 'x_studio_te_bairro',
  'x_studio_te_municipio', 'x_studio_te_uf', 'x_studio_te_cep',
  'x_studio_te_latitude', 'x_studio_te_longitude',
];

var SALE_ORDER_FIELDS = [
  'id', 'name', 'partner_id', 'state',
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

// Mapeamento de campos customizados por modelo
var CUSTOM_FIELDS = {
  'res.partner': PARTNER_CUSTOM_FIELDS,
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
var _syncFieldChecked = { 'stock.picking': false, 'sale.order': false };

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

async function updatePickingTeData(pickingId, data) {
  await safeWriteCustom('stock.picking', [pickingId], data);
  logger.info('[ODOO-TE] Picking ' + pickingId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function updateSaleOrderTeData(orderId, data) {
  await safeWriteCustom('sale.order', [orderId], data);
  logger.info('[ODOO-TE] Sale Order ' + orderId + ' atualizado: ' + JSON.stringify(Object.keys(data)));
}

async function getPartner(partnerId) {
  var partners = await safeReadCustom('res.partner', [partnerId], PARTNER_FIELDS, PARTNER_CUSTOM_FIELDS);
  return partners ? partners[0] : null;
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
  // Expose para testes/diagnostico
  PICKING_FIELDS: PICKING_FIELDS,
  PICKING_CUSTOM_FIELDS: PICKING_CUSTOM_FIELDS,
};