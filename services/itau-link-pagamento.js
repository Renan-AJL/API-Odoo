// ============================================
// SERVICO DE CHECKOUT CARTAO - REDE E.REDE W3.0
// ============================================
// e.Rede W3.0 usa Basic Auth (PV:Chave) direto
// nas requisicoes, NAO precisa de OAuth/token.
// Referencia: documentacao e.Rede W3.0

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Store de pedidos de checkout pendentes (em memoria)
const pendingOrders = new Map();

/**
 * Cria um pedido de checkout e retorna o link para a pagina de pagamento
 * A pagina de checkout fica hospedada no proprio servidor
 */
async function criarLinkPagamento(dadosLink) {
  logger.info('Criando checkout de cartao...');

  var orderId = dadosLink.seu_numero || ('ORD-' + Date.now());
  var valor = dadosLink.valor || 0;
  var descricao = dadosLink.descricao || 'Pagamento';
  var parcelas = dadosLink.parcelas || 12;

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
 * Processa o pagamento do cartao via API e.Rede W3.0
 * Autenticacao: Basic Auth (PV:ChaveIntegracao) direto na requisicao
 * Endpoint: POST /erede/v2/transactions
 */
async function processarPagamento(orderId, cartaoData) {
  var order = pendingOrders.get(orderId);
  if (!order) throw { status: 404, message: 'Pedido nao encontrado ou expirado' };
  if (order.status !== 'pendente') throw { status: 400, message: 'Pedido ja foi processado' };

  var pv = config.rede.pv;
  var chave = config.rede.chaveIntegracao;

  // e.Rede W3.0 payload
  var payload = {
    capture: true,
    merchantOrderId: orderId,
    amount: Math.round(order.valor * 100), // centavos
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

  var apiUrl = config.redeBaseUrl + '/erede/v2/transactions';
  logger.info('Processando pagamento e.Rede W3.0: ' + orderId + ' R$' + order.valor + ' ' + payload.installments + 'x');
  logger.info('Endpoint: ' + apiUrl + ' | PV: ' + pv.substring(0, 4) + '***');

  try {
    var response = await axios.post(apiUrl, payload, {
      auth: {
        username: pv,
        password: chave,
      },
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

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
    var errBody = typeof errData === 'string' ? errData : JSON.stringify(errData);
    logger.error('Falha pagamento e.Rede: ' + status + ' - ' + errBody);
    throw {
      status: status,
      message: (errData.message || errData.mensagem || errData.returnMessage) || 'Erro ao processar pagamento',
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
  criarLinkPagamento,
  processarPagamento,
  consultarPedido,
  pendingOrders,
};