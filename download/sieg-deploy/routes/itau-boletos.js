/**
 * routes/itau-boletos.js - PDF de Boleto (namespaced: /api/v1/itau/boletos/*)
 */
const express = require('express');
const router = express.Router();
const { storeBoleto, getBoleto, getTxidByNn, generatePdf, generatePdfFromData, generatePdfFromFields } = require('../services/pdf-boleto');

router.post('/pdf', async function(req, res) {
  try {
    var b = await generatePdfFromData(req.body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=boleto.pdf');
    res.send(b);
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

router.post('/regen', async function(req, res) {
  try {
    var pdfBuf = await generatePdfFromFields(req.body);
    var b64 = pdfBuf.toString('base64');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send('OK|' + b64);
  } catch(e) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send('ERRO|' + e.message);
  }
});

router.get('/pdf/nn/:nosso_numero', async function(req, res) {
  try {
    var nn = req.params.nosso_numero;
    var txid = getTxidByNn(nn);
    if (!txid) {
      return res.status(404).json({ erro: 'Boleto nao encontrado na memoria.', solucao: 'Os PDFs ja foram anexados no Odoo.', nosso_numero: nn });
    }
    var dados = getBoleto(txid);
    if (!dados) {
      return res.status(404).json({ erro: 'Dados do boleto nao encontrados na memoria.' });
    }
    var b = await generatePdf(txid);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=boleto-' + nn + '.pdf');
    res.send(b);
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

router.get('/pdf/:txid', async function(req, res) {
  try {
    var txid = req.params.txid;
    var dados = getBoleto(txid);
    if (!dados) {
      return res.status(404).json({ erro: 'Boleto nao encontrado na memoria.' });
    }
    var b = await generatePdf(txid);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=boleto-' + txid + '.pdf');
    res.send(b);
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

router.get('/info/:nosso_numero', async function(req, res) {
  var nn = req.params.nosso_numero;
  res.status(400).json({
    erro: 'Itau API nao suporta busca por nosso_numero (HTTP 405).',
    solucao: 'Use POST /api/v1/itau/regen para gerar o PDF.',
  });
});

module.exports = router;