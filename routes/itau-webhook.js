/**
 * routes/itau-webhook.js - Webhooks Itau (namespaced: /api/v1/itau/webhook/*)
 * ============================================================
 * Recebe notificacoes do Itau quando:
 *   - PIX e recebido (pix-confirmacao)
 *   - Boleto e pago (bolecode-confirmacao)
 *
 * Atualiza a fatura correspondente no Odoo com status de pagamento.
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

    // Buscar invoice pelo txid
    var invoiceIds = await odooExec(oc, odooHost, odooUid, 'account.move', 'search', [
      [['x_studio_itau_txid', '=', txid], ['move_type', '=', 'out_invoice']]
    ]);

    if (!invoiceIds || invoiceIds.length === 0) {
      console.log('[WEBHOOK-PIX] Nenhuma invoice encontrada para txid=' + txid);
      return;
    }

    var invId = invoiceIds[0];
    var nowStr = new Date().toISOString().substring(0, 19).replace('T', ' ');

    // Atualizar status
    await odooExec(oc, odooHost, odooUid, 'account.move', 'write', [[invId], {
      'x_studio_itau_pix_status': 'CONCLUIDA',
      'x_studio_itau_status_pagamento': 'PAGO',
      'x_studio_itau_pix_data_pagamento': nowStr,
      'x_studio_itau_pix_e2e': e2eId,
    }]);

    // Post chatter note
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

    // Buscar invoice pelo nosso_numero
    var invoiceIds = await odooExec(oc, odooHost, odooUid, 'account.move', 'search', [
      [['x_studio_itau_nosso_numero', 'like', nossoNumero], ['move_type', '=', 'out_invoice']]
    ]);

    if (!invoiceIds || invoiceIds.length === 0) {
      console.log('[WEBHOOK-BOLETO] Nenhuma invoice encontrada para NN=' + nossoNumero);
      return;
    }

    var invId = invoiceIds[0];
    var todayStr = new Date().toISOString().substring(0, 10);

    // Atualizar status
    await odooExec(oc, odooHost, odooUid, 'account.move', 'write', [[invId], {
      'x_studio_itau_boleto_status': 'PAGO',
      'x_studio_itau_status_pagamento': 'PAGO',
      'x_studio_itau_boleto_data_pagamento': todayStr,
    }]);

    // Post chatter note
    await odooExec(oc, odooHost, odooUid, 'mail.message', 'create', [{
      model: 'account.move',
      res_id: invId,
      body: '<p><b>Boleto Confirmado via Webhook</b></p>'
        + '<p>Nosso Numero: ' + nossoNumero + '</p>'
        + '<p>Data: ' + todayStr + '</p>',
      message_type: 'comment',
      subtype_xmlid: 'mail.mt_note',
    }]);

    console.log('[WEBHOOK-BOLETO] Invoice ' + invId + ' atualizada: Boleto pago (NN=' + nossoNumero + ')');

  } catch (err) {
    console.error('[WEBHOOK-BOLETO] Erro ao processar:', err.message);
  }
});

module.exports = router;
