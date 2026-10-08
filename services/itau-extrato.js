/**
 * services/itau-extrato.js - Extrato Bancario Itau
 * ==============================================
 * Busca extrato da conta corrente via API Itau Corporativa
 * e cria account.bank.statement no Odoo
 *
 * Endpoint: GET /corporativo/v2/conta_corrente/extrato
 * Auth: OAuth2 client_credentials (mesmo fluxo do SISPAG)
 *
 * Config necessaria (env vars):
 *   ITAU_EXTRATO_URL - URL base da API de extrato (default: https://api.itau.com.br)
 *   ITAU_EXTRATO_CONTA - Numero da conta (default: usa ITAU_CONTA)
 *   ITAU_EXTRATO_AGENCIA - Agencia (default: usa ITAU_AGENCIA)
 *   ODOO_BANK_JOURNAL_ID - ID do diario bancario no Odoo
 *   ODOO_BANK_STATEMENT_IMPORT_CRON_SECRET - Segredo para chamada do cron
 */
const axios = require('axios');
const https = require('https');
const config = require('../config');

var EXTRATO_BASE_URL = process.env.ITAU_EXTRATO_URL || 'https://api.itau.com.br';

// Token cache para extrato (reusa o SISPAG token)
var _extratoTokenCache = { accessToken: null, expiresAt: 0 };

async function getExtratoToken() {
  var now = Date.now();
  if (_extratoTokenCache.accessToken && now < _extratoTokenCache.expiresAt) {
    return _extratoTokenCache.accessToken;
  }

  // Tenta usar o token do SISPAG (mesma autenticacao)
  try {
    var sispag = require('./itau-sispag');
    var status = sispag.getTokenStatus();
    if (status.isValid) {
      return sispag._getAccessToken ? sispag._getAccessToken() : null;
    }
  } catch (e) { /* ignora */ }

  // Obtem token proprio via OAuth2
  var clientId = process.env.ITAU_EXTRATO_CLIENT_ID || config.sispag.clientId || config.itau.clientId;
  var clientSecret = process.env.ITAU_EXTRATO_CLIENT_SECRET || config.sispag.clientSecret || config.itau.clientSecret;
  var tokenUrl = process.env.ITAU_EXTRATO_TOKEN_URL || config.itau.tokenUrl;

  if (!clientId || !clientSecret) {
    throw new Error('Credenciais Itau nao configuradas para extrato bancario');
  }

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
    },
    httpsAgent,
    timeout: 30000,
  });

  _extratoTokenCache.accessToken = response.data.access_token;
  _extratoTokenCache.expiresAt = now + ((response.data.expires_in || 1800) * 1000) - 300000;
  return _extratoTokenCache.accessToken;
}

/**
 * Busca extrato bancario do Itau
 * @param {Object} opts
 * @param {string} opts.dataInicial - YYYY-MM-DD
 * @param {string} opts.dataFinal - YYYY-MM-DD
 * @returns {Array} Lista de transacoes
 */
async function buscarExtrato(opts) {
  var accessToken = await getExtratoToken();
  var mtls = config.createMtlsConfig();
  var httpsAgent = mtls.hasMtls ? new https.Agent({ cert: mtls.cert, key: mtls.key }) : undefined;

  var conta = (process.env.ITAU_EXTRATO_CONTA || config.banco.conta).replace(/-/g, '');
  var agencia = process.env.ITAU_EXTRATO_AGENCIA || config.banco.agencia;

  // Formato Itau: DDMMAAAA
  function toItauDate(isoDate) {
    var d = isoDate.split('-');
    return d[2] + d[1] + d[0];
  }

  var di = toItauDate(opts.dataInicial);
  var df = toItauDate(opts.dataFinal);

  console.log('[EXTRATO] Buscando extrato: agencia=' + agencia + ' conta=' + conta + ' de ' + opts.dataInicial + ' ate ' + opts.dataFinal);

  var url = EXTRATO_BASE_URL + '/corporativo/v2/conta_corrente/extrato';
  var headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Accept': 'application/json',
    'x-itau-apikey': config.sispag.credencial || config.itau.clientId,
    'x-itau-flowID': '1',
    'x-itau-correlationID': String(Date.now()),
  };

  var params = {
    data_inicio: di,
    data_fim: df,
    agencia: agencia,
    conta: conta,
  };

  var response = await axios.get(url, { headers, httpsAgent, timeout: 30000, params });
  var data = response.data;

  console.log('[EXTRATO] Resposta recebida: ' + JSON.stringify(data).substring(0, 1000));

  // Normaliza transacoes (formato pode variar)
  var transacoes = [];
  if (Array.isArray(data)) {
    transacoes = data;
  } else if (data && Array.isArray(data.lancamentos)) {
    transacoes = data.lancamentos;
  } else if (data && Array.isArray(data.transacoes)) {
    transacoes = data.transacoes;
  } else if (data && Array.isArray(data.extrato)) {
    transacoes = data.extrato;
  } else if (data && data.Result && Array.isArray(data.Result)) {
    transacoes = data.Result;
  }

  console.log('[EXTRATO] ' + transacoes.length + ' transacoes encontradas');
  return transacoes;
}

/**
 * Normaliza uma transacao do Itau para o formato do Odoo
 * Formatos possiveis do Itau: muito variados
 */
function normalizarTransacao(t) {
  // Tenta varios campos possiveis do Itau
  var data = t.data_lancamento || t.data || t.date || t.DataLancamento || '';
  if (data && data.length === 8) {
    // Formato DDMMAAAA -> YYYY-MM-DD
    data = data.substring(4, 8) + '-' + data.substring(2, 4) + '-' + data.substring(0, 2);
  } else if (data && data.length === 10 && data.includes('/')) {
    // Formato DD/MM/AAAA -> YYYY-MM-DD
    var p = data.split('/');
    data = p[2] + '-' + p[1].padStart(2, '0') + '-' + p[0].padStart(2, '0');
  }

  var valor = t.valor || t.valor_lancamento || t.amount || t.Valor || t.ValorLancamento || 0;
  if (typeof valor === 'string') {
    valor = parseFloat(valor.replace(',', '.')) || 0;
  }
  // Negativo = saida (pagamento), positivo = entrada (recebimento)
  var tipo = t.tipo_lancamento || t.tipo || t.type || t.TipoLancamento || '';
  var isSaida = tipo.toUpperCase().indexOf('D') >= 0 || tipo.toUpperCase().indexOf('DEB') >= 0 || valor < 0;
  valor = Math.abs(valor);

  var historico = t.historico || t.descricao || t.description || t.Historico || t.Descricao || '';
  var documento = t.numero_documento || t.documento || t.document_number || t.NumeroDocumento || '';

  return {
    date: data,
    name: historico.substring(0, 200),
    amount: isSaida ? -valor : valor,
    ref: documento || '',
    raw: t,
  };
}

/**
 * Busca e normaliza extrato para o Odoo
 */
async function buscarExtratoNormalizado(dataInicial, dataFinal) {
  var transacoes = await buscarExtrato({ dataInicial, dataFinal });
  return transacoes.map(normalizarTransacao).filter(function(t) {
    return t.date && t.amount !== 0;
  });
}

module.exports = { buscarExtrato, buscarExtratoNormalizado, normalizarTransacao };
