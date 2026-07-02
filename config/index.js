// ====================================================================
// CONFIG UNIFICADO - Itau (Boleto/PIX) + CNP Ja
// ====================================================================
require('dotenv').config();

// --- CNP Ja config (auto-detecao inteligente da URL) ---
const cnpjaApiToken = process.env.CNPJA_API_TOKEN || '';
let cnpjaApiBase = process.env.CNPJA_API_BASE || '';

if (!cnpjaApiBase) {
  cnpjaApiBase = cnpjaApiToken ? 'https://api.cnpja.com' : 'https://open.cnpja.com';
} else if (cnpjaApiBase.includes('open.cnpja.com') && cnpjaApiToken) {
  console.warn('[CONFIG] CNPJA_API_BASE e API publica mas tem token comercial. Corrigindo para api.cnpja.com');
  cnpjaApiBase = 'https://api.cnpja.com';
}

// --- Itau URLs por ambiente ---
const ambiente = process.env.AMBIENTE || 'producao';
const isSandbox = ambiente === 'sandbox';

const config = {
  // --- Geral ---
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'production',
  middlewareApiKey: process.env.MIDDLEWARE_API_KEY || process.env.API_SECRET_KEY || 'change-me-unified-key',
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE, 10) || 60,
  debug: process.env.DEBUG === 'true',

  // --- Itau (URLs identicas ao itau-odoo original) ---
  itau: {
    clientId: process.env.ITAU_CLIENT_ID || '',
    clientSecret: process.env.ITAU_CLIENT_SECRET || '',
    tokenUrl: process.env.ITAU_TOKEN_URL || process.env.ITAU_TOKEN_PRODUCAO_URL || 'https://sts.itau.com.br/api/oauth/token',
    bolecodeBaseUrl: process.env.ITAU_BOLECODE_URL || process.env.ITAU_PRODUCAO_URL || 'https://secure.api.itau/pix_recebimentos_conciliacoes/v2',
    pixBaseUrl: process.env.ITAU_PIX_URL || process.env.ITAU_PIX_BASE_URL || '',
    pixChave: process.env.ITAU_PIX_CHAVE || process.env.ITAU_PIX_KEY || '',
  },

  banco: {
    agencia: process.env.ITAU_AGENCIA || '7764',
    conta: process.env.ITAU_CONTA || '22338-9',
    idBeneficiario: process.env.ITAU_ID_BENEFICIARIO || '776400223389',
    codigoCarteira: process.env.ITAU_CARTEIRA || '109',
  },

  empresa: {
    cnpj: process.env.EMPRESA_CNPJ || '22603750000190',
    nome: process.env.EMPRESA_NOME || 'AJL FERRO E ACO LTDA',
  },

  mtls: {
    cert: process.env.ITAU_CERT_CRT || '',
    key: process.env.ITAU_CERT_KEY || '',
    ca: process.env.ITAU_CERT_CA || '',
  },

  // --- Rede (Cartao de Credito / Checkout) ---
  rede: {
    pv: process.env.REDE_PV || '',
    chaveIntegracao: process.env.REDE_CHAVE_INTEGRACAO || '',
    softDescriptor: process.env.REDE_SOFT_DESCRIPTOR || 'AJL FERRO',
  },

  redeBaseUrl: (function() {
    var amb = process.env.REDE_AMBIENTE || 'producao';
    return amb === 'sandbox'
      ? 'https://sandbox.userede.com.br'
      : 'https://api.userede.com.br';
  })(),

  linkPagamento: {
    pv: process.env.REDE_PV || '',
    clientId: process.env.REDE_PV || '',
    clientSecret: process.env.REDE_CHAVE_INTEGRACAO || '',
    apiUrl: (function() {
      var amb = process.env.REDE_AMBIENTE || 'producao';
      return amb === 'sandbox'
        ? 'https://sandbox.userede.com.br/erede/v2'
        : 'https://api.userede.com.br/erede/v2';
    })(),
    tokenUrl: (function() {
      var amb = process.env.REDE_AMBIENTE || 'producao';
      return amb === 'sandbox'
        ? 'https://sandbox.userede.com.br/redelabs/oauth2/token'
        : 'https://api.userede.com.br/redelabs/oauth2/token';
    })(),
  },

  mockMode: process.env.MOCK_MODE === 'true',

  createMtlsConfig() {
    const hasCert = !!(this.mtls.cert && this.mtls.key);
    if (!hasCert) return { cert: null, key: null, hasMtls: false };
    return { cert: this.mtls.cert, key: this.mtls.key, hasMtls: true };
  },

  // --- Odoo ---
  odoo: {
    enabled: process.env.ODOO_PUSH_ENABLED === 'true',
    url: process.env.ODOO_URL || '',
    db: process.env.ODOO_DB || '',
    user: process.env.ODOO_USERNAME || '',
    password: process.env.ODOO_API_KEY || '',
  },

  // --- CNP Ja ---
  cnpjaApiBase: cnpjaApiBase,
  cnpjaApiToken: cnpjaApiToken,
  cnpjaUsingCommercial: !!cnpjaApiToken,
  cnpjaTimeout: parseInt(process.env.CNPJA_TIMEOUT, 10) || 15000,
};

// Warnings
if (!config.itau.pixChave) console.warn('[CONFIG] ITAU_PIX_CHAVE nao definida!');
if (!config.itau.clientId) console.warn('[CONFIG] ITAU_CLIENT_ID nao definida!');
if (!config.rede.pv) console.warn('[CONFIG] REDE_PV nao definida - checkout cartao indisponivel');
if (!config.rede.chaveIntegracao) console.warn('[CONFIG] REDE_CHAVE_INTEGRACAO nao definida - checkout cartao indisponivel');
if (!config.cnpjaApiToken && !process.env.CONSULTAR_IO_TOKEN) {
  console.warn('[CONFIG] Sem CNPJA_API_TOKEN nem CONSULTAR_IO_TOKEN - IE ficara indisponivel');
}

module.exports = config;