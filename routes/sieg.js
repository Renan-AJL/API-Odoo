/**
 * routes/sieg.js — Rotas de emissao fiscal SIEG
 * 
 * GET  /api/v1/sieg/status            — Status dos tokens SIEG
 * GET  /api/v1/sieg/oauth-url          — Gerar URL de autorizacao OAuth
 * POST /api/v1/sieg/emitir             — Emitir NF-e ou NFS-e (auto-detect)
 * POST /api/v1/sieg/emitir-nfe         — Emitir NF-e (produtos)
 * POST /api/v1/sieg/emitir-nfse        — Emitir NFS-e (servicos)
 * POST /api/v1/sieg/danfe              — Gerar DANFE a partir de XML
 * POST /api/v1/sieg/process-pending    — Poll: processar emissoes pendentes
 * GET  /callback/sieg                  — OAuth callback SIEG (recebe token temp)
 */
const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const { 
  getTokenState, 
  getOAuthAuthorizeUrl, 
  exchangeTempToken,
  setOAuthToken,
} = require('../services/sieg-auth');
const { emitirNota, enviarNFe, emitirNFSe, gerarDanfe, gerarDanfse } = require('../services/sieg-api');
const { processPendingEmissions } = require('../services/sieg-odoo-emit');
const { cancelarNFeOdoo } = require('../services/nfe-cancelar-odoo');

// === OAuth Callback ===
// A SIEG redireciona aqui apos o usuario autorizar o acesso.
// O SIEG pode retornar o token temporario em varios query params.
router.get('/callback/sieg', async (req, res) => {
  try {
    // Tentar varios nomes de parametro que o SIEG pode usar
    var temporaryToken = req.query.temporaryToken || req.query.tempToken ||
                         req.query.code || req.query.token || req.query.accessToken ||
                         req.query.AccessToken;
    var state = req.query.state;
    var redirectUri = req.protocol + '://' + req.get('host') + '/callback/sieg';
    
    if (!temporaryToken) {
      console.log('[SIEG-CALLBACK] Callback recebido. Query:', JSON.stringify(req.query));
      return res.status(400).json({ erro: 'Token temporario nao fornecido. Query params recebidos: ' + JSON.stringify(req.query) });
    }
    
    console.log('[SIEG-CALLBACK] Token temporario recebido (' + temporaryToken.length + ' chars), trocando por definitivo... (state=' + state + ')');
    
    var tokens = await exchangeTempToken(temporaryToken, state, redirectUri);
    
    res.send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f4f8">' +
      '<div style="max-width:500px;margin:0 auto;background:white;padding:40px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.1)">' +
      '<h2 style="color:#16a34a">SIEG Integrado com sucesso!</h2>' +
      '<p>Token OAuth definitivo obtido.</p>' +
      '<p style="color:#666;font-size:14px">Validade: 30 dias. Voce pode fechar esta aba.</p>' +
      '<p style="color:#999;font-size:12px">State: ' + (state || 'N/A') + '</p>' +
      '</div></body></html>'
    );
  } catch (err) {
    console.error('[SIEG-CALLBACK] Erro:', err.message);
    res.status(500).send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:50px">' +
      '<h2 style="color:#dc2626">Erro na autenticacao SIEG</h2>' +
      '<p>' + err.message + '</p>' +
      '<p style="color:#999">Verifique os logs do servidor para detalhes.</p>' +
      '</body></html>'
    );
  }
});

// === Status dos tokens ===
router.get('/status', apiKeyAuth, async (req, res) => {
  try {
    const state = getTokenState();
    res.json({ sieg_auth: state });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Gerar URL de autorizacao OAuth ===
// Retorna a URL que o usuario deve visitar para autorizar o acesso
router.get('/oauth-url', apiKeyAuth, async (req, res) => {
  try {
    var accessLevel = req.query.accessLevel || 'write';
    var state = req.query.state || null;
    var result = getOAuthAuthorizeUrl(state, accessLevel);
    res.json({ 
      authorize_url: result.url,
      state: result.state,
      instrucoes: 'Abra esta URL no navegador, faca login na SIEG e autorize o acesso. O token sera enviado para o callback configurado.'
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Emitir NF (auto-detect NF-e ou NFS-e) ===
router.post('/emitir', apiKeyAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const dados = req.body;
    if (!dados || !dados.company || !dados.partner || !dados.lines || !dados.lines.length) {
      return res.status(400).json({ erro: 'Dados obrigatorios: company, partner, lines' });
    }
    console.log('[SIEG] Emitir NF pedido ' + (dados.order && dados.order.name || '?') + ' - ' + dados.lines.length + ' linhas');

    const resultado = await emitirNota(dados);
    const duracao = Date.now() - t0;
    console.log('[SIEG] NF ' + resultado.tipo + ' processada em ' + duracao + 'ms - sucesso: ' + resultado.sucesso);

    res.json({
      sucesso: resultado.sucesso,
      tipo: resultado.tipo,
      duracao_ms: duracao,
      resposta_sieg: resultado.resposta,
      erro: resultado.erro,
      pdf_gerado: resultado.pdfGerado,
      pdf_base64: resultado.pdfGerado ? resultado.pdfBase64 : undefined,
    });
  } catch (err) {
    const duracao = Date.now() - t0;
    console.error('[SIEG] Erro ao emitir NF (' + duracao + 'ms):', err.message);
    res.status(500).json({
      sucesso: false,
      duracao_ms: duracao,
      erro: err.message,
      detalhes: err.response && err.response.data || null,
    });
  }
});

// === Emitir NF-e (forcar produto) ===
router.post('/emitir-nfe', apiKeyAuth, async (req, res) => {
  try {
    req.body.tipo = 'nfe';
    const resultado = await emitirNota(req.body);
    res.json({ sucesso: resultado.sucesso, tipo: 'nfe', resposta_sieg: resultado.resposta, erro: resultado.erro });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Emitir NFS-e (forcar servico) ===
router.post('/emitir-nfse', apiKeyAuth, async (req, res) => {
  try {
    req.body.tipo = 'nfse';
    const resultado = await emitirNota(req.body);
    res.json({ sucesso: resultado.sucesso, tipo: 'nfse', resposta_sieg: resultado.resposta, erro: resultado.erro });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Gerar DANFE (PDF) a partir de XML ===
router.post('/danfe', apiKeyAuth, async (req, res) => {
  try {
    const xml = req.body.xml;
    if (!xml) return res.status(400).json({ erro: 'XML obrigatorio' });
    const pdf = await gerarDanfe(xml);
    res.json({ sucesso: true, pdf_base64: pdf });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === PROCESSAR EMISSOES PENDENTES (Polling / Cron) ===
router.post('/process-pending', apiKeyAuth, async (req, res) => {
  console.log('[SIEG] process-pending chamado');
  try {
    const resultado = await processPendingEmissions();
    res.json({
      sucesso: true,
      processadas: resultado.processed,
      autorizadas: resultado.sucesso || 0,
      detalhes: resultado.detalhes || [],
    });
  } catch (err) {
    console.error('[SIEG] Erro process-pending:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === WEBHOOK do Odoo ===
router.post('/webhook', apiKeyAuth, async (req, res) => {
  console.log('[SIEG] Webhook recebido do Odoo:', JSON.stringify(req.body).substring(0, 300));
  try {
    const resultado = await processPendingEmissions();
    res.json({
      sucesso: true,
      processadas: resultado.processed,
      autorizadas: resultado.sucesso || 0,
    });
  } catch (err) {
    console.error('[SIEG] Erro webhook:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === CANCELAR NF-e ===
// Recebe: { move_id, justificativa }
// Cancela na SEFAZ + reverte fatura no Odoo
router.post('/cancelar', apiKeyAuth, async (req, res) => {
  var moveId       = req.body.move_id;
  var justificativa = req.body.justificativa || 'Cancelamento solicitado pelo emitente';
  if (!moveId) return res.status(400).json({ sucesso: false, erro: 'move_id obrigatorio' });
  console.log('[NFE-CANCEL] Solicitacao de cancelamento move_id=' + moveId + ' just=' + justificativa.slice(0, 50));
  try {
    var resultado = await cancelarNFeOdoo({ moveId, justificativa });
    res.json(resultado);
  } catch (err) {
    console.error('[NFE-CANCEL] Erro:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

module.exports = router;
