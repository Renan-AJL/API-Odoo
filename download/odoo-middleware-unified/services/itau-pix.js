// ============================================
// SERVICO DE INTEGRACAO API PIX ITAU v5.0
// ============================================
// Criacao de cobranca PIX - Especificacao BACEN
// v5: Usa token real do Itau

const { callPix } = require('./itau-api');
const config = require('../config');
const logger = require('../utils/logger');
const uuid = require('uuid');

/**
 * Cria cobranca PIX (PUT /v2/cob/{txid})
 */
async function criarCobrancaPix(pixData) {
  logger.info('Criando cobranca PIX...');
  var txid = pixData.txid || gerarTxid(pixData);
  var headers = null; // callPix ja adiciona headers automaticamente

  var payload = {
    calendario: {
      criacao: new Date().toISOString(),
      expiracao: pixData.expiracao || 3600,
    },
    valor: {
      original: (pixData.valor || 0).toFixed(2),
      modalidadeAlteracao: pixData.modalidadeAlteracao || null,
    },
    chave: pixData.chave || config.itau.pixChave,
    devedor: pixData.devedor ? {
      cpf: pixData.devedor.cpf || null,
      cnpj: pixData.devedor.cnpj || null,
      nome: pixData.devedor.nome,
    } : undefined,
    infoAdicionais: pixData.infoAdicionais || [],
    solicitacaoPagador: pixData.solicitacaoPagador || false,
  };

  // Remove campos undefined
  if (payload.valor.modalidadeAlteracao === null) delete payload.valor.modalidadeAlteracao;

  try {
    var resultado = await callPix('PUT', 'v2/cob/' + txid, payload);
    logger.info('Cobranca PIX criada: ' + (resultado.txid || 'sem txid'));
    return resultado;
  } catch (error) {
    var status = error.response?.status;
    var errData = error.response?.data;
    logger.error('Falha ao criar cobranca PIX: ' + status + ' - ' + JSON.stringify(errData));
    logger.error('URL usada: ' + config.itauPixUrl + 'v2/cob/' + txid);
    logger.error('Detalhes completos: ' + JSON.stringify(error, null, 2));
    throw {
      status: status || error.status || 502,
      message: errData?.mensagem || error.message || 'Erro ao criar cobranca PIX',
      detail: errData,
      debug_url: config.itauPixUrl + 'v2/cob/' + txid,
    };
  }
}

/**
 * Consulta cobranca PIX
 */
async function consultarCobrancaPix(txid) {
  logger.info('Consultando cobranca PIX ' + txid + '...');
  try {
    var resultado = await callPix('GET', 'v2/cob/' + txid);
    return resultado;
  } catch (error) {
    throw {
      status: error.status || 502,
      message: 'Erro ao consultar PIX: ' + error.message,
      detail: error.detail,
    };
  }
}

/**
 * Gera TXID unico para a cobranca PIX
 */
function gerarTxid(pixData) {
  // TXID: ate 26 caracteres, alfanumerico
  var txid = uuid.v4().replace(/-/g, '').substring(0, 26).toUpperCase();
  return txid;
}

/**
 * Consulta PIX recebido por e2eId
 */
async function consultarPixRecebido(e2eId) {
  logger.info('Consultando PIX recebido ' + e2eId + '...');
  try {
    var resultado = await callPix('GET', 'v2/pix/' + e2eId);
    return resultado;
  } catch (error) {
    throw {
      status: error.status || 502,
      message: 'Erro ao consultar PIX recebido: ' + error.message,
      detail: error.detail,
    };
  }
}

/**
 * Configura webhook PIX
 */
async function configurarWebhookPix(chave, webhookUrl) {
  logger.info('Configurando webhook PIX: ' + webhookUrl);
  try {
    var resultado = await callPix('PUT', 'v2/webhook/' + chave, { webhookUrl: webhookUrl });
    logger.info('Webhook PIX configurado com sucesso');
    return resultado;
  } catch (error) {
    throw {
      status: error.status || 502,
      message: 'Erro ao configurar webhook PIX: ' + error.message,
      detail: error.detail,
    };
  }
}

/**
 * Consulta webhook PIX configurado
 */
async function consultarWebhookPix(chave) {
  logger.info('Consultando webhook PIX para chave ' + chave + '...');
  try {
    var resultado = await callPix('GET', 'v2/webhook/' + chave);
    return resultado;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

module.exports = {
  criarCobrancaPix,
  consultarCobrancaPix,
  gerarTxid,
  consultarPixRecebido,
  configurarWebhookPix,
  consultarWebhookPix,
};
