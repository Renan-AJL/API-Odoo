// ============================================
// SERVICO DE CHECKOUT CARTAO - REDE ITAU (OAuth 2.0)
// ============================================
// Rede Itau exige OAuth 2.0:
//   1. POST /redelabs/oauth2/token (Basic Auth PV:Chave -> Bearer token)
//   2. POST /erede/v2/transactions (Bearer token)
// Referencia: documentacao Rede Itau for Developers

var axios = require('axios');
var config = require('../config');
var logger = require('../utils/logger');

// Store de pedidos de checkout pendentes (em memoria)
var pendingOrders = new Map();

// Cache de token OAuth Rede
var tokenCache = {
  accessToken: null,
  expiresAt: null,
};

/**
 * Obtem token OAuth 2.0 da Rede Itau
 * POST /redelabs/oauth2/token
 * Header: Authorization: Basic base64(PV:Chave)
 * Body: grant_type=client_credentials
 */
async function getRedeToken() {
  var now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt && now < tokenCache.expiresAt - 30000) {
    return tokenCache.accessToken;
  }

  var pv = config.rede.pv;
  var chave = config.rede.chaveIntegracao;
  var basicAuth = Buffer.from(pv + ':' + chave).toString('base64');

  var tokenUrl = config.redeBaseUrl + '/redelabs/oauth2/token';
  logger.info('[REDE-OAUTH] Obtendo token... URL: ' + tokenUrl + ' | PV: ' + pv.substring(0, 4) + '***');

  try {
    var params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');

    var response = await axios.post(tokenUrl, params, {
      headers: {
        'Authorization': 'Basic ' + basicAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });

    var data = response.data;
    if (!data.access_token) {
      throw new Error('Token nao retornado pela Rede: ' + JSON.stringify(data));
    }

    tokenCache.accessToken = data.access_token;
    tokenCache.expiresAt = now + (data.expires_in * 1000);

    logger.info('[REDE-OAUTH] Token obtido com sucesso (expira em ' + data.expires_in + 's)');
    return data.access_token;
  } catch (error) {
    var status = error.response ? error.response.status : 0;
    var errBody = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[REDE-OAUTH] Falha ao obter token: ' + status + ' - ' + errBody);
    throw new Error('Autenticacao Rede falhou (OAuth): ' + status + ' - ' + errBody);
  }
}

/**
 * Cria um pedido de checkout e retorna o link para a pagina de pagamento
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
  for (var entry of pendingOrders) {
    if (new Date(entry[1].criado_em).getTime() < cutoff) pendingOrders.delete(entry[0]);
  }

  var host = dadosLink.host || '';
  var checkoutUrl = host + '/api/v1/itau/checkout/' + orderId;

  logger.info('Checkout criado: ' + orderId + ' -> ' + checkoutUrl);
  return { id: orderId, link: checkoutUrl, raw: { orderId: orderId, checkoutUrl: checkoutUrl } };
}

/**
 * Processa o pagamento do cartao via API Rede Itau (OAuth 2.0)
 * 1. Obtem Bearer token via OAuth
 * 2. Envia transacao com Bearer token
 */
async function processarPagamento(orderId, cartaoData) {
  var order = pendingOrders.get(orderId);
  if (!order) throw { status: 404, message: 'Pedido nao encontrado ou expirado' };
  if (order.status !== 'pendente') throw { status: 400, message: 'Pedido ja foi processado' };

  var pv = config.rede.pv;
  var chave = config.rede.chaveIntegracao;

  // Payload da transacao
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

  var apiUrl = config.redeBaseUrl + '/erede/v2/transactions';
  logger.info('[REDE-PAG] Processando: ' + orderId + ' R$' + order.valor + ' ' + payload.installments + 'x');
  logger.info('[REDE-PAG] Endpoint: ' + apiUrl);
  logger.info('[REDE-PAG] PV: ' + pv.substring(0, 4) + '***' + pv.substring(pv.length - 3) + ' | Chave: ' + (chave ? chave.substring(0, 4) + '***' + chave.substring(chave.length - 3) : 'VAZIA'));
  logger.info('[REDE-PAG] Ambiente: ' + (process.env.REDE_AMBIENTE || 'producao (default)'));

  try {
    // PASSO 1: Obter token OAuth
    var token = await getRedeToken();

    // PASSO 2: Enviar transacao com Bearer token
    var response = await axios.post(apiUrl, payload, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    var result = response.data;
    var autorizado = result.returnCode === '00' || result.returnCode === '174';
    order.status = autorizado ? 'pago' : 'negado';
    order.resultado = result;
    pendingOrders.set(orderId, order);

    logger.info('[REDE-PAG] Resultado: ' + result.returnCode + ' - ' + result.returnMessage);

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

    // Se token expirou ou invalido, limpa cache e tenta uma vez
    if (status === 401 && tokenCache.accessToken) {
      logger.warn('[REDE-PAG] 401 recebido, limpando cache de token e tentando novamente...');
      tokenCache.accessToken = null;
      tokenCache.expiresAt = null;
      try {
        var token2 = await getRedeToken();
        var retry = await axios.post(apiUrl, payload, {
          headers: {
            'Authorization': 'Bearer ' + token2,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        });
        var result2 = retry.data;
        var ok = result2.returnCode === '00' || result2.returnCode === '174';
        order.status = ok ? 'pago' : 'negado';
        order.resultado = result2;
        pendingOrders.set(orderId, order);
        logger.info('[REDE-PAG] Retry OK: ' + result2.returnCode + ' - ' + result2.returnMessage);
        return {
          autorizado: ok,
          returnCode: result2.returnCode,
          returnMessage: result2.returnMessage,
          tid: result2.tid,
          nsu: result2.nsu,
          authorizationCode: result2.authorizationCode,
          brand: result2.brand ? result2.brand.name : '',
        };
      } catch (retryErr) {
        var rs = retryErr.response ? retryErr.response.status : 502;
        var rd = retryErr.response ? retryErr.response.data : {};
        var rb = typeof rd === 'string' ? rd : JSON.stringify(rd);
        logger.error('[REDE-PAG] Retry tambem falhou: ' + rs + ' - ' + rb);
        throw { status: rs, message: (rd.message || rd.mensagem || rd.returnMessage) || 'Erro ao processar pagamento', detail: rd };
      }
    }

    logger.error('[REDE-PAG] Falha: ' + status + ' - ' + errBody);
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