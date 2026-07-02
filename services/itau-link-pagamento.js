// ============================================
// SERVICO DE LINK DE PAGAMENTO - REDE CHECKOUT
// ============================================
// Cria checkout de cartao de credito/debito
// via e.Rede (Rede Itau E-Commerce PV)
// Portal: https://developer.userede.com.br

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Cache do token OAuth2 da Rede
let linkTokenCache = {
  accessToken: null,
  expiresAt: null,
  isLoading: false,
};

/**
 * Obtem token OAuth2 da Rede (e.Rede W3.0)
 * Auth: Basic Auth com PV:ChaveIntegracao
 */
async function getLinkToken() {
  const now = Date.now();

  // Retorna token em cache se ainda valido (com margem de 30s)
  if (linkTokenCache.accessToken && linkTokenCache.expiresAt && now < linkTokenCache.expiresAt - 30000) {
    logger.debug('Token Rede obtido do cache');
    return linkTokenCache.accessToken;
  }

  // Evita multiplas requisicoes simultaneas
  if (linkTokenCache.isLoading) {
    await new Promise(resolve => setTimeout(resolve, 500));
    return getLinkToken();
  }

  linkTokenCache.isLoading = true;

  try {
    const tokenUrl = config.linkPagamento.tokenUrl;
    const pv = config.linkPagamento.pv;
    const chave = config.linkPagamento.clientSecret;

    if (!pv || !chave) {
      throw new Error('REDE_PV e REDE_CHAVE_INTEGRACAO devem estar configurados');
    }

    logger.info('Solicitando token Rede e.Rede (' + config.redeBaseUrl + ')...');

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');

    // e.Rede usa Basic Auth: PV como username, Chave de Integracao como password
    const response = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      auth: {
        username: pv,
        password: chave,
      },
      timeout: 30000,
    });

    const data = response.data;

    if (!data.access_token) {
      throw new Error('Token nao retornado pela API Rede');
    }

    linkTokenCache.accessToken = data.access_token;
    linkTokenCache.expiresAt = now + (data.expires_in * 1000);
    linkTokenCache.isLoading = false;

    logger.info('Token Rede obtido com sucesso. Expira em ' + data.expires_in + 's');
    return data.access_token;

  } catch (error) {
    linkTokenCache.isLoading = false;
    linkTokenCache.accessToken = null;
    linkTokenCache.expiresAt = null;

    const msg = error.response
      ? 'Erro ' + error.response.status + ': ' + JSON.stringify(error.response.data)
      : error.message;

    logger.error('Falha ao obter token Rede: ' + msg);
    throw new Error('Falha na autenticacao Rede: ' + msg);
  }
}

/**
 * Retorna headers autenticados para Rede
 */
async function getLinkAuthHeaders() {
  const token = await getLinkToken();
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  };
}

/**
 * CRIAR link de checkout de cartao (e.Rede Checkout)
 *
 * @param {Object} dadosLink - Dados para criar o checkout
 * @param {number} dadosLink.valor - Valor total (ex: 150.00)
 * @param {string} dadosLink.seu_numero - Numero de referencia (ID fatura Odoo)
 * @param {string} dadosLink.descricao - Descricao do pagamento
 * @param {number} dadosLink.parcelas - Numero de parcelas (default: 1)
 * @param {string} dadosLink.nome_pagador - Nome do pagador (opcional)
 * @param {string} dadosLink.cpf_cnpj_pagador - CPF/CNPJ do pagador (opcional)
 * @param {string} dadosLink.email_pagador - Email do pagador (opcional)
 * @param {number} dadosLink.expiracao - Expiracao em segundos (default: 7 dias)
 * @returns {Promise<Object>} { id, link, raw }
 */
async function criarLinkPagamento(dadosLink) {
  logger.info('Criando link de pagamento cartao (Rede Checkout)...');

  const headers = await getLinkAuthHeaders();
  const baseUrl = config.linkPagamento.apiUrl;
  const pv = config.linkPagamento.pv;

  if (!pv) {
    throw { status: 500, message: 'REDE_PV nao configurado' };
  }

  const payload = {
    capture: true,
    merchantOrderId: dadosLink.seu_numero || String(Date.now()),
    amount: Math.round(dadosLink.valor * 100), // Valor em centavos
    currency: 'BRL',
    installments: dadosLink.parcelas || 1,
    softDescriptor: config.rede.softDescriptor || 'LOJA',
  };

  // Dados do cliente
  if (dadosLink.nome_pagador || dadosLink.cpf_cnpj_pagador || dadosLink.email_pagador) {
    payload.customer = {};
    if (dadosLink.nome_pagador) payload.customer.name = dadosLink.nome_pagador;
    if (dadosLink.email_pagador) payload.customer.email = dadosLink.email_pagador;
    if (dadosLink.cpf_cnpj_pagador) {
      var doc = dadosLink.cpf_cnpj_pagador.replace(/\D/g, '');
      if (doc.length > 0) payload.customer.document = doc;
    }
  }

  // URLs de retorno
  var host = dadosLink.host || '';
  if (host) {
    payload.settings = {
      returnUrl: host + '/retorno',
      cancelUrl: host + '/cancelamento',
    };
  }

  try {
    // e.Rede Checkout API: POST /checkout/v1/orders/{pv}
    const response = await axios.post(
      baseUrl + '/checkout/v1/orders/' + pv,
      payload,
      { headers, timeout: 30000 }
    );

    const resultado = response.data;
    // A URL de checkout pode vir em diferentes campos dependendo da versao da API
    var link = resultado.checkoutUrl
      || resultado.paymentUrl
      || resultado.url
      || resultado.link
      || (resultado.links && resultado.links.checkout)
      || '';

    logger.info('Link de pagamento criado: ' + (resultado.orderId || resultado.id || 'sem ID')
      + ' -> ' + (link ? 'URL recebida' : 'SEM URL - verificar formato da resposta'));

    return {
      id: resultado.orderId || resultado.id || '',
      link: link,
      raw: resultado,
    };

  } catch (error) {
    const status = error.response?.status;
    const errData = error.response?.data;
    logger.error('Falha ao criar link de pagamento: ' + status + ' - ' + JSON.stringify(errData));
    throw {
      status: status || 502,
      message: (errData && (errData.message || errData.mensagem)) || 'Erro ao criar link de pagamento cartao',
      detail: errData,
    };
  }
}

/**
 * CONSULTAR pedido de checkout pelo ID
 */
async function consultarLinkPagamento(idLink) {
  logger.info('Consultando checkout ' + idLink + '...');
  const headers = await getLinkAuthHeaders();
  const baseUrl = config.linkPagamento.apiUrl;
  const pv = config.linkPagamento.pv;

  try {
    const response = await axios.get(
      baseUrl + '/checkout/v1/orders/' + pv + '/' + idLink,
      { headers, timeout: 30000 }
    );
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const errData = error.response?.data;
    logger.error('Falha ao consultar checkout: ' + status + ' - ' + JSON.stringify(errData));
    throw {
      status: status || 502,
      message: (errData && errData.mensagem) || 'Erro ao consultar checkout',
      detail: errData,
    };
  }
}

module.exports = {
  getLinkToken,
  getLinkAuthHeaders,
  criarLinkPagamento,
  consultarLinkPagamento,
};