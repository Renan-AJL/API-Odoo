/**
 * services/itau-sispag.js - API PIX Pagamentos SISPAG Itau v1.0
 * ====================================================
 * Pagamentos PIX outbound: por chave, dados bancarios, EMV (QR copia-e-cola)
 * Consulta de pagamentos por ID e por filtros
 *
 * Endpoints Itau:
 *   POST /sispag_transferencias/v1/transferencias_pix/chave_pix
 *   POST /sispag_transferencias/v1/transferencias_pix/dados_bancarios
 *   POST /sispag_transferencias/v1/transferencias_pix/qrcode_copia_e_cola
 *   GET  /sispag/v1/pagamentos_sispag?...filtros...
 *   GET  /sispag/v1/pagamentos_sispag/:id_pagamento_sispag
 *
 * Auth: OAuth2 client_credentials -> Bearer token
 * Headers: x-itau-apikey: Credencial, x-itau-flowID, x-itau-correlationID
 */
const axios = require('axios');
const https = require('https');
const config = require('../config');

const SISPAG_BASE_URL = 'https://api.itau.com.br';
const TRANSFERENCIAS_PATH = '/sispag_transferencias/v1/transferencias_pix';
const PAGAMENTOS_PATH = '/sispag/v1/pagamentos_sispag';

// --- Token cache separado para SISPAG ---
let sispagTokenCache = { accessToken: null, expiresAt: 0 };

/**
 * Obtem access_token OAuth2 para SISPAG
 * Usa client_id/secret dedicados ou fallback para os do PIX cobranca
 */
async function getSispagToken() {
  var now = Date.now();
  if (sispagTokenCache.accessToken && now < sispagTokenCache.expiresAt) {
    console.log('[SISPAG] Token do cache (expira em ' + Math.round((sispagTokenCache.expiresAt - now) / 1000) + 's)');
    return sispagTokenCache.accessToken;
  }

  var clientId = config.sispag.clientId || config.itau.clientId;
  var clientSecret = config.sispag.clientSecret || config.itau.clientSecret;
  var tokenUrl = config.sispag.tokenUrl || config.itau.tokenUrl;

  if (!clientId || !clientSecret) {
    throw new Error('SISPAG: client_id e client_secret nao configurados. Defina ITAU_SISPAG_CLIENT_ID/SECRET ou ITAU_CLIENT_ID/SECRET.');
  }

  console.log('[SISPAG] Solicitando novo token OAuth2...');
  console.log('[SISPAG] Client ID: ***' + clientId.substring(clientId.length - 4));

  var mtls = config.createMtlsConfig();
  var httpsAgent = mtls.hasMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;

  var params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  var response = await axios.post(tokenUrl, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-itau-flowID': '1',
      'x-itau-correlationID': String(Date.now()),
      'Accept': 'application/json',
    },
    httpsAgent,
    timeout: 30000,
  });

  if (response.data && response.data.access_token) {
    sispagTokenCache.accessToken = response.data.access_token;
    sispagTokenCache.expiresAt = now + ((response.data.expires_in || 1800) * 1000) - 300000; // 5min antes
    console.log('[SISPAG] Token obtido com sucesso!');
    return response.data.access_token;
  }

  throw new Error('SISPAG token: resposta sem access_token: ' + JSON.stringify(response.data));
}

/**
 * Monta headers padrao para chamadas SISPAG
 */
function getSispagHeaders(accessToken) {
  return {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-itau-apikey': config.sispag.credencial || '',
    'x-itau-flowID': '1',
    'x-itau-correlationID': String(Date.now()),
  };
}

/**
 * POST generico ao SISPAG
 */
async function sispagPost(path, payload) {
  var accessToken = await getSispagToken();
  var mtls = config.createMtlsConfig();
  var httpsAgent = mtls.hasMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;
  var url = SISPAG_BASE_URL + path;
  var headers = getSispagHeaders(accessToken);

  console.log('[SISPAG] POST ' + url);
  console.log('[SISPAG] Credencial: ' + (config.sispag.credencial ? '***' + config.sispag.credencial.substring(config.sispag.credencial.length - 4) : 'NAO CONFIGURADA'));

  var response = await axios.post(url, payload, { headers, httpsAgent, timeout: 30000 });
  return response.data;
}

/**
 * GET generico ao SISPAG
 */
async function sispagGet(path, params) {
  var accessToken = await getSispagToken();
  var mtls = config.createMtlsConfig();
  var httpsAgent = mtls.hasMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;
  var url = SISPAG_BASE_URL + path;
  var headers = getSispagHeaders(accessToken);

  // Remove Content-Type de GET
  delete headers['Content-Type'];

  console.log('[SISPAG] GET ' + url);

  var response = await axios.get(url, { headers, httpsAgent, timeout: 30000, params });
  return response.data;
}

// ============================================================
// PAGAMENTOS PIX
// ============================================================

/**
 * Pagamento PIX por chave
 * @param {Object} data
 * @param {string} data.chave - Chave PIX do favorecido
 * @param {string} data.valor_pagamento - Ex: "150.00"
 * @param {string} [data.data_pagamento] - ISO datetime, default agora
 * @param {string} [data.referencia_empresa] - Ref interna
 * @param {string} [data.identificacao_comprovante] - Descricao no comprovante
 * @param {string} [data.informacoes_entre_usuarios] - Msg pro favorecido
 */
async function pagarPorChavePix(data) {
  var pagador = buildPagador(data);

  var payload = {
    valor_pagamento: data.valor_pagamento,
    data_pagamento: data.data_pagamento || new Date().toISOString(),
    chave: data.chave,
    referencia_empresa: data.referencia_empresa || '',
    identificacao_comprovante: data.identificacao_comprovante || '',
    informacoes_entre_usuarios: data.informacoes_entre_usuarios || '',
    pagador: pagador,
  };

  console.log('[SISPAG] PIX por chave: ' + data.chave.substring(0, 20) + '... | R$ ' + data.valor_pagamento);
  var result = await sispagPost(TRANSFERENCIAS_PATH + '/chave_pix', payload);
  console.log('[SISPAG] Resultado: status_pagamento=' + (result.status_pagamento || 'N/A'));
  return result;
}

/**
 * Pagamento PIX por dados bancarios
 * @param {Object} data
 * @param {string} data.ispb - ISPB do banco favorecido
 * @param {string} data.tipo_identificacao_conta - CC (corrente) ou CP (poupanca)
 * @param {string} data.agencia_recebedor - Agencia
 * @param {string} data.conta_recebedor - Conta
 * @param {string} data.tipo_de_identificacao_do_recebedor - F (fisica) ou J (juridica)
 * @param {string} data.identificacao_recebedor - CPF ou CNPJ
 * @param {string} data.valor_pagamento
 * @param {string} [data.data_pagamento]
 * @param {string} [data.txid]
 */
async function pagarPorDadosBancarios(data) {
  var pagador = buildPagador(data);

  var payload = {
    valor_pagamento: data.valor_pagamento,
    data_pagamento: data.data_pagamento || new Date().toISOString(),
    ispb: data.ispb,
    tipo_identificacao_conta: data.tipo_identificacao_conta || 'CC',
    agencia_recebedor: data.agencia_recebedor,
    conta_recebedor: data.conta_recebedor,
    tipo_de_identificacao_do_recebedor: data.tipo_de_identificacao_do_recebedor || 'J',
    identificacao_recebedor: (data.identificacao_recebedor || '').replace(/\D/g, ''),
    informacoes_entre_usuarios: data.informacoes_entre_usuarios || '',
    referencia_empresa: data.referencia_empresa || '',
    identificacao_comprovante: data.identificacao_comprovante || '',
    pagador: pagador,
  };

  if (data.txid) payload.txid = data.txid;

  console.log('[SISPAG] PIX por dados bancarios: ISPB=' + data.ispb + ' Ag=' + data.agencia_recebedor + ' Cta=' + data.conta_recebedor + ' | R$ ' + data.valor_pagamento);
  var result = await sispagPost(TRANSFERENCIAS_PATH + '/dados_bancarios', payload);
  console.log('[SISPAG] Resultado: status_pagamento=' + (result.status_pagamento || 'N/A'));
  return result;
}

/**
 * Pagamento PIX por EMV (QR Code copia-e-cola)
 * @param {Object} data
 * @param {string} data.emv - String EMV do QR Code PIX
 * @param {string} data.valor_pagamento
 * @param {string} [data.data_pagamento]
 */
async function pagarPorEmv(data) {
  var pagador = buildPagador(data);

  var payload = {
    emv: data.emv,
    valor_pagamento: data.valor_pagamento,
    data_pagamento: data.data_pagamento || new Date().toISOString(),
    pagador: pagador,
  };

  console.log('[SISPAG] PIX por EMV: ' + data.emv.substring(0, 40) + '... | R$ ' + data.valor_pagamento);
  var result = await sispagPost(TRANSFERENCIAS_PATH + '/qrcode_copia_e_cola', payload);
  console.log('[SISPAG] Resultado: status_pagamento=' + (result.status_pagamento || 'N/A'));
  return result;
}

/**
 * Monta o bloco "pagador" com dados da empresa (conta debito)
 */
function buildPagador(data) {
  return {
    tipo_conta: data.pagador_tipo_conta || config.sispag.pagadorTipoConta || 'CC',
    agencia: data.pagador_agencia || config.sispag.pagadorAgencia || config.banco.agencia,
    conta: data.pagador_conta || config.sispag.pagadorConta || config.banco.conta.replace('-', ''),
    tipo_pessoa: data.pagador_tipo_pessoa || config.sispag.pagadorTipoPessoa || 'J',
    documento: data.pagador_documento || config.sispag.pagadorDocumento || config.empresa.cnpj.replace(/\D/g, ''),
    modulo_sispag: data.pagador_modulo_sispag || config.sispag.pagadorModuloSispag || 'Fornecedores',
  };
}

// ============================================================
// CONSULTA DE PAGAMENTOS
// ============================================================

/**
 * Consulta pagamento por ID SISPAG
 * @param {string} idPagamentoSispag
 */
async function consultarPagamento(idPagamentoSispag) {
  console.log('[SISPAG] Consultando pagamento: ' + idPagamentoSispag);
  var result = await sispagGet(PAGAMENTOS_PATH + '/' + idPagamentoSispag);
  return result;
}

/**
 * Consulta pagamentos com filtros
 * @param {Object} filtros
 * @param {string} [filtros.data_inicial] - YYYY-MM-DD
 * @param {string} [filtros.data_final] - YYYY-MM-DD
 * @param {string} [filtros.referencia_empresa]
 * @param {string} [filtros.nome_beneficiario]
 * @param {string} [filtros.status] - AE (agendado), EX (executado), etc
 * @param {string} [filtros.tipo_pagamento] - 01=TED/DOC, 41=PIX
 * @param {number} [filtros.numero_lote]
 */
async function consultarPagamentos(filtros) {
  var params = {
    agencia_operacao: config.sispag.pagadorAgencia || config.banco.agencia,
    conta_operacao: (config.sispag.pagadorConta || config.banco.conta).replace('-', ''),
    cnpj_empresa: (config.sispag.pagadorDocumento || config.empresa.cnpj).replace(/\D/g, ''),
  };

  if (filtros.data_inicial) params.data_inicial = filtros.data_inicial;
  if (filtros.data_final) params.data_final = filtros.data_final;
  if (filtros.referencia_empresa) params.referencia_empresa = filtros.referencia_empresa;
  if (filtros.nome_beneficiario) params.nome_beneficiario = filtros.nome_beneficiario;
  if (filtros.status) params.status = filtros.status;
  if (filtros.tipo_pagamento) params.tipo_pagamento = filtros.tipo_pagamento;
  if (filtros.numero_lote) params.numero_lote = filtros.numero_lote;

  // Required by SISPAG
  params.tipo_lista = 'Detalhada';
  params.order_by = 'data_pagamento';
  params.order = 'desc';

  console.log('[SISPAG] Consultando pagamentos com filtros:', JSON.stringify(filtros));
  var result = await sispagGet(PAGAMENTOS_PATH, params);
  return result;
}

/**
 * Invalida o cache de token SISPAG
 */
function invalidateToken() {
  sispagTokenCache.accessToken = null;
  sispagTokenCache.expiresAt = 0;
  console.log('[SISPAG] Token cache invalidado.');
}

/**
 * Status do token SISPAG
 */
function getTokenStatus() {
  var now = Date.now();
  return {
    hasToken: !!sispagTokenCache.accessToken,
    isValid: !!sispagTokenCache.accessToken && now < sispagTokenCache.expiresAt,
    expiresAt: sispagTokenCache.expiresAt > 0 ? new Date(sispagTokenCache.expiresAt).toISOString() : null,
    expiresIn: sispagTokenCache.expiresAt > now ? Math.round((sispagTokenCache.expiresAt - now) / 1000) + 's' : 'expirado',
    credencialConfigurada: !!config.sispag.credencial,
  };
}

module.exports = {
  pagarPorChavePix,
  pagarPorDadosBancarios,
  pagarPorEmv,
  consultarPagamento,
  consultarPagamentos,
  invalidateToken,
  getTokenStatus,
};
