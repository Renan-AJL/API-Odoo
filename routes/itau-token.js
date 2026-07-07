/**
 * routes/itau-token.js - Token Itau (namespaced: /api/v1/itau/token/*)
 */
const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const { getAccessToken, invalidateToken, getTokenStatus } = require('../services/itau-auth');

router.get('/status', apiKeyAuth, (req, res) => {
  res.json(getTokenStatus());
});

router.post('/gerar', apiKeyAuth, async (req, res) => {
  try {
    invalidateToken();
    const token = await getAccessToken();
    res.json({ sucesso: true, token: token });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

module.exports = router;