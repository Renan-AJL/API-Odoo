/**
 * routes/cep.js - Rotas de consulta de CEP (namespaced: /api/v1/cep/*)
 * ============================================================
 * Endpoint principal:
 *   POST /api/v1/cep
 *   Body: { "cep": "83323-000" }
 *
 * Adaptado de Api-CEP-Odoo-AJL-main/main.py (Python/FastAPI)
 * para o padrao Node.js/Express do middleware AJL.
 * Utiliza apiKeyAuth (mesma autenticacao das demais rotas).
 */
const express = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { consultarCEP } = require('../services/cep.service');

const router = express.Router();

/**
 * POST /api/v1/cep
 * Consulta CEP com fallback multi-fonte (OpenCEP → Cepify → ViaCEP → BrasilAPI).
 *
 * Body:
 *   { "cep": "83323-000" }   // com mascara
 *   { "cep": "83323000" }    // sem mascara
 *
 * Response (sucesso):
 *   {
 *     "sucesso": true,
 *     "fonte": "OpenCEP",
 *     "cep": "83323-000",
 *     "rua": "...",
 *     "bairro": "...",
 *     "cidade": "...",
 *     "estado": "PR",
 *     "pais": "Brasil",
 *     "ibge_cidade": "4108304",
 *     "ibge_estado": null
 *   }
 *
 * Response (erro):
 *   { "sucesso": false, "erro": "CEP invalido...", "cep_recebido": "..." }
 */
router.post('/cep', apiKeyAuth, async (req, res) => {
  try {
    const { cep } = req.body;

    if (!cep) {
      return res.status(400).json({
        sucesso: false,
        erro: 'CEP e obrigatorio no corpo da requisicao. Envie: { "cep": "83323-000" }',
      });
    }

    const resultado = await consultarCEP(cep);

    if (!resultado.sucesso) {
      const status = resultado.erro && resultado.erro.includes('invalido') ? 400 : 502;
      return res.status(status).json(resultado);
    }

    return res.json(resultado);
  } catch (error) {
    console.error('[CEP] Erro na rota /cep:', error.message);
    return res.status(500).json({
      sucesso: false,
      erro: 'Erro interno ao consultar CEP.',
    });
  }
});

/**
 * GET /api/v1/cep/fontes
 * Lista as fontes de consulta disponiveis (utilitario).
 */
router.get('/fontes', apiKeyAuth, (_req, res) => {
  res.json({
    sucesso: true,
    fontes: [
      { nome: 'OpenCEP',   ordem: 1, tipo: 'principal',  url: 'https://opencep.com' },
      { nome: 'Cepify',    ordem: 2, tipo: 'fallback',   url: 'https://cepify.com.br' },
      { nome: 'ViaCEP',    ordem: 3, tipo: 'fallback',   url: 'https://viacep.com.br' },
      { nome: 'BrasilAPI', ordem: 4, tipo: 'fallback',   url: 'https://brasilapi.com.br' },
    ],
  });
});

module.exports = router;
