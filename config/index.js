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
  middlewareApiKey: process.env.MIDDLEWARE_API_KEY || 'change-me-unified-key',
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE, 10) || 60,
  debug: process.env.DEBUG === 'true',

  // --- Itau ---
  itau: {
    clientId: process.env.ITAU_CLIENT_ID || '',
    clientSecret: process.env.ITAU_CLIENT_SECRET || '',
    tokenUrl: process.env.ITAU_TOKEN_URL || (isSandbox
      ? 'https://sandbox.devportal.itau.com.br/itau-ep9-gtw-autenticacao-ext/oauth/v2/token'
      : 'https://sts.itau.com.br/api/oauth/token'),
    bolecodeBaseUrl: process.env.ITAU_BOLECODE_URL || (isSandbox
      ? 'https://sandbox.devportal.itau.com.br/itau-ep9-gtw-cash-management-ext-v2/v2'
      : 'https://api.itau.com.br/cash_management/v2'),
    pixBaseUrl: process.env.ITAU_PIX_URL || (isSandbox
      ? 'https://sandbox.devportal.itau.com.br/itau-ep9-gtw-pix-ext-v2'
      : 'https://api.itau.com.br/pix/v2'),
    pixChave: process.env.ITAU_PIX_CHAVE || '',
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
if (!config.cnpjaApiToken && !process.env.CONSULTAR_IO_TOKEN) {
  console.warn('[CONFIG] Sem CNPJA_API_TOKEN nem CONSULTAR_IO_TOKEN - IE ficara indisponivel');
}

module.exports = config;