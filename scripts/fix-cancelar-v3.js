const fs = require('fs');
const filePath = '/home/z/my-project/API-Odoo/routes/itau-api.js';
let content = fs.readFileSync(filePath, 'utf8');

// Replace the entire /cancelar/web route
const startMarker = '// GET /api/v1/itau/cancelar/web?odoo_id=XXX';
const endMarker = '// === CHECKOUT DE CARTAO ===';
const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('Markers not found!'); process.exit(1);
}

const newRoute = `// GET /api/v1/itau/cancelar/web?odoo_id=XXX
// Le resposta_json do Odoo, cancela boletos no Itau, posta resultado no chatter e redireciona de volta
router.get('/cancelar/web', async function(req, res) {
  var odooId = req.query.odoo_id || '';
  var oc = config.odoo;
  var returnUrl = (oc && oc.url ? oc.url.replace(/\\/+$/, '') : '') + '/web#id=' + odooId + '&model=account.move&view_type=form';

  function odooRpc(model, method, args, kwargs) {
    var xmlrpc = require('xmlrpc');
    var base = oc.url.replace(/\\/+$/, '');
    var host = base.replace('https://', '');
    var commonCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
    var modelsCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });
    return new Promise(function(ok, fail) {
      commonCli.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, uid) {
        if (e || !uid) return fail(e || new Error('auth failed'));
        var params = [oc.db, uid, oc.password, model, method, args || []];
        if (kwargs) params.push(kwargs);
        modelsCli.methodCall('execute_kw', params, function(e2, r) {
          if (e2) fail(e2); else ok(r);
        });
      });
    });
  }

  function postChatter(recordId, bodyHtml) {
    return odooRpc('mail.message', 'create', [{
      model: 'account.move',
      res_id: parseInt(recordId),
      body: bodyHtml,
      message_type: 'comment',
    }]);
  }

  if (!odooId || !oc || !oc.enabled || !oc.url || !oc.db || !oc.user || !oc.password) {
    return res.redirect(returnUrl);
  }

  try {
    var nossoNumeros = [];
    console.log('[CANCELAR-WEB] Lendo resposta_json da fatura ID:', odooId);
    var fields = await odooRpc('account.move', 'read', [[parseInt(odooId)], ['x_studio_itau_resposta_json']]);
    var rawJson = '';
    if (fields && fields[0] && fields[0].x_studio_itau_resposta_json) {
      rawJson = fields[0].x_studio_itau_resposta_json;
    }
    if (!rawJson) {
      await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style=\"color:red\">Fatura nao possui dados de boleto.</span>');
      return res.redirect(returnUrl);
    }

    var jsonStr = rawJson.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null');
    var data = JSON.parse(jsonStr);
    var pagamentos = data.pagamentos || [];
    if (pagamentos.length === 0) {
      await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style=\"color:red\">Nenhum pagamento encontrado.</span>');
      return res.redirect(returnUrl);
    }
    for (var i = 0; i < pagamentos.length; i++) {
      if (pagamentos[i].nosso_numero) nossoNumeros.push(pagamentos[i].nosso_numero);
    }
    if (nossoNumeros.length === 0) {
      await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style=\"color:red\">Nenhum nosso numero encontrado.</span>');
      return res.redirect(returnUrl);
    }

    console.log('[CANCELAR-WEB] Cancelando', nossoNumeros.length, 'boleto(s):', nossoNumeros.join(', '));
    var resultados = [];
    for (var i = 0; i < nossoNumeros.length; i++) {
      try {
        await cancelarBoleto(nossoNumeros[i]);
        resultados.push({ nn: nossoNumeros[i], ok: true });
      } catch (err) {
        resultados.push({ nn: nossoNumeros[i], ok: false, erro: err.message });
      }
    }

    var sucesso = resultados.filter(function(r) { return r.ok; }).length;
    var falha = resultados.filter(function(r) { return !r.ok; }).length;
    var chatBody = '<b>Cancelar Boleto</b><br/>';
    if (falha === 0) {
      chatBody += '<span style=\"color:green\">' + sucesso + ' boleto(s) cancelado(s) com sucesso no Itau.</span>';
    } else if (sucesso === 0) {
      chatBody += '<span style=\"color:red\">Falha ao cancelar todos os boletos:</span><br/>';
      for (var i = 0; i < resultados.length; i++) chatBody += 'NN ' + resultados[i].nn + ': ' + resultados[i].erro + '<br/>';
    } else {
      chatBody += '<span style=\"color:orange\">' + sucesso + ' cancelado(s), ' + falha + ' falha(s):</span><br/>';
      for (var i = 0; i < resultados.length; i++) {
        if (!resultados[i].ok) chatBody += 'NN ' + resultados[i].nn + ': ' + resultados[i].erro + '<br/>';
      }
    }
    chatBody += '<br/><small>NN: ' + nossoNumeros.join(', ') + '</small>';

    await postChatter(odooId, chatBody);

    try {
      await odooRpc('account.move', 'write', [[parseInt(odooId)], { 'x_studio_boleto_cancelado': true }]);
    } catch (wErr) {
      console.warn('[CANCELAR-WEB] Aviso:', wErr.message);
    }

    res.redirect(returnUrl);
  } catch (err) {
    console.error('[CANCELAR-WEB] ERRO:', err.message);
    try { await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style=\"color:red\">Erro: ' + err.message + '</span>'); } catch(e) {}
    res.redirect(returnUrl);
  }
});

`;

content = content.substring(0, startIdx) + newRoute + content.substring(endIdx);
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed! Lines:', content.split('\n').length);
