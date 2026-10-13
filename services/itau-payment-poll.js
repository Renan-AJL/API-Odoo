/**
 * services/itau-payment-poll.js - Polling de status de pagamento Itaú
 * ============================================================
 * Consulta periodicamente o status de PIX e boletos no Itaú
 * e atualiza as faturas correspondentes no Odoo.
 *
 * Campos Odoo (account.move):
 *   x_studio_itau_status_pagamento  — PENDENTE / PAGO / CANCELADO / EXPIRADO
 *   x_studio_itau_pix_status       — ATIVA / CONCLUIDA / REMOVIDA_PELO_PSP / EXPIRADA
 *   x_studio_itau_pix_data_pagamento — Data/hora do pagamento PIX
 *   x_studio_itau_pix_e2e          — End-to-end ID do PIX
 *   x_studio_itau_txid             — TXID da cobrança PIX (para polling)
 *   x_studio_itau_boleto_status    — EM_ABERTO / PAGO / CANCELADO / EXPIRADO
 *   x_studio_itau_boleto_data_pagamento — Data do pagamento do boleto
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');
var { consultarCobrancaPix } = require('./itau-pix');
var { consultarBoletoPorNossoNumero } = require('./itau-boleto');

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
// PROCESSAR PIX PENDENTES
// ============================================================

/**
 * Busca faturas Odoo com PIX pendente e consulta status no Itaú.
 * Retorna { processed, paid, errors }
 */
async function processPendingPix() {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return { processed: 0, paid: 0, errors: 0 };
  }

  var odooHost, odooUid;
  try {
    var authResult = await odooAuth(oc);
    odooUid = authResult.uid;
    odooHost = authResult.host;
  } catch (err) {
    console.error('[PAYMENT-POLL] Erro auth Odoo:', err.message);
    return { processed: 0, paid: 0, errors: 1 };
  }

  // Detectar campos disponiveis no Odoo
  var fieldChecks;
  try {
    fieldChecks = await detectFields(oc, odooHost, odooUid);
  } catch (err) {
    console.error('[PAYMENT-POLL] Erro ao detectar campos:', err.message);
    return { processed: 0, paid: 0, errors: 1 };
  }

  // Buscar invoices com PIX emitido e status pendente
  // Usa apenas campos que existem no Odoo
  var domain = [
    ['move_type', '=', 'out_invoice'],
    ['payment_state', '!=', 'paid'],
  ];
  if (fieldChecks['x_studio_itau_tipo_pagamento']) {
    domain.push(['x_studio_itau_tipo_pagamento', 'like', 'PIX']);
  }
  if (fieldChecks['x_studio_itau_txid']) {
    domain.push(['x_studio_itau_txid', '!=', false]);
    domain.push(['x_studio_itau_txid', '!=', '']);
  }

  // Filter domain to only use existing fields
  domain = buildSafeDomain(domain, fieldChecks);

  var invoiceIds;
  try {
    invoiceIds = await odooExec(oc, odooHost, odooUid, 'account.move', 'search', [domain], { limit: 50 });
  } catch (err) {
    console.error('[PAYMENT-POLL] Erro ao buscar invoices PIX:', err.message);
    return { processed: 0, paid: 0, errors: 1 };
  }

  if (!invoiceIds || invoiceIds.length === 0) {
    return { processed: 0, paid: 0, errors: 0 };
  }

  // Build read fields list (only existing custom fields)
  var readFields = ['name', 'amount_total'];
  if (fieldChecks['x_studio_itau_txid']) readFields.push('x_studio_itau_txid');
  if (fieldChecks['x_studio_itau_status_pagamento']) readFields.push('x_studio_itau_status_pagamento');
  if (fieldChecks['x_studio_itau_pix_status']) readFields.push('x_studio_itau_pix_status');

  var invoices = await odooExec(oc, odooHost, odooUid, 'account.move', 'read', [
    invoiceIds, readFields
  ]);

  var processed = 0;
  var paid = 0;
  var errors = 0;

  for (var i = 0; i < invoices.length; i++) {
    var inv = invoices[i];
    var txid = inv.x_studio_itau_txid;

    if (!txid) continue;

    try {
      var pixResult = await consultarCobrancaPix(txid);
      var pixStatus = pixResult.status || ''; // ATIVA, CONCLUIDA, REMOVIDA_PELO_PSP, EXPIRADA
      processed++;

      var writeVals = {};
      writeVals['x_studio_itau_pix_status'] = pixStatus;

      if (pixStatus === 'CONCLUIDA') {
        // PIX foi pago!
        writeVals['x_studio_itau_situacao'] = 'PAGO';
        writeVals['x_studio_itau_status_pagamento'] = 'PAGO';
        writeVals['x_studio_itau_pix_data_pagamento'] = (pixResult.pix && pixResult.pix.horario)
          ? pixResult.pix.horario.substring(0, 19).replace('T', ' ')
          : new Date().toISOString().substring(0, 19).replace('T', ' ');

        if (pixResult.pix && pixResult.endToEndId) {
          writeVals['x_studio_itau_pix_e2e'] = pixResult.pix.endToEndId;
        }

        paid++;

        // Post chatter note
        var valorPago = pixResult.pix && pixResult.pix.infoPagador
          ? '' : '';
        var pixInfo = pixResult.pix || {};
        var body = '<p><b>✅ PIX Confirmado</b></p>'
          + '<p>TXID: ' + txid + '</p>'
          + '<p>E2E ID: ' + (pixInfo.endToEndId || 'N/A') + '</p>'
          + '<p>Valor: R$ ' + (pixInfo.valorPagamento || inv.amount_total) + '</p>'
          + '<p>Data: ' + writeVals['x_studio_itau_pix_data_pagamento'] + '</p>';

        try {
          await odooExec(oc, odooHost, odooUid, 'mail.message', 'create', [{
            model: 'account.move',
            res_id: inv.id,
            body: body,
            message_type: 'comment',
            subtype_xmlid: 'mail.mt_note',
          }]);
        } catch (msgErr) { /* ignore */ }

      } else if (pixStatus === 'EXPIRADA' || pixStatus === 'REMOVIDA_PELO_PSP') {
        writeVals['x_studio_itau_situacao'] = 'EXPIRADO';
        writeVals['x_studio_itau_status_pagamento'] = 'EXPIRADO';
      }
      // ATIVA = ainda pendente, nao muda status_pagamento

      // Atualizar invoice (only write fields that exist)
      var safeVals = filterWriteVals(writeVals, fieldChecks);
      if (Object.keys(safeVals).length > 0) {
        await odooExec(oc, odooHost, odooUid, 'account.move', 'write', [[inv.id], safeVals]);
      }

      console.log('[PAYMENT-POLL] PIX invoice ' + inv.name + ' (txid=' + txid + '): ' + pixStatus);

    } catch (err) {
      console.error('[PAYMENT-POLL] Erro ao consultar PIX txid=' + txid + ':', err.message);
      errors++;
    }
  }

  return { processed: processed, paid: paid, errors: errors };
}

// ============================================================
// PROCESSAR BOLETOS PENDENTES
// ============================================================

/**
 * Busca faturas Odoo com boleto pendente e consulta status no Itaú.
 * O Itaú BoleCode API consulta o boleto mas o status de pagamento
 * vem principalmente via webhook ou extrato bancário.
 * Aqui verificamos o que a API retorna.
 * Retorna { processed, paid, errors }
 */
async function processPendingBoletos() {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return { processed: 0, paid: 0, errors: 0 };
  }

  var odooHost, odooUid;
  try {
    var authResult = await odooAuth(oc);
    odooUid = authResult.uid;
    odooHost = authResult.host;
  } catch (err) {
    console.error('[PAYMENT-POLL] Erro auth Odoo:', err.message);
    return { processed: 0, paid: 0, errors: 1 };
  }

  // Detectar campos disponiveis
  var fieldChecks;
  try {
    fieldChecks = await detectFields(oc, odooHost, odooUid);
  } catch (err) {
    console.error('[PAYMENT-POLL] Erro ao detectar campos:', err.message);
    return { processed: 0, paid: 0, errors: 1 };
  }

  // Buscar invoices com boleto emitido e status pendente
  var domain = [
    ['move_type', '=', 'out_invoice'],
    ['payment_state', '!=', 'paid'],
  ];
  if (fieldChecks['x_studio_itau_tipo_pagamento']) {
    domain.push(['x_studio_itau_tipo_pagamento', 'like', 'BOLETO']);
  }
  if (fieldChecks['x_studio_itau_nosso_numero']) {
    domain.push(['x_studio_itau_nosso_numero', '!=', false]);
    domain.push(['x_studio_itau_nosso_numero', '!=', '']);
  }
  domain = buildSafeDomain(domain, fieldChecks);

  var invoiceIds;
  try {
    invoiceIds = await odooExec(oc, odooHost, odooUid, 'account.move', 'search', [domain], { limit: 50 });
  } catch (err) {
    console.error('[PAYMENT-POLL] Erro ao buscar invoices boleto:', err.message);
    return { processed: 0, paid: 0, errors: 1 };
  }

  if (!invoiceIds || invoiceIds.length === 0) {
    return { processed: 0, paid: 0, errors: 0 };
  }

  var boletoReadFields = ['name'];
  if (fieldChecks['x_studio_itau_nosso_numero']) boletoReadFields.push('x_studio_itau_nosso_numero');
  if (fieldChecks['x_studio_itau_status_pagamento']) boletoReadFields.push('x_studio_itau_status_pagamento');
  if (fieldChecks['x_studio_itau_boleto_status']) boletoReadFields.push('x_studio_itau_boleto_status');

  var invoices = await odooExec(oc, odooHost, odooUid, 'account.move', 'read', [
    invoiceIds, boletoReadFields
  ]);

  var processed = 0;
  var paid = 0;
  var errors = 0;
  var beneficiaryId = config.banco.idBeneficiario;

  for (var i = 0; i < invoices.length; i++) {
    var inv = invoices[i];
    var nossoNumero = inv.x_studio_itau_nosso_numero;

    // Se tem múltiplos NN separados por |, pega o primeiro
    if (nossoNumero && nossoNumero.indexOf('|') >= 0) {
      nossoNumero = nossoNumero.split('|')[0];
    }
    if (!nossoNumero) continue;

    try {
      var boletoResult = await consultarBoletoPorNossoNumero(nossoNumero, beneficiaryId);
      processed++;

      // O Itaú retorna situação do boleto no campo situacao ou status
      var situacao = '';
      if (boletoResult && boletoResult.dado_boleto) {
        situacao = boletoResult.dado_boleto.situacao_boleto || '';
      }
      if (!situacao && Array.isArray(boletoResult) && boletoResult.length > 0) {
        situacao = boletoResult[0].situacao_boleto || '';
      }

      var writeVals = {};

      // Mapear situação do Itaú para nosso status
      // Situações típicas: NORMAL, BAIXADO, CANCELADO, PROTESTADO, PAGO
      if (situacao === 'PAGO' || situacao === 'LIQUIDADO') {
        writeVals['x_studio_itau_situacao'] = 'PAGO';
        writeVals['x_studio_itau_boleto_status'] = 'PAGO';
        writeVals['x_studio_itau_status_pagamento'] = 'PAGO';
        writeVals['x_studio_itau_boleto_data_pagamento'] = new Date().toISOString().substring(0, 10);
        paid++;

        // Post chatter note
        var body = '<p><b>✅ Boleto Pago</b></p>'
          + '<p>Nosso Número: ' + nossoNumero + '</p>'
          + '<p>Situação Itaú: ' + situacao + '</p>';

        try {
          await odooExec(oc, odooHost, odooUid, 'mail.message', 'create', [{
            model: 'account.move',
            res_id: inv.id,
            body: body,
            message_type: 'comment',
            subtype_xmlid: 'mail.mt_note',
          }]);
        } catch (msgErr) { /* ignore */ }

      } else if (situacao === 'CANCELADO' || situacao === 'BAIXADO') {
        writeVals['x_studio_itau_situacao'] = 'CANCELADO';
        writeVals['x_studio_itau_boleto_status'] = 'CANCELADO';
        writeVals['x_studio_itau_status_pagamento'] = 'CANCELADO';
      } else if (situacao) {
        writeVals['x_studio_itau_boleto_status'] = situacao;
      }

      var safeBoletoVals = filterWriteVals(writeVals, fieldChecks);
      if (Object.keys(safeBoletoVals).length > 0) {
        await odooExec(oc, odooHost, odooUid, 'account.move', 'write', [[inv.id], safeBoletoVals]);
        console.log('[PAYMENT-POLL] Boleto invoice ' + inv.name + ' (NN=' + nossoNumero + '): ' + situacao);
      }

    } catch (err) {
      console.error('[PAYMENT-POLL] Erro ao consultar boleto NN=' + nossoNumero + ':', err.message);
      errors++;
    }
  }

  return { processed: processed, paid: paid, errors: errors };
}

// ============================================================
// PROCESSAR EXTRATO PARA CONFIRMAÇÃO DE PAGAMENTO
// ============================================================

/**
 * Quando o extrato bancário é importado, busca linhas que correspondem
 * a faturas pendentes e marca como pagas.
 * Esta função é chamada após a importação do extrato.
 *
 * @param {Array} transacoes - Transações normalizadas do extrato
 * @returns {Object} { matched, invoices_paid }
 */
async function reconcileStatementPayments(transacoes) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) {
    return { matched: 0, invoices_paid: 0 };
  }

  var odooHost, odooUid;
  try {
    var authResult = await odooAuth(oc);
    odooUid = authResult.uid;
    odooHost = authResult.host;
  } catch (err) {
    console.error('[PAYMENT-POLL] Erro auth Odoo:', err.message);
    return { matched: 0, invoices_paid: 0 };
  }

  var matched = 0;
  var invoicesPaid = 0;

  // Detectar campos disponiveis
  var fieldChecks;
  try {
    fieldChecks = await detectFields(oc, odooHost, odooUid);
  } catch (err) {
    return { matched: 0, invoices_paid: 0 };
  }

  // Buscar invoices pendentes
  var domain = [
    ['move_type', '=', 'out_invoice'],
    ['payment_state', '!=', 'paid'],
  ];
  if (fieldChecks['x_studio_itau_tipo_pagamento']) {
    domain.push('|');
    domain.push(['x_studio_itau_tipo_pagamento', 'like', 'BOLETO']);
    domain.push(['x_studio_itau_tipo_pagamento', 'like', 'PIX']);
  }
  domain = buildSafeDomain(domain, fieldChecks);

  var invoiceIds;
  try {
    invoiceIds = await odooExec(oc, odooHost, odooUid, 'account.move', 'search', [domain], { limit: 100 });
  } catch (err) {
    return { matched: 0, invoices_paid: 0 };
  }

  if (!invoiceIds || invoiceIds.length === 0) {
    return { matched: 0, invoices_paid: 0 };
  }

  var recReadFields = ['name', 'amount_total'];
  if (fieldChecks['x_studio_itau_nosso_numero']) recReadFields.push('x_studio_itau_nosso_numero');
  if (fieldChecks['x_studio_itau_txid']) recReadFields.push('x_studio_itau_txid');
  if (fieldChecks['x_studio_itau_tipo_pagamento']) recReadFields.push('x_studio_itau_tipo_pagamento');

  var invoices = await odooExec(oc, odooHost, odooUid, 'account.move', 'read', [
    invoiceIds, recReadFields
  ]);

  // Para cada crédito no extrato, tentar match com invoice
  for (var t = 0; t < transacoes.length; t++) {
    var txn = transacoes[t];
    if (!txn.amount || txn.amount <= 0) continue; // Só créditos (entradas)

    for (var j = 0; j < invoices.length; j++) {
      var inv = invoices[j];
      // Match por valor (tolerância de R$ 0,02 por arredondamento)
      var diff = Math.abs(txn.amount - inv.amount_total);
      if (diff < 0.02) {
        matched++;

        // Verificar se já está pago
        var currentInv = await odooExec(oc, odooHost, odooUid, 'account.move', 'read', [
          [inv.id], ['payment_state']
        ]);
        if (currentInv && currentInv[0] && currentInv[0].payment_state === 'paid') continue;

        // Atualizar status
        var writeVals = {
          x_studio_itau_situacao: 'PAGO',
          x_studio_itau_status_pagamento: 'PAGO',
        };

        if (inv.x_studio_itau_tipo_pagamento && inv.x_studio_itau_tipo_pagamento.indexOf('PIX') >= 0) {
          writeVals.x_studio_itau_pix_status = 'CONCLUIDA';
          writeVals.x_studio_itau_pix_data_pagamento = txn.date + ' 00:00:00';
        } else {
          writeVals.x_studio_itau_boleto_status = 'PAGO';
          writeVals.x_studio_itau_boleto_data_pagamento = txn.date;
        }

        try {
          var safeRecVals = filterWriteVals(writeVals, fieldChecks);
          if (Object.keys(safeRecVals).length > 0) {
            await odooExec(oc, odooHost, odooUid, 'account.move', 'write', [[inv.id], safeRecVals]);
          } else {
            console.log('[PAYMENT-POLL] Nenhum campo valido para escrever (campos ausentes no Odoo)');
            continue;
          }
          invoicesPaid++;

          // Chatter note
          await odooExec(oc, odooHost, odooUid, 'mail.message', 'create', [{
            model: 'account.move',
            res_id: inv.id,
            body: '<p><b>✅ Pagamento confirmado via extrato bancário</b></p>'
              + '<p>Valor: R$ ' + txn.amount.toFixed(2) + '</p>'
              + '<p>Data: ' + txn.date + '</p>'
              + '<p>Ref: ' + (txn.name || txn.ref || 'N/A') + '</p>',
            message_type: 'comment',
            subtype_xmlid: 'mail.mt_note',
          }]);
        } catch (writeErr) {
          console.error('[PAYMENT-POLL] Erro ao atualizar invoice ' + inv.name + ':', writeErr.message);
        }

        // Remover da lista para não match novamente
        invoices.splice(j, 1);
        break;
      }
    }
  }

  return { matched: matched, invoices_paid: invoicesPaid };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  processPendingPix: processPendingPix,
  processPendingBoletos: processPendingBoletos,
  reconcileStatementPayments: reconcileStatementPayments,
};
