/**
 * routes/fabricacao.js — Webhook de FABRICAÇÃO para o PCP (app externo Base44)
 * ====================================================
 * Demanda 23/10/2026 — "Regra de fabricação com estoque negativo:
 * PCP QUEM VAI DECIDIR, NO APP EXTERNO Q ENVIAMOS VIA WEBHOOKS"
 *
 * REGRAS:
 *  - O Odoo NUNCA bloqueia OF (mrp.production) por falta de estoque:
 *    criar/confirmar OF com componentes insuficientes é permitido e, ao
 *    concluir, o consumo negativo é aceito (estoque negativo).
 *  - A DECISÃO é do PCP, no app externo (Base44). Este webhook é o canal
 *    oficial para o app externo mandar o resultado dessa decisão.
 *
 * POST /api/v1/fabricacao/ordens   (header X-API-Key)
 * Body:
 * {
 *   "pedido": "S01234",                     // opcional — amarra a OF ao pedido
 *   "itens": [
 *     { "produto": "FERRO-CODE", "quantidade": 120.5, "unidade": "KG" },
 *     { "produto": 4567,          "quantidade": 3 }
 *   ],                                       // produto = ID Odoo OU default_code OU nome
 *   "permitir_estoque_negativo": true,       // default true (regra da demanda)
 *   "observacao": "decisão PCP ..."          // opcional, vai no chatter
 * }
 *
 * Comportamento por item:
 *  - resolve o produto (id > default_code exato > nome ilike);
 *  - acha a Lista de Materiais (BOM) do produto, se houver;
 *  - cria a OF em RASCUNHO (origin "BASE44-PCP/<pedido>") e CONFIRMA
 *    imediatamente — SEM checar disponibilidade de estoque (não há bloqueio
 *    em action_confirm; ao concluir o consumo negativo é permitido);
 *  - posta no chatter da OF (e do pedido, se houver) a nota da decisão PCP.
 *
 * Notas:
 *  - origin "BASE44-PCP/..." NÃO casa com o padrão "OP/xxx - S00xxx" nem
 *    "% - S00xxx", então a automação 56 (cancela OFs automáticas do padrão
 *    na confirmação do pedido) NUNCA toca nas OFs criadas aqui.
 *  - A regra 29 (Gatilho de criação de OF) continua dona do fluxo por linha
 *    ("PEDIDO - SOLid"); este webhook é um canal independente para o PCP.
 * ====================================================
 */
var express = require('express');
var router = express.Router();
var config = require('../config');
var xmlrpc = require('xmlrpc');

function apiKeyAuth(req, res, next) {
  var key = req.headers['x-api-key'] || req.query.api_key || '';
  if (key === config.middlewareApiKey) return next();
  return res.status(401).json({ error: 'Unauthorized — invalid API key' });
}

function odooAuth() {
  var oc = config.odoo || {};
  var base = (oc.url || '').replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  var port = base.startsWith('http://') ? 80 : 443;
  var createFn = base.startsWith('http://') ? xmlrpc.createClient : xmlrpc.createSecureClient;
  var commonCli = createFn({ host: host, path: '/xmlrpc/2/common', port: port });
  return new Promise(function (ok, fail) {
    commonCli.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function (e, r) {
      if (e || !r) return fail(e || new Error('Odoo auth failed'));
      ok({ uid: r, host: host, port: port, secure: !base.startsWith('http://'), oc: oc });
    });
  });
}

function odooExec(sess, model, method, args, kwargs) {
  var modelsCli = (sess.secure ? xmlrpc.createSecureClient : xmlrpc.createClient)({
    host: sess.host, path: '/xmlrpc/2/object', port: sess.port,
  });
  var params = [sess.oc.db, sess.uid, sess.oc.password, model, method, args];
  if (kwargs) params.push(kwargs);
  return new Promise(function (ok, fail) {
    modelsCli.methodCall('execute_kw', params, function (e, r) {
      if (e) return fail(e);
      ok(r);
    });
  });
}

function tupId(t) { return Array.isArray(t) ? t[0] : (t || false); }

// ============================================================
// POST /api/v1/fabricacao/ordens
// ============================================================
router.post('/ordens', apiKeyAuth, async function (req, res) {
  var body = req.body || {};
  var pedidoNome = String(body.pedido || body.numero_pedido || body.order || '').trim();
  var itens = Array.isArray(body.itens) ? body.itens
    : (Array.isArray(body.ofs) ? body.ofs : []);
  if (body.produto) {
    itens = [{
      produto: body.produto,
      quantidade: body.quantidade || body.qtd || body.qty || 1,
      unidade: body.unidade || body.uom,
    }];
  }
  var permitirNeg = (body.permitir_estoque_negativo !== undefined)
    ? !!body.permitir_estoque_negativo : true; // regra: PCP decide — nunca bloqueia
  var observacao = String(body.observacao || body.obs || '').trim();

  if (!itens.length) {
    return res.status(400).json({ sucesso: false, error: 'Informe "itens" (lista) ou "produto"+"quantidade".' });
  }

  try {
    var sess = await odooAuth();

    // Pedido (opcional) — para amarrar a OF e avisar no chatter
    var pedidoId = false;
    if (pedidoNome) {
      var pids = await odooExec(sess, 'sale.order', 'search', [[['name', '=', pedidoNome]]], { limit: 1 });
      if (pids && pids.length) pedidoId = pids[0];
    }

    var ofs = [];
    var avisos = [];
    for (var i = 0; i < itens.length; i++) {
      var it = itens[i] || {};
      var qtd = parseFloat(it.quantidade || it.qty || it.qtd || 1) || 0;
      var ref = it.produto || it.product || it.produto_id;
      if (!ref || qtd <= 0) {
        avisos.push('item ' + (i + 1) + ': produto/quantidade inválidos — ignorado');
        continue;
      }

      // --- resolver produto ---
      var prodId = 0, prodName = String(ref);
      if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
        prodId = parseInt(ref, 10);
      } else {
        var byCode = await odooExec(sess, 'product.product', 'search',
          [[['default_code', '=', String(ref)]]], { limit: 1 });
        if (byCode && byCode.length) {
          prodId = byCode[0];
        } else {
          var byName = await odooExec(sess, 'product.product', 'search',
            [[['name', '=ilike', String(ref)]]], { limit: 1 });
          if (byName && byName.length) prodId = byName[0];
        }
      }
      if (!prodId) {
        avisos.push('item ' + (i + 1) + ': produto "' + ref + '" não encontrado — ignorado');
        continue;
      }
      var prodData = await odooExec(sess, 'product.product', 'read', [[prodId],
        ['name', 'default_code', 'uom_id', 'product_tmpl_id']]);

      // --- unidade (opcional) ---
      var vals = {
        product_id: prodId,
        product_qty: qtd,
        origin: 'BASE44-PCP' + (pedidoNome ? '/' + pedidoNome : ''),
      };
      if (it.unidade) {
        var uoms = await odooExec(sess, 'uom.uom', 'search',
          [[['name', '=ilike', String(it.unidade)]]], { limit: 1 });
        if (uoms && uoms.length) vals.product_uom_id = uoms[0];
        else avisos.push('item ' + (i + 1) + ': unidade "' + it.unidade + '" não encontrada — usando a do produto');
      } else if (prodData[0] && prodData[0].uom_id) {
        vals.product_uom_id = tupId(prodData[0].uom_id);
      }

      // --- BOM (se houver) ---
      var tmplId = prodData[0] && prodData[0].product_tmpl_id ? tupId(prodData[0].product_tmpl_id) : false;
      var bomId = false;
      try {
        var bomDom = tmplId
          ? [['|', ['product_id', '=', prodId], ['product_tmpl_id', '=', tmplId]]]
          : [['product_id', '=', prodId]];
        var boms = await odooExec(sess, 'mrp.bom', 'search', bomDom, { limit: 1 });
        if (boms && boms.length) bomId = boms[0];
      } catch (eBom) { /* sem BOM: OF é criada mesmo assim (regra 29 igual) */ }
      if (bomId) vals.bom_id = bomId;

      // --- criar OF (rascunho) ---
      var moId;
      try {
        moId = await odooExec(sess, 'mrp.production', 'create', [vals]);
      } catch (eCreate) {
        avisos.push('item ' + (i + 1) + ' (' + ref + '): erro ao criar OF — ' + eCreate.message);
        continue;
      }
      if (Array.isArray(moId)) moId = moId[0];
      var moData = (await odooExec(sess, 'mrp.production', 'read', [[moId], ['name']]))[0];

      // --- CONFIRMAR (efetiva) SEM bloqueio de estoque ---
      // A regra da demanda: fabricação com estoque negativo PERMITIDA;
      // action_confirm do Odoo não exige disponibilidade — o consumo
      // negativo acontece na conclusão, conforme decisão do PCP.
      var confirmado = false, erroConfirm = '';
      try {
        await odooExec(sess, 'mrp.production', 'action_confirm', [[moId]]);
        confirmado = true;
      } catch (eConf) {
        erroConfirm = eConf.message;
      }

      // --- chatter ---
      var nota = '<b>OF via webhook PCP/Base44</b><br/>Estoque negativo: <b>' +
        (permitirNeg ? 'PERMITIDO (decisão do PCP no app externo)' : 'NÃO permitido') +
        '</b><br/>' + (pedidoNome ? 'Pedido: ' + pedidoNome + '<br/>' : '') +
        (observacao ? 'Obs.: ' + observacao : '');
      try {
        await odooExec(sess, 'mrp.production', 'message_post', [[moId]], { body: nota });
      } catch (eMsg) { /* chatter é best-effort */ }
      if (pedidoId) {
        try {
          await odooExec(sess, 'sale.order', 'message_post', [[pedidoId]], {
            body: 'OF ' + moData.name + ' (' + (prodData[0].default_code || prodData[0].name) +
              ' x ' + qtd + ') ' + (confirmado ? 'efetivada' : 'criada (não confirmada: ' + erroConfirm + ')') +
              ' via webhook PCP/Base44 — estoque negativo ' + (permitirNeg ? 'PERMITIDO' : 'NÃO permitido') + '.',
          });
        } catch (eMsg2) { /* best-effort */ }
      }

      ofs.push({
        id: moId,
        nome: moData.name,
        produto: prodData[0].default_code || prodData[0].name,
        quantidade: qtd,
        bom: bomId || false,
        confirmada: confirmado,
        erro_confirmacao: erroConfirm || undefined,
      });
    }

    if (!ofs.length) {
      return res.status(422).json({ sucesso: false, error: 'Nenhuma OF criada', avisos: avisos });
    }
    return res.json({
      sucesso: true,
      permitir_estoque_negativo: permitirNeg,
      pedido: pedidoNome || undefined,
      ofs: ofs,
      avisos: avisos,
    });
  } catch (err) {
    console.error('[FABRICACAO] Erro:', err.message);
    return res.status(500).json({ sucesso: false, error: err.message });
  }
});

// ============================================================
// GET /api/v1/fabricacao/ordens/:nome — conferência de uma OF
// ============================================================
router.get('/ordens/:nome', apiKeyAuth, async function (req, res) {
  try {
    var sess = await odooAuth();
    var ids = await odooExec(sess, 'mrp.production', 'search',
      [[['name', '=', req.params.nome]]], { limit: 1 });
    if (!ids.length) return res.status(404).json({ sucesso: false, error: 'OF não encontrada' });
    var r = await odooExec(sess, 'mrp.production', 'read', [ids,
      ['name', 'state', 'product_id', 'product_qty', 'uom_id', 'origin', 'date_start']]);
    return res.json({ sucesso: true, of: r[0] });
  } catch (err) {
    return res.status(500).json({ sucesso: false, error: err.message });
  }
});

module.exports = router;
