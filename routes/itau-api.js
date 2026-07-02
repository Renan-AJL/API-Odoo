/**
 * routes/itau-api.js - Rotas Itau Principais (namespaced: /api/v1/itau/*)
 * Adaptado de itau-odoo/routes/api.js v6.9.4
 * - POST /api/v1/itau/pagar  - Emitir boletos + gerar PDF + push Odoo
 * - POST /api/v1/itau/gerar  - Simplificado para Odoo Server Actions
 * - POST /api/v1/itau/regen  - Regenerar PDF de campos Odoo
 */
const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const { emitirBoleto, parseFormaPagamento } = require('../services/itau-boleto');
const { storeBoleto, generatePdf, generatePdfFromFields } = require('../services/pdf-boleto');
const { pushBoletosToOdoo } = require('../services/odoo-push');
const { criarLinkPagamento } = require('../services/itau-link-pagamento');
const config = require('../config');

// --- Deteccao de cartao por bandeira ---
var BANDEIRAS = ['VISA', 'MASTER', 'ELO', 'AMEX', 'HIPERCARD', 'HIPER'];

function detectarCartao(formaPag) {
  if (!formaPag) return null;
  var n = formaPag.trim().toUpperCase();
  for (var i = 0; i < BANDEIRAS.length; i++) {
    var b = BANDEIRAS[i];
    if (n.indexOf(b) === 0 || n.indexOf(b + ' ') === 0) {
      var debito = n.indexOf('DEBITO') >= 0 || n.indexOf('DEB') >= 0;
      var parcelas = 1;
      var match = n.match(/(\d+)\s*(VEZES|X|VEZ)/);
      if (match) parcelas = parseInt(match[1]);
      return { bandeira: b, parcelas: parcelas, debito: debito };
    }
  }
  // Generico: CARTAO, CARTAO CREDITO, CREDITO, etc.
  if (n.indexOf('CART') === 0 || n.indexOf('CREDITO') === 0) {
    var debito = n.indexOf('DEBITO') >= 0 || n.indexOf('DEB') >= 0;
    var parcelas = 1;
    var match = n.match(/(\d+)\s*(VEZES|X|VEZ)/);
    if (match) parcelas = parseInt(match[1]);
    return { bandeira: 'CARTAO', parcelas: parcelas, debito: debito };
  }
  return null;
}

// --- Handler de pagamento em cartao ---
async function handleCartao(req, res, d, cartaoInfo) {
  var fat = d.fatura || {};
  var faturaName = fat.name || fat.seu_numero || d.fatura_name || '';
  var faturaId = (fat.id || d.fatura_id) ? parseInt(String(fat.id || d.fatura_id)) : 0;
  var valorTotal = parseFloat(fat.valor_nominal || d.fatura_valor) || 0;
  var pag = d.pagador || {};

  console.log('[API/CARTAO] Fatura:', faturaName, '| Valor:', valorTotal, '| Bandeira:', cartaoInfo.bandeira);

  if (valorTotal <= 0) {
    return res.json({ success: false, message: 'Valor invalido para pagamento em cartao' });
  }

  if (!config.rede.pv || !config.rede.chaveIntegracao) {
    console.error('[API/CARTAO] Rede nao configurada. PV:', config.rede.pv ? 'OK' : 'faltando',
      '| Chave:', config.rede.chaveIntegracao ? 'OK' : 'faltando');
    return res.json({
      success: false,
      message: 'Rede nao configurada. Defina REDE_PV e REDE_CHAVE_INTEGRACAO nas variaveis de ambiente.',
    });
  }

  try {
    var linkResult = await criarLinkPagamento({
      valor: valorTotal,
      seu_numero: faturaName || String(Date.now()),
      descricao: 'Fatura ' + faturaName,
      parcelas: cartaoInfo.parcelas,
      nome_pagador: pag.nome || d.pagador_nome || '',
      cpf_cnpj_pagador: pag.cpf_cnpj || d.pagador_cpf || '',
      email_pagador: pag.email || '',
      expiracao: 7 * 86400,
      host: req.protocol + '://' + req.get('host'),
    });

    var checkoutUrl = linkResult.link || '';

    if (!checkoutUrl) {
      console.error('[API/CARTAO] Checkout criado mas sem URL. Resposta bruta:', JSON.stringify(linkResult.raw));
      return res.json({
        success: false,
        message: 'Checkout criado porem sem URL de pagamento. Verificar resposta da Rede.',
        detail: linkResult.raw,
      });
    }

    console.log('[API/CARTAO] Checkout URL gerada:', checkoutUrl.substring(0, 80) + '...');

    res.json({
      success: true,
      data: {
        forma_pagamento: d.forma_pagamento,
        total_parcelas: 1,
        valor_total: valorTotal.toFixed(2),
        fatura_name: faturaName || '(nao informado)',
        fatura_id: faturaId || 0,
        pagamentos: [{
          tipo: cartaoInfo.debito ? 'cartao_debito' : 'cartao_credito',
          parcela: 1,
          total_parcelas: 1,
          valor_titulo: valorTotal.toFixed(2),
          bandeira: cartaoInfo.bandeira,
          parcelas: cartaoInfo.parcelas,
          pix_copia_cola: checkoutUrl,
          link_checkout: checkoutUrl,
          checkout_id: linkResult.id || '',
        }],
        odoo_push: 'nao_aplicavel',
      }
    });

  } catch (err) {
    console.error('[API/CARTAO] ERRO:', err.message);
    if (err.detail) console.error('[API/CARTAO] Detalhes:', JSON.stringify(err.detail));
    res.json({
      success: false,
      message: 'Erro ao gerar link de pagamento: ' + (err.message || 'Erro desconhecido'),
    });
  }
}

function calcDataVenc(base, dias) {
  var db = base ? new Date(base + 'T12:00:00') : new Date();
  var hj = new Date(); hj.setHours(0,0,0,0);
  if (db <= hj) db = new Date();
  db.setDate(db.getDate() + dias);
  var a = db.getFullYear();
  var m = String(db.getMonth()+1).padStart(2,'0');
  var d = String(db.getDate()).padStart(2,'0');
  return a+'-'+m+'-'+d;
}

router.post('/pagar', apiKeyAuth, async function(req, res) {
  try {
    var d = req.body;

    console.log('[API] === NOVA REQUISICAO DE PAGAMENTO ===');
    console.log('[API] Body keys:', Object.keys(d).join(', '));
    var formaPag = d.forma_pagamento || '';
    console.log('[API] forma_pagamento:', formaPag);

    // === DETECTAR PAGAMENTO EM CARTAO ===
    var cartaoInfo = detectarCartao(formaPag);
    if (cartaoInfo) {
      console.log('[API] Pagamento em cartao detectado:', cartaoInfo.bandeira, cartaoInfo.parcelas, 'x');
      return await handleCartao(req, res, d, cartaoInfo);
    }

    var fat = d.fatura || {};
    var fatNameFromNested = fat.name || fat.seu_numero || '';
    var fatNameFromFlat = d.fatura_name || d.invoice_name || '';
    var faturaName = fatNameFromNested || fatNameFromFlat;
    var faturaId = (fat.id || d.fatura_id || d.invoice_id) ? parseInt(String(fat.id || d.fatura_id || d.invoice_id)) : 0;
    var valorTotal = parseFloat(fat.valor_nominal || d.fatura_valor) || 0;
    var dataVencBase = fat.data_vencimento || d.fatura_vencimento || '';

    var pag = d.pagador || {};
    var formaPag = d.forma_pagamento || '';

    var plano = parseFormaPagamento(formaPag);
    console.log('[API] Plano parsed:', JSON.stringify(plano));

    if (plano.tipo !== 'boleto' || plano.parcelas.length === 0) {
      return res.json({ success: false, message: 'Forma de pagamento nao suportada para boleto: ' + formaPag });
    }

    var basePayload = {
      cpfCnpjPagador: pag.cpf_cnpj || d.pagador_cpf || '',
      nomePagador: pag.nome || d.pagador_nome || '',
      numeroPedido: fat.seu_numero || fat.name || d.fatura_name || '',
      dataVencimento: dataVencBase,
      logradouro: pag.street || d.pagador_street || '',
      cidade: pag.city || d.pagador_city || '',
      estado: pag.state || d.pagador_state || '',
      cep: pag.zip || d.pagador_zip || ''
    };

    var totalP = plano.parcelas.length;
    var pagamentos = [];

    for (var i = 0; i < totalP; i++) {
      var parc = plano.parcelas[i];
      var valorParc = Math.round((valorTotal * parc.valor_pct / 100) * 100) / 100;
      if (i === totalP - 1) {
        var soma = 0;
        for (var j = 0; j < totalP - 1; j++) soma += Math.round((valorTotal * plano.parcelas[j].valor_pct / 100) * 100) / 100;
        valorParc = Math.round((valorTotal - soma) * 100) / 100;
      }

      var dataVenc = calcDataVenc(dataVencBase, parc.dias);
      var pPayload = Object.assign({}, basePayload);
      pPayload.valor = valorParc;
      pPayload.dataVencimento = dataVenc;
      pPayload.numeroPedido = basePayload.numeroPedido + (totalP > 1 ? '-P' + parc.numero : '');

      var resultado = await emitirBoleto(pPayload);
      var dados = (resultado.dados && resultado.dados.data) ? resultado.dados.data : {};
      var ind = (dados.dado_boleto && dados.dado_boleto.dados_individuais_boleto && dados.dado_boleto.dados_individuais_boleto[0]) || {};
      var qr = dados.dados_qrcode || {};
      var txid = qr.txid || ('BL' + Date.now() + '-' + parc.numero);
      var nossoNumero = ind.numero_nosso_numero || '';

      storeBoleto(txid, {
        txid, nosso_numero: nossoNumero,
        linha_digitavel: ind.numero_linha_digitavel || '',
        codigo_barras: ind.codigo_barras || '',
        data_vencimento: ind.data_vencimento || dataVenc,
        data_emissao: dados.dado_boleto ? dados.dado_boleto.data_emissao : '',
        valor_titulo: ind.valor_titulo || '',
        pix_copia_cola: qr.emv || '',
        qrcode_base64: qr.base64 || '',
        nome_pagador: basePayload.nomePagador,
        cpf_cnpj_pagador: basePayload.cpfCnpjPagador,
        logradouro: basePayload.logradouro,
        cidade: basePayload.cidade,
        estado: basePayload.estado,
        cep: basePayload.cep,
        seu_numero: pPayload.numeroPedido,
        parcela: parc.numero, total_parcelas: totalP
      });

      var vc = parseInt(String(ind.valor_titulo || '0'), 10);

      // URL dinamica baseada no host da requisicao
      var host = req.get('host') || 'localhost:3000';
      var protocol = req.protocol || 'https';

      pagamentos.push({
        tipo: 'boleto', parcela: parc.numero, total_parcelas: totalP,
        nosso_numero: nossoNumero,
        linha_digitavel: ind.numero_linha_digitavel || '',
        codigo_barras: ind.codigo_barras || '',
        pix_copia_cola: qr.emv || '',
        txid: txid,
        valor_titulo: (vc / 100).toFixed(2),
        data_vencimento: ind.data_vencimento || dataVenc,
        pdf_url_txid: protocol + '://' + host + '/api/v1/itau/boletos/pdf/' + txid,
        pdf_url_nn: protocol + '://' + host + '/api/v1/itau/boletos/pdf/nn/' + nossoNumero
      });
    }

    // Gerar PDFs imediatamente
    var pdfsBase64 = [];
    for (var i = 0; i < pagamentos.length; i++) {
      try {
        var pdfBuf = await generatePdf(pagamentos[i].txid);
        pdfsBase64.push(pdfBuf.toString('base64'));
      } catch (pdfErr) {
        console.error('[API]   PDF', i + 1, 'ERRO:', pdfErr.message);
        pdfsBase64.push(null);
      }
    }

    // Push Odoo
    var pushResult = { pushed: false, reason: 'not_called' };
    try {
      pushResult = await pushBoletosToOdoo({
        faturaId, faturaName, boletos: pagamentos, pdfsBase64
      });
    } catch (pushErr) {
      pushResult = { pushed: false, reason: pushErr.message };
    }

    res.json({
      success: true,
      data: {
        forma_pagamento: formaPag, total_parcelas: totalP,
        valor_total: valorTotal.toFixed(2),
        fatura_name: faturaName || '(nao informado)',
        fatura_id: faturaId || 0,
        pagamentos: pagamentos,
        odoo_push: pushResult.pushed ? 'OK_' + pushResult.attachments + '_attachments' : 'falhou_' + (pushResult.reason || 'unknown')
      }
    });

  } catch (e) {
    console.error('[API] ERRO:', e.message, e.stack);
    res.json({ success: false, message: e.message });
  }
});

/**
 * POST /api/v1/itau/gerar - Simplificado para Odoo Server Actions
 */
router.post('/gerar', async function(req, res) {
  try {
    var formaPag = req.body.forma_pagamento || '';
    var fatName = req.body.fatura_name || '';
    var fatValor = parseFloat(req.body.fatura_valor) || 0;
    var fatVenc = req.body.fatura_vencimento || '';
    var pagNome = req.body.pagador_nome || '';
    var pagCpf = req.body.pagador_cpf || '';
    var pagStreet = req.body.pagador_street || '';
    var pagCity = req.body.pagador_city || '';
    var pagState = req.body.pagador_state || '';
    var pagZip = req.body.pagador_zip || '';

    var plano = parseFormaPagamento(formaPag);
    if (plano.tipo !== 'boleto' || plano.parcelas.length === 0) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('ERRO|Forma de pagamento nao suportada: ' + formaPag);
      return;
    }

    var basePayload = {
      cpfCnpjPagador: pagCpf, nomePagador: pagNome, numeroPedido: fatName,
      dataVencimento: fatVenc, logradouro: pagStreet, cidade: pagCity,
      estado: pagState, cep: pagZip
    };

    var totalP = plano.parcelas.length;
    var lines = ['OK|' + totalP];

    for (var i = 0; i < totalP; i++) {
      var parc = plano.parcelas[i];
      var valorParc = Math.round((fatValor * parc.valor_pct / 100) * 100) / 100;
      if (i === totalP - 1) {
        var soma = 0;
        for (var j = 0; j < totalP - 1; j++) soma += Math.round((fatValor * plano.parcelas[j].valor_pct / 100) * 100) / 100;
        valorParc = Math.round((fatValor - soma) * 100) / 100;
      }

      var dataVenc = calcDataVenc(fatVenc, parc.dias);
      var pPayload = Object.assign({}, basePayload);
      pPayload.valor = valorParc;
      pPayload.dataVencimento = dataVenc;
      pPayload.numeroPedido = fatName + (totalP > 1 ? '-P' + parc.numero : '');

      var resultado = await emitirBoleto(pPayload);
      var dados = (resultado.dados && resultado.dados.data) ? resultado.dados.data : {};
      var ind = (dados.dado_boleto && dados.dado_boleto.dados_individuais_boleto && dados.dado_boleto.dados_individuais_boleto[0]) || {};
      var qr = dados.dados_qrcode || {};
      var txid = qr.txid || ('BL' + Date.now() + '-' + parc.numero);
      var nossoNumero = ind.numero_nosso_numero || '';

      storeBoleto(txid, {
        txid, nosso_numero: nossoNumero,
        linha_digitavel: ind.numero_linha_digitavel || '',
        codigo_barras: ind.codigo_barras || '',
        data_vencimento: ind.data_vencimento || dataVenc,
        data_emissao: dados.dado_boleto ? dados.dado_boleto.data_emissao : '',
        valor_titulo: ind.valor_titulo || '',
        pix_copia_cola: qr.emv || '',
        qrcode_base64: qr.base64 || '',
        nome_pagador: pagNome, cpf_cnpj_pagador: pagCpf,
        logradouro: pagStreet, cidade: pagCity, estado: pagState, cep: pagZip,
        seu_numero: pPayload.numeroPedido, parcela: parc.numero, total_parcelas: totalP
      });

      var pdfBuf = await generatePdf(txid);
      var pdfB64 = pdfBuf.toString('base64');
      var vc = parseInt(String(ind.valor_titulo || '0'), 10);

      lines.push(
        'NN=' + nossoNumero + '|TXID=' + txid +
        '|VD=' + (vc / 100).toFixed(2) + '|VC=' + (ind.data_vencimento || dataVenc) +
        '|LD=' + (ind.numero_linha_digitavel || '') + '|PIX=' + (qr.emv || '') +
        '|B64=' + pdfB64
      );
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  } catch (e) {
    console.error('[API/GERAR] ERRO:', e.message);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send('ERRO|' + e.message);
  }
});

/**
 * POST /api/v1/itau/regen
 */
router.post('/regen', async function(req, res) {
  try {
    var nn = req.body.nosso_numero || '';
    var ld = req.body.linha_digitavel || '';
    var cb = req.body.codigo_barras || '';
    var pix = req.body.pix_copia_cola || '';
    var vd = req.body.valor_titulo || '';
    var vc = req.body.data_vencimento || '';
    var pn = req.body.nome_pagador || '';
    var pc = req.body.cpf_cnpj_pagador || '';
    var sn = req.body.seu_numero || nn;
    var parc = req.body.parcela || '';
    var tp = req.body.total_parcelas || '';

    if (!nn && !ld) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('ERRO|Campos obrigatorios: nosso_numero ou linha_digitavel');
      return;
    }

    var dados = {
      nosso_numero: nn, linha_digitavel: ld, codigo_barras: cb,
      pix_copia_cola: pix, valor_titulo: vd, data_vencimento: vc,
      nome_pagador: pn, cpf_cnpj_pagador: pc, seu_numero: sn,
      parcela: parc ? parseInt(parc) : 0, total_parcelas: tp ? parseInt(tp) : 0,
    };

    var pdfBuf = await generatePdfFromFields(dados);
    var b64 = pdfBuf.toString('base64');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send('OK|' + b64);
  } catch(e) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send('ERRO|' + e.message);
  }
});

// === CHECKOUT DE CARTAO ===
var checkoutPage = require('../views/checkout-page');
var linkPagService = require('../services/itau-link-pagamento');

// GET /api/v1/itau/checkout/:orderId - Pagina de pagamento
router.get('/checkout/:orderId', function(req, res) {
  var order = linkPagService.consultarPedido(req.params.orderId);
  if (!order) {
    res.status(404).send('Pedido nao encontrado ou expirado');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(checkoutPage.checkoutHtml(order));
});

// POST /api/v1/itau/checkout/:orderId/pay - Processar pagamento
router.post('/checkout/:orderId/pay', async function(req, res) {
  try {
    var result = await linkPagService.processarPagamento(req.params.orderId, req.body);
    res.json(result);
  } catch (err) {
    var status = err.status || 500;
    res.status(status).json({
      autorizado: false,
      returnMessage: err.message,
      detail: err.detail,
    });
  }
});

module.exports = router;