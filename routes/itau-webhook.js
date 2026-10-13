/**
 * routes/itau-webhook.js - Webhooks Itau (namespaced: /api/v1/itau/webhook/*)
 * ============================================================
 * Recebe notificacoes do Itau quando:
 *   - PIX e recebido (pix-confirmacao)
 *   - Boleto e pago (bolecode-confirmacao)
 *
 * Atualiza a fatura correspondente no Odoo com status de pagamento.
 * Resiliente a campos inexistentes - usa detectFields para verificar
 * quais campos existem antes de escrever.
 */
var express = require('express');
var router = express.Router();
var config = require('../config');
var xmlrpc = require('xmlrpc');

// ============================================================
// Odoo XML-RPC helpers
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

/**
 * safeWriteFields - Detects existing fields and writes only those that exist.
 * Returns the fields that were actually written.
 */
async function safeWriteFields(oc, host, uid, invId, writeVals) {
  var payPoll;
  try {
    payPoll = require('../services/itau-payment-poll');
  } catch (e) {
    // Fallback: try writing all fields
    await odooExec(oc, host, uid, 'account.move', 'write', [[invId], writeVals]);
    return Object.keys(writeVals);
  }

  var fieldChecks;
  try {
    fieldChecks = await payPoll.detectFields(oc, host, uid);
  } catch (e) {
    fieldChecks = null;
  }

  // Filter to only existing fields
  var safeVals = payPoll.filterWriteVals(writeVals, fieldChecks);
  var written = Object.keys(safeVals);

  if (written.length > 0) {
    await odooExec(oc, host, uid, 'account.move', 'write', [[invId], safeVals]);
  } else {
    console.log('[WEBHOOK] Nenhum campo itau existe no Odoo - pulando write');
  }

  return written;
}

/**
 * safeSearchByField - Searches for invoices using a field, but falls back
 * gracefully if the field doesn't exist.
 */
async function safeSearchByField(oc, host, uid, fieldName, operator, value) {
  var payPoll;
  try {
    payPoll = require('../services/itau-payment-poll');
  } catch (e) {
    // Fallback: try the search directly
    return await odooExec(oc, host, uid, 'account.move', 'search', [
      [[fieldName, operator, value], ['move_type', '=', 'out_invoice']]
    ]);
  }

  var fieldChecks;
  try {
    fieldChecks = await payPoll.detectFields(oc, host, uid);
  } catch (e) {
    fieldChecks = null;
  }

  // If field exists, use it for search
  if (fieldChecks && fieldChecks[fieldName]) {
    return await odooExec(oc, host, uid, 'account.move', 'search', [
      [[fieldName, operator, value], ['move_type', '=', 'out_invoice']]
    ]);
  }

  // Field doesn't exist - can't search by it
  console.log('[WEBHOOK] Campo ' + fieldName + ' nao existe no Odoo, nao e possivel buscar invoice por ele');
  return [];
}

// ============================================================
// POST /api/v1/itau/webhook/pix-confirmacao
// Recebe notificacao de PIX recebido do Itau
// ============================================================
router.post('/pix-confirmacao', async function(req, res) {
  var pixData = req.body;
  console.log('[WEBHOOK-PIX] Notificacao recebida:', JSON.stringify(pixData).substring(0, 500));

  // Responder ao Itau imediatamente (nao bloquear)
  res.json({ status: 'recebido' });

  // Processar em background
  if (!config.odoo.enabled || !config.odoo.url) return;

  try {
    var oc = config.odoo;
    var authResult = await odooAuth(oc);
    var odooUid = authResult.uid;
    var odooHost = authResult.host;

    // O Itau envia o txid e/ou e2eId na notificacao
    var txid = pixData.txid || (pixData.pix && pixData.pix.txid) || '';
    var e2eId = (pixData.pix && pixData.pix.endToEndId) || '';

    if (!txid) {
      console.log('[WEBHOOK-PIX] Notificacao sem txid, ignorando');
      return;
    }

    // Buscar invoice pelo txid (resiliente a campo inexistente)
    var invoiceIds = await safeSearchByField(oc, odooHost, odooUid, 'x_studio_itau_txid', '=', txid);

    if (!invoiceIds || invoiceIds.length === 0) {
      console.log('[WEBHOOK-PIX] Nenhuma invoice encontrada para txid=' + txid);
      return;
    }

    var invId = invoiceIds[0];
    var nowStr = new Date().toISOString().substring(0, 19).replace('T', ' ');

    // Atualizar status (resiliente a campos inexistentes)
    var writeVals = {
      'x_studio_itau_situacao': 'pago',
      'x_studio_itau_pix_status': 'concluida',
      'x_studio_itau_status_pagamento': 'pago',
      'x_studio_itau_pix_data_pagamento': nowStr,
      'x_studio_itau_pix_e2e': e2eId,
    };

    try {
      var written = await safeWriteFields(oc, odooHost, odooUid, invId, writeVals);
      console.log('[WEBHOOK-PIX] Campos escritos: ' + written.join(', '));
    } catch (writeErr) {
      console.warn('[WEBHOOK-PIX] Erro ao escrever campos:', writeErr.message);
    }

    // Post chatter note
    try {
      await odooExec(oc, odooHost, odooUid, 'mail.message', 'create', [{
        model: 'account.move',
        res_id: invId,
        body: '<p><b>PIX Confirmado via Webhook</b></p>'
          + '<p>TXID: ' + txid + '</p>'
          + '<p>E2E ID: ' + (e2eId || 'N/A') + '</p>'
          + '<p>Data: ' + nowStr + '</p>',
        message_type: 'comment',
        subtype_xmlid: 'mail.mt_note',
      }]);
    } catch (msgErr) {
      console.warn('[WEBHOOK-PIX] Erro chatter:', msgErr.message);
    }

    console.log('[WEBHOOK-PIX] Invoice ' + invId + ' atualizada: PIX pago (txid=' + txid + ')');

  } catch (err) {
    console.error('[WEBHOOK-PIX] Erro ao processar:', err.message);
  }
});

// ============================================================
// POST /api/v1/itau/webhook/bolecode-confirmacao
// Recebe notificacao de pagamento de boleto do Itau
// ============================================================
router.post('/bolecode-confirmacao', async function(req, res) {
  var boletoData = req.body;
  console.log('[WEBHOOK-BOLETO] Notificacao recebida:', JSON.stringify(boletoData).substring(0, 500));

  // Responder ao Itau imediatamente
  res.json({ status: 'recebido' });

  // Processar em background
  if (!config.odoo.enabled || !config.odoo.url) return;

  try {
    var oc = config.odoo;
    var authResult = await odooAuth(oc);
    var odooUid = authResult.uid;
    var odooHost = authResult.host;

    // Extrair nosso_numero da notificacao
    var nossoNumero = boletoData.nosso_numero
      || (boletoData.dado_boleto && boletoData.dado_boleto.dados_individuais_boleto
          && boletoData.dado_boleto.dados_individuais_boleto[0]
          && boletoData.dado_boleto.dados_individuais_boleto[0].numero_nosso_numero)
      || '';

    if (!nossoNumero) {
      console.log('[WEBHOOK-BOLETO] Notificacao sem nosso_numero, ignorando');
      return;
    }

    // Buscar invoice pelo nosso_numero (resiliente a campo inexistente)
    var invoiceIds = await safeSearchByField(oc, odooHost, odooUid, 'x_studio_itau_nosso_numero', 'like', nossoNumero);

    if (!invoiceIds || invoiceIds.length === 0) {
      console.log('[WEBHOOK-BOLETO] Nenhuma invoice encontrada para NN=' + nossoNumero);
      return;
    }

    var invId = invoiceIds[0];
    var todayStr = new Date().toISOString().substring(0, 10);

    // Atualizar status (resiliente a campos inexistentes)
    var writeVals = {
      'x_studio_itau_situacao': 'pago',
      'x_studio_itau_boleto_status': 'pago',
      'x_studio_itau_status_pagamento': 'pago',
      'x_studio_itau_boleto_data_pagamento': todayStr,
    };

    try {
      var written = await safeWriteFields(oc, odooHost, odooUid, invId, writeVals);
      console.log('[WEBHOOK-BOLETO] Campos escritos: ' + written.join(', '));
    } catch (writeErr) {
      console.warn('[WEBHOOK-BOLETO] Erro ao escrever campos:', writeErr.message);
    }

    // Post chatter note
    try {
      await odooExec(oc, odooHost, odooUid, 'mail.message', 'create', [{
        model: 'account.move',
        res_id: invId,
        body: '<p><b>Boleto Confirmado via Webhook</b></p>'
          + '<p>Nosso Numero: ' + nossoNumero + '</p>'
          + '<p>Data: ' + todayStr + '</p>',
        message_type: 'comment',
        subtype_xmlid: 'mail.mt_note',
      }]);
    } catch (msgErr) {
      console.warn('[WEBHOOK-BOLETO] Erro chatter:', msgErr.message);
    }

    console.log('[WEBHOOK-BOLETO] Invoice ' + invId + ' atualizada: Boleto pago (NN=' + nossoNumero + ')');

  } catch (err) {
    console.error('[WEBHOOK-BOLETO] Erro ao processar:', err.message);
  }
});

module.exports = router;
