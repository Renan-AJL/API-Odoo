/**
 * routes/odoo-admin.js - Rota admin para aplicar demandas diretamente no Odoo
 * Usa a conexão XML-RPC já configurada no config
 */
const express = require('express');
const router = express.Router();
const xmlrpc = require('xmlrpc');
const config = require('../config');

// Auth middleware
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key || '';
  if (key !== config.middlewareApiKey) {
    return res.status(401).json({ success: false, error: 'API Key invalida' });
  }
  next();
}

// XML-RPC helpers
function createClient(url) {
  var base = url.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  var port = base.startsWith('https') ? 443 : 80;
  var isSecure = base.startsWith('https');
  var createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host: host, path: '/xmlrpc/2/common', port: port }),
    models: createFn({ host: host, path: '/xmlrpc/2/object', port: port }),
  };
}

function authenticate(client, db, login, password) {
  return new Promise(function(resolve, reject) {
    client.common.methodCall('authenticate', [db, login, password, {}], function(err, uid) {
      if (err) reject(new Error('Auth falhou: ' + (err.message || JSON.stringify(err))));
      else if (uid === false || uid === null) reject(new Error('Credenciais invalidas'));
      else resolve(uid);
    });
  });
}

function executeKw(client, db, uid, password, model, method, args, kwargs) {
  return new Promise(function(resolve, reject) {
    var params = [db, uid, password, model, method, args || []];
    if (kwargs) params.push(kwargs);
    client.models.methodCall('execute_kw', params, function(err, result) {
      if (err) reject(new Error(model + '.' + method + ': ' + (err.message || JSON.stringify(err))));
      else resolve(result);
    });
  });
}

// POST /api/v1/admin/apply-demandas
router.post('/apply-demandas', apiKeyAuth, async function(req, res) {
  const odoo = config.odoo;
  if (!odoo || !odoo.url || !odoo.enabled) {
    return res.status(503).json({ success: false, error: 'Odoo nao configurado' });
  }

  var results = [];
  var client, uid, db, pwd;

  try {
    client = createClient(odoo.url);
    uid = await authenticate(client, odoo.db, odoo.user, odoo.password);
    db = odoo.db;
    pwd = odoo.password;
    results.push({ step: 'auth', ok: true, uid: uid });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Auth falhou: ' + e.message });
  }

  function ekw(model, method, args, kwargs) {
    return executeKw(client, db, uid, pwd, model, method, args, kwargs);
  }

  // === 1. PESO UNITARIO x QTD = PESO TOTAL ===
  try {
    var solModelId = await ekw('ir.model', 'search', [[['model', '=', 'sale.order.line']]], {limit: 1});
    
    // x_studio_peso_unitario
    var existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_peso_unitario'],['model','=','sale.order.line']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_peso_unitario','model_id':solModelId[0],'field_description':'Peso Unitario (kg)','ttype':'float','store':true}]);
      results.push({step:'peso_unitario', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'peso_unitario', ok:true, msg:'Ja existe'});
    }

    // x_studio_peso_total
    existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_peso_total'],['model','=','sale.order.line']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_peso_total','model_id':solModelId[0],'field_description':'Peso Total (kg)','ttype':'float','store':true}]);
      results.push({step:'peso_total', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'peso_total', ok:true, msg:'Ja existe'});
    }

    // x_studio_peso no product.product
    var prodModelId = await ekw('ir.model', 'search', [[['model', '=', 'product.product']]], {limit: 1});
    existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_peso'],['model','=','product.product']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_peso','model_id':prodModelId[0],'field_description':'Peso Unitario (kg)','ttype':'float','store':true}]);
      results.push({step:'peso_produto', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'peso_produto', ok:true, msg:'Ja existe'});
    }
  } catch(e) { results.push({step:'peso', ok:false, error:e.message}); }

  // === 2. VENDEDOR VINCULADO AO CLIENTE ===
  try {
    var partnerModelId = await ekw('ir.model', 'search', [[['model', '=', 'res.partner']]], {limit: 1});
    var existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_vendedor_cadastro'],['model','=','res.partner']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_vendedor_cadastro','model_id':partnerModelId[0],'field_description':'Vendedor Cadastro','ttype':'many2one','relation':'res.users','store':true}]);
      results.push({step:'vendedor_cadastro', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'vendedor_cadastro', ok:true, msg:'Ja existe'});
    }

    // Server action: vincular vendedor ao criar cliente
    var saExists = await ekw('ir.actions.server', 'search', [[['name','=','AJL: Vincular Vendedor ao Cliente']]], {limit:1});
    if (!saExists.length) {
      var saId = await ekw('ir.actions.server', 'create', [{
        'name': 'AJL: Vincular Vendedor ao Cliente',
        'model_id': partnerModelId[0],
        'state': 'code',
        'code': 'if not record.x_studio_vendedor_cadastro:\n    record["x_studio_vendedor_cadastro"] = env.uid\nif not record.user_id:\n    record["user_id"] = env.uid',
      }]);
      results.push({step:'sa_vendedor', ok:true, id:saId});
    } else {
      results.push({step:'sa_vendedor', ok:true, msg:'Ja existe', id:saExists[0]});
    }

    // Server action: usar vendedor do cliente na venda
    var soModelId = await ekw('ir.model', 'search', [[['model', '=', 'sale.order']]], {limit: 1});
    var sa2Exists = await ekw('ir.actions.server', 'search', [[['name','=','AJL: Vendedor do Cliente na Venda']]], {limit:1});
    if (!sa2Exists.length) {
      var sa2Id = await ekw('ir.actions.server', 'create', [{
        'name': 'AJL: Vendedor do Cliente na Venda',
        'model_id': soModelId[0],
        'state': 'code',
        'code': 'if record.partner_id.x_studio_vendedor_cadastro and record.partner_id.x_studio_vendedor_cadastro != record.user_id:\n    record["user_id"] = record.partner_id.x_studio_vendedor_cadastro\nelif record.partner_id.user_id and record.partner_id.user_id != record.user_id:\n    record["user_id"] = record.partner_id.user_id',
      }]);
      results.push({step:'sa_vendedor_venda', ok:true, id:sa2Id});
    } else {
      results.push({step:'sa_vendedor_venda', ok:true, msg:'Ja existe', id:sa2Exists[0]});
    }
  } catch(e) { results.push({step:'vendedor', ok:false, error:e.message}); }

  // === 3. STATUS PEDIDO + STATUS FABRICACAO + DIAS PARADOS ===
  try {
    var soModelId = await ekw('ir.model', 'search', [[['model', '=', 'sale.order']]], {limit: 1});
    
    // x_studio_status_pedido
    var existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_status_pedido'],['model','=','sale.order']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_status_pedido','model_id':soModelId[0],'field_description':'Status Pedido','ttype':'selection','selection':"[['aberto','Aberto'],['faturado','Faturado'],['aprovado','Aprovado (Producao)'],['cancelado','Cancelado']]",'store':true}]);
      results.push({step:'status_pedido', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'status_pedido', ok:true, msg:'Ja existe'});
    }

    // x_studio_status_fabricacao
    existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_status_fabricacao'],['model','=','sale.order']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_status_fabricacao','model_id':soModelId[0],'field_description':'Status Fabricacao','ttype':'selection','selection':"[['sem_fabricacao','Sem Fabricacao'],['em_producao','Em Producao'],['finalizada','Finalizada'],['parcial','Parcial'],['cancelada','Cancelada']]",'store':true}]);
      results.push({step:'status_fabricacao', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'status_fabricacao', ok:true, msg:'Ja existe'});
    }

    // x_studio_dias_parados
    existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_dias_parados'],['model','=','sale.order']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_dias_parados','model_id':soModelId[0],'field_description':'Dias Parados','ttype':'integer','store':true}]);
      results.push({step:'dias_parados', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'dias_parados', ok:true, msg:'Ja existe'});
    }

    // Server action: calcular status derivado
    var saStatus = await ekw('ir.actions.server', 'search', [[['name','=','AJL: Calcular Status do Pedido']]], {limit:1});
    if (!saStatus.length) {
      var saId = await ekw('ir.actions.server', 'create', [{
        'name': 'AJL: Calcular Status do Pedido',
        'model_id': soModelId[0],
        'state': 'code',
        'code': 'if record.invoice_status == "invoiced":\n    record["x_studio_status_pedido"] = "faturado"\nelif record.state in ("draft", "sent"):\n    record["x_studio_status_pedido"] = "aberto"\nelif record.state == "cancel":\n    record["x_studio_status_pedido"] = "cancelado"\nelif record.state in ("sale", "done"):\n    mo_count = env["mrp.production"].search_count([("origin", "=", record.name), ("state", "in", ("confirmed", "progress", "to_close"))])\n    if mo_count > 0:\n        record["x_studio_status_pedido"] = "aprovado"\nmos = env["mrp.production"].search([("origin", "=", record.name)])\nif not mos:\n    record["x_studio_status_fabricacao"] = "sem_fabricacao"\nelse:\n    all_done = all(mo.state == "done" for mo in mos)\n    has_progress = any(mo.state in ("progress", "confirmed") for mo in mos)\n    if all_done:\n        record["x_studio_status_fabricacao"] = "finalizada"\n    elif has_progress:\n        record["x_studio_status_fabricacao"] = "em_producao"\n    else:\n        record["x_studio_status_fabricacao"] = "parcial"',
      }]);
      results.push({step:'sa_status', ok:true, id:saId});
    } else {
      results.push({step:'sa_status', ok:true, msg:'Ja existe', id:saStatus[0]});
    }
  } catch(e) { results.push({step:'status', ok:false, error:e.message}); }

  // === 4. CRM: ESTAGIO PRODUTO FINALIZADO + DIAS PARADOS ===
  try {
    var pfStage = await ekw('crm.stage', 'search', [[['name','ilike','Finalizado']]], {limit:1});
    if (!pfStage.length) {
      var stages = await ekw('crm.stage', 'search_read', [[]], {fields:['sequence'], order:'sequence desc', limit:1});
      var maxSeq = stages.length ? stages[0].sequence : 0;
      var newId = await ekw('crm.stage', 'create', [{'name':'Produto Finalizado','sequence':maxSeq+1,'is_won':true,'fold':true}]);
      results.push({step:'crm_finalizado', ok:true, id:newId});
    } else {
      results.push({step:'crm_finalizado', ok:true, msg:'Ja existe', id:pfStage[0]});
    }

    // x_studio_dias_parados_estagio no crm.lead
    var crmModelId = await ekw('ir.model', 'search', [[['model','=','crm.lead']]], {limit:1});
    var existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_dias_parados_estagio'],['model','=','crm.lead']]]);
    if (!existing) {
      await ekw('ir.model.fields', 'create', [{'name':'x_studio_dias_parados_estagio','model_id':crmModelId[0],'field_description':'Dias Parados no Estagio','ttype':'integer','store':true}]);
      results.push({step:'crm_dias_parados', ok:true, msg:'Campo criado'});
    } else {
      results.push({step:'crm_dias_parados', ok:true, msg:'Ja existe'});
    }
  } catch(e) { results.push({step:'crm', ok:false, error:e.message}); }

  // === 5. BOTAO ENVIAR PRODUCAO NA INVOICE ===
  try {
    var invModelId = await ekw('ir.model', 'search', [[['model','=','account.move']]], {limit:1});
    var saEnviar = await ekw('ir.actions.server', 'search', [[['name','=','AJL: Enviar Producao']]], {limit:1});
    if (!saEnviar.length) {
      var saId = await ekw('ir.actions.server', 'create', [{
        'name': 'AJL: Enviar Producao',
        'model_id': invModelId[0],
        'state': 'code',
        'code': 'created_mos = []\nif record.move_type == "out_invoice":\n    for order in record.sale_order_ids:\n        for line in order.order_line:\n            if line.x_studio_fabricar and line.product_id:\n                existing = env["mrp.production"].search([("origin", "=", order.name), ("product_id", "=", line.product_id.id)], limit=1)\n                if not existing:\n                    bom = env["mrp.bom"]._bom_find(line.product_id)\n                    if bom:\n                        mo = env["mrp.production"].create({"product_id": line.product_id.id, "bom_id": bom.id, "product_qty": line.product_uom_qty, "origin": order.name})\n                        mo.action_confirm()\n                        created_mos.append(mo.name)\nmsg = "OF criadas: " + ", ".join(created_mos) if created_mos else "Nenhuma OF criada"\nrecord.message_post(body=msg)',
      }]);
      results.push({step:'enviar_producao', ok:true, id:saId});
    } else {
      results.push({step:'enviar_producao', ok:true, msg:'Ja existe', id:saEnviar[0]});
    }
  } catch(e) { results.push({step:'enviar_producao', ok:false, error:e.message}); }

  // === 6. IMPRESSAO SO - COMPACTAR PARA 1 PAGINA ===
  try {
    var soViews = await ekw('ir.ui.view', 'search_read', [[['key','=','sale.report_saleorder_document']]], {fields:['id','name'], limit:3});
    if (!soViews.length) {
      soViews = await ekw('ir.ui.view', 'search_read', [[['name','ilike','report_saleorder_document']]], {fields:['id','name'], limit:3});
    }
    if (soViews.length) {
      var viewId = soViews[0].id;
      // Ler arch_db (campo real do QWeb)
      var archData = await ekw('ir.ui.view', 'read', [[viewId], ['arch_db']]);
      var arch = archData[0].arch_db || archData[0].arch || '';
      var originalLen = arch.length;
      
      var newArch = arch;
      
      // 1. Remover page breaks
      newArch = newArch.replace(/page-break-after:\s*always/g, 'page-break-after: avoid');
      newArch = newArch.replace(/page-break-before:\s*always/g, 'page-break-before: avoid');
      newArch = newArch.replace(/page-break-inside:\s*avoid/g, 'page-break-inside: auto');
      
      // 2. Reduzir margins (conservador)
      newArch = newArch.replace(/margin-top:\s*20px/g, 'margin-top:5px');
      newArch = newArch.replace(/margin-bottom:\s*20px/g, 'margin-bottom:5px');
      newArch = newArch.replace(/margin-top:\s*15px/g, 'margin-top:3px');
      newArch = newArch.replace(/margin-bottom:\s*15px/g, 'margin-bottom:3px');
      newArch = newArch.replace(/margin-top:\s*10px/g, 'margin-top:2px');
      newArch = newArch.replace(/margin-bottom:\s*10px/g, 'margin-bottom:2px');
      
      // 3. @page A4 margem minima
      if (newArch.indexOf('@page') === -1) {
        var stylePos = newArch.indexOf('<style');
        if (stylePos !== -1) {
          var styleEnd = newArch.indexOf('>', stylePos) + 1;
          newArch = newArch.substring(0, styleEnd) + '\n@page { size: A4; margin: 5mm; }\n' + newArch.substring(styleEnd);
        }
      } else {
        newArch = newArch.replace(/@page\s*\{[^}]*\}/g, '@page { size: A4; margin: 5mm; }');
      }
      
      // 4. Font 12px global
      if (newArch.indexOf('font-size: 12px') === -1 && newArch.indexOf('font-size:12px') === -1) {
        var stylePos = newArch.indexOf('<style');
        if (stylePos !== -1) {
          var styleEnd = newArch.indexOf('>', stylePos) + 1;
          newArch = newArch.substring(0, styleEnd) + '\nbody, table, th, td, p, span { font-size: 12px; line-height: 1.3; }\n' + newArch.substring(styleEnd);
        }
      }
      
      if (newArch !== arch) {
        try {
          await ekw('ir.ui.view', 'write', [[viewId], {'arch_db': newArch}]);
          results.push({step:'so_print', ok:true, viewId:viewId, msg:'View compactada: page breaks off, margins reduzidos, @page A4 5mm, font 12px', originalLen:originalLen, newLen:newArch.length});
        } catch(e2) {
          // Fallback: tentar com 'arch'
          try {
            await ekw('ir.ui.view', 'write', [[viewId], {'arch': newArch}]);
            results.push({step:'so_print', ok:true, viewId:viewId, msg:'View compactada (fallback arch)', originalLen:originalLen, newLen:newArch.length});
          } catch(e3) {
            results.push({step:'so_print', ok:false, error:'arch_db e arch falharam: ' + e3.message});
          }
        }
      } else {
        results.push({step:'so_print', ok:true, msg:'Nenhuma mudanca necessaria'});
      }
    } else {
      results.push({step:'so_print', ok:false, msg:'View nao encontrada'});
    }
  } catch(e) { results.push({step:'so_print', ok:false, error:e.message}); }

  // === 7. LOCAL DO ESTOQUE ===
  try {
    var prodModelIds = await ekw('ir.model', 'search', [[['model','=','product.product']]], {limit:1});
    var prodModelId = prodModelIds && prodModelIds.length ? prodModelIds[0] : false;
    if (prodModelId) {
      var existing = await ekw('ir.model.fields', 'search_count', [[['name','=','x_studio_local_armazenagem'],['model_id','=',prodModelId]]]);
      if (!existing) {
        await ekw('ir.model.fields', 'create', [{'name':'x_studio_local_armazenagem','model_id':prodModelId,'field_description':'Local do Estoque','ttype':'char','store':true}]);
        results.push({step:'local_estoque', ok:true, msg:'Campo criado'});
      } else {
        results.push({step:'local_estoque', ok:true, msg:'Ja existe'});
      }
    } else {
      results.push({step:'local_estoque', ok:false, msg:'Model product.product nao encontrado'});
    }
  } catch(e) { results.push({step:'local_estoque', ok:false, error:e.message}); }

  res.json({ success: true, results: results });
});

module.exports = router;

// POST /api/v1/admin/compact-so-print
// Rota dedicada para compactar o report de SO para 1 pagina
router.post('/compact-so-print', apiKeyAuth, async function(req, res) {
  const odoo = config.odoo;
  if (!odoo || !odoo.url || !odoo.enabled) {
    return res.status(503).json({ success: false, error: 'Odoo nao configurado' });
  }

  try {
    var client = createClient(odoo.url);
    var uid2 = await authenticate(client, odoo.db, odoo.user, odoo.password);
    var db = odoo.db;
    var pwd = odoo.password;

    function ekw2(model, method, args, kwargs) {
      return executeKw(client, db, uid2, pwd, model, method, args, kwargs);
    }

    // Encontrar a view
    var soViews = await ekw2('ir.ui.view', 'search_read', [[['key','=','sale.report_saleorder_document']]], {fields:['id','name'], limit:3});
    if (!soViews.length) {
      soViews = await ekw2('ir.ui.view', 'search_read', [[['name','ilike','report_saleorder_document']]], {fields:['id','name'], limit:3});
    }
    if (!soViews.length) {
      return res.json({ success: false, error: 'View nao encontrada' });
    }

    var viewId = soViews[0].id;
    
    // Ler arch_db
    var archData = await ekw2('ir.ui.view', 'read', [[viewId], ['arch_db', 'arch']]);
    var arch = archData[0].arch_db || archData[0].arch || '';
    
    var newArch = arch;
    var changes = [];
    
    // 1. Remover page breaks
    if (newArch.indexOf('page-break-after: always') !== -1) {
      newArch = newArch.replace(/page-break-after:\s*always/g, 'page-break-after: avoid');
      changes.push('page-break-after: always→avoid');
    }
    if (newArch.indexOf('page-break-before: always') !== -1) {
      newArch = newArch.replace(/page-break-before:\s*always/g, 'page-break-before: avoid');
      changes.push('page-break-before: always→avoid');
    }
    if (newArch.indexOf('page-break-inside: avoid') !== -1) {
      newArch = newArch.replace(/page-break-inside:\s*avoid/g, 'page-break-inside: auto');
      changes.push('page-break-inside: avoid→auto');
    }
    
    // 2. Reduzir margins
    newArch = newArch.replace(/margin-top:\s*20px/g, 'margin-top:5px');
    newArch = newArch.replace(/margin-bottom:\s*20px/g, 'margin-bottom:5px');
    newArch = newArch.replace(/margin-top:\s*15px/g, 'margin-top:3px');
    newArch = newArch.replace(/margin-bottom:\s*15px/g, 'margin-bottom:3px');
    newArch = newArch.replace(/margin-top:\s*10px/g, 'margin-top:2px');
    newArch = newArch.replace(/margin-bottom:\s*10px/g, 'margin-bottom:2px');
    changes.push('margins reduzidos (20→5, 15→3, 10→2px)');
    
    // 3. @page A4 margem minima
    if (newArch.indexOf('@page') !== -1) {
      newArch = newArch.replace(/@page\s*\{[^}]*\}/g, '@page { size: A4; margin: 5mm; }');
      changes.push('@page ajustado para A4 5mm');
    } else {
      var stylePos = newArch.indexOf('<style');
      if (stylePos !== -1) {
        var styleEnd = newArch.indexOf('>', stylePos) + 1;
        newArch = newArch.substring(0, styleEnd) + '\n@page { size: A4; margin: 5mm; }\n' + newArch.substring(styleEnd);
        changes.push('@page adicionado: A4 5mm');
      }
    }
    
    // 4. Font 12px global
    if (newArch.indexOf('font-size: 12px') === -1 && newArch.indexOf('font-size:12px') === -1) {
      var stylePos = newArch.indexOf('<style');
      if (stylePos !== -1) {
        var styleEnd = newArch.indexOf('>', stylePos) + 1;
        newArch = newArch.substring(0, styleEnd) + '\nbody, table, th, td, p, span { font-size: 12px; line-height: 1.3; }\n' + newArch.substring(styleEnd);
        changes.push('font 12px adicionado');
      }
    }
    
    if (newArch !== arch) {
      try {
        await ekw2('ir.ui.view', 'write', [[viewId], {'arch_db': newArch}]);
        return res.json({ success: true, viewId: viewId, changes: changes, originalLen: arch.length, newLen: newArch.length, field: 'arch_db' });
      } catch(e2) {
        try {
          await ekw2('ir.ui.view', 'write', [[viewId], {'arch': newArch}]);
          return res.json({ success: true, viewId: viewId, changes: changes, originalLen: arch.length, newLen: newArch.length, field: 'arch (fallback)' });
        } catch(e3) {
          return res.json({ success: false, error: 'Write falhou: ' + e3.message, changes: changes });
        }
      }
    } else {
      return res.json({ success: true, msg: 'Nenhuma mudanca necessaria', changes: changes });
    }
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});
