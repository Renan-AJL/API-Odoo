/**
 * services/odoo-push.js - v7.0.2
 * =============================================
 * Push de PDFs de boletos para Odoo via XML-RPC
 * - Usa faturaId (record.id) diretamente - SEMPRE funciona, mesmo rascunho
 * - Cria ir.attachment com PDF base64
 * - Posta NOTA INTERNA no chatter com PDF anexado (mail.mt_note)
 * - Cada boleto: 1 attachment + 1 nota com detalhes
 * - Grava campos x_studio_* na fatura (situacao, tipo_pagamento, pix, nn, link)
 *
 * ENV VARS (Render):
 *   ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD, ODOO_PUSH_ENABLED
 * =============================================
 */

var xmlrpc = require('xmlrpc');

function createClient(url) {
  var base = url.replace(/\/+$/, '');
  return {
    common: xmlrpc.createSecureClient({ host: base.replace('https://', ''), path: '/xmlrpc/2/common', port: 443 }),
    models: xmlrpc.createSecureClient({ host: base.replace('https://', ''), path: '/xmlrpc/2/object', port: 443 }),
    baseUrl: base
  };
}

function authenticate(client, db, login, password) {
  return new Promise(function(resolve, reject) {
    client.common.methodCall('authenticate', [db, login, password, {}], function(err, uid) {
      if (err) {
        reject(new Error('Erro ao autenticar no Odoo: ' + (err.message || JSON.stringify(err))));
      } else if (uid === false || uid === null) {
        reject(new Error('Falha na autenticacao Odoo: credenciais invalidas'));
      } else {
        console.log('[ODOO-PUSH] Autenticado. UID:', uid);
        resolve(uid);
      }
    });
  });
}

function executeKw(client, db, uid, password, model, method, args, kwargs) {
  return new Promise(function(resolve, reject) {
    var params = [db, uid, password, model, method, args || []];
    if (kwargs) params.push(kwargs || {});
    client.models.methodCall('execute_kw', params, function(err, result) {
      if (err) {
        reject(new Error('Erro Odoo ' + model + '.' + method + ': ' + (err.message || JSON.stringify(err))));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Push completo
 * @param {Object} pushData
 *   - faturaId:    ID da fatura Odoo (record.id) - SEMPRE disponivel
 *   - faturaName:  nome da fatura (pode ser vazio para rascunhos)
 *   - boletos:     array de dados dos boletos
 *   - pdfsBase64:  array de PDFs em base64 (mesma ordem)
 */
async function pushBoletosToOdoo(pushData) {
  var config = require('../config');
  var odooConfig = config.odoo;

  if (!odooConfig || !odooConfig.enabled) {
    console.log('[ODOO-PUSH] Desabilitado');
    return { pushed: false, reason: 'disabled' };
  }

  if (!odooConfig.url || !odooConfig.db || !odooConfig.user || !odooConfig.password) {
    console.warn('[ODOO-PUSH] Credenciais Odoo incompletas');
    return { pushed: false, reason: 'missing_credentials' };
  }

  var faturaId = parseInt(pushData.faturaId) || 0;
  var faturaName = pushData.faturaName || '';
  var boletos = pushData.boletos || [];
  var pdfsBase64 = pushData.pdfsBase64 || [];

  console.log('[ODOO-PUSH] === INICIANDO ===');
  console.log('[ODOO-PUSH] faturaId:', faturaId, '| faturaName:', faturaName || 'vazio');
  console.log('[ODOO-PUSH] boletos:', boletos.length, '| pdfs:', pdfsBase64.length);

  try {
    var client = createClient(odooConfig.url);
    var uid = await authenticate(client, odooConfig.db, odooConfig.user, odooConfig.password);

    // Determinar recordId
    var recordId;
    if (faturaId > 0) {
      // ID direto - sempre funciona, mesmo rascunho
      recordId = faturaId;
      console.log('[ODOO-PUSH] Usando faturaId direto:', recordId);
    } else if (faturaName) {
      // Fallback: buscar por nome
      console.log('[ODOO-PUSH] Buscando fatura por nome:', faturaName);
      var ids = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'search', [[['name', '=', faturaName]]]);
      if (!ids || ids.length === 0) {
        console.warn('[ODOO-PUSH] Fatura nao encontrada por nome, buscando mais recente...');
        var recentIds = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'search', [[['move_type', '=', 'out_invoice']]], { order: 'id desc', limit: 1 });
        if (!recentIds || recentIds.length === 0) {
          return { pushed: false, reason: 'invoice_not_found' };
        }
        recordId = recentIds[0];
      } else {
        recordId = ids[0];
      }
    } else {
      // Sem ID e sem nome - buscar mais recente
      console.warn('[ODOO-PUSH] Sem ID e sem nome, buscando fatura mais recente...');
      var recentIds = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'search', [[['move_type', '=', 'out_invoice']]], { order: 'id desc', limit: 1 });
      if (!recentIds || recentIds.length === 0) {
        return { pushed: false, reason: 'no_invoices' };
      }
      recordId = recentIds[0];
    }

    console.log('[ODOO-PUSH] recordId final:', recordId);

    // Buscar nome da fatura para o filename (se nao temos)
    if (!faturaName) {
      try {
        var names = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'read', [[recordId], ['name']]);
        if (names && names[0] && names[0].name) {
          faturaName = names[0].name;
          console.log('[ODOO-PUSH] Nome encontrado:', faturaName);
        }
      } catch (e) {
        console.warn('[ODOO-PUSH] Nao conseguiu ler nome:', e.message);
      }
    }

    var faturaNameSafe = faturaName ? faturaName.replace(/[^a-zA-Z0-9\-_]/g, '_') : 'Fatura';
    var totalAttachments = 0;

    // Processar cada boleto
    for (var i = 0; i < boletos.length; i++) {
      var bol = boletos[i];
      var pdfB64 = pdfsBase64[i];

      console.log('[ODOO-PUSH] Processando boleto', (i + 1) + '/' + boletos.length, '- PDF:', pdfB64 ? (pdfB64.length / 1024).toFixed(0) + 'KB' : 'AUSENTE');

      if (!pdfB64) {
        console.warn('[ODOO-PUSH]   PDF ausente, pulando boleto', (i + 1));
        continue;
      }

      var nn = bol.nosso_numero || '';
      var vd = bol.valor_titulo || '0,00';
      var vc = bol.data_vencimento || '';
      var ld = bol.linha_digitavel || '';
      var pix = bol.pix_copia_cola || '';
      var p = bol.parcela || 1;
      var t = bol.total_parcelas || 1;

      // Nome do arquivo
      var filename;
      if (t > 1) {
        filename = 'Boleto_' + faturaNameSafe + '_P' + p + 'de' + t + '_' + nn + '.pdf';
      } else {
        filename = 'Boleto_' + faturaNameSafe + '_' + nn + '.pdf';
      }

      try {
        // 1. Criar attachment
        var attachId = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'ir.attachment', 'create', [{
          name: filename,
          datas: pdfB64,
          res_model: 'account.move',
          res_id: recordId,
          mimetype: 'application/pdf',
        }]);
        console.log('[ODOO-PUSH]   Attachment OK:', filename, 'ID:', attachId);

        // 2. Criar nota interna com PDF amarrado
        var htmlBody = '<b>' + (t > 1 ? 'Boleto Parcela ' + p + '/' + t : 'Boleto') + '</b><br/>';
        htmlBody += 'Nosso Numero: ' + nn + '<br/>';
        htmlBody += 'Valor: R$ ' + vd + '<br/>';
        htmlBody += 'Vencimento: ' + vc + '<br/>';
        htmlBody += 'Linha Digitavel: ' + ld + '<br/>';
        if (pix) {
          htmlBody += 'PIX Copia e Cola: ' + pix;
        }

        await executeKw(client, odooConfig.db, uid, odooConfig.password, 'mail.message', 'create', [{
          model: 'account.move',
          res_id: recordId,
          body: htmlBody,
          message_type: 'comment',
          subtype_xmlid: 'mail.mt_note',
          attachment_ids: [[6, 0, [attachId]]],
        }]);
        console.log('[ODOO-PUSH]   Nota interna OK - boleto', (i + 1));
        totalAttachments++;

      } catch (err) {
        console.error('[ODOO-PUSH]   ERRO boleto', (i + 1) + ':', err.message);
      }
    }

    // === GRAVAR CAMPOS x_studio_* NA FATURA ===
    // Preenche os campos customizados do Odoo com dados dos boletos emitidos
    try {
      var bol0 = boletos[0] || {};
      var nnList = [];
      var pixList = [];
      var linkList = [];
      for (var i = 0; i < boletos.length; i++) {
        if (boletos[i].nosso_numero) nnList.push(boletos[i].nosso_numero);
        if (boletos[i].pix_copia_cola) pixList.push(boletos[i].pix_copia_cola);
        if (boletos[i].pdf_url_txid) linkList.push(boletos[i].pdf_url_txid);
        if (boletos[i].pdf_url_nn) linkList.push(boletos[i].pdf_url_nn);
      }

      var camposWrite = {};

      // x_studio_itau_situacao
      if (totalAttachments > 0) {
        camposWrite['x_studio_itau_situacao'] = 'EMITIDO';
      } else {
        camposWrite['x_studio_itau_situacao'] = 'ERRO';
      }

      // x_studio_itau_tipo_pagamento
      camposWrite['x_studio_itau_tipo_pagamento'] = 'BOLETO';

      // x_studio_itau_pix_copia_cola
      if (pixList.length > 0) {
        camposWrite['x_studio_itau_pix_copia_cola'] = pixList.join(' | ');
      }

      // x_studio_itau_nosso_numero
      if (nnList.length > 0) {
        camposWrite['x_studio_itau_nosso_numero'] = nnList.join(' | ');
      }

      // x_studio_itau_link_status
      if (linkList.length > 0) {
        camposWrite['x_studio_itau_link_status'] = linkList[0]; // Link do primeiro boleto
      }

      var keysWrite = Object.keys(camposWrite);
      if (keysWrite.length > 0) {
        console.log('[ODOO-PUSH] Gravando campos x_studio_*:', keysWrite.join(', '));
        await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'write', [[recordId], camposWrite]);
        console.log('[ODOO-PUSH] Campos x_studio_* gravados com sucesso na fatura', recordId);
      }
    } catch (fieldsErr) {
      console.error('[ODOO-PUSH] Erro ao gravar campos x_studio_*:', fieldsErr.message);
      // Nao falhar o push inteiro por causa dos campos
    }

    console.log('[ODOO-PUSH] === PUSH COMPLETO: ' + totalAttachments + '/' + boletos.length + ' PDFs na fatura ' + faturaNameSafe + ' (ID: ' + recordId + ') ===');
    return { pushed: totalAttachments > 0, attachments: totalAttachments, record_id: recordId };

  } catch (err) {
    console.error('[ODOO-PUSH] ERRO FATAL:', err.message);
    return { pushed: false, reason: err.message };
  }
}

/**
 * Push PIX para Odoo via XML-RPC
 * - Grava campos x_studio_* na fatura (tipo_pagamento, pix, html com QR code)
 * - Posta nota interna no chatter
 */
async function pushPixToOdoo(pushData) {
  var config = require('../config');
  var odooConfig = config.odoo;

  if (!odooConfig || !odooConfig.enabled) {
    console.log('[ODOO-PUSH-PIX] Desabilitado');
    return { pushed: false, reason: 'disabled' };
  }

  if (!odooConfig.url || !odooConfig.db || !odooConfig.user || !odooConfig.password) {
    console.warn('[ODOO-PUSH-PIX] Credenciais Odoo incompletas');
    return { pushed: false, reason: 'missing_credentials' };
  }

  var faturaId = parseInt(pushData.faturaId) || 0;
  var faturaName = pushData.faturaName || '';
  var pix = pushData.pix || {};
  var txid = pix.txid || '';
  var pixCopiaCola = pix.pix_copia_cola || '';
  var qrcodeBase64 = pix.qrcode_base64 || '';
  var htmlPix = pix.html_pix || '';
  var valor = pushData.valor || '0,00';

  console.log('[ODOO-PUSH-PIX] === INICIANDO ===');
  console.log('[ODOO-PUSH-PIX] faturaId:', faturaId, '| faturaName:', faturaName || 'vazio');
  console.log('[ODOO-PUSH-PIX] TXID:', txid, '| Valor:', valor);

  try {
    var client = createClient(odooConfig.url);
    var uid = await authenticate(client, odooConfig.db, odooConfig.user, odooConfig.password);

    // Determinar recordId
    var recordId;
    if (faturaId > 0) {
      recordId = faturaId;
      console.log('[ODOO-PUSH-PIX] Usando faturaId direto:', recordId);
    } else if (faturaName) {
      console.log('[ODOO-PUSH-PIX] Buscando fatura por nome:', faturaName);
      var ids = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'search', [[['name', '=', faturaName]]]);
      if (!ids || ids.length === 0) {
        var recentIds = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'search', [[['move_type', '=', 'out_invoice']]], { order: 'id desc', limit: 1 });
        if (!recentIds || recentIds.length === 0) {
          return { pushed: false, reason: 'invoice_not_found' };
        }
        recordId = recentIds[0];
      } else {
        recordId = ids[0];
      }
    } else {
      var recentIds = await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'search', [[['move_type', '=', 'out_invoice']]], { order: 'id desc', limit: 1 });
      if (!recentIds || recentIds.length === 0) {
        return { pushed: false, reason: 'no_invoices' };
      }
      recordId = recentIds[0];
    }

    console.log('[ODOO-PUSH-PIX] recordId final:', recordId);

    // === Gravar campos em writes separados ===
    // Campos Selection (tipo_pagamento, situacao) podem falhar se as opcoes nao existem
    // Entao cada campo critico vai em seu proprio write

    // 1. Campos TEXT/HTML (nunca falham por Selection)
    var textFields = {};
    if (pixCopiaCola) {
      textFields['x_studio_itau_pix_copia_cola'] = pixCopiaCola;
    }
    if (htmlPix) {
      textFields['x_studio_itau_boletos_html'] = htmlPix;
    }

    if (Object.keys(textFields).length > 0) {
      try {
        console.log('[ODOO-PUSH-PIX] Gravando campos texto/HTML:', Object.keys(textFields).join(', '));
        await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'write', [[recordId], textFields]);
        console.log('[ODOO-PUSH-PIX] Campos texto/HTML gravados OK');
      } catch (textErr) {
        console.error('[ODOO-PUSH-PIX] Erro campos texto/HTML:', textErr.message);
      }
    }

    // 2. tipo_pagamento (separado - falha se 'PIX' nao esta nas opcoes)
    try {
      await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'write', [[recordId], {
        'x_studio_itau_tipo_pagamento': 'PIX',
      }]);
      console.log('[ODOO-PUSH-PIX] tipo_pagamento=PIX gravado OK');
    } catch (tipoErr) {
      console.warn('[ODOO-PUSH-PIX] AVISO: tipo_pagamento=PIX falhou. Adicione "PIX" nas opcoes do campo Selection no Odoo Studio.');
    }

    // 3. situacao (separado - falha se 'EMITIDO' nao esta nas opcoes)
    try {
      await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'write', [[recordId], {
        'x_studio_itau_situacao': 'EMITIDO',
      }]);
    } catch (sitErr) {
      console.warn('[ODOO-PUSH-PIX] AVISO: situacao=EMITIDO falhou (valor nao existe nas opcoes Selection).');
    }

    // 4. Nota interna no chatter (sem subtype_xmlid - campo invalido neste Odoo)
    var htmlBody = '<b>PIX Gerado</b><br/>';
    htmlBody += 'TXID: ' + txid + '<br/>';
    htmlBody += 'Valor: R$ ' + valor + '<br/>';
    if (pixCopiaCola) {
      htmlBody += 'PIX Copia e Cola: ' + pixCopiaCola;
    }

    try {
      await executeKw(client, odooConfig.db, uid, odooConfig.password, 'mail.message', 'create', [{
        model: 'account.move',
        res_id: recordId,
        body: htmlBody,
        message_type: 'comment',
      }]);
      console.log('[ODOO-PUSH-PIX] Nota interna OK');
    } catch (noteErr) {
      console.warn('[ODOO-PUSH-PIX] Nota interna falhou (nao critico):', noteErr.message.substring(0, 100));
    }

    console.log('[ODOO-PUSH-PIX] === PUSH COMPLETO na fatura ' + faturaName + ' (ID: ' + recordId + ') ===');
    return { pushed: true, record_id: recordId };

  } catch (err) {
    console.error('[ODOO-PUSH-PIX] ERRO:', err.message);
    return { pushed: false, reason: err.message };
  }
}

module.exports = { pushBoletosToOdoo, pushPixToOdoo };