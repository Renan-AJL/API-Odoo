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
          raw: pdfB64,
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
        camposWrite['x_studio_itau_situacao'] = 'emitido';
      } else {
        camposWrite['x_studio_itau_situacao'] = 'erro';
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

      // x_studio_itau_boletos_html — HTML com dados do boleto para exibir na aba Itaú
      // Igual ao PIX: gera HTML com linha digitável, PIX copia e cola, QR code
      if (totalAttachments > 0) {
        var boletosHtmlParts = [];
        for (var bi = 0; bi < boletos.length; bi++) {
          var b = boletos[bi];
          var bParcela = b.parcela || 1;
          var bTotal = b.total_parcelas || 1;
          var bTitulo = (bTotal > 1) ? 'Boleto Parcela ' + bParcela + '/' + bTotal : 'Boleto';
          var bValor = b.valor_titulo || '0,00';
          var bVenc = b.data_vencimento || '';
          var bNN = b.nosso_numero || '';
          var bLD = b.linha_digitavel || '';
          var bPix = b.pix_copia_cola || '';
          var bQR = b.qrcode_base64 || '';

          var bHtml = '<div style="text-align:center; font-family:Arial,sans-serif; padding:10px; margin-bottom:16px; border:1px solid #ddd; border-radius:8px;">';
          bHtml += '<div style="font-size:18px; font-weight:bold; color:#333; margin-bottom:8px;">' + bTitulo + '</div>';
          bHtml += '<div style="font-size:14px; color:#666; margin-bottom:4px;">' + (faturaName || '') + '</div>';
          bHtml += '<div style="font-size:14px; color:#666; margin-bottom:8px;">Valor: R$ ' + bValor + (bVenc ? ' | Venc: ' + bVenc : '') + '</div>';
          if (bNN) {
            bHtml += '<div style="font-size:11px; color:#555; margin-bottom:4px;">Nosso Número: ' + bNN + '</div>';
          }
          if (bLD) {
            bHtml += '<div style="font-size:11px; color:#555; margin-bottom:8px; word-break:break-all;">Linha Digitável: ' + bLD + '</div>';
          }
          if (bQR) {
            var qrSrc = bQR.indexOf('data:') === 0 ? bQR : 'data:image/png;base64,' + bQR;
            bHtml += '<img src="' + qrSrc + '" style="width:180px; height:180px; margin:0 auto 8px auto; display:block;" />';
          }
          if (bPix) {
            bHtml += '<div style="font-size:9px; color:#999; word-break:break-all; max-width:380px; margin:0 auto; line-height:1.3; border:1px dashed #ccc; padding:6px; border-radius:4px;">' + bPix + '</div>';
          }
          bHtml += '</div>';
          boletosHtmlParts.push(bHtml);
        }
        camposWrite['x_studio_itau_boletos_html'] = boletosHtmlParts.join('');
      }

      var keysWrite = Object.keys(camposWrite);
      if (keysWrite.length > 0) {
        console.log('[ODOO-PUSH] Gravando campos x_studio_*:', keysWrite.join(', '));
        try {
          await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'write', [[recordId], camposWrite]);
          console.log('[ODOO-PUSH] Campos x_studio_* gravados com sucesso na fatura', recordId);
        } catch (fieldWriteErr) {
          // Campo pode nao existir - tentar campo a campo
          console.warn('[ODOO-PUSH] Erro ao gravar todos campos, tentando campo a campo:', fieldWriteErr.message);
          var writtenFields = [];
          for (var wk = 0; wk < keysWrite.length; wk++) {
            var singleField = {};
            singleField[keysWrite[wk]] = camposWrite[keysWrite[wk]];
            try {
              await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'write', [[recordId], singleField]);
              writtenFields.push(keysWrite[wk]);
            } catch (singleErr) {
              console.warn('[ODOO-PUSH] Campo ausente/pulando:', keysWrite[wk]);
            }
          }
          if (writtenFields.length > 0) {
            console.log('[ODOO-PUSH] Campos gravados individualmente:', writtenFields.join(', '));
          }
        }
      }
    } catch (fieldsErr) {
      console.error('[ODOO-PUSH] Erro ao gravar campos x_studio_*:', fieldsErr.message);
      // Nao falhar o push inteiro por causa dos campos
    }

    console.log('[ODOO-PUSH] === PUSH COMPLETO: ' + totalAttachments + '/' + boletos.length + ' PDFs na fatura ' + faturaNameSafe + ' (ID: ' + recordId + ') ===');

    // === PUSH BOLETOS PARA O PEDIDO DE VENDA ===
    // Quando o Financeiro emite boleto, anexar tambem no chatter do pedido
    var soResult = { pushed: false };
    if (totalAttachments > 0) {
      try {
        soResult = await pushBoletosToSaleOrder({
          client: client, db: odooConfig.db, uid: uid, password: odooConfig.password,
          invoiceId: recordId, boletos: boletos, pdfsBase64: pdfsBase64, faturaName: faturaName,
        });
        if (soResult.pushed) {
          console.log('[ODOO-PUSH] Boleto(s) tambem anexado(s) no pedido de venda:', soResult.sale_order_name);
        }
      } catch (soErr) {
        console.warn('[ODOO-PUSH] Nao conseguiu anexar no pedido de venda:', soErr.message);
      }
    }

    return { pushed: totalAttachments > 0, attachments: totalAttachments, record_id: recordId, sale_order_push: soResult };

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

    // === Gravar campos texto/HTML + nota interna ===
    // Campos Selection (tipo_pagamento, situacao) removidos: valores nao batem
    // com as opcoes do Odoo Studio. Reative com os valores corretos se necessario.

    var textFields = {};

    // Campos obrigatórios para polling e exibição no Odoo
    textFields['x_studio_itau_situacao'] = 'emitido';
    textFields['x_studio_itau_tipo_pagamento'] = 'PIX';
    if (txid) {
      textFields['x_studio_itau_txid'] = txid;
    }

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
        // Campo pode nao existir - tentar campo a campo
        console.warn('[ODOO-PUSH-PIX] Erro ao gravar todos campos, tentando campo a campo:', textErr.message);
        var textKeys = Object.keys(textFields);
        var writtenPixFields = [];
        for (var tk = 0; tk < textKeys.length; tk++) {
          var singlePixField = {};
          singlePixField[textKeys[tk]] = textFields[textKeys[tk]];
          try {
            await executeKw(client, odooConfig.db, uid, odooConfig.password, 'account.move', 'write', [[recordId], singlePixField]);
            writtenPixFields.push(textKeys[tk]);
          } catch (singlePixErr) {
            console.warn('[ODOO-PUSH-PIX] Campo ausente/pulando:', textKeys[tk]);
          }
        }
        if (writtenPixFields.length > 0) {
          console.log('[ODOO-PUSH-PIX] Campos gravados individualmente:', writtenPixFields.join(', '));
        }
      }
    }

    // Nota interna no chatter
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

/**
 * Busca o sale.order vinculado a uma invoice e anexa boleto/NF no chatter dele
 * Chamado apos pushBoletosToOdoo() para espelhar os PDFs no pedido de venda
 * @param {Object} params: { client, db, uid, password, invoiceId, boletos, pdfsBase64, faturaName }
 */
async function pushBoletosToSaleOrder(params) {
  var client = params.client;
  var db = params.db;
  var uid = params.uid;
  var password = params.password;
  var invoiceId = params.invoiceId;
  var boletos = params.boletos || [];
  var pdfsBase64 = params.pdfsBase64 || [];
  var faturaName = params.faturaName || '';

  console.log('[ODOO-PUSH-SO] Buscando sale.order da fatura', invoiceId);

  try {
    // Buscar sale.order vinculado a esta invoice
    // Metodo 1: via invoice_line_ids -> sale_line_ids -> order_id
    // Metodo 2: search sale.order where invoice_ids contains invoiceId
    var soIds = await executeKw(client, db, uid, password, 'sale.order', 'search', [[['invoice_ids', 'in', [invoiceId]]]], { limit: 5 });

    if (!soIds || soIds.length === 0) {
      // Fallback: tentar via invoice_origin (campo texto com nome do pedido)
      console.log('[ODOO-PUSH-SO] Nenhum SO via invoice_ids, tentando invoice_origin...');
      var invData = await executeKw(client, db, uid, password, 'account.move', 'read', [[invoiceId], ['invoice_origin']]);
      var origin = (invData && invData[0] && invData[0].invoice_origin) || '';
      if (origin) {
        console.log('[ODOO-PUSH-SO] invoice_origin:', origin);
        soIds = await executeKw(client, db, uid, password, 'sale.order', 'search', [[['name', 'ilike', origin]]], { limit: 5 });
      }
    }

    if (!soIds || soIds.length === 0) {
      console.warn('[ODOO-PUSH-SO] Nenhum pedido de venda vinculado a fatura', invoiceId);
      return { pushed: false, reason: 'no_sale_order' };
    }

    // Usar o primeiro SO encontrado
    var soId = soIds[0];
    var soData = await executeKw(client, db, uid, password, 'sale.order', 'read', [[soId], ['name']]);
    var soName = (soData && soData[0] && soData[0].name) || 'SO' + soId;
    console.log('[ODOO-PUSH-SO] Pedido encontrado:', soName, '(ID:', soId, ')');

    var faturaNameSafe = faturaName ? faturaName.replace(/[^a-zA-Z0-9\-_]/g, '_') : 'Fatura';
    var soAttachments = 0;

    for (var i = 0; i < boletos.length; i++) {
      var bol = boletos[i];
      var pdfB64 = pdfsBase64[i];
      if (!pdfB64) continue;

      var nn = bol.nosso_numero || '';
      var vd = bol.valor_titulo || '0,00';
      var vc = bol.data_vencimento || '';
      var p = bol.parcela || 1;
      var t = bol.total_parcelas || 1;

      var filename;
      if (t > 1) {
        filename = 'Boleto_' + faturaNameSafe + '_P' + p + 'de' + t + '_' + nn + '.pdf';
      } else {
        filename = 'Boleto_' + faturaNameSafe + '_' + nn + '.pdf';
      }

      try {
        // Criar attachment no sale.order
        var attachId = await executeKw(client, db, uid, password, 'ir.attachment', 'create', [{
          name: filename,
          raw: pdfB64,
          res_model: 'sale.order',
          res_id: soId,
          mimetype: 'application/pdf',
        }]);
        console.log('[ODOO-PUSH-SO]   Attachment OK:', filename, 'ID:', attachId);

        // Nota interna no chatter do pedido
        var htmlBody = '<b>' + (t > 1 ? 'Boleto Parcela ' + p + '/' + t : 'Boleto') + '</b> — Fatura: ' + (faturaName || 'N/A') + '<br/>';
        htmlBody += 'Nosso Número: ' + nn + '<br/>';
        htmlBody += 'Valor: R$ ' + vd + '<br/>';
        htmlBody += 'Vencimento: ' + vc + '<br/>';

        await executeKw(client, db, uid, password, 'mail.message', 'create', [{
          model: 'sale.order',
          res_id: soId,
          body: htmlBody,
          message_type: 'comment',
          subtype_xmlid: 'mail.mt_note',
          attachment_ids: [[6, 0, [attachId]]],
        }]);
        console.log('[ODOO-PUSH-SO]   Nota interna OK - boleto', (i + 1));
        soAttachments++;

      } catch (err) {
        console.error('[ODOO-PUSH-SO]   ERRO boleto', (i + 1) + ':', err.message);
      }
    }

    console.log('[ODOO-PUSH-SO] === PUSH COMPLETO: ' + soAttachments + '/' + boletos.length + ' PDFs no pedido ' + soName + ' ===');
    return { pushed: soAttachments > 0, attachments: soAttachments, sale_order_id: soId, sale_order_name: soName };

  } catch (err) {
    console.error('[ODOO-PUSH-SO] ERRO:', err.message);
    return { pushed: false, reason: err.message };
  }
}

/**
 * Copia attachments de boleto/NF da invoice para o sale.order vinculado
 * Usado pelo script retroativo para pedidos que ja tinham boletos
 * @param {Object} params: { client, db, uid, password, invoiceId }
 */
async function copyInvoiceAttachmentsToSaleOrder(params) {
  var client = params.client;
  var db = params.db;
  var uid = params.uid;
  var password = params.password;
  var invoiceId = params.invoiceId;

  try {
    // Buscar SO vinculado
    var soIds = await executeKw(client, db, uid, password, 'sale.order', 'search', [[['invoice_ids', 'in', [invoiceId]]]], { limit: 5 });
    if (!soIds || soIds.length === 0) {
      var invData = await executeKw(client, db, uid, password, 'account.move', 'read', [[invoiceId], ['invoice_origin', 'name']]);
      var origin = (invData && invData[0] && invData[0].invoice_origin) || '';
      if (origin) {
        soIds = await executeKw(client, db, uid, password, 'sale.order', 'search', [[['name', 'ilike', origin]]], { limit: 5 });
      }
    }
    if (!soIds || soIds.length === 0) return { pushed: false, reason: 'no_sale_order' };

    var soId = soIds[0];

    // Buscar attachments de boleto na invoice
    var attachIds = await executeKw(client, db, uid, password, 'ir.attachment', 'search', [[
      ['res_model', '=', 'account.move'],
      ['res_id', '=', invoiceId],
      ['name', 'ilike', 'Boleto'],
      ['mimetype', '=', 'application/pdf'],
    ]]);

    if (!attachIds || attachIds.length === 0) {
      console.log('[ODOO-COPY-SO] Fatura', invoiceId, ': sem attachments de boleto');
      return { pushed: false, reason: 'no_boleto_attachments' };
    }

    // Ler dados dos attachments
    var attachments = await executeKw(client, db, uid, password, 'ir.attachment', 'read', [attachIds, ['name', 'raw', 'mimetype']]);

    // Verificar quais ja existem no SO (evitar duplicar)
    var soExisting = await executeKw(client, db, uid, password, 'ir.attachment', 'search', [[
      ['res_model', '=', 'sale.order'],
      ['res_id', '=', soId],
      ['name', 'ilike', 'Boleto'],
    ]]);
    var soExistingNames = [];
    if (soExisting && soExisting.length > 0) {
      var soExistingData = await executeKw(client, db, uid, password, 'ir.attachment', 'read', [soExisting, ['name']]);
      soExistingNames = soExistingData.map(function(a) { return a.name; });
    }

    var copied = 0;
    for (var i = 0; i < attachments.length; i++) {
      var att = attachments[i];
      // Pular se ja existe no SO
      if (soExistingNames.indexOf(att.name) >= 0) {
        console.log('[ODOO-COPY-SO]   Ja existe no SO:', att.name, '- pulando');
        continue;
      }

      // Criar copia no sale.order
      try {
        var newAttId = await executeKw(client, db, uid, password, 'ir.attachment', 'create', [{
          name: att.name,
          raw: att.raw,
          res_model: 'sale.order',
          res_id: soId,
          mimetype: att.mimetype || 'application/pdf',
        }]);

        // Postar chatter note
        await executeKw(client, db, uid, password, 'mail.message', 'create', [{
          model: 'sale.order',
          res_id: soId,
          body: '<b>Boleto</b> (cópia da fatura ID ' + invoiceId + ')<br/>Arquivo: ' + att.name,
          message_type: 'comment',
          subtype_xmlid: 'mail.mt_note',
          attachment_ids: [[6, 0, [newAttId]]],
        }]);
        copied++;
        console.log('[ODOO-COPY-SO]   Copiado:', att.name, '→ SO', soId);
      } catch (copyErr) {
        console.error('[ODOO-COPY-SO]   ERRO ao copiar', att.name + ':', copyErr.message);
      }
    }

    return { pushed: copied > 0, copied: copied, sale_order_id: soId };

  } catch (err) {
    console.error('[ODOO-COPY-SO] ERRO:', err.message);
    return { pushed: false, reason: err.message };
  }
}

module.exports = { pushBoletosToOdoo, pushPixToOdoo, pushBoletosToSaleOrder, copyInvoiceAttachmentsToSaleOrder };