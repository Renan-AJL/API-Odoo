// ============================================
// SERVICO DE CHECKOUT CARTAO - REDE ITAU (OAuth 2.0)
// ============================================
// Conforme documentacao oficial e.Rede (atualizada 18/06/2026)
// OAuth 2.0: POST /redelabs/oauth2/token -> Bearer token
// Transacao: POST /erede/v2/transactions (Bearer token + payload flat)

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
 * Obtem token OAuth 2.0 da Rede
 * POST /redelabs/oauth2/token (producao)
 * POST /oauth2/token (sandbox)
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

  // URLs conforme doc oficial
  var isSandbox = (process.env.REDE_AMBIENTE || '') === 'sandbox';
  var tokenUrl = isSandbox
    ? config.redeBaseUrl + '/oauth2/token'
    : config.redeBaseUrl + '/redelabs/oauth2/token';

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
      throw new Error('Token nao retornado: ' + JSON.stringify(data));
    }

    tokenCache.accessToken = data.access_token;
    tokenCache.expiresAt = now + (data.expires_in * 1000);

    logger.info('[REDE-OAUTH] Token OK (expira em ' + data.expires_in + 's)');
    return data.access_token;
  } catch (error) {
    var status = error.response ? error.response.status : 0;
    var errBody = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[REDE-OAUTH] Falha: ' + status + ' - ' + errBody);
    throw new Error('Autenticacao Rede falhou (OAuth): ' + status);
  }
}

/**
 * Cria um pedido de checkout e retorna o link para a pagina de pagamento
 */
async function criarLinkPagamento(dadosLink) {
  logger.info('Criando checkout de cartao...');

  var orderId = dadosLink.seu_numero || ('ORD-' + Date.now());
  // Sanitiza orderId para URL e Rede reference (sem espacos)
  orderId = String(orderId).replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 50);
  if (!orderId) orderId = 'ORD' + Date.now();
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
 * Processa pagamento via e.Rede (OAuth 2.0)
 * Payload FLAT conforme documentacao oficial (sem objeto "card" aninhado)
 *
 * Campos obrigatorios: reference, amount, cardNumber, expirationMonth, expirationYear
 * Campos opcionais: capture, kind, installments, softDescriptor, cardholderName, securityCode
 */
async function processarPagamento(orderId, cartaoData) {
  var order = pendingOrders.get(orderId);
  if (!order) throw { status: 404, message: 'Pedido nao encontrado ou expirado' };
  if (order.status !== 'pendente') throw { status: 400, message: 'Pedido ja foi processado' };

  var pv = config.rede.pv;
  var chave = config.rede.chaveIntegracao;

  // Sanitiza reference: remove espacos e chars especiais (Rede aceita apenas alfanumericos)
  var safeReference = String(orderId).replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 50);
  if (!safeReference) safeReference = 'ORD' + Date.now();

  // Payload FLAT conforme doc oficial e.Rede
  // https://developer.userrede.com.br/erede/v2/transactions
  var payload = {
    // Obrigatorios
    reference: safeReference,                              // ate 50 chars - alfanumerico sem espacos
    amount: Math.round(order.valor * 100),                // centavos, sem separador
    cardNumber: cartaoData.numero.replace(/\D/g, ''),      // ate 19 chars
    expirationMonth: parseInt(cartaoData.validade_mes, 10), // 1-12
    expirationYear: cartaoData.validade_ano,                // 2 ou 4 digitos (ex: 28 ou 2028)

    // Opcionais
    capture: true,
    kind: 'credit',                                        // credit ou debit
    installments: parseInt(cartaoData.parcelas) || 1,
    // softDescriptor REMOVIDO: merchant nao tem essa funcionalidade habilitada na Rede
    cardholderName: (cartaoData.titular || '').toUpperCase(),
    securityCode: cartaoData.cvv || '',
  };

  // URLs conforme doc oficial
  var isSandbox = (process.env.REDE_AMBIENTE || '') === 'sandbox';
  var apiUrl = isSandbox
    ? config.redeBaseUrl.replace('/api.', 'https://sandbox-erede.useredecloud.com.br').replace('https://sandbox.userede.com.br', 'https://sandbox-erede.useredecloud.com.br') + '/v2/transactions'
    : config.redeBaseUrl + '/erede/v2/transactions';

  // Fallback: se a URL do sandbox ficou estranha, usa a doc direto
  if (isSandbox) {
    apiUrl = 'https://sandbox-erede.useredecloud.com.br/v2/transactions';
  }

  logger.info('[REDE-PAG] Transacao: ' + orderId + ' R$' + order.valor + ' ' + payload.installments + 'x');
  logger.info('[REDE-PAG] URL: ' + apiUrl);
  logger.info('[REDE-PAG] PV: ' + pv.substring(0, 4) + '*** | Chave: ' + (chave ? chave.substring(0, 4) + '***' : 'VAZIA'));
  logger.info('[REDE-PAG] Ambiente: ' + (isSandbox ? 'SANDBOX' : 'PRODUCAO'));
  logger.info('[REDE-PAG] Payload: ' + JSON.stringify({
    reference: payload.reference,
    amount: payload.amount,
    kind: payload.kind,
    installments: payload.installments,
    cardNumber: payload.cardNumber.substring(0, 6) + '******' + payload.cardNumber.substring(payload.cardNumber.length - 4),
    expirationMonth: payload.expirationMonth,
    expirationYear: payload.expirationYear,
    cardholderName: payload.cardholderName,
  }));

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

    logger.info('[REDE-PAG] Resultado: ' + result.returnCode + ' - ' + result.returnMessage +
      (result.tid ? ' | TID: ' + result.tid : '') +
      (result.nsu ? ' | NSU: ' + result.nsu : ''));

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

    // Se 401, limpa cache e tenta uma vez com token novo
    if (status === 401 && tokenCache.accessToken) {
      logger.warn('[REDE-PAG] 401 - limpando cache de token e tentando novamente...');
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
        logger.error('[REDE-PAG] Retry falhou: ' + rs + ' - ' + rb);
        throw { status: rs, message: (rd.returnMessage || rd.message || 'Erro ao processar pagamento'), detail: rd };
      }
    }

    logger.error('[REDE-PAG] Falha: ' + status + ' - ' + errBody);
    throw {
      status: status,
      message: (errData.returnMessage || errData.message || 'Erro ao processar pagamento'),
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