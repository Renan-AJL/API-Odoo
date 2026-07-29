/**
 * routes/sieg.js — Rotas de emissão fiscal SIEG
 * 
 * GET  /api/v1/sieg/status         — Status do token SIEG
 * POST /api/v1/sieg/emitir          — Emitir NF-e ou NFS-e (auto-detect)
 * POST /api/v1/sieg/emitir-nfe      — Emitir NF-e (produtos)
 * POST /api/v1/sieg/emitir-nfse     — Emitir NFS-e (serviços)
 * POST /api/v1/sieg/danfe           — Gerar DANFE a partir de XML
 * POST /api/v1/sieg/danfse          — Gerar DANFSE a partir de XML
 * GET  /callback/sieg              — OAuth callback SIEG
 */
const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const { exchangeCode, getTokenState, setTokens } = require('../services/sieg-auth');
const { emitirNota, enviarNFe, emitirNFSe, gerarDanfe, gerarDanfse } = require('../services/sieg-api');
const { pushToOdoo } = require('../services/odoo-push');
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

// === Emitir NF (auto-detect NF-e ou NFS-e) ===
router.post('/emitir', apiKeyAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const dados = req.body;
    if (!dados || !dados.company || !dados.partner || !dados.lines?.length) {
      return res.status(400).json({ erro: 'Dados obrigatorios: company, partner, lines' });
    }
    console.log(`[SIEG] Emitir NF pedido ${dados.order?.name || '?'} - ${dados.lines.length} linhas`);

    const resultado = await emitirNota(dados);
    const duracao = Date.now() - t0;
    console.log(`[SIEG] NF ${resultado.tipo} processada em ${duracao}ms - sucesso: ${resultado.sucesso}`);

    // Push resultado de volta ao Odoo
    if (resultado.sucesso && dados.order?.id) {
      try {
        await pushResultadoEmissao(resultado, dados);
      } catch (errPush) {
        console.error('[SIEG] Erro ao push resultado para Odoo:', errPush.message);
      }
    }

    res.json({
      sucesso: true,
      tipo: resultado.tipo,
      duracao_ms: duracao,
      xml_enviado: resultado.xmlEnviado,
      resposta_sieg: resultado.resposta,
      pdf_gerado: resultado.pdfGerado,
      pdf_base64: resultado.pdfGerado ? resultado.pdfBase64 : undefined,
    });
  } catch (err) {
    const duracao = Date.now() - t0;
    console.error(`[SIEG] Erro ao emitir NF (${duracao}ms):`, err.message);
    res.status(500).json({
      sucesso: false,
      duracao_ms: duracao,
      erro: err.message,
      detalhes: err.response?.data || null,
    });
  }
});

// === Emitir NF-e (forçar produto) ===
router.post('/emitir-nfe', apiKeyAuth, async (req, res) => {
  try {
    req.body.tipo = 'nfe';
    // Reuse the emitir logic
    const resultado = await emitirNota(req.body);
    res.json({ sucesso: true, tipo: 'nfe', resposta_sieg: resultado.resposta, pdf_base64: resultado.pdfBase64 });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Emitir NFS-e (forçar serviço) ===
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
    if (!xml) return res.status(400).json({ erro: 'XML obrigatório' });
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
    if (!xml) return res.status(400).json({ erro: 'XML obrigatório' });
    const pdf = await gerarDanfse(xml);
    res.json({ sucesso: true, pdf_base64: pdf });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Push resultado de emissão para o Odoo (account.move) ===
async function pushResultadoEmissao(resultado, dados) {
  if (!dados.order?.id || !config.ODOO_URL) return;
  
  const model = 'account.move';
  const recordId = dados.order.id;
  const vals = {};

  const resp = resultado.resposta || {};
  if (resultado.tipo === 'nfe') {
    const chave = resp.chNFe || resp.chave || resp.ChaveXml || '';
    const protocolo = resp.nProt || resp.protocolo || '';
    const motivo = resp.xMotivo || resp.motivo || 'Processado';
    const cStat = resp.cStat || resp.status || '';
    vals.x_studio_nfe_chave = chave;
    vals.x_studio_nfe_status = cStat ? `${cStat} - ${motivo}` : motivo;
    vals.x_studio_nfe_protocolo = protocolo;
  } else {
    const numero = resp.nDFSe || resp.numero || resp.nNFSe || '';
    vals.x_studio_nfse_numero = numero;
    vals.x_studio_nfse_status = 'Autorizada';
  }

  await pushToOdoo(model, recordId, vals);
}

module.exports = router;
