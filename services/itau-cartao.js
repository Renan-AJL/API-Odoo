// ============================================
// SERVICO DE INTEGRACAO API CARTAO (REDE ITAU)
// ============================================
// e.Rede - Pagamentos com cartao de credito/debito
// Portal: https://developer.usererede.com.br

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Cache de token da Rede
let redeTokenCache = {
  accessToken: null,
  expiresAt: null,
};

/**
 * Obtem token de acesso da Rede Itau
 */
async function getRedeToken() {
  const now = Date.now();

  if (redeTokenCache.accessToken && redeTokenCache.expiresAt && now < redeTokenCache.expiresAt - 30000) {
    return redeTokenCache.accessToken;
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');

    const response = await axios.post(`${config.redeBaseUrl}/oauth/token`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(
          `${config.rede.clientId}:${config.rede.clientSecret}`
        ).toString('base64'),
      },
      timeout: 30000,
    });

    redeTokenCache.accessToken = response.data.access_token;
    redeTokenCache.expiresAt = now + (response.data.expires_in * 1000);

    logger.info('Token Rede obtido com sucesso');
    return response.data.access_token;

  } catch (error) {
    logger.error('Falha ao obter token Rede: ' + error.message);
    throw new Error('Autenticacao Rede falhou: ' + error.message);
  }
}

/**
 * Obtem headers autenticados para a Rede
 */
async function getRedeHeaders() {
  const token = await getRedeToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Realiza uma transacao de cartao (credito ou debito)
 * @param {Object} cartaoData - Dados do pagamento
 * @returns {Promise<Object>} Resultado da transacao
 */
async function autorizarPagamento(cartaoData) {
  logger.info(`Autorizando pagamento cartao (${cartaoData.tipo || 'credito'})...`);

  const headers = await getRedeHeaders();

  const payload = {
    merchantId: config.rede.merchantId,
    merchantOrderId: cartaoData.order_id || String(Date.now()),
    amount: Math.round(cartaoData.valor * 100), // Valor em centavos
    softDescriptor: config.rede.softDescriptor,
    currency: 'BRL',
    installments: cartaoData.parcelas || 1,
    capture: cartaoData.capture !== false, // Captura automatica
  };

  // Dados do cartao (tokenizado ou pleno)
  if (cartaoData.card_token) {
    payload.cardToken = cartaoData.card_token;
  } else {
    payload.card = {
      cardNumber: cartaoData.numero.replace(/\D/g, ''),
      holder: cartaoData.titular,
      expirationDate: `${cartaoData.validade_mes}/${cartaoData.validade_ano}`,
      securityCode: cartaoData.cvv,
    };
  }

  try {
    const response = await axios.post(
      `${config.redeBaseUrl}/transactions`,
      payload,
      { headers, timeout: 30000 }
    );

    const result = response.data;
    logger.info(`Transacao cartao: ${result.returnCode} - ${result.returnMessage}`);

    return {
      tid: result.tid,
      nsu: result.nsu,
      authorizationCode: result.authorizationCode,
      status: result.returnCode === '00' ? 'autorizado' : 'negado',
      returnCode: result.returnCode,
      returnMessage: result.returnMessage,
      brand: result.brand?.name || null,
      installmentPayments: result.installmentPayments || null,
    };

  } catch (error) {
    logger.error('Falha no pagamento cartao: ' + error.message);
    throw {
      status: error.response?.status || 502,
      message: 'Erro ao processar pagamento com cartao',
      detail: error.response?.data || error.message,
    };
  }
}

/**
 * Cancela uma transacao de cartao
 */
async function cancelarTransacao(tid) {
  logger.info(`Cancelando transacao cartao ${tid}...`);

  const headers = await getRedeHeaders();

  try {
    const response = await axios.put(
      `${config.redeBaseUrl}/transactions/${tid}/void`,
      {},
      { headers, timeout: 30000 }
    );

    return {
      tid: response.data.tid,
      status: response.data.returnCode === '00' ? 'cancelado' : 'falhou',
      returnCode: response.data.returnCode,
      returnMessage: response.data.returnMessage,
    };

  } catch (error) {
    logger.error('Falha ao cancelar transacao: ' + error.message);
    throw error;
  }
}

/**
 * Consulta uma transacao pelo TID
 */
async function consultarTransacao(tid) {
  logger.info(`Consultando transacao ${tid}...`);

  const headers = await getRedeHeaders();

  const response = await axios.get(
    `${config.redeBaseUrl}/transactions/${tid}`,
    { headers, timeout: 30000 }
  );

  return response.data;
}

/**
 * Captura uma transacao pre-autorizada
 */
async function capturarTransacao(tid, amount) {
  logger.info(`Capturando transacao ${tid}...`);

  const headers = await getRedeHeaders();

  const payload = amount ? { amount: Math.round(amount * 100) } : {};

  const response = await axios.put(
    `${config.redeBaseUrl}/transactions/${tid}/capture`,
    payload,
    { headers, timeout: 30000 }
  );

  return response.data;
}

/**
 * Tokeniza dados do cartao (para uso futuro sem armazenar pleno)
 */
async function tokenizarCartao(cartaoData) {
  logger.info('Tokenizando cartao...');

  const headers = await getRedeHeaders();

  const payload = {
    merchantId: config.rede.merchantId,
    customerName: cartaoData.titular,
    cardNumber: cartaoData.numero.replace(/\D/g, ''),
    expirationMonth: cartaoData.validade_mes,
    expirationYear: cartaoData.validade_ano,
    securityCode: cartaoData.cvv,
  };

  const response = await axios.post(
    `${config.redeBaseUrl}/tokens`,
    payload,
    { headers, timeout: 30000 }
  );

  logger.info('Cartao tokenizado com sucesso');
  return {
    token: response.data.cardToken,
    maskedNumber: response.data.maskedNumber || response.data.last4,
    brand: response.data.brand?.name || null,
  };
}

module.exports = {
  autorizarPagamento,
  cancelarTransacao,
  consultarTransacao,
  capturarTransacao,
  tokenizarCartao,
};
