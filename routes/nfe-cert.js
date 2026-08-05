/**
 * routes/nfe-cert.js — Certificado A1 e emissao propria na SEFAZ
 *
 * POST   /api/v1/nfe/certificado         — upload do .pfx (base64 + senha)
 * GET    /api/v1/nfe/certificado         — status do certificado carregado
 * DELETE /api/v1/nfe/certificado         — remove o certificado
 * GET    /api/v1/nfe/sefaz/status        — status do servico da SEFAZ (testa mTLS)
 * POST   /api/v1/nfe/danfe               — gera o DANFE PDF localmente a partir do XML
 */
var express = require('express');
var router = express.Router();
var { apiKeyAuth } = require('../middleware/auth');
var { salvarCertificado, statusCertificado, removerCertificado } = require('../services/nfe-cert');
var { statusServico } = require('../services/sefaz-client');
var { gerarDanfePdf } = require('../services/danfe-pdf');

// Upload do certificado A1 (protegido por API key)
router.post('/certificado', apiKeyAuth, express.json({ limit: '10mb' }), function (req, res) {
  try {
    var body = req.body || {};
    var b64 = body.pfxBase64 || body.pfx_base64 || body.certificado || body.arquivo;
    var senha = body.senha || body.password || body.pfxSenha;
    if (!b64) return res.status(400).json({ erro: 'Envie o arquivo .pfx em base64 no campo "pfxBase64".' });
    if (!senha) return res.status(400).json({ erro: 'Campo "senha" obrigatorio.' });

    var buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
    var info = salvarCertificado(buf, senha);
    res.json({ sucesso: true, mensagem: 'Certificado A1 armazenado com sucesso.', certificado: info });
  } catch (err) {
    console.error('[NFE-CERT] Erro no upload: ' + err.message);
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

router.get('/certificado', apiKeyAuth, function (req, res) {
  res.json(statusCertificado());
});

router.delete('/certificado', apiKeyAuth, function (req, res) {
  removerCertificado();
  res.json({ sucesso: true, mensagem: 'Certificado removido.' });
});

// Testa conexao mTLS com a SEFAZ usando o certificado carregado
router.get('/sefaz/status', apiKeyAuth, async function (req, res) {
  try {
    res.json(await statusServico());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Gera o DANFE PDF localmente (sem SIEG)
router.post('/danfe', apiKeyAuth, express.json({ limit: '10mb' }), async function (req, res) {
  try {
    var xml = req.body && (req.body.xml || (req.body.xmlBase64 ? Buffer.from(req.body.xmlBase64, 'base64').toString('utf8') : ''));
    if (!xml) return res.status(400).json({ erro: 'Informe "xml" (nfeProc autorizado) ou "xmlBase64".' });
    var pdf = await gerarDanfePdf(xml);
    if (req.query.base64 === '1') return res.json({ sucesso: true, pdfBase64: pdf.toString('base64') });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="danfe.pdf"');
    res.send(pdf);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

module.exports = router;
