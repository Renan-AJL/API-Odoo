/**
 * routes/delivery.js - Rotas TE protegidas por API Key
 * Baseado na spec oficial TudoEntregue Swagger v1.0.20
 */
var express = require('express');
var router = express.Router();
var apiKeyAuth = require('../middleware/auth').apiKeyAuth;
var teApi = require('../services/tudoentregue');
var odooTe = require('../services/odoo-te');
var mapper = require('../services/mapper-te');
var config = require('../config');
var logger = require('../utils/logger');

router.use(apiKeyAuth);

// POST /api/v1/te/send-invoice - Envia fatura ao TE (chamado pela Server Action do Odoo)
// Aceita: { "invoice_id": 123 }  (um unico ID por chamada)
router.post('/send-invoice', async function(req, res) {
  var invId = req.body.invoice_id;
  if (!invId) return res.status(400).json({ success: false, error: 'invoice_id obrigatorio' });

  try {
    logger.info('[TE-SEND-INVOICE] Recebido invoice_id=' + invId);

    // 1. Encontra a venda relacionada a esta fatura
    var saleOrder = await odooTe.findSaleOrderByInvoice(invId);
    if (!saleOrder) {
      await odooTe.postChatter('account.move', invId, '<b>TudoEntregue - ERRO</b><br/>Venda nao encontrada para esta fatura. Verifique se a fatura esta vinculada a um pedido de venda.');
      return res.status(404).json({ success: false, error: 'Venda nao encontrada para esta fatura' });
    }
    logger.info('[TE-SEND-INVOICE] Venda: ' + saleOrder.name + ' (id=' + saleOrder.id + ')');

    // 2. Encontra o picking de entrega
    var picking = await odooTe.findDeliveryPicking(saleOrder.id);
    if (!picking) {
      await odooTe.postChatter('account.move', invId, '<b>TudoEntregue - ERRO</b><br/>Picking de entrega nao encontrado para a venda ' + saleOrder.name + '. Confirme o pedido de venda primeiro.');
      return res.status(404).json({ success: false, error: 'Picking de entrega nao encontrado' });
    }
    logger.info('[TE-SEND-INVOICE] Picking: ' + picking.name + ' (id=' + picking.id + ')');

    // 3. Le o partner
    var partnerId = picking.partner_id ? picking.partner_id[0] : null;
    if (!partnerId) {
      return res.status(400).json({ success: false, error: 'Picking sem parceiro' });
    }
    var partner = await odooTe.getPartner(partnerId);

    // 4. Le a venda completa (para campos x_studio + amount_total)
    var saleFull = await odooTe.readSaleOrder(saleOrder.id);

    // 5. Le a fatura completa (para numero NF + valor)
    var invoice = { id: invId, name: String(invId), amount_total: 0 };
    try {
      var invRead = await odooTe.executeKw('account.move', 'read', [[invId]], {
        fields: ['id', 'name', 'amount_total'],
      });
      if (invRead && invRead[0]) invoice = invRead[0];
    } catch (err) {
      logger.warn('[TE-SEND-INVOICE] Erro lendo fatura (usando fallback): ' + err.message);
    }

    // 6. Le os moves do picking (itens/produtos)
    var moves = await odooTe.getStockMoves(picking.id);
    var productIds = [];
    if (moves.length) {
      moves.forEach(function(m) {
        if (m.product_id && m.product_id[0]) productIds.push(m.product_id[0]);
      });
    }
    var productsMap = await odooTe.getProducts(productIds);

    // 7. Le dados da empresa (remetente)
    var company = await odooTe.getCompany();

    // 8. Mapeia para TE
    var delivery = mapper.odooToTeDelivery({
      picking: picking,
      partner: partner,
      saleOrder: saleFull,
      invoice: invoice,
      company: company,
      companyCnpj: config.empresa.cnpj,
      moves: moves,
      productsMap: productsMap,
    });
    if (!delivery) {
      return res.status(500).json({ success: false, error: 'Falha no mapeamento dos dados' });
    }

    // 9. Chatter: enviando
    var chatterMsg = '<b>TudoEntregue - Enviando...</b><br/>';
    chatterMsg += 'Fatura ID: ' + invId + '<br/>';
    chatterMsg += 'Pedido: ' + delivery.OrderNumber + '<br/>';
    chatterMsg += 'Destinatario: ' + (delivery.DestinationAddress.Name || '') + '<br/>';
    chatterMsg += 'CNPJ/CPF: ' + (delivery.DestinationAddress.DocumentNumber || '') + '<br/>';
    chatterMsg += 'Cidade: ' + (delivery.DestinationAddress.City || '') + '/' + (delivery.DestinationAddress.State || '') + '<br/>';
    chatterMsg += 'CEP: ' + (delivery.DestinationAddress.ZipCode || '');
    if (delivery.Weight) chatterMsg += '<br/>Peso: ' + delivery.Weight + ' kg';
    if (delivery.Volume) chatterMsg += ' | Volumes: ' + delivery.Volume;
    if (delivery.Documents && delivery.Documents.length) {
      chatterMsg += '<br/>NF: ' + (delivery.Documents[0].DocumentNumber || '');
    }
    await odooTe.postChatter('account.move', invId, chatterMsg);
    await odooTe.postChatter('stock.picking', picking.id, chatterMsg);
    await odooTe.postChatter('sale.order', saleOrder.id, chatterMsg);

    // 7. Envia ao TE
    logger.info('[TE-SEND-INVOICE] Payload TE: ' + JSON.stringify(delivery, null, 2));
    var teResult = await teApi.createOrders([delivery]);
    var teResp = Array.isArray(teResult) ? teResult[0] : teResult;

    // 8. Grava retorno
    if (teResp) {
      var odooData = mapper.teCreateToOdoo(teResp);
      await odooTe.markInvoiceSynced([invId], teResp.OrderID || null);
      if (Object.keys(odooData).length) {
        await odooTe.updatePickingTeData(picking.id, odooData);
        await odooTe.updateSaleOrderTeData(saleOrder.id, odooData);
      }
      await odooTe.markPickingsSynced([picking.id], teResp.OrderID || null);
      await odooTe.markSaleOrdersSynced([saleOrder.id], teResp.OrderID || null);

      var resultMsg = mapper.chatterCreateMessage(teResp, delivery);
      await odooTe.postChatter('account.move', invId, resultMsg);
      await odooTe.postChatter('stock.picking', picking.id, resultMsg);
      await odooTe.postChatter('sale.order', saleOrder.id, resultMsg);

      res.json({
        success: true,
        invoice_id: invId,
        sale: saleOrder.name,
        picking: picking.name,
        te_order_id: teResp.OrderID,
        te_received: teResp.Received,
        te_tracking: teResp.TrackingCode,
      });
    } else {
      await odooTe.postChatter('account.move', invId, '<b>TudoEntregue - ERRO</b><br/>TE nao retornou dados.');
      res.status(502).json({ success: false, error: 'TE nao retornou dados' });
    }
  } catch (err) {
    logger.error('[TE-SEND-INVOICE] Erro: ' + err.message);
    await odooTe.postChatter('account.move', invId, '<b>TudoEntregue - ERRO no envio</b><br/>' + err.message).catch(function() {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/te/send - Envia picking ao TE
router.post('/send', async function(req, res) {
  try {
    var pickingId = req.body.picking_id;
    if (!pickingId) return res.status(400).json({ success: false, error: 'picking_id obrigatorio' });

    var picking = await odooTe.readPicking(pickingId);
    if (!picking) return res.status(404).json({ success: false, error: 'Picking nao encontrado' });

    var partnerId = picking.partner_id ? picking.partner_id[0] : null;
    if (!partnerId) return res.status(400).json({ success: false, error: 'Picking sem parceiro' });

    var partner = await odooTe.getPartner(partnerId);
    var saleId = picking.sale_id ? picking.sale_id[0] : null;
    var saleOrder = null;
    if (saleId) saleOrder = await odooTe.readSaleOrder(saleId);

    // Le moves, produtos e empresa para mapeamento completo
    var moves = await odooTe.getStockMoves(pickingId);
    var productIds = [];
    if (moves.length) {
      moves.forEach(function(m) {
        if (m.product_id && m.product_id[0]) productIds.push(m.product_id[0]);
      });
    }
    var productsMap = await odooTe.getProducts(productIds);
    var company = await odooTe.getCompany();

    var delivery = mapper.odooToTeDelivery({
      picking: picking, partner: partner, saleOrder: saleOrder,
      invoice: null, company: company, companyCnpj: config.empresa.cnpj,
      moves: moves, productsMap: productsMap,
    });
    if (!delivery) return res.status(500).json({ success: false, error: 'Falha no mapeamento' });

    // Log no chatter - inicio
    var chatterMsg = '<b>TudoEntregue - Enviando...</b><br/>';
    chatterMsg += 'Pedido: ' + delivery.OrderNumber + '<br/>';
    chatterMsg += 'Destinatario: ' + (delivery.DestinationAddress.Name || '') + '<br/>';
    chatterMsg += 'Cidade: ' + (delivery.DestinationAddress.City || '') + '/' + (delivery.DestinationAddress.State || '') + '<br/>';
    chatterMsg += 'CEP: ' + (delivery.DestinationAddress.ZipCode || '');
    if (delivery.Weight) chatterMsg += '<br/>Peso: ' + delivery.Weight + ' kg';
    if (delivery.Volume) chatterMsg += ' | Volumes: ' + delivery.Volume;
    await odooTe.postChatter('stock.picking', pickingId, chatterMsg);
    if (saleId) await odooTe.postChatter('sale.order', saleId, chatterMsg);

    var result = await teApi.createOrders([delivery]);
    var teResp = Array.isArray(result) ? result[0] : result;

    // Grava dados de retorno
    if (teResp && teResp.Received !== undefined) {
      var odooData = mapper.teCreateToOdoo(teResp);
      if (Object.keys(odooData).length) {
        await odooTe.updatePickingTeData(pickingId, odooData);
      }
      // Marca como sync
      await odooTe.markPickingsSynced([pickingId], teResp.OrderID || null);
      if (saleId) await odooTe.markSaleOrdersSynced([saleId], teResp.OrderID || null);

      // Chatter resultado
      var resultMsg = mapper.chatterCreateMessage(teResp, delivery);
      await odooTe.postChatter('stock.picking', pickingId, resultMsg);
      if (saleId) await odooTe.postChatter('sale.order', saleId, resultMsg);
    }

    res.json({ success: true, data: teResp });
  } catch (err) {
    logger.error('[TE-ROUTE] /send erro: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/te/sync-unsynced - Forca sync dos pendentes
router.post('/sync-unsynced', async function(req, res) {
  try {
    var results = await runAutoSync();
    res.json({ success: true, synced: results.synced, errors: results.errors, details: results.details });
  } catch (err) {
    logger.error('[TE-ROUTE] /sync-unsynced erro: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/te/status - Consulta situacao
router.get('/status', async function(req, res) {
  try {
    var params = {};
    if (req.query.order_id) params.orderID = req.query.order_id;
    if (req.query.order_type) params.orderType = req.query.order_type;
    if (req.query.phone) params.phoneNumber = req.query.phone;
    if (req.query.phone_country) params.phoneCountry = req.query.phone_country;
    var data = await teApi.getSituation(params);
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/te/occurrences - Consulta entregas com ocorrencia
router.get('/occurrences', async function(req, res) {
  try {
    var params = {};
    if (req.query.order_id) params.orderID = req.query.order_id;
    if (req.query.order_type) params.orderType = req.query.order_type;
    if (req.query.partial !== undefined) params.partial = req.query.partial;
    if (req.query.phone) params.phoneNumber = req.query.phone;
    var data = await teApi.getFinished(params);
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/te/tracking - Acompanhamento
router.get('/tracking', async function(req, res) {
  try {
    if (!req.query.code) return res.status(400).json({ error: 'trackingCode obrigatorio' });
    var data = await teApi.getTracking(req.query.code);
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/v1/te/cancel - Cancelar entregas
router.put('/cancel', async function(req, res) {
  try {
    var data = await teApi.cancelOrders(req.body);
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Auto-sync (poll faturas postadas + envia ao TE) ---
// Fluxo: Fatura postada (NF emitida) -> Venda (sale.order) -> Picking de entrega -> TE
async function runAutoSync() {
  var results = { synced: 0, errors: 0, details: [] };
  try {
    var invoices = await odooTe.getUnsyncedInvoices();
    if (!invoices.length) {
      logger.info('[TE-AUTO-SYNC] Nenhuma fatura pendente');
      return results;
    }
    logger.info('[TE-AUTO-SYNC] ' + invoices.length + ' fatura(s) pendente(s)');

    for (var i = 0; i < invoices.length; i++) {
      var invoice = invoices[i];
      try {
        logger.info('[TE-AUTO-SYNC] Fatura ' + invoice.name + ' (id=' + invoice.id + ')');

        // 1. Encontra a venda relacionada
        var saleOrder = await odooTe.findSaleOrderByInvoice(invoice.id);
        if (!saleOrder) {
          logger.warn('[TE-AUTO-SYNC] Venda nao encontrada para fatura ' + invoice.name);
          // Marca como sync para nao tentar de novo (fatura sem venda vinculada)
          await odooTe.markInvoiceSynced([invoice.id], null);
          results.details.push({ invoice: invoice.name, error: 'Venda nao encontrada' });
          continue;
        }
        logger.info('[TE-AUTO-SYNC] Venda encontrada: ' + saleOrder.name);

        // 2. Encontra o picking de entrega
        var picking = await odooTe.findDeliveryPicking(saleOrder.id);
        if (!picking) {
          logger.warn('[TE-AUTO-SYNC] Picking de entrega nao encontrado para venda ' + saleOrder.name);
          results.details.push({ invoice: invoice.name, sale: saleOrder.name, error: 'Picking nao encontrado' });
          continue;
        }
        logger.info('[TE-AUTO-SYNC] Picking encontrado: ' + picking.name);

        // 3. Le o partner completo
        var partnerId = picking.partner_id ? picking.partner_id[0] : null;
        if (!partnerId) {
          results.details.push({ invoice: invoice.name, error: 'Picking sem parceiro' });
          continue;
        }
        var partner = await odooTe.getPartner(partnerId);

        // 4. Le dados completos para mapeamento
        var saleFull = await odooTe.readSaleOrder(saleOrder.id);
        var moves = await odooTe.getStockMoves(picking.id);
        var moveProductIds = [];
        if (moves.length) {
          moves.forEach(function(m) {
            if (m.product_id && m.product_id[0]) moveProductIds.push(m.product_id[0]);
          });
        }
        var productsMap = await odooTe.getProducts(moveProductIds);
        var company = await odooTe.getCompany();

        var delivery = mapper.odooToTeDelivery({
          picking: picking, partner: partner, saleOrder: saleFull,
          invoice: invoice, company: company, companyCnpj: config.empresa.cnpj,
          moves: moves, productsMap: productsMap,
        });
        if (!delivery) {
          results.details.push({ invoice: invoice.name, error: 'Falha no mapeamento' });
          continue;
        }

        // 5. Chatter: enviando (na fatura, na venda e no picking)
        var chatterMsg = '<b>TudoEntregue - Enviando...</b><br/>';
        chatterMsg += 'Fatura: ' + invoice.name + '<br/>';
        chatterMsg += 'Pedido: ' + delivery.OrderNumber + '<br/>';
        chatterMsg += 'Destinatario: ' + (delivery.DestinationAddress.Name || '') + '<br/>';
        chatterMsg += 'CNPJ/CPF: ' + (delivery.DestinationAddress.DocumentNumber || '') + '<br/>';
        chatterMsg += 'Cidade: ' + (delivery.DestinationAddress.City || '') + '/' + (delivery.DestinationAddress.State || '') + '<br/>';
        chatterMsg += 'CEP: ' + (delivery.DestinationAddress.ZipCode || '');
        if (delivery.Weight) chatterMsg += '<br/>Peso: ' + delivery.Weight + ' kg';
        if (delivery.Volume) chatterMsg += ' | Volumes: ' + delivery.Volume;
        if (delivery.Documents && delivery.Documents.length) {
          chatterMsg += '<br/>NF: ' + (delivery.Documents[0].DocumentNumber || '');
        }
        await odooTe.postChatter('account.move', invoice.id, chatterMsg);
        await odooTe.postChatter('stock.picking', picking.id, chatterMsg);
        await odooTe.postChatter('sale.order', saleOrder.id, chatterMsg);

        // 6. Envia ao TE
        logger.info('[TE-AUTO-SYNC] Payload para TE: ' + JSON.stringify(delivery, null, 2));
        var teResult = await teApi.createOrders([delivery]);
        var teResp = Array.isArray(teResult) ? teResult[0] : teResult;

        // 7. Grava retorno em todos os modelos
        if (teResp) {
          var odooData = mapper.teCreateToOdoo(teResp);

          // Marca fatura como sync
          await odooTe.markInvoiceSynced([invoice.id], teResp.OrderID || null);

          // Grava dados TE no picking e venda (se campos existem)
          if (Object.keys(odooData).length) {
            await odooTe.updatePickingTeData(picking.id, odooData);
            await odooTe.updateSaleOrderTeData(saleOrder.id, odooData);
          }
          await odooTe.markPickingsSynced([picking.id], teResp.OrderID || null);
          await odooTe.markSaleOrdersSynced([saleOrder.id], teResp.OrderID || null);

          // Chatter: resultado
          var resultMsg = mapper.chatterCreateMessage(teResp, delivery);
          await odooTe.postChatter('account.move', invoice.id, resultMsg);
          await odooTe.postChatter('stock.picking', picking.id, resultMsg);
          await odooTe.postChatter('sale.order', saleOrder.id, resultMsg);
        }

        results.synced++;
        results.details.push({
          invoice: invoice.name,
          sale: saleOrder.name,
          picking: picking.name,
          te_id: teResp ? teResp.OrderID : null,
          status: 'ok',
        });
      } catch (err) {
        results.errors++;
        var errMsg = '<b>TudoEntregue - ERRO no envio</b><br/>Fatura: ' + invoice.name + '<br/>' + err.message;
        await odooTe.postChatter('account.move', invoice.id, errMsg).catch(function() {});
        results.details.push({ invoice: invoice.name, error: err.message });
        logger.error('[TE-AUTO-SYNC] Erro fatura ' + invoice.name + ': ' + err.message);
      }
    }
  } catch (err) {
    logger.error('[TE-AUTO-SYNC] Erro geral: ' + err.message);
    results.errors++;
  }
  return results;
}

router._runAutoSync = runAutoSync;
module.exports = router;