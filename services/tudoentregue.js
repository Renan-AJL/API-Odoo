/**
 * services/tudoentregue.js - TudoEntregue API Client
 * CRUD de entregas via /api/Entregas/*
 * Headers: AppKey + RequesterKey
 */
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { retry } = require('../utils/retry');

var SITUATION = {
  PENDENTE: 1,
  COLETADO: 2,
  EM_TRANSITO: 3,
  ENTREGUE: 4,
  CANCELADO: 5,
  PARCIALMENTE_ENTREGUE: 6,
  DEVOLVIDO: 7,
  PROBLEMA_NA_ENTREGA: 8,
  AGENDADO: 9,
};

var SITUATION_LABELS = {};
SITUATION_LABELS[SITUATION.PENDENTE] = 'Pendente';
SITUATION_LABELS[SITUATION.COLETADO] = 'Coletado';
SITUATION_LABELS[SITUATION.EM_TRANSITO] = 'Em Transito';
SITUATION_LABELS[SITUATION.ENTREGUE] = 'Entregue';
SITUATION_LABELS[SITUATION.CANCELADO] = 'Cancelado';
SITUATION_LABELS[SITUATION.PARCIALMENTE_ENTREGUE] = 'Parcialmente Entregue';
SITUATION_LABELS[SITUATION.DEVOLVIDO] = 'Devolvido';
SITUATION_LABELS[SITUATION.PROBLEMA_NA_ENTREGA] = 'Problema na Entrega';
SITUATION_LABELS[SITUATION.AGENDADO] = 'Agendado';

var SITUATION_TO_ODOO_STATE = {};
SITUATION_TO_ODOO_STATE[SITUATION.PENDENTE] = 'assigned';
SITUATION_TO_ODOO_STATE[SITUATION.COLETADO] = 'confirmed';
SITUATION_TO_ODOO_STATE[SITUATION.EM_TRANSITO] = 'in_transit';
SITUATION_TO_ODOO_STATE[SITUATION.ENTREGUE] = 'done';
SITUATION_TO_ODOO_STATE[SITUATION.CANCELADO] = 'cancel';
SITUATION_TO_ODOO_STATE[SITUATION.PARCIALMENTE_ENTREGUE] = 'partial';
SITUATION_TO_ODOO_STATE[SITUATION.DEVOLVIDO] = 'returned';
SITUATION_TO_ODOO_STATE[SITUATION.PROBLEMA_NA_ENTREGA] = 'problem';
SITUATION_TO_ODOO_STATE[SITUATION.AGENDADO] = 'scheduled';

var ORDER_TYPES = {
  VENDA: 'VENDA',
  COMPRA: 'COMPRA',
  TRANSFERENCIA: 'TRANSFERENCIA',
};

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'AppKey': config.tudoentregue.appKey,
    'RequesterKey': config.tudoentregue.requesterKey,
  };
}

async function createDeliveries(deliveries) {
  logger.info('[TE] Criando ' + deliveries.length + ' entrega(s)');
  var resp = await retry(function() {
    return axios.post(config.tudoentregue.baseUrl + '/api/Entregas', deliveries, {
      headers: getHeaders(),
      timeout: 30000,
    });
  }, { label: 'TE createDeliveries', maxRetries: 2 });
  logger.info('[TE] Resposta create: ' + resp.status);
  return resp.data;
}

async function editDeliveries(deliveries) {
  logger.info('[TE] Editando ' + deliveries.length + ' entrega(s)');
  var resp = await retry(function() {
    return axios.put(config.tudoentregue.baseUrl + '/api/Entregas', deliveries, {
      headers: getHeaders(),
      timeout: 30000,
    });
  }, { label: 'TE editDeliveries', maxRetries: 2 });
  logger.info('[TE] Resposta edit: ' + resp.status);
  return resp.data;
}

async function cancelDeliveries(deliveries) {
  logger.info('[TE] Cancelando ' + deliveries.length + ' entrega(s)');
  var resp = await retry(function() {
    return axios.put(config.tudoentregue.baseUrl + '/api/Entregas/CancelarEntregas', deliveries, {
      headers: getHeaders(),
      timeout: 30000,
    });
  }, { label: 'TE cancelDeliveries', maxRetries: 2 });
  logger.info('[TE] Resposta cancel: ' + resp.status);
  return resp.data;
}

async function getDeliveries(filter) {
  var params = {};
  if (filter) {
    Object.keys(filter).forEach(function(k) { params[k] = filter[k]; });
  }
  var resp = await retry(function() {
    return axios.get(config.tudoentregue.baseUrl + '/api/Entregas', {
      headers: getHeaders(),
      params: params,
      timeout: 30000,
    });
  }, { label: 'TE getDeliveries', maxRetries: 2 });
  return resp.data;
}

async function fetchAllPages(filter) {
  var all = [];
  var page = 1;
  var pageSize = config.tudoentregue.pageSize || 50;
  var emptyCount = 0;
  var maxEmpty = config.tudoentregue.maxEmptyPages || 3;

  while (true) {
    var params = Object.assign({}, filter || {}, { pagina: page, tamanhoPagina: pageSize });
    var data = await getDeliveries(params);
    var items = Array.isArray(data) ? data : (data.data || data.entregas || []);
    if (!items.length) {
      emptyCount++;
      if (emptyCount >= maxEmpty) break;
    } else {
      emptyCount = 0;
      all = all.concat(items);
    }
    if (items.length < pageSize) break;
    page++;
    if (config.tudoentregue.pageIntervalMs) {
      await new Promise(function(r) { setTimeout(r, config.tudoentregue.pageIntervalMs); });
    }
  }
  return all;
}

async function getSituations() {
  var resp = await retry(function() {
    return axios.get(config.tudoentregue.baseUrl + '/api/Situacoes', {
      headers: getHeaders(),
      timeout: 15000,
    });
  }, { label: 'TE getSituations', maxRetries: 1 });
  return resp.data;
}

module.exports = {
  createDeliveries: createDeliveries,
  editDeliveries: editDeliveries,
  cancelDeliveries: cancelDeliveries,
  getDeliveries: getDeliveries,
  fetchAllPages: fetchAllPages,
  getSituations: getSituations,
  SITUATION: SITUATION,
  SITUATION_LABELS: SITUATION_LABELS,
  SITUATION_TO_ODOO_STATE: SITUATION_TO_ODOO_STATE,
  ORDER_TYPES: ORDER_TYPES,
};