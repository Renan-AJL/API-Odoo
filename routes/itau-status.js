/**
 * routes/itau-status.js - Status de Pagamentos + Gatilho Manual + Extrato
 * ==================================================================
 * Rotas para consultar e disparar manualmente:
 *   - Status PIX/Boleto de uma fatura específica no Odoo
 *   - Polling manual de PIX pendentes
 *   - Polling manual de boletos pendentes
 *   - Importação manual de extrato bancário
 *   - Consulta do diário bancário configurado
 *
 * Namespaced: /api/v1/itau/status/*
 */
var express = require('express');
var router = express.Router();
var { apiKeyAuth } = require('../middleware/auth');
var config = require('../config');
var xmlrpc = require('xmlrpc');

var { processPendingPix, processPendingBoletos, reconcileStatementPayments } = require('../services/itau-payment-poll');
var { buscarExtratoNormalizado } = require('../services/itau-extrato');
var { criarExtrato, findBankJournal, findExistingStatement } = require('../services/odoo-bank-statement');

// ============================================================
// Odoo XML-RPC helpers (reutilizado do itau-payment-poll)
// ============================================================

function odooAuth(oc) {
  return new Promise(function(ok, fail) {
    var base = oc.url.replace(/\/+$/, '');
    var host = base.replace('https://', '');
    var client = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
    client.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, r) {
      if (e || !r) return fail(e || new Error('Odoo auth failed'));
      ok({ uid: r, host: host });
    });
  });
}

function odooExec(oc, host, uid, model, method, args, kwargs) {
  return new Promise(function(ok, fail) {
    var client = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });
    var params = [oc.db, uid, oc.password, model, method, args];
    if (kwargs) params.push(kwargs);
    client.methodCall('execute_kw', params, function(e, r) {
      if (e) return fail(e);
      ok(r);
    });
  });
}

// ============================================================
// GET /api/v1/itau/status/invoice/:invoiceId
// Consulta status PIX/Boleto de uma fatura específica no Odoo
// ============================================================
router.get('/invoice/:invoiceId', apiKeyAuth, async function(req, res) {
  var invoiceId = parseInt(req.params.invoiceId, 10);
  if (!invoiceId || invoiceId <= 0) {
    return res.status(400).json({ erro: 'invoiceId inválido (deve ser número inteiro positivo)' });
  }

  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return res.status(503).json({ erro: 'Integração Odoo desabilitada' });
  }

  try {
    var authResult = await odooAuth(oc);
    var odooUid = authResult.uid;
    var odooHost = authResult.host;

    var fields = [
      'name', 'move_type', 'payment_state', 'amount_total',
      'x_studio_itau_tipo_pagamento',
      'x_studio_itau_situacao',
      'x_studio_itau_status_pagamento',
      'x_studio_itau_pix_status',
      'x_studio_itau_pix_data_pagamento',
      'x_studio_itau_pix_e2e',
      'x_studio_itau_txid',
      'x_studio_itau_pix_copia_cola',
      'x_studio_itau_boleto_status',
      'x_studio_itau_boleto_data_pagamento',
      'x_studio_itau_nosso_numero',
      'x_studio_itau_link_status',
      'x_studio_boleto_cancelado',
    ];

    var invoices = await odooExec(oc, odooHost, odooUid, 'account.move', 'read', [
      [invoiceId], fields
    ]);

    if (!invoices || invoices.length === 0) {
      return res.status(404).json({ erro: 'Fatura ' + invoiceId + ' não encontrada no Odoo' });
    }

    var inv = invoices[0];

    // Resumo legível
    var tipoPag = inv.x_studio_itau_tipo_pagamento || 'NÃO DEFINIDO';
    var statusPag = inv.x_studio_itau_status_pagamento || 'N/A';
    var resumo = {
      fatura: inv.name,
      fatura_id: inv.id,
      tipo_pagamento: tipoPag,
      status_pagamento: statusPag,
      payment_state_odoo: inv.payment_state,
      valor_total: inv.amount_total,
    };

    if (tipoPag.indexOf('PIX') >= 0) {
      resumo.pix = {
        status: inv.x_studio_itau_pix_status || 'N/A',
        data_pagamento: inv.x_studio_itau_pix_data_pagamento || null,
        e2e_id: inv.x_studio_itau_pix_e2e || null,
        txid: inv.x_studio_itau_txid || null,
      };
    }

    if (tipoPag.indexOf('BOLETO') >= 0) {
      resumo.boleto = {
        status: inv.x_studio_itau_boleto_status || 'N/A',
        data_pagamento: inv.x_studio_itau_boleto_data_pagamento || null,
        nosso_numero: inv.x_studio_itau_nosso_numero || null,
        cancelado: inv.x_studio_boleto_cancelado || false,
      };
    }

    res.json({
      sucesso: true,
      resumo: resumo,
      campos_brutos: inv,
    });

  } catch (err) {
    console.error('[ITAU-STATUS] Erro ao consultar invoice:', err.message);
    res.status(500).json({ erro: 'Erro ao consultar fatura: ' + err.message });
  }
});

// ============================================================
// POST /api/v1/itau/status/poll-pix
// Dispara polling manual de PIX pendentes
// ============================================================
router.post('/poll-pix', apiKeyAuth, async function(req, res) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return res.status(503).json({ erro: 'Integração Odoo desabilitada' });
  }

  try {
    var result = await processPendingPix();
    res.json({
      sucesso: true,
      acao: 'poll_pix',
      processados: result.processed,
      pagos: result.paid,
      erros: result.errors,
    });
  } catch (err) {
    console.error('[ITAU-STATUS] Erro polling PIX:', err.message);
    res.status(500).json({ erro: 'Erro no polling PIX: ' + err.message });
  }
});

// ============================================================
// POST /api/v1/itau/status/poll-boletos
// Dispara polling manual de boletos pendentes
// ============================================================
router.post('/poll-boletos', apiKeyAuth, async function(req, res) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return res.status(503).json({ erro: 'Integração Odoo desabilitada' });
  }

  try {
    var result = await processPendingBoletos();
    res.json({
      sucesso: true,
      acao: 'poll_boletos',
      processados: result.processed,
      pagos: result.paid,
      erros: result.errors,
    });
  } catch (err) {
    console.error('[ITAU-STATUS] Erro polling boletos:', err.message);
    res.status(500).json({ erro: 'Erro no polling boletos: ' + err.message });
  }
});

// ============================================================
// POST /api/v1/itau/status/poll-all
// Dispara polling manual de PIX + boletos
// ============================================================
router.post('/poll-all', apiKeyAuth, async function(req, res) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return res.status(503).json({ erro: 'Integração Odoo desabilitada' });
  }

  try {
    var pixResult = await processPendingPix();
    var boletoResult = await processPendingBoletos();
    res.json({
      sucesso: true,
      acao: 'poll_all',
      pix: {
        processados: pixResult.processed,
        pagos: pixResult.paid,
        erros: pixResult.errors,
      },
      boletos: {
        processados: boletoResult.processed,
        pagos: boletoResult.paid,
        erros: boletoResult.errors,
      },
    });
  } catch (err) {
    console.error('[ITAU-STATUS] Erro polling all:', err.message);
    res.status(500).json({ erro: 'Erro no polling: ' + err.message });
  }
});

// ============================================================
// POST /api/v1/itau/status/consultar-pix/:txid
// Consulta status PIX diretamente no Itaú (sem Odoo)
// ============================================================
router.post('/consultar-pix/:txid', apiKeyAuth, async function(req, res) {
  var txid = req.params.txid;
  if (!txid || txid.length < 10) {
    return res.status(400).json({ erro: 'txid inválido' });
  }

  try {
    var { consultarCobrancaPix } = require('../services/itau-pix');
    var result = await consultarCobrancaPix(txid);
    res.json({
      sucesso: true,
      txid: txid,
      status: result.status || 'DESCONHECIDO',
      dados: result,
    });
  } catch (err) {
    console.error('[ITAU-STATUS] Erro consultar PIX:', err.message);
    res.status(500).json({ erro: 'Erro ao consultar PIX: ' + err.message });
  }
});

// ============================================================
// POST /api/v1/itau/status/consultar-boleto/:nossoNumero
// Consulta status boleto diretamente no Itaú (sem Odoo)
// ============================================================
router.post('/consultar-boleto/:nossoNumero', apiKeyAuth, async function(req, res) {
  var nossoNumero = req.params.nossoNumero;
  if (!nossoNumero || nossoNumero.length < 5) {
    return res.status(400).json({ erro: 'nosso_numero inválido' });
  }

  try {
    var { consultarBoletoPorNossoNumero } = require('../services/itau-boleto');
    var beneficiaryId = config.banco.idBeneficiario;
    var result = await consultarBoletoPorNossoNumero(nossoNumero, beneficiaryId);
    res.json({
      sucesso: true,
      nosso_numero: nossoNumero,
      dados: result,
    });
  } catch (err) {
    console.error('[ITAU-STATUS] Erro consultar boleto:', err.message);
    res.status(500).json({ erro: 'Erro ao consultar boleto: ' + err.message });
  }
});

// ============================================================
// POST /api/v1/itau/status/importar-extrato
// Importação manual de extrato bancário para o Odoo
// Body: { dataInicial: "YYYY-MM-DD", dataFinal: "YYYY-MM-DD" } (opcional, default: ontem)
// ============================================================
router.post('/importar-extrato', apiKeyAuth, async function(req, res) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return res.status(503).json({ erro: 'Integração Odoo desabilitada' });
  }

  // Default: ontem
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var defaultDate = yesterday.toISOString().substring(0, 10);

  var dataInicial = req.body.dataInicial || defaultDate;
  var dataFinal = req.body.dataFinal || defaultDate;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicial) || !/^\d{4}-\d{2}-\d{2}$/.test(dataFinal)) {
    return res.status(400).json({ erro: 'Datas devem estar no formato YYYY-MM-DD' });
  }

  try {
    console.log('[ITAU-STATUS] Importação manual extrato: ' + dataInicial + ' a ' + dataFinal);

    // Buscar extrato do Itaú
    var transacoes = await buscarExtratoNormalizado(dataInicial, dataFinal);

    if (!transacoes || transacoes.length === 0) {
      return res.json({
        sucesso: true,
        acao: 'importar_extrato',
        data_inicial: dataInicial,
        data_final: dataFinal,
        transacoes: 0,
        mensagem: 'Nenhuma transação encontrada no período',
      });
    }

    // Verificar se já existe extrato
    var journal = await findBankJournal();
    var existing = await findExistingStatement(journal.id, dataInicial);

    if (existing && existing.length > 0) {
      // Extrato já existe, apenas reconciliar
      var recResult = await reconcileStatementPayments(transacoes);
      return res.json({
        sucesso: true,
        acao: 'importar_extrato',
        data_inicial: dataInicial,
        data_final: dataFinal,
        transacoes: transacoes.length,
        extrato_existente: true,
        extrato_id: existing[0],
        diario: journal.name,
        reconciliacao: {
          matched: recResult.matched,
          faturas_pagas: recResult.invoices_paid,
        },
        mensagem: 'Extrato já existia. Reconciliação executada.',
      });
    }

    // Criar extrato no Odoo
    var stmtResult = await criarExtrato(dataInicial, transacoes);

    // Reconciliar pagamentos
    var recResult = await reconcileStatementPayments(transacoes);

    res.json({
      sucesso: true,
      acao: 'importar_extrato',
      data_inicial: dataInicial,
      data_final: dataFinal,
      transacoes: transacoes.length,
      extrato_criado: true,
      extrato_id: stmtResult.statementId,
      diario: stmtResult.journalName,
      diario_id: stmtResult.journalId,
      linhas: stmtResult.linesCreated,
      saldo: stmtResult.balance,
      reconciliacao: {
        matched: recResult.matched,
        faturas_pagas: recResult.invoices_paid,
      },
    });

  } catch (err) {
    console.error('[ITAU-STATUS] Erro importar extrato:', err.message);
    res.status(500).json({ erro: 'Erro ao importar extrato: ' + err.message });
  }
});

// ============================================================
// GET /api/v1/itau/status/diario
// Consulta o diário bancário configurado no Odoo
// ============================================================
router.get('/diario', apiKeyAuth, async function(req, res) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return res.status(503).json({ erro: 'Integração Odoo desabilitada' });
  }

  try {
    var journal = await findBankJournal();
    res.json({
      sucesso: true,
      diario: journal,
      env_bank_journal_id: process.env.ODOO_BANK_JOURNAL_ID || 'não configurado',
    });
  } catch (err) {
    console.error('[ITAU-STATUS] Erro ao buscar diário:', err.message);
    res.status(500).json({ erro: 'Erro ao buscar diário bancário: ' + err.message });
  }
});

// ============================================================
// GET /api/v1/itau/status/pendentes
// Lista faturas com pagamento pendente no Odoo
// Query: ?tipo=PIX|BOLETO|todos (default: todos)
// ============================================================
router.get('/pendentes', apiKeyAuth, async function(req, res) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return res.status(503).json({ erro: 'Integração Odoo desabilitada' });
  }

  var tipo = (req.query.tipo || 'todos').toUpperCase();

  try {
    var authResult = await odooAuth(oc);
    var odooUid = authResult.uid;
    var odooHost = authResult.host;

    var domain = [
      ['move_type', '=', 'out_invoice'],
      ['payment_state', '!=', 'paid'],
    ];

    if (tipo === 'PIX') {
      domain.push(['x_studio_itau_tipo_pagamento', 'like', 'PIX']);
    } else if (tipo === 'BOLETO') {
      domain.push(['x_studio_itau_tipo_pagamento', 'like', 'BOLETO']);
    } else {
      domain.push('|');
      domain.push(['x_studio_itau_tipo_pagamento', 'like', 'PIX']);
      domain.push(['x_studio_itau_tipo_pagamento', 'like', 'BOLETO']);
    }

    var invoiceIds = await odooExec(oc, odooHost, odooUid, 'account.move', 'search', [domain], { limit: 100, order: 'id desc' });

    if (!invoiceIds || invoiceIds.length === 0) {
      return res.json({ sucesso: true, pendentes: [], total: 0 });
    }

    var invoices = await odooExec(oc, odooHost, odooUid, 'account.move', 'read', [
      invoiceIds,
      ['name', 'amount_total', 'x_studio_itau_tipo_pagamento', 'x_studio_itau_status_pagamento',
       'x_studio_itau_pix_status', 'x_studio_itau_boleto_status', 'x_studio_itau_txid', 'x_studio_itau_nosso_numero']
    ]);

    var lista = invoices.map(function(inv) {
      return {
        id: inv.id,
        nome: inv.name,
        valor: inv.amount_total,
        tipo: inv.x_studio_itau_tipo_pagamento || 'N/A',
        status_pagamento: inv.x_studio_itau_status_pagamento || 'N/A',
        pix_status: inv.x_studio_itau_pix_status || null,
        boleto_status: inv.x_studio_itau_boleto_status || null,
      };
    });

    res.json({ sucesso: true, pendentes: lista, total: lista.length });

  } catch (err) {
    console.error('[ITAU-STATUS] Erro ao listar pendentes:', err.message);
    res.status(500).json({ erro: 'Erro ao listar pendentes: ' + err.message });
  }
});

// ============================================================
// GET /api/v1/itau/status/odoo-test
// Testa conexão com o Odoo (auth + read res.partner)
// ============================================================
router.get('/odoo-test', apiKeyAuth, async function(req, res) {
  var oc = config.odoo;
  if (!oc || !oc.url) {
    return res.status(503).json({ erro: 'Odoo não configurado (ODOO_URL vazio)' });
  }

  try {
    var authResult = await odooAuth(oc);
    var odooUid = authResult.uid;
    var odooHost = authResult.host;

    // Testar leitura simples
    var partnerCount = await odooExec(oc, odooHost, odooUid, 'res.partner', 'search_count', [[]]);

    // Testar se campos x_studio existem (tentar ler 1 invoice)
    var camposStatus = true;
    var camposMsg = '';
    try {
      var testInv = await odooExec(oc, odooHost, odooUid, 'account.move', 'search', [[['move_type', '=', 'out_invoice']]], { limit: 1 });
      if (testInv && testInv.length > 0) {
        await odooExec(oc, odooHost, odooUid, 'account.move', 'read', [
          [testInv[0]],
          ['x_studio_itau_pix_status', 'x_studio_itau_boleto_status', 'x_studio_itau_status_pagamento', 'x_studio_itau_txid', 'x_studio_itau_tipo_pagamento']
        ]);
        camposMsg = 'Campos x_studio_itau_* encontrados no modelo account.move';
      } else {
        camposMsg = 'Nenhuma fatura encontrada para testar campos';
      }
    } catch (fieldErr) {
      camposStatus = false;
      camposMsg = 'Campos x_studio_itau_* NÃO encontrados: ' + fieldErr.message;
    }

    // Testar diário bancário
    var journalStatus = false;
    var journalInfo = {};
    try {
      var journal = await findBankJournal();
      journalStatus = true;
      journalInfo = { id: journal.id, name: journal.name, code: journal.code };
    } catch (jErr) {
      journalInfo = { erro: jErr.message };
    }

    res.json({
      sucesso: true,
      odoo_url: oc.url,
      odoo_db: oc.db,
      odoo_user: oc.user,
      odoo_uid: odooUid,
      odoo_push_enabled: oc.enabled,
      partners_count: partnerCount,
      campos_status: {
        ok: camposStatus,
        mensagem: camposMsg,
      },
      diario_bancario: {
        ok: journalStatus,
        info: journalInfo,
      },
    });

  } catch (err) {
    console.error('[ITAU-STATUS] Erro teste Odoo:', err.message);
    res.status(500).json({
      sucesso: false,
      erro: err.message,
      odoo_url: oc.url,
      odoo_db: oc.db,
      odoo_user: oc.user,
    });
  }
});

module.exports = router;
