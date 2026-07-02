// ============================================
// SERVICO DE CHECKOUT CARTAO - REDE E.REede
// ============================================
// Cria checkout hospedado para cartao
// API e.Rede W3.0: /redelabs/oauth2/token + /erede/v2/transactions

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Cache do token OAuth2
let tokenCache = { accessToken: null, expiresAt: null, isLoading: false };

// Store de pedidos de checkout pendentes (em memoria)
const pendingOrders = new Map();

/**
 * Obtem token OAuth2 da Rede e.Rede
 * Endpoint correto: /redelabs/oauth2/token
 */
async function getRedeToken() {
  var now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt && now < tokenCache.expiresAt - 30000) {
    return tokenCache.accessToken;
  }
  if (tokenCache.isLoading) {
    await new Promise(function(resolve) { setTimeout(resolve, 500); });
    return getRedeToken();
  }
  tokenCache.isLoading = true;

  try {
    var pv = config.linkPagamento.pv;
    var chave = config.linkPagamento.clientSecret;
    if (!pv || !chave) throw new Error('REDE_PV e REDE_CHAVE_INTEGRACAO nao configurados');

    logger.info('Obtendo token e.Rede (' + config.linkPagamento.tokenUrl + ')...');

    var params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');

    var response = await axios.post(config.linkPagamento.tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: pv, password: chave },
      timeout: 30000,
    });

    var data = response.data;
    if (!data.access_token) throw new Error('Token nao retornado');

    tokenCache.accessToken = data.access_token;
    tokenCache.expiresAt = now + (data.expires_in * 1000);
    tokenCache.isLoading = false;

    logger.info('Token e.Rede OK, expira em ' + data.expires_in + 's');
    return data.access_token;
  } catch (error) {
    tokenCache.isLoading = false;
    tokenCache.accessToken = null;
    var msg = error.response
      ? 'Erro ' + error.response.status + ': ' + JSON.stringify(error.response.data)
      : error.message;
    logger.error('Falha token e.Rede: ' + msg);
    throw new Error('Autenticacao Rede falhou: ' + msg);
  }
}

/**
 * Cria um pedido de checkout e retorna o link para a pagina de pagamento
 * A pagina de checkout fica hospedada no proprio servidor
 */
async function criarLinkPagamento(dadosLink) {
  logger.info('Criando checkout de cartao...');

  var orderId = dadosLink.seu_numero || ('ORD-' + Date.now());
  var valor = dadosLink.valor || 0;
  var descricao = dadosLink.descricao || 'Pagamento';
  var parcelas = dadosLink.parcelas || 12; // maximo de parcelas permitido

  if (valor <= 0) throw { status: 400, message: 'Valor invalido' };
  if (!config.rede.pv || !config.rede.chaveIntegracao) {
    throw { status: 500, message: 'Rede nao configurada. Defina REDE_PV e REDE_CHAVE_INTEGRACAO.' };
  }

  // Armazena o pedido pendente
  var orderData = {
    id: orderId,
    valor: valor,
    descricao: descricao,
    maxParcelas: parcelas,
    nome_pagador: dadosLink.nome_pagador || '',
    cpf_cnpj_pagador: dadosLink.cpf_cnpj_pagador || '',
    fatura_name: dadosLink.seu_numero || '',
    criado_em: new Date().toISOString(),
    status: 'pendente',
  };
  pendingOrders.set(orderId, orderData);

  // Limpa pedidos antigos (mais de 24h)
  var cutoff = Date.now() - 86400000;
  for (var [key, val] of pendingOrders) {
    if (new Date(val.criado_em).getTime() < cutoff) pendingOrders.delete(key);
  }

  // O link e a URL da propria pagina de checkout hospedada
  var host = dadosLink.host || '';
  var checkoutUrl = host + '/api/v1/itau/checkout/' + orderId;

  logger.info('Checkout criado: ' + orderId + ' -> ' + checkoutUrl);
  return { id: orderId, link: checkoutUrl, raw: { orderId: orderId, checkoutUrl: checkoutUrl } };
}

/**
 * Processa o pagamento do cartao via API e.Rede
 * Chamado quando o cliente submete o formulario de checkout
 */
async function processarPagamento(orderId, cartaoData) {
  var order = pendingOrders.get(orderId);
  if (!order) throw { status: 404, message: 'Pedido nao encontrado ou expirado' };
  if (order.status !== 'pendente') throw { status: 400, message: 'Pedido ja foi processado' };

  var token = await getRedeToken();
  var pv = config.linkPagamento.pv;

  var payload = {
    capture: true,
    merchantOrderId: orderId,
    amount: Math.round(order.valor * 100),
    currency: 'BRL',
    installments: parseInt(cartaoData.parcelas) || 1,
    softDescriptor: (config.rede.softDescriptor || 'LOJA').substring(0, 13),
    card: {
      cardNumber: cartaoData.numero.replace(/\D/g, ''),
      holder: cartaoData.titular,
      expirationDate: (cartaoData.validade_mes || '') + '/' + (cartaoData.validade_ano || ''),
      securityCode: cartaoData.cvv,
    },
  };

  logger.info('Processando pagamento: ' + orderId + ' R$' + order.valor + ' ' + payload.installments + 'x');

  try {
    var response = await axios.post(
      config.linkPagamento.apiUrl + '/transactions',
      payload,
      {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    var result = response.data;
    var autorizado = result.returnCode === '00' || result.returnCode === '174';
    order.status = autorizado ? 'pago' : 'negado';
    order.resultado = result;
    pendingOrders.set(orderId, order);

    logger.info('Pagamento ' + orderId + ': ' + result.returnCode + ' - ' + result.returnMessage);

    return {
      autorizado: autorizado,
      returnCode: result.returnCode,
      returnMessage: result.returnMessage,
      tid: result.tid,
      nsu: result.nsu,
      authorizationCode: result.authorizationCode,
      brand: result.brand ? result.brand.name : '',
    };
  } catch (error) {
    var status = error.response ? error.response.status : 502;
    var errData = error.response ? error.response.data : {};
    logger.error('Falha pagamento: ' + status + ' - ' + JSON.stringify(errData));
    throw {
      status: status,
      message: (errData.message || errData.mensagem) || 'Erro ao processar pagamento',
      detail: errData,
    };
  }
}

/**
 * Consulta pedido de checkout
 */
function consultarPedido(orderId) {
  return pendingOrders.get(orderId) || null;
}

module.exports = {
  getRedeToken,
  criarLinkPagamento,
  processarPagamento,
  consultarPedido,
  pendingOrders,
};