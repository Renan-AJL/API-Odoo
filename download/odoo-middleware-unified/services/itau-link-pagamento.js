// ============================================
// SERVICO DE LINK DE PAGAMENTO ITAU (CARTOES)
// ============================================
// Criacao e gestao de links de pagamento para
// cartao de credito/debito via Itau Shopline

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// Cache do token separado para Link de Pagamento
let linkTokenCache = {
  accessToken: null,
  expiresAt: null,
  isLoading: false,
};

/**
 * Obtem token OAuth2 para a API de Link de Pagamento
 * Usa credenciais separadas do boleto/PIX
 */
async function getLinkToken() {
  const now = Date.now();

  // Retorna token em cache se ainda valido (com margem de 30s)
  if (linkTokenCache.accessToken && linkTokenCache.expiresAt && now < linkTokenCache.expiresAt - 30000) {
    logger.debug('Token Link de Pagamento obtido do cache');
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
    logger.info(`Solicitando token Link de Pagamento (${config.ambiente})...`);

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');

    const response = await axios.post(tokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      auth: {
        username: config.linkPagamento.clientId,
        password: config.linkPagamento.clientSecret,
      },
      timeout: 30000,
    });

    const data = response.data;

    if (!data.access_token) {
      throw new Error('Token nao retornado pela API de Link de Pagamento');
    }

    linkTokenCache.accessToken = data.access_token;
    linkTokenCache.expiresAt = now + (data.expires_in * 1000);
    linkTokenCache.isLoading = false;

    logger.info('Token Link de Pagamento obtido com sucesso. Expira em ' + data.expires_in + 's');
    return data.access_token;

  } catch (error) {
    linkTokenCache.isLoading = false;
    linkTokenCache.accessToken = null;
    linkTokenCache.expiresAt = null;

    const msg = error.response
      ? `Erro ${error.response.status}: ${JSON.stringify(error.response.data)}`
      : error.message;

    logger.error('Falha ao obter token Link de Pagamento: ' + msg);
    throw new Error('Falha na autenticacao Link de Pagamento: ' + msg);
  }
}

/**
 * Retorna headers de autenticacao para Link de Pagamento
 */
async function getLinkAuthHeaders() {
  const token = await getLinkToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * CRIAR link de pagamento
 * @param {Object} dadosLink - Dados para criar o link
 * @param {number} dadosLink.valor - Valor total (ex: 150.00)
 * @param {string} dadosLink.seu_numero - Numero de referencia (ID fatura Odoo)
 * @param {string} dadosLink.descricao - Descricao do pagamento
 * @param {number} dadosLink.parcelas - Numero de parcelas (default: 1)
 * @param {string} dadosLink.email_pagador - Email do pagador (opcional)
 * @param {string} dadosLink.cpf_cnpj_pagador - CPF/CNPJ do pagador (opcional)
 * @param {string} dadosLink.nome_pagador - Nome do pagador (opcional)
 * @param {number} dadosLink.expiracao - Expiracao em dias (default: 7)
 * @param {string} dadosLink.webhook_url - URL para notificacao de pagamento
 * @returns {Promise<Object>} Link de pagamento criado
 */
async function criarLinkPagamento(dadosLink) {
  logger.info('Criando link de pagamento...');

  const headers = await getLinkAuthHeaders();
  const baseUrl = config.linkPagamento.apiUrl;

  const payload = {
    valor: {
      original: dadosLink.valor.toFixed(2),
    },
    calendario: {
      criacao: new Date().toISOString(),
      expiracao: dadosLink.expiracao || 604800, // Default 7 dias em segundos
    },
    chave: dadosLink.chave || config.itau.pixChave || '',
    infoAdicionais: [],
    solicitacaoPagador: dadosLink.descricao || dadosLink.seu_numero || '',
  };

  // Adiciona dados do pagador se fornecidos
  if (dadosLink.cpf_cnpj_pagador || dadosLink.nome_pagador) {
    payload.devedor = {};
    if (dadosLink.cpf_cnpj_pagador) {
      const doc = dadosLink.cpf_cnpj_pagador.replace(/\D/g, '');
      payload.devedor.cpf = doc.length <= 11 ? doc : undefined;
      payload.devedor.cnpj = doc.length > 11 ? doc : undefined;
    }
    if (dadosLink.nome_pagador) {
      payload.devedor.nome = dadosLink.nome_pagador;
    }
  }

  try {
    const response = await axios.post(
      `${baseUrl}/payment_link`,
      payload,
      { headers, timeout: 30000 }
    );

    const resultado = response.data;
    logger.info(`Link de pagamento criado: ${resultado.id || resultado.link || 'sem ID'}`);
    return resultado;

  } catch (error) {
    const status = error.response?.status;
    const errData = error.response?.data;
    logger.error(`Falha ao criar link de pagamento: ${status} - ${JSON.stringify(errData)}`);
    throw {
      status: status || 502,
      message: errData?.mensagem || errData?.message || 'Erro ao criar link de pagamento',
      detail: errData,
    };
  }
}

/**
 * CONSULTAR link de pagamento pelo ID
 * @param {string} idLink - ID do link de pagamento
 * @returns {Promise<Object>} Dados do link de pagamento
 */
async function consultarLinkPagamento(idLink) {
  logger.info(`Consultando link de pagamento ${idLink}...`);

  const headers = await getLinkAuthHeaders();
  const baseUrl = config.linkPagamento.apiUrl;

  try {
    const response = await axios.get(
      `${baseUrl}/payment_link/${idLink}`,
      { headers, timeout: 30000 }
    );
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const errData = error.response?.data;
    logger.error(`Falha ao consultar link: ${status} - ${JSON.stringify(errData)}`);
    throw {
      status: status || 502,
      message: errData?.mensagem || 'Erro ao consultar link de pagamento',
      detail: errData,
    };
  }
}

/**
 * CANCELAR link de pagamento
 * @param {string} idLink - ID do link de pagamento
 * @returns {Promise<Object>}
 */
async function cancelarLinkPagamento(idLink) {
  logger.info(`Cancelando link de pagamento ${idLink}...`);

  const headers = await getLinkAuthHeaders();
  const baseUrl = config.linkPagamento.apiUrl;

  try {
    const response = await axios.put(
      `${baseUrl}/payment_link/${idLink}/cancel`,
      {},
      { headers, timeout: 30000 }
    );
    logger.info(`Link de pagamento ${idLink} cancelado`);
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const errData = error.response?.data;
    logger.error(`Falha ao cancelar link: ${status} - ${JSON.stringify(errData)}`);
    throw {
      status: status || 502,
      message: errData?.mensagem || 'Erro ao cancelar link de pagamento',
      detail: errData,
    };
  }
}

/**
 * LISTAR links de pagamento com filtros
 * @param {Object} filtros - Filtros de busca
 * @returns {Promise<Array>}
 */
async function listarLinksPagamento(filtros = {}) {
  logger.info('Listando links de pagamento...', filtros);

  const headers = await getLinkAuthHeaders();
  const baseUrl = config.linkPagamento.apiUrl;

  try {
    const response = await axios.get(
      `${baseUrl}/payment_link`,
      { headers, params: filtros, timeout: 30000 }
    );
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const errData = error.response?.data;
    logger.error(`Falha ao listar links: ${status} - ${JSON.stringify(errData)}`);
    throw {
      status: status || 502,
      message: errData?.mensagem || 'Erro ao listar links de pagamento',
      detail: errData,
    };
  }
}

module.exports = {
  getLinkToken,
  getLinkAuthHeaders,
  criarLinkPagamento,
  consultarLinkPagamento,
  cancelarLinkPagamento,
  listarLinksPagamento,
};
