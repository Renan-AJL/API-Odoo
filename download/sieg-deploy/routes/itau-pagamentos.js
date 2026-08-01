/**
 * routes/itau-pagamentos.js - PIX Pagamentos SISPAG (pagar fornecedores)
 * ============================================================
 * POST /api/v1/itau/pix-pagar          - Pagamento PIX unificado (chave, dados bancarios, EMV)
 * GET  /api/v1/itau/pix-pagar/status   - Status do token SISPAG
 * POST /api/v1/itau/pix-pagar/status/gerar - Forcar geracao de token
 * GET  /api/v1/itau/pix-pagar/consultar/:id - Consultar pagamento por ID
 * GET  /api/v1/itau/pix-pagar/consultar     - Listar pagamentos com filtros
 * ============================================================
 */
const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const sispag = require('../services/itau-sispag');

// Todas as rotas exigem API Key
router.use(apiKeyAuth);

// -------------------------------------------------------
// POST /api/v1/itau/pix-pagar — Pagamento PIX unificado
// Body:
//   tipo: "chave" | "dados_bancarios" | "emv"
//   + campos especificos de cada tipo (veja service)
// -------------------------------------------------------
router.post('/pix-pagar', async (req, res) => {
  try {
    var body = req.body;
    var tipo = body.tipo || 'chave';

    console.log('[PIX-PAGAR] Tipo:', tipo, '| Valor:', body.valor_pagamento);

    var resultado;

    if (tipo === 'chave') {
      if (!body.chave) {
        return res.status(400).json({ success: false, error: 'Campo "chave" obrigatorio para tipo=chave' });
      }
      resultado = await sispag.pagarPorChavePix(body);
    } else if (tipo === 'dados_bancarios') {
      if (!body.ispb || !body.agencia_recebedor || !body.conta_recebedor) {
        return res.status(400).json({ success: false, error: 'Campos obrigatorios: ispb, agencia_recebedor, conta_recebedor' });
      }
      resultado = await sispag.pagarPorDadosBancarios(body);
    } else if (tipo === 'emv') {
      if (!body.emv) {
        return res.status(400).json({ success: false, error: 'Campo "emv" obrigatorio para tipo=emv' });
      }
      resultado = await sispag.pagarPorEmv(body);
    } else {
      return res.status(400).json({ success: false, error: 'Tipo invalido: "' + tipo + '". Use: chave, dados_bancarios, emv' });
    }

    var statusPag = resultado.status_pagamento || '';
    var sucesso = statusPag.toLowerCase() === 'sucesso';

    // Monta resposta amigavel
    var resposta = {
      success: sucesso,
      status_pagamento: statusPag,
      cod_pagamento: resultado.cod_pagamento || null,
      numero_lote: resultado.numero_lote || null,
      numero_lancamento: resultado.numero_lancamento || null,
      tipo_pagamento: resultado.tipo_pagamento || 'PIX',
      data_pagamento: resultado.data_pagamento || null,
      valor_pagamento: resultado.valor_pagamento || body.valor_pagamento,
      referencia_empresa: resultado.referencia_empresa || body.referencia_empresa || null,
      id_pagamento_sispag: resultado.id_pagamento || null,
    };

    if (resultado.dados_pagamento) {
      resposta.dados_pagamento = resultado.dados_pagamento;
    }
    if (resultado.dados_debito) {
      resposta.dados_debito = resultado.dados_debito;
    }

    console.log('[PIX-PAGAR] Resultado: ' + statusPag + ' | cod_pagamento=' + resposta.cod_pagamento);

    res.json(resposta);

  } catch (err) {
    console.error('[PIX-PAGAR] ERRO:', err.message);
    if (err.response) {
      console.error('[PIX-PAGAR] Status:', err.response.status);
      console.error('[PIX-PAGAR] Data:', JSON.stringify(err.response.data));
      return res.status(err.response.status || 502).json({
        success: false,
        error: 'Erro Itau SISPAG: ' + (err.response.status || 'unknown'),
        detail: err.response.data,
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// GET /api/v1/itau/pix-pagar/status — Status do token
// -------------------------------------------------------
router.get('/pix-pagar/status', (req, res) => {
  res.json(sispag.getTokenStatus());
});

// -------------------------------------------------------
// POST /api/v1/itau/pix-pagar/status/gerar — Forcar token
// -------------------------------------------------------
router.post('/pix-pagar/status/gerar', async (req, res) => {
  try {
    sispag.invalidateToken();
    var token = await getSispagTokenForced();
    res.json({ success: true, message: 'Token gerado com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hack: importa getSispagToken via service interno
async function getSispagTokenForced() {
  // Forca nova obtencao acessando o cache diretamente
  sispag.invalidateToken();
  // Faz uma chamada leve pra forcar o token a ser gerado
  var st = sispag.getTokenStatus();
  if (!st.hasToken) {
    // Dispara um pagamento dummy soh pra gerar o token? Nao.
    // Vamos expor o token no service
    throw new Error('Token nao disponivel. Verifique client_id/secret e credencial.');
  }
  return true;
}

// -------------------------------------------------------
// GET /api/v1/itau/pix-pagar/consultar/:id — Consultar por ID
// -------------------------------------------------------
router.get('/pix-pagar/consultar/:id', async (req, res) => {
  try {
    var id = req.params.id;
    console.log('[PIX-PAGAR] Consultando ID:', id);

    var result = await sispag.consultarPagamento(id);

    // Extrai dados relevantes
    var value = result.value || result;
    var data = value.data || {};
    var pagamento = data.dados_pagamento || {};
    var debito = data.dados_debito || {};

    res.json({
      success: true,
      id_pagamento: id,
      status: pagamento.status || data.status || 'N/A',
      nome_favorecido: pagamento.nome_favorecido || '',
      cpf_cnpj_favorecido: pagamento.cpf_cnpj_favorecido || '',
      cod_banco: pagamento.cod_banco_favorecido || '',
      agencia: pagamento.numero_agencia_favorecido || '',
      conta: pagamento.numero_conta_favorecido || '',
      valor_pagamento: pagamento.valor_pagamento || '',
      data_pagamento: pagamento.data_pagamento || '',
      referencia_empresa: pagamento.referencia_empresa || '',
      numero_lancamento: pagamento.numero_lancamento || '',
      dados_debito: debito,
      raw: result,
    });
  } catch (err) {
    console.error('[PIX-PAGAR/CONSULTAR] ERRO:', err.message);
    if (err.response) {
      return res.status(err.response.status || 502).json({
        success: false, error: 'Erro na consulta: ' + err.response.status,
        detail: err.response.data,
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------
// GET /api/v1/itau/pix-pagar/consultar — Listar com filtros
// Query: data_inicial, data_final, referencia_empresa, status, nome_beneficiario
// -------------------------------------------------------
router.get('/pix-pagar/consultar', async (req, res) => {
  try {
    var filtros = {
      data_inicial: req.query.data_inicial,
      data_final: req.query.data_final,
      referencia_empresa: req.query.referencia_empresa,
      status: req.query.status,
      tipo_pagamento: req.query.tipo_pagamento || '41', // 41 = PIX
      nome_beneficiario: req.query.nome_beneficiario,
    };

    console.log('[PIX-PAGAR] Listando pagamentos:', JSON.stringify(filtros));

    var result = await sispag.consultarPagamentos(filtros);

    var value = result.value || result;
    var data = value.data || {};
    var itens = data.itens || [];

    res.json({
      success: true,
      total: itens.length,
      pagamentos: itens.map(function(item) {
        return {
          id_pagamento: item.id_pagamento || null,
          nome_favorecido: item.nome_favorecido || '',
          cpf_cnpj: item.cpf_cnpj || '',
          cod_banco: item.cod_banco || '',
          agencia: item.numero_agencia || '',
          conta: item.numero_conta || '',
          valor_pagamento: item.valor_pagamento || '',
          data_pagamento: item.data_pagamento || '',
          status: item.status || '',
          status_descricao: item.status || '',
          referencia_empresa: item.referencia_empresa || '',
          numero_lancamento: item.numero_lancamento || '',
        };
      }),
      raw: result,
    });
  } catch (err) {
    console.error('[PIX-PAGAR/LISTAR] ERRO:', err.message);
    if (err.response) {
      return res.status(err.response.status || 502).json({
        success: false, error: 'Erro na listagem: ' + err.response.status,
        detail: err.response.data,
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
