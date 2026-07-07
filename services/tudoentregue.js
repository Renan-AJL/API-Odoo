/**
 * services/tudoentregue.js - TudoEntregue API Client v2
 * Baseado na spec oficial Swagger v1.0.20
 * Host: api.tudoentregue.com.br  basePath: /v1
 * Auth: headers AppKey + RequesterKey
 *
 * Endpoints:
 *   POST   /v1/orders              - Inclusao/Edicao de Entrega
 *   POST   /v1/orders/delete      - Exclusao
 *   PUT    /v1/orders/cancel      - Cancelamento
 *   GET    /v1/orders/situation   - Consulta situacao
 *   GET    /v1/orders/finish      - Consulta com ocorrencias
 *   GET    /v1/tracking           - Acompanhamento
 *   POST   /v1/occurrences        - Criar/editar tipo ocorrencia
 *   GET    /v1/occurrences        - Listar ocorrencias
 */
var axios = require('axios');
var config = require('../config');
var logger = require('../utils/logger');
var retry = require('../utils/retry').retry;

// --- Situacoes da Entrega (conforme doc) ---
var SITUATION = {
  RECEBIDA_TORRE: 0,
  ENVIADA_MOTORISTA: 1,
  AGUARDANDO_CONFIRMACAO: 2,       // descontinuado
  RECEBIDA_MOTORISTA: 3,
  RECUSADA_MOTORISTA: 4,           // descontinuado
  FINALIZADA_MOTORISTA: 5,
  FINALIZADA_TORRE: 6,
  OPERACAO_FINALIZADA: 7,          // descontinuado
  CANCELADA: 8,
  NOTIFICACAO_CANCELAMENTO: 9,
  TRANSFERIDA: 11,
};

var SITUATION_LABELS = {};
SITUATION_LABELS[0] = 'Recebida pela Torre de Controle';
SITUATION_LABELS[1] = 'Enviada ao Motorista';
SITUATION_LABELS[2] = 'Aguardando Confirmacao';
SITUATION_LABELS[3] = 'Recebida pelo Motorista';
SITUATION_LABELS[4] = 'Recusada pelo Motorista';
SITUATION_LABELS[5] = 'Finalizada pelo Motorista';
SITUATION_LABELS[6] = 'Finalizada pela Torre de Controle';
SITUATION_LABELS[7] = 'Operacao Finalizada';
SITUATION_LABELS[8] = 'Operacao Cancelada';
SITUATION_LABELS[9] = 'Notificacao de Cancelamento Enviada';
SITUATION_LABELS[11] = 'Transferida';

var ORDER_TYPE = {
  ENTREGA: 1,
  COLETA: 2,
};

function getBaseUrl() {
  return config.tudoentregue.baseUrl.replace(/\/+$/, '') + '/v1';
}

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'AppKey': config.tudoentregue.appKey,
    'RequesterKey': config.tudoentregue.requesterKey,
  };
}

/**
 * POST /v1/orders - Inclusao/Edicao de Entrega
 * Body: array de OrderViewModel
 * Returns: array de OrderInsertUpdateReturn
 */
function createOrders(orders) {
  logger.info('[TE] Criando ' + orders.length + ' entrega(s) via /v1/orders');
  return retry(function() {
    return axios.post(getBaseUrl() + '/orders', orders, {
      headers: getHeaders(),
      timeout: 30000,
    });
  }, { label: 'TE createOrders', maxRetries: 2 }).then(function(resp) {
    logger.info('[TE] createOrders status: ' + resp.status);
    return resp.data;
  });
}

/**
 * POST /v1/orders - Edicao (mesmo endpoint, mesma estrutura)
 */
function editOrders(orders) {
  logger.info('[TE] Editando ' + orders.length + ' entrega(s) via /v1/orders');
  return retry(function() {
    return axios.post(getBaseUrl() + '/orders', orders, {
      headers: getHeaders(),
      timeout: 30000,
    });
  }, { label: 'TE editOrders', maxRetries: 2 }).then(function(resp) {
    logger.info('[TE] editOrders status: ' + resp.status);
    return resp.data;
  });
}

/**
 * PUT /v1/orders/cancel - Cancelamento
 */
function cancelOrders(orders) {
  logger.info('[TE] Cancelando ' + orders.length + ' entrega(s)');
  return retry(function() {
    return axios.put(getBaseUrl() + '/orders/cancel', orders, {
      headers: getHeaders(),
      timeout: 30000,
    });
  }, { label: 'TE cancelOrders', maxRetries: 2 }).then(function(resp) {
    return resp.data;
  });
}

/**
 * POST /v1/orders/delete - Exclusao permanente
 */
function deleteOrders(orders) {
  logger.info('[TE] Excluindo ' + orders.length + ' entrega(s)');
  return retry(function() {
    return axios.post(getBaseUrl() + '/orders/delete', orders, {
      headers: getHeaders(),
      timeout: 30000,
    });
  }, { label: 'TE deleteOrders', maxRetries: 2 }).then(function(resp) {
    return resp.data;
  });
}

/**
 * GET /v1/orders/situation - Consulta situacao
 * Query: phoneCountry, phoneNumber, orderType, orderID
 */
function getSituation(params) {
  return retry(function() {
    return axios.get(getBaseUrl() + '/orders/situation', {
      headers: getHeaders(),
      params: params,
      timeout: 15000,
    });
  }, { label: 'TE getSituation', maxRetries: 1 }).then(function(resp) {
    return resp.data;
  });
}

/**
 * GET /v1/orders/finish - Consulta entregas com ocorrencia
 * Query: phoneCountry, phoneNumber, orderType, orderID, partial
 */
function getFinished(params) {
  return retry(function() {
    return axios.get(getBaseUrl() + '/orders/finish', {
      headers: getHeaders(),
      params: params,
      timeout: 15000,
    });
  }, { label: 'TE getFinished', maxRetries: 1 }).then(function(resp) {
    return resp.data;
  });
}

/**
 * GET /v1/tracking?trackingCode=XXX - Acompanhamento
 */
function getTracking(trackingCode) {
  return retry(function() {
    return axios.get(getBaseUrl() + '/tracking', {
      headers: getHeaders(),
      params: { trackingCode: trackingCode },
      timeout: 15000,
    });
  }, { label: 'TE getTracking', maxRetries: 1 }).then(function(resp) {
    return resp.data;
  });
}

/**
 * GET /v1/occurrences - Listar tipos de ocorrencia
 */
function getOccurrences() {
  return retry(function() {
    return axios.get(getBaseUrl() + '/occurrences', {
      headers: getHeaders(),
      timeout: 15000,
    });
  }, { label: 'TE getOccurrences', maxRetries: 1 }).then(function(resp) {
    return resp.data;
  });
}

module.exports = {
  createOrders: createOrders,
  editOrders: editOrders,
  cancelOrders: cancelOrders,
  deleteOrders: deleteOrders,
  getSituation: getSituation,
  getFinished: getFinished,
  getTracking: getTracking,
  getOccurrences: getOccurrences,
  SITUATION: SITUATION,
  SITUATION_LABELS: SITUATION_LABELS,
  ORDER_TYPE: ORDER_TYPE,
};