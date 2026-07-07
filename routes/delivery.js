/**
 * routes/delivery.js - Rotas TE protegidas por API Key
 * POST /send        - Envia entregas ao TE
 * POST /sync-unsynced - Forca sync dos pendentes
 * GET  /status/:id  - Consulta situacao no TE
 * GET  /occurrences/:id - Ocorrencias de uma entrega
 * PUT  /edit        - Edita entregas no TE
 * PUT  /cancel      - Cancela entregas no TE
 * POST /pull        - Puxa atualizacoes do TE
 * GET  /situations  - Lista situacoes disponiveis
 */
var express = require('express');
var router = express.Router();
var { apiKeyAuth } = require('../middleware/auth');
var teApi = require('../services/tudoentregue');
var odooTe = require('../services/odoo-te');
var mapper = require('../services/mapper-te');
var logger = require('../utils/logger');

router.use(apiKeyAuth);

// POST /api/v1/te/send - Envia picking ao TE
router.post('/send', async function(req, res) {
  try {
    var pickingId = req.body.picking_id;
    if (!pickingId) return res.status(400).json({ success: false, error: 'picking_id obrigatorio' });

    var client = odooTe.getClient();
    await client.authenticate();
    var pickings = await client.execute('stock.picking', 'read', [[pickingId]], {
      fields: odooTe.FIELDS['stock.picking'],
    });
    if (!pickings || !pickings.length) return res.status(404).json({ success: false, error: 'Picking nao encontrado' });

    var picking = pickings[0];
    var partnerId = picking.partner_id ? picking.partner_id[0] : null;
    if (!partnerId) return res.status(400).json({ success: false, error: 'Picking sem parceiro' });

    var partner = await odooTe.getPartner(partnerId);
    var saleId = picking.sale_id ? picking.sale_id[0] : null;
    var saleOrder = null;
    if (saleId) {
      var orders = await client.execute('sale.order', 'read', [[saleId]], {
        fields: odooTe.FIELDS['sale.order'],
      });
      saleOrder = orders ? orders[0] : null;
    }

    var delivery = mapper.odooToTeDelivery(picking, partner, saleOrder);
    if (!delivery) return res.status(500).json({ success: false, error: 'Falha ao mapear entrega' });

    var result = await teApi.createDeliveries([delivery]);

    // Grava te_order_id
    if (result && result.data && result.data.length) {
      var teId = result.data[0].Id || result.data[0].id;
      await odooTe.markPickingsSynced([pickingId], teId);
      if (saleId) await odooTe.markSaleOrdersSynced([saleId], teId);
    }

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('[TE-ROUTE] /send erro: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/te/sync-unsynced - Sync automatico dos pendentes
router.post('/sync-unsynced', async function(req, res) {
  try {
    var results = await runAutoSync();
    res.json({ success: true, synced: results.synced, errors: results.errors, details: results.details });
  } catch (err) {
    logger.error('[TE-ROUTE] /sync-unsynced erro: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/te/status/:id
router.get('/status/:id', async function(req, res) {
  try {
    var data = await teApi.getDeliveries({ id: req.params.id });
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/te/occurrences/:id
router.get('/occurrences/:id', async function(req, res) {
  try {
    var data = await teApi.getDeliveries({ entregaId: req.params.id });
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/v1/te/edit
router.put('/edit', async function(req, res) {
  try {
    var deliveries = req.body.deliveries || req.body;
    if (!Array.isArray(deliveries)) deliveries = [deliveries];
    var data = await teApi.editDeliveries(deliveries);
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/v1/te/cancel
router.put('/cancel', async function(req, res) {
  try {
    var deliveries = req.body.deliveries || req.body;
    if (!Array.isArray(deliveries)) deliveries = [deliveries];
    var data = await teApi.cancelDeliveries(deliveries);
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/te/pull - Puxa atualizacoes do TE
router.post('/pull', async function(req, res) {
  try {
    var filter = req.body.filter || {};
    var all = await teApi.fetchAllPages(filter);
    res.json({ success: true, count: all.length, data: all });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/te/situations
router.get('/situations', async function(req, res) {
  try {
    var data = await teApi.getSituations();
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Auto-sync logic (reused by route and cron) ---
async function runAutoSync() {
  var results = { synced: 0, errors: 0, details: [] };
  try {
    var pickings = await odooTe.getUnsyncedPickings();
    if (!pickings.length) {
      logger.info('[TE-AUTO-SYNC] Nenhum picking pendente encontrado');
      return results;
    }

    logger.info('[TE-AUTO-SYNC] ' + pickings.length + ' picking(s) pendente(s)');

    for (var i = 0; i < pickings.length; i++) {
      var picking = pickings[i];
      try {
        var partnerId = picking.partner_id ? picking.partner_id[0] : null;
        if (!partnerId) {
          results.errors++;
          results.details.push({ picking: picking.name, error: 'Sem parceiro' });
          continue;
        }

        var partner = await odooTe.getPartner(partnerId);
        var saleId = picking.sale_id ? picking.sale_id[0] : null;
        var saleOrder = null;
        if (saleId) {
          var odooClient = odooTe.getClient();
          var orders = await odooClient.execute('sale.order', 'read', [[saleId]], {
            fields: odooTe.FIELDS['sale.order'],
          });
          saleOrder = orders ? orders[0] : null;
        }

        var delivery = mapper.odooToTeDelivery(picking, partner, saleOrder);
        if (!delivery) {
          results.errors++;
          results.details.push({ picking: picking.name, error: 'Falha no mapeamento' });
          continue;
        }

        // Log no chatter - inicio do envio
        var chatterMsg = '<b>TudoEntregue - Enviando...</b><br/>';
        chatterMsg += 'Pedido: ' + (delivery.CodigoPedido || '') + '<br/>';
        chatterMsg += 'Destinatario: ' + (delivery.NomeDestinatario || '') + '<br/>';
        chatterMsg += 'CNPJ/CPF: ' + (delivery.CnpjCpfDestinatario || '') + '<br/>';
        chatterMsg += 'Cidade/UF: ' + (delivery.Municipio || '') + '/' + (delivery.Uf || '') + '<br/>';
        chatterMsg += 'CEP: ' + (delivery.Cep || '');

        await odooTe.postChatter('stock.picking', picking.id, chatterMsg);
        if (saleId) {
          await odooTe.postChatter('sale.order', saleId, chatterMsg);
        }

        var teResult = await teApi.createDeliveries([delivery]);

        // Extrai TE Id
        var teId = null;
        if (teResult && teResult.data && teResult.data.length) {
          teId = teResult.data[0].Id || teResult.data[0].id;
        }

        // Marca como sync
        await odooTe.markPickingsSynced([picking.id], teId);
        if (saleId) await odooTe.markSaleOrdersSynced([saleId], teId);

        // Log no chatter - resultado
        var resultMsg = '<b>TudoEntregue - Enviado com sucesso!</b><br/>';
        resultMsg += 'TE ID: ' + (teId || 'N/A') + '<br/>';
        resultMsg += 'Status API: ' + (teResult ? 'OK' : 'Sem resposta');
        await odooTe.postChatter('stock.picking', picking.id, resultMsg);
        if (saleId) {
          await odooTe.postChatter('sale.order', saleId, resultMsg);
        }

        results.synced++;
        results.details.push({ picking: picking.name, te_id: teId, status: 'ok' });
      } catch (err) {
        results.errors++;
        var errMsg = '<b>TudoEntregue - ERRO no envio</b><br/>' + err.message;
        await odooTe.postChatter('stock.picking', picking.id, errMsg).catch(function() {});
        results.details.push({ picking: picking.name, error: err.message });
        logger.error('[TE-AUTO-SYNC] Erro picking ' + picking.name + ': ' + err.message);
      }
    }
  } catch (err) {
    logger.error('[TE-AUTO-SYNC] Erro geral: ' + err.message);
    results.errors++;
  }
  return results;
}

module.exports = router;
module.exports.runAutoSync = runAutoSync;