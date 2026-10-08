/**
 * services/consultflex-poll.js — ConsultFlex Polling (like SIEG)
 * ==============================================================
 * Polls Odoo sale.orders with x_studio_cf_status = 'pendente',
 * calls ConsultFlex API, and writes the HTML result back.
 * Runs every 15 seconds in the background.
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');
var { consultarCredito, formatarRespostaHtml } = require('./consultflex');

var POLL_INTERVAL_MS = 15000; // 15s
var MAX_PER_POLL = 5; // Process up to 5 per poll cycle

/**
 * Authenticate to Odoo and return uid + clients
 */
function odooConnect() {
  return new Promise(function(ok, fail) {
    var oc = config.odoo;
    if (!oc || !oc.enabled || !oc.url) return fail(new Error('Odoo not configured'));

    var base = oc.url.replace(/\/+$/, '');
    var host = base.replace('https://', '');
    var commonCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });

    commonCli.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, r) {
      if (e || !r) return fail(e || new Error('Odoo auth failed'));
      ok({ uid: r, host: host, oc: oc });
    });
  });
}

/**
 * Execute Odoo XML-RPC call
 */
function odooExec(conn, model, method, args, kwargs) {
  return new Promise(function(ok, fail) {
    var modelsCli = xmlrpc.createSecureClient({ host: conn.host, path: '/xmlrpc/2/object', port: 443 });
    var params = [conn.oc.db, conn.uid, conn.oc.password, model, method, args];
    if (kwargs) params.push(kwargs);
    modelsCli.methodCall('execute_kw', params, function(e, r) {
      if (e) return fail(e);
      ok(r);
    });
  });
}

/**
 * Process pending ConsultFlex consultations
 */
async function processPendingConsultations() {
  var conn;
  try {
    conn = await odooConnect();
  } catch (e) {
    // Odoo not configured, skip
    return { processed: 0 };
  }

  // Search sale.orders with cf_status = 'pendente'
  var orderIds;
  try {
    orderIds = await odooExec(conn, 'sale.order', 'search', [
      [['x_studio_cf_status', '=', 'pendente']],
    ], { limit: MAX_PER_POLL });
  } catch (e) {
    console.error('[CF-POLL] Error searching pending:', e.message);
    return { processed: 0, error: e.message };
  }

  if (!orderIds || orderIds.length === 0) {
    return { processed: 0 };
  }

  console.log('[CF-POLL] Found %d pending consultation(s): %s', orderIds.length, JSON.stringify(orderIds));

  // Read the orders
  var orders;
  try {
    orders = await odooExec(conn, 'sale.order', 'read', [
      [orderIds],
      ['x_studio_cf_cpfcnpj', 'x_studio_cf_tipo_pessoa', 'partner_id']
    ]);
  } catch (e) {
    console.error('[CF-POLL] Error reading orders:', e.message);
    return { processed: 0, error: e.message };
  }

  var processed = 0;
  var sucesso = 0;

  for (var i = 0; i < orders.length; i++) {
    var order = orders[i];
    var cpfcnpj = (order.x_studio_cf_cpfcnpj || '').replace(/\D/g, '');
    var tipoPessoa = order.x_studio_cf_tipo_pessoa || '';

    // Fallback: get from partner
    if (!cpfcnpj && order.partner_id && order.partner_id.length > 0) {
      try {
        var partner = await odooExec(conn, 'res.partner', 'read', [
          [order.partner_id[0]],
          ['vat', 'is_company']
        ]);
        if (partner && partner.length > 0) {
          cpfcnpj = (partner[0].vat || '').replace(/\D/g, '');
          tipoPessoa = partner[0].is_company ? 'J' : 'F';
        }
      } catch (pe) {
        console.error('[CF-POLL] Error reading partner:', pe.message);
      }
    }

    if (!cpfcnpj) {
      // Mark as error
      try {
        await odooExec(conn, 'sale.order', 'write', [
          [order.id],
          {
            'x_studio_cf_status': 'erro',
            'x_studio_resposta_consultflex': '<p style="color:red;font-weight:bold">Erro: CPF/CNPJ nao encontrado no pedido nem no parceiro.</p>'
          }
        ]);
      } catch (we) {}
      processed++;
      continue;
    }

    // Call ConsultFlex API
    try {
      var resultado = await consultarCredito({ cpfcnpj: cpfcnpj, tipoPessoa: tipoPessoa });
      var html = formatarRespostaHtml(resultado);

      var writeVals = {
        'x_studio_cf_status': 'concluido',
        'x_studio_resposta_consultflex': html,
      };

      // Try to write data_consulta
      try {
        var nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
        writeVals['x_studio_cf_data_consulta'] = nowStr;
      } catch (de) {}

      await odooExec(conn, 'sale.order', 'write', [[order.id], writeVals]);
      sucesso++;
      console.log('[CF-POLL] Consulta concluida: sale.order %s (%s %s)', order.id, tipoPessoa === 'J' ? 'CNPJ' : 'CPF', cpfcnpj.substring(0, 3) + '***');
    } catch (cfErr) {
      console.error('[CF-POLL] ConsultFlex API error for order %s:', order.id, cfErr.message);
      try {
        await odooExec(conn, 'sale.order', 'write', [
          [order.id],
          {
            'x_studio_cf_status': 'erro',
            'x_studio_resposta_consultflex': '<p style="color:red;font-weight:bold">Erro: ' + (cfErr.message || 'Erro desconhecido') + '</p>'
          }
        ]);
      } catch (we2) {}
    }
    processed++;
  }

  return { processed: processed, sucesso: sucesso };
}

module.exports = { processPendingConsultations };
