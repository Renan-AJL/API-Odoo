/**
 * routes/sieg.js — Rotas de emissao fiscal SIEG
 * 
 * GET  /api/v1/sieg/status            — Status do token SIEG
 * POST /api/v1/sieg/emitir             — Emitir NF-e ou NFS-e (auto-detect, dados inline)
 * POST /api/v1/sieg/emitir-nfe         — Emitir NF-e (produtos)
 * POST /api/v1/sieg/emitir-nfse        — Emitir NFS-e (servicos)
 * POST /api/v1/sieg/danfe              — Gerar DANFE a partir de XML
 * POST /api/v1/sieg/danfse             — Gerar DANFSE a partir de XML
 * POST /api/v1/sieg/process-pending    — Poll: processar emissoes pendentes do Odoo
 * POST /api/v1/sieg/webhook            — Webhook: Odoo notifica que ha pendente
 * GET  /callback/sieg                 — OAuth callback SIEG
 */
const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const { exchangeCode, getTokenState, setTokens } = require('../services/sieg-auth');
const { emitirNota, enviarNFe, emitirNFSe, gerarDanfe, gerarDanfse } = require('../services/sieg-api');
const { processPendingEmissions } = require('../services/sieg-odoo-emit');
const config = require('../config');

// === OAuth Callback ===
router.get('/callback/sieg', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) {
      return res.status(400).json({ erro: 'Codigo de autorizacao nao fornecido' });
    }
    console.log('[SIEG-CALLBACK] Recebido code OAuth, trocando por token...');
    const tokens = await exchangeCode(code);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
      <h2>SIEG Integrado com sucesso!</h2>
      <p>Token obtido. Voce pode fechar esta aba.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[SIEG-CALLBACK] Erro:', err.message);
    res.status(500).send('Erro na autenticacao SIEG: ' + err.message);
  }
});

// === Status do token ===
router.get('/status', apiKeyAuth, async (req, res) => {
  try {
    const state = getTokenState();
    res.json({ sieg_auth: state });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Emitir NF (auto-detect NF-e ou NFS-e) — dados enviados inline ===
router.post('/emitir', apiKeyAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const dados = req.body;
    if (!dados || !dados.company || !dados.partner || !dados.lines?.length) {
      return res.status(400).json({ erro: 'Dados obrigatorios: company, partner, lines' });
    }
    console.log('[SIEG] Emitir NF pedido ' + (dados.order?.name || '?') + ' - ' + dados.lines.length + ' linhas');

    const resultado = await emitirNota(dados);
    const duracao = Date.now() - t0;
    console.log('[SIEG] NF ' + resultado.tipo + ' processada em ' + duracao + 'ms - sucesso: ' + resultado.sucesso);

    res.json({
      sucesso: resultado.sucesso,
      tipo: resultado.tipo,
      duracao_ms: duracao,
      xml_enviado: resultado.xmlEnviado,
      resposta_sieg: resultado.resposta,
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
      detalhes: err.response?.data || null,
    });
  }
});

// === Emitir NF-e (forcar produto) ===
router.post('/emitir-nfe', apiKeyAuth, async (req, res) => {
  try {
    req.body.tipo = 'nfe';
    const resultado = await emitirNota(req.body);
    res.json({ sucesso: true, tipo: 'nfe', resposta_sieg: resultado.resposta, pdf_base64: resultado.pdfBase64 });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Emitir NFS-e (forcar servico) ===
router.post('/emitir-nfse', apiKeyAuth, async (req, res) => {
  try {
    req.body.tipo = 'nfse';
    const resultado = await emitirNota(req.body);
    res.json({ sucesso: true, tipo: 'nfse', resposta_sieg: resultado.resposta, pdf_base64: resultado.pdfBase64 });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Gerar DANFE (PDF) a partir de XML ===
router.post('/danfe', apiKeyAuth, async (req, res) => {
  try {
    const { xml } = req.body;
    if (!xml) return res.status(400).json({ erro: 'XML obrigatorio' });
    const pdf = await gerarDanfe(xml);
    res.json({ sucesso: true, pdf_base64: pdf });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Gerar DANFSE (PDF) a partir de XML ===
router.post('/danfse', apiKeyAuth, async (req, res) => {
  try {
    const { xml } = req.body;
    if (!xml) return res.status(400).json({ erro: 'XML obrigatorio' });
    const pdf = await gerarDanfse(xml);
    res.json({ sucesso: true, pdf_base64: pdf });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === PROCESSAR EMISSOES PENDENTES (Polling / Cron) ===
// Conecta ao Odoo via XML-RPC, busca faturas com status 'pendente',
// extrai dados, emite via SIEG, e devolve XML+PDF no chatter.
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

// === WEBHOOK do Odoo (Outgoing Webhook) ===
// Recebe POST do Odoo quando x_studio_status_emissao muda para 'pendente'.
// Opcional: se o Odoo SaaS suportar Outgoing Webhooks, configure:
//   URL: https://<middleware>/api/v1/sieg/webhook
//   Header: X-API-Key: <sua-chave>
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

module.exports = router;
