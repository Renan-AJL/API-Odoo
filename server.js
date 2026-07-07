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
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'AppKey', 'RequesterKey'],
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
const teDeliveryRoutes = require('./routes/delivery');
const teWebhookRoutes = require('./routes/webhook-te');

app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/cnpj', cnpjRoutes);
app.use('/api/v1/itau', itauApiRoutes);
app.use('/api/v1/itau/boletos', itauBoletosRoutes);
app.use('/api/v1/itau/webhook', itauWebhookRoutes);
app.use('/api/v1/itau/token', itauTokenRoutes);
app.use('/api/v1/te', teDeliveryRoutes);
app.use('/api/v1/te/webhook', teWebhookRoutes);

// --- Root ---
app.get('/', (req, res) => {
  res.json({
    service: 'Odoo Middleware Unificado',
    version: '1.1.0',
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
      tudoentregue: {
        status: config.isTeConfigured ? 'configurado' : 'nao_configurado',
        baseUrl: config.tudoentregue.baseUrl,
      },
    },
    endpoints: {
      health: 'GET /api/v1/health',
      cnpj_consultar: 'GET /api/v1/cnpj/consultar/:cnpj',
      itau_pagar: 'POST /api/v1/itau/pagar',
      itau_gerar: 'POST /api/v1/itau/gerar',
      itau_pdf_txid: 'GET /api/v1/itau/boletos/pdf/:txid',
      itau_webhook_pix: 'POST /api/v1/itau/webhook/pix-confirmacao',
      te_send: 'POST /api/v1/te/send',
      te_webhook: 'POST /api/v1/te/webhook/tudoentregue',
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
const logger = require('./utils/logger');

app.listen(PORT, () => {
  const mtls = config.createMtlsConfig();
  console.log('');
  console.log('===========================================================');
  console.log('  Middleware Unificado Odoo v1.1.0');
  console.log('  Itau + CNP Ja + TudoEntregue');
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
  console.log('  ---');
  console.log('  [TUDOENTREGUE]');
  console.log('  Configurado:', config.isTeConfigured ? 'SIM' : 'NAO');
  if (config.isTeConfigured) {
    console.log('  Base URL:', config.tudoentregue.baseUrl);
    console.log('  AppKey: ***' + config.tudoentregue.appKey.slice(-4));
  }
  console.log('===========================================================');
  console.log('');

  // --- Auto-sync TudoEntregue ---
  if (config.isTeConfigured && config.odoo.enabled) {
    var syncIntervalMs = parseInt(process.env.TE_SYNC_INTERVAL_MS, 10) || 180000; // 3 min
    var firstRunDelay = 10000; // 10s apos start

    var teAutoSync = require('./routes/delivery')._runAutoSync;

    setTimeout(function() {
      logger.info('[TE-AUTO-SYNC] Primeira execucao (delay=' + firstRunDelay + 'ms)');
      teAutoSync().catch(function(err) {
        logger.error('[TE-AUTO-SYNC] Erro na primeira execucao: ' + err.message);
      });
    }, firstRunDelay);

    setInterval(function() {
      logger.info('[TE-AUTO-SYNC] Execucao periodica (intervalo=' + syncIntervalMs + 'ms)');
      teAutoSync().catch(function(err) {
        logger.error('[TE-AUTO-SYNC] Erro na execucao periodica: ' + err.message);
      });
    }, syncIntervalMs);

    console.log('  [TE-AUTO-SYNC] Ativo! Intervalo: ' + (syncIntervalMs / 1000) + 's | Primeira execucao em ' + (firstRunDelay / 1000) + 's');
  } else {
    console.log('  [TE-AUTO-SYNC] DESATIVADO (TE ou Odoo nao configurados)');
  }
});

module.exports = app;