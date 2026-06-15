/**
 * routes/cnpj.js - Rotas CNP Ja (namespaced: /api/v1/cnpj/*)
 * Adaptado de cnpja-odoo/src/routes/api.routes.js
 */
const express = require('express');
const { CnpjaService, log } = require('../services/cnpja.service');
const { IeService } = require('../services/ie.service');
const { transformarParaOdoo, gerarResumo, verificarIE } = require('../services/transform.service');
const { apiKeyAuth } = require('../middleware/auth');

const router = express.Router();
const cnpja = new CnpjaService();
const ieService = new IeService();

/**
 * GET /api/v1/cnpj/consultar/:cnpj
 */
router.get('/consultar/:cnpj', apiKeyAuth, async (req, res) => {
  try {
    const { cnpj } = req.params;
    const formato = req.query.format || 'full';
    log.info(`Requisicao de consulta: CNPJ=${cnpj}, formato=${formato}`);

    const cnpjaData = await cnpja.consultarCNPJ(cnpj);
    const ieCnpja = verificarIE(cnpjaData.registrations);

    let ieExterna = null;
    if (!ieCnpja.hasIE) {
      const ufEmpresa = cnpjaData.address?.state || '';
      log.info(`CNPJ ${cnpj}: sem IE no CNP Ja, tentando fontes externas (UF: ${ufEmpresa})...`);
      const ieResult = await ieService.obterIE(cnpj, ieCnpja, ufEmpresa);
      if (ieResult.hasIE) {
        ieExterna = ieResult;
        log.info(`CNPJ ${cnpj}: IE encontrada via ${ieResult.source}: ${ieResult.ie} (${ieResult.ieState})`);
      }
    }

    const odooData = transformarParaOdoo(cnpjaData, ieExterna);

    if (formato === 'resumo') {
      return res.json({ success: true, data: gerarResumo(odooData) });
    }
    return res.json({ success: true, data: odooData });
  } catch (error) {
    log.error(`Erro na consulta: ${error.message}`);
    return res.status(error.message.includes('nao encontrado') ? 404 : 422).json({
      success: false, error: error.message,
    });
  }
});

/**
 * POST /api/v1/cnpj/consultar
 */
router.post('/consultar', apiKeyAuth, async (req, res) => {
  try {
    const { cnpj } = req.body;
    if (!cnpj) {
      return res.status(400).json({ success: false, error: 'CNPJ e obrigatorio no corpo da requisicao.' });
    }
    log.info(`Requisicao POST de consulta: CNPJ=${cnpj}`);

    const cnpjaData = await cnpja.consultarCNPJ(cnpj);
    const ieCnpja = verificarIE(cnpjaData.registrations);

    let ieExterna = null;
    if (!ieCnpja.hasIE) {
      const ufEmpresa = cnpjaData.address?.state || '';
      const ieResult = await ieService.obterIE(cnpj, ieCnpja, ufEmpresa);
      if (ieResult.hasIE) ieExterna = ieResult;
    }

    const odooData = transformarParaOdoo(cnpjaData, ieExterna);
    return res.json({ success: true, data: odooData });
  } catch (error) {
    log.error(`Erro na consulta POST: ${error.message}`);
    return res.status(error.message.includes('nao encontrado') ? 404 : 422).json({
      success: false, error: error.message,
    });
  }
});

/**
 * GET /api/v1/cnpj/regras-imposto
 */
router.get('/regras-imposto', apiKeyAuth, (req, res) => {
  res.json({
    success: true,
    data: {
      regras: [
        {
          condicao: 'Possui Inscricao Estadual (IE) ativa',
          aliquota: 12,
          descricao: 'Empresa contribuinte do ICMS com IE regular. Aliquota de 12% para ICMS-ST.',
        },
        {
          condicao: 'NAO possui Inscricao Estadual (IE)',
          aliquota: 19,
          descricao: 'Empresa nao contribuinte ou isenta. Aliquota de 19% para ICMS-ST.',
        },
      ],
    },
  });
});

module.exports = router;