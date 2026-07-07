/**
 * server.js - Middleware Unificado Odoo v1.0.0
 * ================================================
 * Combina Itau (Boleto/PIX) + CNP Ja em um unico servidor.
 * Uma API Key para tudo. Uma mensalidade no Render.
 *
 * Rotas:
 *   GET  /                          - Info do servico
 *   GET  /api/v1/health             - Health check unificado
 *
 *   CNP Ja:
 *   GET  /api/v1/cnpj/consultar/:cnpj
 *   POST /api/v1/cnpj/consultar
 *   GET  /api/v1/cnpj/regras-imposto
 *
 *   Itau:
 *   POST /api/v1/itau/pagar         - Emitir boletos + PDF + push Odoo
 *   POST /api/v1/itau/gerar         - Simplificado (Odoo Server Actions)
 *   POST /api/v1/itau/regen         - Regenerar PDF de campos Odoo
 *   GET  /api/v1/itau/boletos/pdf/:txid
 *   GET  /api/v1/itau/boletos/pdf/nn/:nosso_numero
 *   POST /api/v1/itau/boletos/pdf
 *   POST /api/v1/itau/boletos/regen
 *   POST /api/v1/itau/webhook/pix-confirmacao
 *   POST /api/v1/itau/webhook/bolecode-confirmacao
 *   GET  /api/v1/itau/token/status
 *   POST /api/v1/itau/token/gerar
 * ================================================
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');

const app = express();
app.set('trust proxy', 1);

// --- Security ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
}));

// --- Rate Limiting ---
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimitPerMinute,
  message: { success: false, error: 'Muitas requisicoes. Aguarde e tente novamente.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// --- Parsing ---
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Logging ---
if (config.nodeEnv !== 'test') {
  app.use(morgan('combined'));
}

// --- Routes ---
const healthRoutes = require('./routes/health');
const cnpjRoutes = require('./routes/cnpj');
const itauApiRoutes = require('./routes/itau-api');
const itauBoletosRoutes = require('./routes/itau-boletos');
const itauWebhookRoutes = require('./routes/itau-webhook');
const itauTokenRoutes = require('./routes/itau-token');

app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/cnpj', cnpjRoutes);
app.use('/api/v1/itau', itauApiRoutes);
app.use('/api/v1/itau/boletos', itauBoletosRoutes);
app.use('/api/v1/itau/webhook', itauWebhookRoutes);
app.use('/api/v1/itau/token', itauTokenRoutes);

// --- Root ---
app.get('/', (req, res) => {
  res.json({
    service: 'Odoo Middleware Unificado',
    version: '1.0.0',
    empresa: config.empresa.nome,
    status: 'online',
    odoo_push: config.odoo.enabled ? 'ATIVO' : 'DESATIVADO',
    modules: {
      itau: {
        status: config.itau.clientId ? 'configurado' : 'nao_configurado',
        ambiente: config.mockMode ? 'MOCK' : (process.env.AMBIENTE || 'producao'),
        mTLS: config.createMtlsConfig().hasMtls ? 'SIM' : 'NAO',
      },
      cnpja: {
        status: 'configurado',
        api: config.cnpjaApiBase,
        commercial: config.cnpjaUsingCommercial,
      },
    },
    endpoints: {
      health: 'GET /api/v1/health',
      cnpj_consultar: 'GET /api/v1/cnpj/consultar/:cnpj',
      itau_pagar: 'POST /api/v1/itau/pagar',
      itau_gerar: 'POST /api/v1/itau/gerar',
      itau_pdf_txid: 'GET /api/v1/itau/boletos/pdf/:txid',
      itau_webhook_pix: 'POST /api/v1/itau/webhook/pix-confirmacao',
    },
    auth: 'Envie header X-API-Key para autenticacao.',
  });
});

// --- Error Handlers ---
app.use((req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada', path: req.path });
});
app.use((err, req, res, next) => {
  console.error('[SERVER] Erro nao tratado:', err);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

// --- Start ---
const PORT = config.port;
app.listen(PORT, () => {
  const mtls = config.createMtlsConfig();
  console.log('');
  console.log('===========================================================');
  console.log('  Middleware Unificado Odoo v1.0.0');
  console.log('  Itau (Boleto/PIX) + CNP Ja - Tudo em um so servidor');
  console.log('===========================================================');
  console.log('  Porta:', PORT);
  console.log('  Ambiente:', config.nodeEnv);
  console.log('  Auth: MIDDLEWARE_API_KEY configurada');
  console.log('  ---');
  console.log('  [ITAU]');
  console.log('  Client ID: ***' + (config.itau.clientId ? config.itau.clientId.substring(config.itau.clientId.length - 4) : 'N/A'));
  console.log('  mTLS:', mtls.hasMtls ? 'SIM' : 'NAO');
  console.log('  PIX Chave:', config.itau.pixChave || 'NAO');
  console.log('  Agencia:', config.banco.agencia, '| Conta:', config.banco.conta);
  console.log('  Mock Mode:', config.mockMode);
  console.log('  Odoo Push:', config.odoo.enabled ? 'ATIVO' : 'DESATIVADO');
  if (config.odoo.enabled) console.log('  Odoo URL:', config.odoo.url);
  console.log('  ---');
  console.log('  [CNP JA]');
  console.log('  API:', config.cnpjaApiBase);
  console.log('  Token:', config.cnpjaApiToken ? 'COMERCIAL' : 'PUBLICA (sem IE)');
  console.log('===========================================================');
  console.log('');
});

module.exports = app;