// ============================================
// SERVICO DE INTEGRACAO API PIX ITAU v5.0
// ============================================
// Criacao de cobranca PIX - Especificacao BACEN
// v5: Usa token real do Itau

const { callPix } = require('./itau-api');
const config = require('../config');
const logger = require('../utils/logger');
const uuid = require('uuid');
const { normalizeDevedor } = require('../utils/pix-devedor');

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
    devedor: normalizeDevedor(pixData.devedor),
    solicitacaoPagador: pixData.solicitacaoPagador || false,
  };

  // infoAdicionais: so enviar se tiver itens (BACEN rejeita array vazio)
  if (pixData.infoAdicionais && pixData.infoAdicionais.length > 0) {
    payload.infoAdicionais = pixData.infoAdicionais;
  }

  // Remove campos undefined/null (BACEN rejeita)
  if (payload.valor.modalidadeAlteracao === null) delete payload.valor.modalidadeAlteracao;
  if (payload.devedor === undefined) delete payload.devedor;

  // Log do payload limpo para depuracao
  if (payload.devedor) {
    logger.info('[PIX-DEV] Payload devedor: ' + JSON.stringify(payload.devedor));
  } else {
    logger.info('[PIX-DEV] Payload sem devedor (cobranca sem identificacao)');
  }

  try {
    var resultado = await callPix('PUT', 'v2/cob/' + txid, payload);
    logger.info('Cobranca PIX criada: ' + (resultado.txid || 'sem txid'));
    return resultado;
  } catch (error) {
    var status = error.response?.status;
    var errData = error.response?.data;
    logger.error('Falha ao criar cobranca PIX: ' + status + ' - ' + JSON.stringify(errData));
    logger.error('URL usada: ' + config.itau.pixBaseUrl + 'v2/cob/' + txid);
    logger.error('Detalhes completos: ' + JSON.stringify(error, null, 2));
    throw {
      status: status || error.status || 502,
      message: errData?.mensagem || error.message || 'Erro ao criar cobranca PIX',
      detail: errData,
      debug_url: config.itau.pixBaseUrl + 'v2/cob/' + txid,
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
 * Cancela (remove) cobranca PIX imediata — BACEN: PUT /cob/{txid} com
 * status REMOVIDA_PELO_USUARIO_RECEBEDOR. Caso S03464 (29/10/2026): PIX
 * com valor errado ficou ATIVA 24h sem forma de cancelar.
 */
async function cancelarCobrancaPix(txid) {
  logger.info('Cancelando cobranca PIX ' + txid + '...');
  try {
    var resultado = await callPix('PUT', 'v2/cob/' + txid, {
      status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR',
    });
    logger.info('Cobranca PIX cancelada: ' + txid + ' -> ' + (resultado.status || 'sem status'));
    return resultado;
  } catch (error) {
    var statusC = error.response?.status;
    var errDataC = error.response?.data;
    logger.error('Falha ao cancelar PIX ' + txid + ': ' + statusC + ' - ' + JSON.stringify(errDataC));
    throw {
      status: statusC || error.status || 502,
      message: (errDataC && (errDataC.mensagem || errDataC.message)) || error.message || 'Erro ao cancelar cobranca PIX',
      detail: errDataC,
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
  cancelarCobrancaPix,
  gerarTxid,
  consultarPixRecebido,
  configurarWebhookPix,
  consultarWebhookPix,
};
