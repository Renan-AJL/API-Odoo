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

// GET /api/v1/admin/read-so-print
// Le o arch da view de SO para debug
router.get('/read-so-print', apiKeyAuth, async function(req, res) {
  const odoo = config.odoo;
  try {
    var client = createClient(odoo.url);
    var uid2 = await authenticate(client, odoo.db, odoo.user, odoo.password);
    function ekw2(model, method, args, kwargs) {
      return executeKw(client, odoo.db, uid2, odoo.password, model, method, args, kwargs);
    }
    var soViews = await ekw2('ir.ui.view', 'search_read', [[['key','=','sale.report_saleorder_document']]], {fields:['id','name'], limit:3});
    if (!soViews.length) soViews = await ekw2('ir.ui.view', 'search_read', [[['name','ilike','report_saleorder_document']]], {fields:['id','name'], limit:3});
    if (!soViews.length) return res.json({ success: false, error: 'View nao encontrada' });
    var viewId = soViews[0].id;
    var archData = await ekw2('ir.ui.view', 'read', [[viewId], ['arch_db', 'arch']]);
    var arch = archData[0].arch_db || archData[0].arch || '';
    // Return first 3000 chars and last 1000 chars + stats
    return res.json({ 
      success: true, viewId: viewId, len: arch.length,
      first3000: arch.substring(0, 3000),
      last1000: arch.substring(arch.length - 1000),
      hasPageBreak: arch.indexOf('page-break') !== -1,
      hasAtPage: arch.indexOf('@page') !== -1,
      hasFontSize: arch.indexOf('font-size') !== -1,
    });
  } catch(e) { return res.status(500).json({ success: false, error: e.message }); }
});

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

// GET /api/v1/admin/ipi-status
// Verifica estado atual do IPI nos pedidos (taxes, products, sale orders)
router.get('/ipi-status', apiKeyAuth, async function(req, res) {
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

    var result = {};

    // 1. Search IPI taxes in account.tax
    var ipiTaxes = await ekw2('account.tax', 'search_read',
      [['|', ['name', 'ilike', 'IPI'], ['name', 'ilike', 'ipi']], ['type_tax_use', '=', 'sale'], ['active', '=', true]],
      {fields: ['id', 'name', 'amount', 'amount_type', 'price_include', 'tax_group_id'], limit: 20}
    );
    result.ipiTaxes = ipiTaxes;

    // 2. All sale taxes for reference
    var allSaleTaxes = await ekw2('account.tax', 'search_read',
      [['type_tax_use', '=', 'sale'], ['active', '=', true]],
      {fields: ['id', 'name', 'amount', 'amount_type', 'price_include'], limit: 30}
    );
    result.allSaleTaxes = allSaleTaxes;

    // 3. Recent sale orders with breakdown
    var recentOrders = await ekw2('sale.order', 'search_read',
      [],
      {fields: ['id', 'name', 'amount_untaxed', 'amount_tax', 'amount_total', 'state'], order: 'id desc', limit: 5}
    );
    result.recentOrders = [];
    for (var i = 0; i < recentOrders.length; i++) {
      var order = recentOrders[i];
      var lines = await ekw2('sale.order.line', 'search_read',
        [['order_id', '=', order.id]],
        {fields: ['id', 'name', 'product_id', 'price_unit', 'price_subtotal', 'price_total', 'tax_id', 'product_uom_qty']}
      );
      var orderInfo = {
        id: order.id, name: order.name, state: order.state,
        amount_untaxed: order.amount_untaxed, amount_tax: order.amount_tax, amount_total: order.amount_total,
        lines: lines.map(function(l) {
          return {
            product: l.product_id ? l.product_id[1] : 'N/A',
            qty: l.product_uom_qty, price_unit: l.price_unit,
            subtotal: l.price_subtotal, total: l.price_total,
            tax_ids: l.tax_id
          };
        })
      };
      // Get tax details for first line
      if (lines.length > 0 && lines[0].tax_id && lines[0].tax_id.length > 0) {
        var taxDetails = await ekw2('account.tax', 'read', [lines[0].tax_id, ['name', 'amount', 'amount_type']]);
        orderInfo.sampleTaxes = taxDetails;
      }
      result.recentOrders.push(orderInfo);
    }

    // 4. Products with x_studio_aliquota_ipi
    try {
      var productsWithIpi = await ekw2('product.template', 'search_read',
        [['x_studio_aliquota_ipi', '>', 0]],
        {fields: ['id', 'name', 'x_studio_aliquota_ipi', 'x_studio_cst_ipi', 'taxes_id'], limit: 15}
      );
      result.productsWithIpi = productsWithIpi.map(function(p) {
        return {
          id: p.id, name: p.name, aliquota_ipi: p.x_studio_aliquota_ipi,
          cst_ipi: p.x_studio_cst_ipi, tax_ids: p.taxes_id
        };
      });
    } catch(e) {
      result.productsWithIpiError = e.message;
    }

    // 5. Tax groups
    var taxGroups = await ekw2('account.tax.group', 'search_read',
      [],
      {fields: ['id', 'name'], limit: 20}
    );
    result.taxGroups = taxGroups;

    return res.json({ success: true, result: result });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/v1/admin/fix-ipi-sale
// Cria impostos IPI e adiciona aos produtos para contabilizar no pedido
router.post('/fix-ipi-sale', apiKeyAuth, async function(req, res) {
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

    var results = [];
    var dryRun = req.body.dry_run !== false; // default true for safety

    // === 1. FIND OR CREATE IPI TAX GROUP ===
    var ipiGroupIds = await ekw2('account.tax.group', 'search', [[['name', '=', 'IPI']]]);
    var ipiGroupId;
    if (!ipiGroupIds.length) {
      ipiGroupId = await ekw2('account.tax.group', 'create', [{'name': 'IPI'}]);
      results.push({step: 'ipi_group', ok: true, id: ipiGroupId, msg: 'Criado'});
    } else {
      ipiGroupId = ipiGroupIds[0];
      results.push({step: 'ipi_group', ok: true, id: ipiGroupId, msg: 'Ja existe'});
    }

    // === 2. FIND OR CREATE IPI TAXES (common rates: 0%, 5%, 10%, 12%, 15%, 20%, 25%) ===
    var ipiRates = [0, 5, 10, 12, 15, 20, 25];
    var ipiTaxMap = {}; // rate -> tax_id

    for (var r = 0; r < ipiRates.length; r++) {
      var rate = ipiRates[r];
      var taxName = 'IPI ' + rate + '%';
      
      var existing = await ekw2('account.tax', 'search_read',
        [['name', '=', taxName], ['type_tax_use', '=', 'sale']],
        {fields: ['id', 'name', 'amount'], limit: 1}
      );
      
      if (existing.length) {
        ipiTaxMap[rate] = existing[0].id;
        results.push({step: 'ipi_tax_' + rate, ok: true, id: existing[0].id, msg: 'Ja existe'});
      } else {
        if (dryRun) {
          results.push({step: 'ipi_tax_' + rate, ok: true, msg: '[DRY RUN] Criaria ' + taxName});
        } else {
          try {
            // Get company
            var companyIds = await ekw2('res.company', 'search', [[]], {limit: 1});
            var companyId = companyIds.length ? companyIds[0] : false;
            
            var taxVals = {
              'name': taxName,
              'amount_type': 'percent',
              'amount': rate,
              'type_tax_use': 'sale',
              'price_include': false,  // IPI is NOT included in price - added on top
              'tax_group_id': ipiGroupId,
              'active': true,
              'sequence': 50 + r,  // After ICMS/PIS/COFINS
            };
            if (companyId) taxVals['company_id'] = companyId;
            
            var newTaxId = await ekw2('account.tax', 'create', [taxVals]);
            ipiTaxMap[rate] = newTaxId;
            results.push({step: 'ipi_tax_' + rate, ok: true, id: newTaxId, msg: 'Criado'});
          } catch(e) {
            results.push({step: 'ipi_tax_' + rate, ok: false, error: e.message});
          }
        }
      }
    }

    // === 3. ADD IPI TAXES TO PRODUCTS WITH x_studio_aliquota_ipi ===
    try {
      var productsWithIpi = await ekw2('product.template', 'search_read',
        [['x_studio_aliquota_ipi', '>', 0]],
        {fields: ['id', 'name', 'x_studio_aliquota_ipi', 'x_studio_cst_ipi', 'taxes_id'], limit: 200}
      );
      
      var updatedCount = 0;
      var skippedCount = 0;
      var alreadyHasCount = 0;
      
      for (var p = 0; p < productsWithIpi.length; p++) {
        var prod = productsWithIpi[p];
        var aliquota = Math.round(prod.x_studio_aliquota_ipi); // Round to nearest integer
        
        // Find the matching IPI tax
        var ipiTaxId = ipiTaxMap[aliquota];
        if (!ipiTaxId) {
          // Try exact rate
          ipiTaxId = ipiTaxMap[prod.x_studio_aliquota_ipi];
        }
        
        if (!ipiTaxId) {
          skippedCount++;
          if (p < 5) results.push({step: 'product_' + prod.id, ok: false, msg: 'Sem IPI tax para ' + prod.x_studio_aliquota_ipi + '%', product: prod.name});
          continue;
        }
        
        // Check if product already has this IPI tax
        var currentTaxes = prod.taxes_id || [];
        if (currentTaxes.indexOf(ipiTaxId) !== -1) {
          alreadyHasCount++;
          continue;
        }
        
        // Add IPI tax to product (use write to append to taxes_id)
        if (dryRun) {
          if (p < 5) results.push({step: 'product_' + prod.id, ok: true, msg: '[DRY RUN] Adicionaria IPI ' + aliquota + '% a ' + prod.name});
          updatedCount++;
        } else {
          try {
            // Write using (4, id) to add to Many2many
            await ekw2('product.template', 'write', [[prod.id], {'taxes_id': [[4, ipiTaxId]]}]);
            updatedCount++;
          } catch(e) {
            if (p < 5) results.push({step: 'product_' + prod.id, ok: false, error: e.message});
          }
        }
      }
      
      results.push({
        step: 'products_ipi', ok: true,
        total: productsWithIpi.length,
        updated: updatedCount,
        alreadyHas: alreadyHasCount,
        skipped: skippedCount,
        dryRun: dryRun
      });
    } catch(e) {
      results.push({step: 'products_ipi', ok: false, error: e.message});
    }

    // === 4. RECOMPUTE RECENT SALE ORDERS ===
    if (!dryRun) {
      try {
        // Trigger recomputation on draft/sent orders by writing a no-op
        var draftOrders = await ekw2('sale.order', 'search',
          [['state', 'in', ['draft', 'sent']]],
          {limit: 50}
        );
        
        if (draftOrders.length > 0) {
          // Use _onchange_tax_id to recompute lines - but via API we can only use write
          // Instead, we trigger recompute by touching the order
          for (var o = 0; o < Math.min(draftOrders.length, 10); o++) {
            try {
              // Read order lines
              var solIds = await ekw2('sale.order.line', 'search', [[['order_id', '=', draftOrders[o]]]], {limit: 50});
              for (var l = 0; l < solIds.length; l++) {
                // Trigger tax recomputation by writing tax_id with current value
                var lineTaxes = await ekw2('sale.order.line', 'read', [[solIds[l]], ['tax_id']]);
                var currentLineTaxes = lineTaxes[0].tax_id || [];
                // Find product for this line
                var lineProduct = await ekw2('sale.order.line', 'read', [[solIds[l]], ['product_id']]);
                if (lineProduct[0].product_id) {
                  var prodId = lineProduct[0].product_id[0];
                  // Get product template taxes
                  var ppTaxes = await ekw2('product.product', 'read', [[prodId], ['taxes_id']]);
                  var newTaxes = ppTaxes[0].taxes_id || [];
                  if (JSON.stringify(currentLineTaxes) !== JSON.stringify(newTaxes)) {
                    // Update line taxes
                    await ekw2('sale.order.line', 'write', [[solIds[l]], {'tax_id': [[6, 0, newTaxes]]}]);
                  }
                }
              }
            } catch(e) {
              // Skip this order
            }
          }
          results.push({step: 'recompute', ok: true, msg: 'Pedidos abertos recomputados (max 10)', count: draftOrders.length});
        } else {
          results.push({step: 'recompute', ok: true, msg: 'Nenhum pedido aberto para recomputar'});
        }
      } catch(e) {
        results.push({step: 'recompute', ok: false, error: e.message});
      }
    } else {
      results.push({step: 'recompute', ok: true, msg: '[DRY RUN] Recomputaria pedidos abertos'});
    }

    return res.json({ success: true, results: results, dryRun: dryRun });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// POST /api/v1/admin/nfe-remontar
// REMONTA a NF-e JA AUTORIZADA (NAO reemite!): busca o XML autorizado no
// cofre SIEG, corrige <pag>/<cobr>/<infCpl> com a forma de pagamento correta
// (campo x_studio_forma_de_pagamento da fatura), regera o DANFE e reanexa
// XML+PDF na fatura do Odoo (novos anexos + mensagem no chatter).
// Body: { move_id } OU { numero: 72853 } OU { chave: '44dig' }
// ============================================================
router.post('/nfe-remontar', apiKeyAuth, async function(req, res) {
  var moveId = parseInt(req.body.move_id) || 0;
  var numero = String(req.body.numero || '').replace(/\D/g, '');
  var chaveParam = String(req.body.chave || '').replace(/\D/g, '');

  try {
    var odoo = config.odoo;
    if (!odoo || !odoo.url || !odoo.enabled) {
      return res.status(503).json({ success: false, error: 'Odoo nao configurado' });
    }
    var client = createClient(odoo.url);
    var uid = await authenticate(client, odoo.db, odoo.user, odoo.password);
    var ekw = function(model, method, args, kwargs) {
      return executeKw(client, odoo.db, uid, odoo.password, model, method, args, kwargs);
    };

    // 1. Localizar a fatura
    var domain;
    if (moveId) domain = [['id', '=', moveId]];
    else if (chaveParam) domain = [['x_studio_nfe_chave', '=', chaveParam]];
    else if (numero) domain = [['x_studio_nfe_chave', 'ilike', numero]];
    else return res.status(400).json({ success: false, error: 'informe move_id, numero ou chave' });

    var ids = await ekw('account.move', 'search', [domain], { limit: 1 });
    if (!ids.length) return res.status(404).json({ success: false, error: 'Fatura nao encontrada' });
    moveId = ids[0];

    var moves = await ekw('account.move', 'read', [[moveId], [
      'name', 'partner_id', 'invoice_date', 'date', 'invoice_origin',
      'x_studio_nfe_chave', 'x_studio_nfe_status', 'x_studio_forma_de_pagamento',
      'x_studio_itau_resposta_json', 'x_studio_itau_nosso_numero', 'narration',
    ]]);
    var move = moves[0];
    var chave = String(move.x_studio_nfe_chave || '').replace(/\D/g, '');
    if (!chave || chave.length !== 44) {
      return res.status(400).json({ success: false, error: 'Fatura sem chave de NF-e valida' });
    }

    // 2. Forma de pagamento (fatura -> fallback pedido de origem)
    var forma = String(move.x_studio_forma_de_pagamento || '').trim();
    if (!forma && move.invoice_origin) {
      try {
        var soIds = await ekw('sale.order', 'search', [[['name', '=', move.invoice_origin]]], { limit: 1 });
        if (soIds.length) {
          var soRecs = await ekw('sale.order', 'read', [[soIds[0]], ['x_studio_forma_de_pagamento']]);
          if (soRecs[0] && soRecs[0].x_studio_forma_de_pagamento) forma = String(soRecs[0].x_studio_forma_de_pagamento);
        }
      } catch (eF) {}
    }

    // 3. Parcelas da fatura (payment_term lines)
    var parcelasFatura = [];
    try {
      var termIds = await ekw('account.move.line', 'search', [[['move_id', '=', moveId], ['display_type', '=', 'payment_term']]], { order: 'date_maturity asc' });
      if (termIds.length) {
        var tLines = await ekw('account.move.line', 'read', [termIds, ['date_maturity', 'debit', 'credit']]);
        for (var t = 0; t < tLines.length; t++) {
          var v = parseFloat(tLines[t].debit) || parseFloat(tLines[t].credit) || 0;
          if (v > 0) parcelasFatura.push({ vencimento: tLines[t].date_maturity || '', valor: v });
        }
      }
    } catch (eT) {}

    // 4. Boletos Itaú (se houver) para NN/linha digitavel
    var itauBoletos = [];
    try {
      var rawJson = move.x_studio_itau_resposta_json || '';
      if (rawJson) {
        var parsed = JSON.parse(rawJson.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null'));
        var pags = parsed.pagamentos || [];
        for (var p2 = 0; p2 < pags.length; p2++) {
          if (pags[p2].nosso_numero) {
            itauBoletos.push({ nosso_numero: pags[p2].nosso_numero, linha_digitavel: pags[p2].linha_digitavel || '' });
          }
        }
      }
      if (!itauBoletos.length && move.x_studio_itau_nosso_numero) {
        itauBoletos.push({ nosso_numero: move.x_studio_itau_nosso_numero, linha_digitavel: '' });
      }
    } catch (eB) {}

    // 5. Buscar XML autorizado no SIEG (cofre)
    var axios = require('axios');
    var AdmZip = require('adm-zip');
    var { getAuthHeaders } = require('../services/sieg-auth');
    var headers = await getAuthHeaders();
    var aamm = chave.slice(2, 6);
    var ano = '20' + aamm.slice(0, 2);
    var mes = aamm.slice(2, 4);
    var dfDate = new Date(parseInt(ano), parseInt(mes), 0);
    var body = {
      TipoXml: 1, Take: 500, Skip: 0,
      DataEmissaoInicio: ano + '-' + mes + '-01T00:00:00Z',
      DataEmissaoFim: ano + '-' + mes + '-' + String(dfDate.getDate()).padStart(2, '0') + 'T23:59:59Z',
    };
    var resp = await axios.post('https://api.sieg.com/api/v1/baixar-xmls', body, {
      headers: headers, timeout: 45000, responseType: 'arraybuffer',
    });
    var zip = new AdmZip(resp.data);
    var entries = zip.getEntries();
    var xmlAutorizado = '';
    for (var ei = 0; ei < entries.length; ei++) {
      if (entries[ei].isDirectory) continue;
      var xmlStr = zip.readAsText(entries[ei]);
      if (xmlStr.indexOf(chave) !== -1) { xmlAutorizado = xmlStr; break; }
    }
    if (!xmlAutorizado) {
      return res.status(404).json({ success: false, error: 'XML da chave ' + chave + ' nao encontrado no cofre SIEG (NF pode estar cancelada/inexistente)' });
    }
    // Validar autorizacao no protocolo
    var cStatMatch = xmlAutorizado.match(/<protNFe[^>]*>[\s\S]*?<cStat>(\d{3})<\/cStat>/);
    var cStatProt = cStatMatch ? cStatMatch[1] : '';
    if (cStatProt !== '100' && cStatProt !== '150') {
      return res.status(400).json({ success: false, error: 'NF nao autorizada na SEFAZ (cStat ' + cStatProt + ') — remontagem indevida' });
    }

    // 6. Recalcular vNF a partir do XML (vProd - vDesc + vIPI) para o pagamento
    function tagV(xml, tag) {
      var m = xml.match(new RegExp('<' + tag + '>([-0-9.]+)</' + tag + '>'));
      return m ? parseFloat(m[1]) : 0;
    }
    var vProdXml = tagV(xmlAutorizado, 'vProd');
    var vDescXml = tagV(xmlAutorizado, 'vDesc');
    var vIpiXml = tagV(xmlAutorizado, 'vIPI');
    var vNFXml = Math.round((vProdXml - vDescXml + vIpiXml) * 100) / 100;
    var vNfTag = xmlAutorizado.match(/<vNF>([-0-9.]+)<\/vNF>/);
    if (vNfTag) vNFXml = parseFloat(vNfTag[1]);

    // 7. Remontar pagamentos/cobranca/infCpl
    var { buildPagamentoInfo } = require('../services/sieg-odoo-emit');
    var pagInfo = buildPagamentoInfo({
      forma: forma,
      vNF: vNFXml,
      parcelasFatura: parcelasFatura,
      dataBase: move.invoice_date || move.date || '',
      itauBoletos: itauBoletos,
    });

    // --- pag ---
    var pagXml = '\n    <pag>';
    for (var gp = 0; gp < pagInfo.pagamentos.length; gp++) {
      var pg = pagInfo.pagamentos[gp];
      pagXml += '\n      <detPag>';
      if (pg.indPag) pagXml += '\n        <indPag>' + pg.indPag + '</indPag>';
      pagXml += '\n        <tPag>' + pg.tPag + '</tPag>';
      pagXml += '\n        <vPag>' + pg.vPag + '</vPag>';
      pagXml += '\n      </detPag>';
    }
    pagXml += '\n    </pag>';

    // --- cobr (somente a prazo) ---
    var cobrXml = '';
    if (pagInfo.duplicatas.length > 0) {
      var vSoma = 0;
      for (var gd = 0; gd < pagInfo.duplicatas.length; gd++) vSoma += Math.round(parseFloat(pagInfo.duplicatas[gd].vDup) * 100) / 100;
      vSoma = Math.round(vSoma * 100) / 100;
      cobrXml = '\n    <cobr>\n      <fat>\n        <nFat>' + escapeXmlText(move.name || '') + '</nFat>\n        <vOrig>' + vSoma.toFixed(2) + '</vOrig>\n        <vDesc>0.00</vDesc>\n        <vLiq>' + vSoma.toFixed(2) + '</vLiq>\n      </fat>';
      for (var gd2 = 0; gd2 < pagInfo.duplicatas.length; gd2++) {
        var d2 = pagInfo.duplicatas[gd2];
        cobrXml += '\n      <dup>\n        <nDup>' + String(gd2 + 1).padStart(3, '0') + '</nDup>\n        <dVenc>' + (d2.dVenc || '') + '</dVenc>\n        <vDup>' + d2.vDup + '</vDup>\n      </dup>';
      }
      cobrXml += '\n    </cobr>';
    }

    // --- infCpl: troca apenas o segmento de pagamento (prefixo), mantendo
    // Pedido/ICMS/Difal/observacoes ja presentes no XML autorizado ---
    var infCplM = xmlAutorizado.match(/<infCpl>([\s\S]*?)<\/infCpl>/);
    var oldInf = infCplM ? infCplM[1] : '';
    var keepIdx = oldInf.indexOf('Pedido:');
    if (keepIdx < 0) keepIdx = oldInf.indexOf('ICMS');
    var tail = keepIdx >= 0 ? oldInf.substring(keepIdx) : '';
    var novoPagText = '';
    if (pagInfo.boletoDetalhes.length > 0) {
      var parts = [];
      for (var bi = 0; bi < pagInfo.boletoDetalhes.length; bi++) {
        var bd = pagInfo.boletoDetalhes[bi];
        var s = 'Boleto ' + (bd.parcela || ((bi + 1) + '/' + pagInfo.boletoDetalhes.length)) + ': R$ ' + bd.valor;
        if (bd.vencimento) s += ' Venc: ' + bd.vencimento;
        if (bd.nosso_numero) s += ' NN: ' + bd.nosso_numero;
        if (bd.linha_digitavel) s += ' Linha: ' + bd.linha_digitavel;
        parts.push(s);
      }
      novoPagText = parts.join(' | ') + '. ';
    } else {
      novoPagText = pagInfo.formaLabel + '. ';
    }
    var newInfCpl = novoPagText + tail;

    // 8. Aplicar os patches no XML (somente blocos pag/cobr/infCpl)
    var xmlPatched = xmlAutorizado;
    xmlPatched = xmlPatched.replace(/<pag>[\s\S]*?<\/pag>/, pagXml);
    if (cobrXml) {
      if (/<cobr>[\s\S]*?<\/cobr>/.test(xmlPatched)) {
        xmlPatched = xmlPatched.replace(/<cobr>[\s\S]*?<\/cobr>/, cobrXml);
      } else {
        xmlPatched = xmlPatched.replace(/<pag>/, cobrXml + '\n    <pag>');
      }
    }
    if (infCplM) {
      // novoPagText e texto novo (escapar); tail ja vem escapado do XML original
      var infCplFinal = (escapeXmlText(novoPagText) + tail).substring(0, 2000);
      xmlPatched = xmlPatched.replace(/<infCpl>[\s\S]*?<\/infCpl>/, '<infCpl>' + infCplFinal + '</infCpl>');
    }

    // 9. Regerar DANFE local a partir do XML remontado
    var { gerarDanfe } = require('../services/danfe-pdf');
    var saleOrderNumber = move.invoice_origin || '';
    var pdfB64 = '';
    try {
      pdfB64 = await gerarDanfe(xmlPatched, {
        saleOrderNumber: saleOrderNumber,
        boletoData: itauBoletos,
      });
    } catch (eDanfe) {
      console.warn('[NFE-REMONTAR] DANFE falhou (seguindo com XML): ' + eDanfe.message);
    }

    // 10. Anexar no Odoo (novos anexos, sem apagar os originais) + chatter
    var safeName = (move.name || 'NF').replace(/[^a-zA-Z0-9\-_]/g, '_');
    var attachIds = [];
    try {
      var xmlB64 = Buffer.from(xmlPatched, 'utf-8').toString('base64');
      attachIds.push(await ekw('ir.attachment', 'create', [{
        name: 'NF-e_' + safeName + '_remontada.xml',
        raw: xmlB64,
        res_model: 'account.move', res_id: moveId,
        mimetype: 'application/xml',
      }]));
      if (pdfB64) {
        attachIds.push(await ekw('ir.attachment', 'create', [{
          name: 'DANFE_' + safeName + '_remontada.pdf',
          raw: pdfB64,
          res_model: 'account.move', res_id: moveId,
          mimetype: 'application/pdf',
        }]));
      }
    } catch (eAtt) {
      return res.status(500).json({ success: false, error: 'Falha ao anexar no Odoo: ' + eAtt.message });
    }

    var corpoMsg = ('<b>NF-e Remontada (pagamento corrigido) — SEM reemissão</b><br/>'
      + 'Forma de pagamento: ' + (forma || '(vazia)') + '<br/>'
      + 'tPag: ' + pagInfo.tPag + ' | indPag: ' + pagInfo.indPag + '<br/>'
      + 'Parcelas: ' + (pagInfo.duplicatas.length || 1) + '<br/>'
      + 'XML e DANFE reanexados (originais preservados).').replace(/\n/g, '');
    try {
      var msgVals = { model: 'account.move', res_id: moveId, body: corpoMsg, message_type: 'comment' };
      if (attachIds.length) msgVals.attachment_ids = [[6, 0, attachIds]];
      await ekw('mail.message', 'create', [msgVals]);
    } catch (eMsg) {}

    res.json({
      success: true,
      move_id: moveId,
      fatura: move.name,
      chave: chave,
      cStat_protocolo: cStatProt,
      forma_pagamento: forma,
      tPag: pagInfo.tPag,
      indPag: pagInfo.indPag,
      duplicatas: pagInfo.duplicatas,
      infCpl_novo: newInfCpl.substring(0, 600),
      anexos: attachIds.length,
    });
  } catch (e) {
    console.error('[NFE-REMONTAR] Erro:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

function escapeXmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// POST /api/v1/admin/odoo-rpc
// RPC generico controlado para diagnostico/correcao no Odoo.
// Body: { model, method, args?, kwargs?, readOnly? }
//   - model/method obrigatorios (method limitado a uma whitelist segura)
//   - args: array de argumentos posicionais; kwargs: dicionario opcional
// Ex: { model: 'account.move', method: 'read', args: [[147], ['amount_total']] }
// ============================================================
var RPC_ALLOWED_METHODS = ['search', 'search_read', 'read', 'search_count', 'fields_get', 'write', 'create', 'exists', 'name_get', 'read_group'];

router.post('/odoo-rpc', apiKeyAuth, async function(req, res) {
  const odoo = config.odoo;
  if (!odoo || !odoo.url || !odoo.enabled) {
    return res.status(503).json({ success: false, error: 'Odoo nao configurado' });
  }
  var model = String(req.body.model || '');
  var method = String(req.body.method || '');
  var args = Array.isArray(req.body.args) ? req.body.args : [];
  var kwargs = (req.body.kwargs && typeof req.body.kwargs === 'object') ? req.body.kwargs : null;

  if (!model || /^[a-z_.]+$/.test(model) === false) {
    return res.status(400).json({ success: false, error: 'model invalido' });
  }
  if (RPC_ALLOWED_METHODS.indexOf(method) < 0) {
    return res.status(400).json({ success: false, error: 'metodo nao permitido: ' + method });
  }
  // write/create exigem flag explicita
  if ((method === 'write' || method === 'create') && !req.body.allowWrite) {
    return res.status(400).json({ success: false, error: 'write/create exige allowWrite=true no body' });
  }

  try {
    var client = createClient(odoo.url);
    var uid = await authenticate(client, odoo.db, odoo.user, odoo.password);
    var result = await executeKw(client, odoo.db, uid, odoo.password, model, method, args, kwargs || undefined);
    res.json({ success: true, model: model, method: method, count: Array.isArray(result) ? result.length : undefined, result: result });
  } catch (e) {
    res.status(500).json({ success: false, error: model + '.' + method + ': ' + e.message });
  }
});

module.exports = router;
