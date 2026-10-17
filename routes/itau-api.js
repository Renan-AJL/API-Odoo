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
const { emitirBoleto, parseFormaPagamento, consultarBoletoPorNossoNumero, cancelarBoleto } = require('../services/itau-boleto');
const { storeBoleto, generatePdf, generatePdfFromFields } = require('../services/pdf-boleto');
const { pushBoletosToOdoo, pushPixToOdoo } = require('../services/odoo-push');
const { criarLinkPagamento } = require('../services/itau-link-pagamento');
const { criarCobrancaPix, consultarCobrancaPix } = require('../services/itau-pix');
const { buildDevedorFromDoc } = require('../utils/pix-devedor');
const { buscarExtratoNormalizado } = require('../services/itau-extrato');
const { criarExtrato } = require('../services/odoo-bank-statement');
const config = require('../config');
const bwipjs = require('bwip-js');

// === Lock anti-concorrencia PIX ===
// Impede que o Odoo dispare multiplas requisicoes PIX simultaneas pra mesma fatura
var _pixLocks = {};     // faturaId -> Promise (in-flight)
var _pixCache = {};     // faturaId -> { timestamp, response } (resultado recente)
var PIX_LOCK_TTL = 30000;  // 30s - tempo maximo de lock
var PIX_CACHE_TTL = 60000; // 60s - reusa resultado se Odoo reenviar

// === Lock anti-concorrencia BOLETO ===
// Impede triplicacao/quadruplicacao de boletos por clicks multiplos no Odoo
var _boletoLocks = {};     // faturaId -> Promise (in-flight)
var _boletoCache = {};     // faturaId -> { timestamp, response } (resultado recente)
var BOLETO_LOCK_TTL = 45000;  // 45s - tempo maximo de lock (boleto demora mais que PIX)
var BOLETO_CACHE_TTL = 90000; // 90s - reusa resultado se Odoo reenviar

function getPixLockKey(faturaId, faturaName) {
  return String(faturaId || 'name:' + (faturaName || 'unknown'));
}

function getBoletoLockKey(faturaId, faturaName) {
  return String(faturaId || 'name:' + (faturaName || 'unknown'));
}

// === Verificar boleto ativo antes de emitir novo ===
// Consulta Odoo (campos x_studio_itau_*) e Itau API para confirmar status
// Retorna: { podeEmitir: true } ou { podeEmitir: false, motivo: string }
async function checkBoletoAtivo(faturaId, faturaName) {
  var config = require('../config');
  var odooConfig = config.odoo;

  if (!odooConfig || !odooConfig.enabled || !odooConfig.url || faturaId <= 0) {
    // Sem Odoo ou sem faturaId, nao podemos verificar — permite emissao
    return { podeEmitir: true };
  }

  try {
    var xmlrpc = require('xmlrpc');
    var base = odooConfig.url.replace(/\/+$/, '');
    var host = base.replace('https://', '');
    var client = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });

    // Auth
    var uid = await new Promise(function(ok, fail) {
      client.methodCall('authenticate', [odooConfig.db, odooConfig.user, odooConfig.password, {}], function(e, r) {
        if (e || !r) return fail(e || new Error('Auth failed'));
        ok(r);
      });
    });

    var objClient = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });

    function execKw(model, method, args, kwargs) {
      return new Promise(function(ok, fail) {
        var params = [odooConfig.db, uid, odooConfig.password, model, method, args];
        if (kwargs) params.push(kwargs);
        objClient.methodCall('execute_kw', params, function(e, r) {
          if (e) return fail(e);
          ok(r);
        });
      });
    }

    // Ler campos da fatura
    var fieldsToRead = ['x_studio_itau_situacao', 'x_studio_itau_nosso_numero',
      'x_studio_itau_boleto_status', 'x_studio_boleto_cancelado'];
    var invoiceData = await execKw('account.move', 'read', [[faturaId]], { fields: fieldsToRead });

    if (!invoiceData || !invoiceData.length) {
      return { podeEmitir: true }; // Fatura nao encontrada, permite
    }

    var inv = invoiceData[0];
    var situacao = (inv.x_studio_itau_situacao || '').toLowerCase();
    var boletoStatus = (inv.x_studio_itau_boleto_status || '').toLowerCase();
    var nossoNumero = inv.x_studio_itau_nosso_numero || '';
    var boletoCancelado = inv.x_studio_boleto_cancelado || false;

    console.log('[BOLETO-CHECK] Fatura ' + faturaId + ': situacao=' + situacao +
      ' | boleto_status=' + boletoStatus + ' | nn=' + nossoNumero +
      ' | cancelado=' + boletoCancelado);

    // Se boleto foi cancelado ou expirado, pode emitir novo
    if (boletoCancelado || situacao === 'cancelado' || situacao === 'expirado' ||
        boletoStatus === 'cancelado' || boletoStatus === 'expirado') {
      console.log('[BOLETO-CHECK] Boleto anterior cancelado/expirado. Pode emitir novo.');
      return { podeEmitir: true };
    }

    // Se nao tem nosso_numero, nao tem boleto emitido
    if (!nossoNumero) {
      console.log('[BOLETO-CHECK] Sem nosso_numero. Pode emitir.');
      return { podeEmitir: true };
    }

    // Se situacao = emitido ou em_aberto, verificar no Itau se ainda ativo
    if (situacao === 'emitido' || boletoStatus === 'em_aberto' || situacao === '' && nossoNumero) {
      // Tentar consultar boleto no Itau
      try {
        var nnFirst = nossoNumero.split(' | ')[0].trim(); // Pega primeiro se multiplos
        var consultaResult = await consultarBoletoPorNossoNumero(nnFirst);

        if (consultaResult && consultaResult.dados) {
          var dados = consultaResult.dados;
          // Verificar situacao do boleto no Itau
          var situacaoItau = '';
          if (dados.data && dados.data.dado_boleto) {
            situacaoItau = (dados.data.dado_boleto.situacao_boleto || '').toLowerCase();
          }
          console.log('[BOLETO-CHECK] Itau situacao_boleto: ' + situacaoItau);

          // Se boleto esta ativo (em_aberto, registrado, etc), BLOQUEAR
          if (situacaoItau === 'em_aberto' || situacaoItau === 'registrado' ||
              situacaoItau === '' && dados.data) {
            return {
              podeEmitir: false,
              motivo: 'Primeiro, cancele o boleto no Itaú para nova emissão. Nosso Número: ' + nnFirst,
              nossoNumero: nnFirst,
            };
          }

          // Se baixado/cancelado no Itau, pode emitir novo
          if (situacaoItau.indexOf('cancelado') >= 0 || situacaoItau.indexOf('baixado') >= 0 ||
              situacaoItau.indexOf('pago') >= 0) {
            console.log('[BOLETO-CHECK] Boleto ' + situacaoItau + ' no Itau. Pode emitir novo.');
            return { podeEmitir: true };
          }
        }
      } catch (itauErr) {
        console.warn('[BOLETO-CHECK] Erro ao consultar Itau: ' + itauErr.message);
        // Se nao conseguiu consultar o Itau, e temos situacao=emitido no Odoo,
        // BLOQUEIA por seguranca (nao sabemos se o boleto ainda esta ativo)
        return {
          podeEmitir: false,
          motivo: 'Primeiro, cancele o boleto no Itaú para nova emissão. Nosso Número: ' + nossoNumero.split(' | ')[0] + ' (não foi possível verificar status no Itaú)',
          nossoNumero: nossoNumero.split(' | ')[0],
        };
      }
    }

    // Se situacao = pago, pode emitir novo (boleto ja foi pago)
    if (situacao === 'pago' || boletoStatus === 'pago') {
      console.log('[BOLETO-CHECK] Boleto anterior ja pago. Pode emitir novo.');
      return { podeEmitir: true };
    }

    // Default: se tem nosso_numero e situacao nao e cancelado/expirado/pago, bloqueia
    if (nossoNumero && situacao !== 'cancelado' && situacao !== 'expirado' && situacao !== 'pago' &&
        boletoStatus !== 'cancelado' && boletoStatus !== 'expirado' && boletoStatus !== 'pago') {
      return {
        podeEmitir: false,
        motivo: 'Primeiro, cancele o boleto no Itaú para nova emissão. Nosso Número: ' + nossoNumero.split(' | ')[0],
        nossoNumero: nossoNumero.split(' | ')[0],
      };
    }

    return { podeEmitir: true };
  } catch (err) {
    console.warn('[BOLETO-CHECK] Erro na verificacao: ' + err.message);
    // Falha FECHADA: se nao conseguimos verificar, BLOQUEIA emissao por seguranca.
    // Evita duplicacao quando Odoo ou API Itau estao instaveis.
    return {
      podeEmitir: false,
      motivo: 'Primeiro, cancele o boleto no Itaú para nova emissão. Não foi possível verificar o status do boleto (' + (err.message || 'erro desconhecido') + ')',
    };
  }
}

/**
 * Posta nota no chatter da invoice quando emissao de boleto e bloqueada
 * Para rastreabilidade: o usuario ve no historico da fatura por que foi bloqueado
 */
async function postBoletoBlockedChatter(faturaId, motivo) {
  var config = require('../config');
  var odooConfig = config.odoo;
  if (!odooConfig || !odooConfig.enabled || !odooConfig.url || !faturaId || faturaId <= 0) return;

  try {
    var xmlrpc = require('xmlrpc');
    var base = odooConfig.url.replace(/\/+$/, '');
    var host = base.replace('https://', '');
    var client = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });

    var uid = await new Promise(function(ok, fail) {
      client.methodCall('authenticate', [odooConfig.db, odooConfig.user, odooConfig.password, {}], function(e, r) {
        if (e || !r) return fail(e || new Error('Auth failed'));
        ok(r);
      });
    });

    var objClient = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });
    var htmlBody = '<b>⚠️ Emissão de Boleto BLOQUEADA</b><br/>' + (motivo || 'Boleto ativo encontrado');
    await new Promise(function(ok, fail) {
      objClient.methodCall('execute_kw', [odooConfig.db, uid, odooConfig.password, 'mail.message', 'create', [{
        model: 'account.move',
        res_id: faturaId,
        body: htmlBody,
        message_type: 'comment',
        subtype_xmlid: 'mail.mt_note',
      }]], function(e, r) {
        if (e) return fail(e);
        ok(r);
      });
    });
    console.log('[BOLETO-BLOCKED-CHATTER] Nota postada na fatura ' + faturaId);
  } catch (err) {
    console.warn('[BOLETO-BLOCKED-CHATTER] Erro ao postar chatter:', err.message);
  }
}

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

    // === DETECTAR PAGAMENTO PIX ===
    if (formaPag.trim().toUpperCase().indexOf('PIX') === 0) {
      return await handlePix(req, res, d);
    }

    var fat = d.fatura || {};
    var fatNameFromNested = fat.name || fat.seu_numero || '';
    var fatNameFromFlat = d.fatura_name || d.invoice_name || '';
    var faturaName = fatNameFromNested || fatNameFromFlat;
    var faturaId = (fat.id || d.fatura_id || d.invoice_id) ? parseInt(String(fat.id || d.fatura_id || d.invoice_id)) : 0;
    var valorTotal = parseFloat(fat.valor_nominal || d.fatura_valor) || 0;
    var dataVencBase = fat.data_vencimento || d.fatura_vencimento || '';

    var pag = d.pagador || {};

    var plano = parseFormaPagamento(formaPag);
    console.log('[API] Plano parsed:', JSON.stringify(plano));

    if (plano.tipo !== 'boleto' || plano.parcelas.length === 0) {
      return res.json({ success: false, message: 'Forma de pagamento nao suportada para boleto: ' + formaPag });
    }

    // === GUARDA: Verificar boleto ativo antes de emitir ===
    var boletoCheck = await checkBoletoAtivo(faturaId, faturaName);
    if (!boletoCheck.podeEmitir) {
      console.warn('[API/BOLETO] Boleto ativo encontrado. Bloqueando emissao.');
      // Postar chatter na fatura para rastreabilidade
      try { await postBoletoBlockedChatter(faturaId, boletoCheck.motivo); } catch(cErr) {}
      return res.json({ success: false, message: boletoCheck.motivo, nosso_numero: boletoCheck.nossoNumero });
    }

    // === DEDUPLICACAO: Lock anti-concorrencia boleto ===
    var boletoLockKey = getBoletoLockKey(faturaId, faturaName);

    // Se tem resultado cacheado (mesma fatura, menos de 90s atras), reusa
    if (_boletoCache[boletoLockKey]) {
      var boletoCached = _boletoCache[boletoLockKey];
      var boletoAge = Date.now() - boletoCached.timestamp;
      if (boletoAge < BOLETO_CACHE_TTL) {
        console.log('[API/BOLETO] REUSANDO resultado cacheado (' + (boletoAge / 1000).toFixed(1) + 's atras) para', boletoLockKey);
        return res.json(boletoCached.response);
      }
      delete _boletoCache[boletoLockKey];
    }

    // Se tem requisicao em curso, espera ela terminar
    if (_boletoLocks[boletoLockKey]) {
      console.log('[API/BOLETO] AGUARDANDO lock existente para', boletoLockKey);
      try {
        var boletoCachedResult = await _boletoLocks[boletoLockKey];
        console.log('[API/BOLETO] Lock liberado, retornando resultado da requisicao original');
        return res.json(boletoCachedResult);
      } catch (boletoLockErr) {
        console.log('[API/BOLETO] Requisicao original falhou, tentando novamente...');
      }
    }

    // Criar lock
    var boletoLockResolve;
    _boletoLocks[boletoLockKey] = new Promise(function(resolve) { boletoLockResolve = resolve; });

    // Auto-limpar lock apos TTL
    setTimeout(function() {
      if (_boletoLocks[boletoLockKey]) {
        console.warn('[API/BOLETO] Lock expirou por TTL para', boletoLockKey);
        delete _boletoLocks[boletoLockKey];
      }
    }, BOLETO_LOCK_TTL);

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

    var boletoResponseData = {
      success: true,
      data: {
        forma_pagamento: formaPag, total_parcelas: totalP,
        valor_total: valorTotal.toFixed(2),
        fatura_name: faturaName || '(nao informado)',
        fatura_id: faturaId || 0,
        pagamentos: pagamentos,
        odoo_push: pushResult.pushed ? 'OK_' + pushResult.attachments + '_attachments' : 'falhou_' + (pushResult.reason || 'unknown')
      }
    };

    // Cache resultado e liberar lock boleto
    _boletoCache[boletoLockKey] = { timestamp: Date.now(), response: boletoResponseData };
    delete _boletoLocks[boletoLockKey];
    if (boletoLockResolve) boletoLockResolve(boletoResponseData);

    res.json(boletoResponseData);

  } catch (e) {
    console.error('[API] ERRO:', e.message, e.stack);
    // Liberar lock boleto em caso de erro
    var errBolResponse = { success: false, message: e.message };
    delete _boletoLocks[boletoLockKey];
    if (boletoLockResolve) boletoLockResolve(errBolResponse);
    res.json(errBolResponse);
  }
});

// === Lock anti-concorrencia BOLETO ===
// Impede que o Odoo dispare multiplas requisicoes de boleto simultaneas pra mesma fatura
var _boletoLocks = {};   // faturaId/faturaName -> Promise (in-flight)
var _boletoCache = {};   // faturaId/faturaName -> { timestamp, response } (resultado recente)
var BOLETO_LOCK_TTL = 60000;  // 60s - tempo maximo de lock

// === ODOO-SIDE DEDUP (definitivo — sobrevive a restart do Render) ===
// Checa no Odoo se a fatura ja tem x_studio_itau_nosso_numero preenchido.
// Se sim, NAO emite novo boleto — evita triplicacao.
var xmlrpcDedup = require('xmlrpc');
async function checkOdooBoletoExists(faturaName, faturaId) {
  var oc = config.odoo;
  if (!oc || !oc.enabled || !oc.url) return null; // sem Odoo, nao pode checar
  try {
    var base = oc.url.replace(/\/+$/, '');
    var host = base.replace('https://', '').replace('http://', '');
    var common = xmlrpcDedup.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
    var models = xmlrpcDedup.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });

    var uid = await new Promise(function(ok, fail) {
      common.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, r) {
        if (e || !r) fail(e || new Error('auth failed')); else ok(r);
      });
    });

    // Search by name or ID
    var domain;
    if (faturaId && faturaId > 0) {
      domain = [['id', '=', faturaId]];
    } else if (faturaName) {
      domain = [['name', '=', faturaName], ['move_type', '=', 'out_invoice']];
    } else {
      return null;
    }

    var ids = await new Promise(function(ok, fail) {
      models.methodCall('execute_kw', [oc.db, uid, oc.password, 'account.move', 'search', [domain], {limit: 1}], function(e, r) {
        if (e) fail(e); else ok(r);
      });
    });

    if (!ids || !ids.length) return null;

    var records = await new Promise(function(ok, fail) {
      models.methodCall('execute_kw', [oc.db, uid, oc.password, 'account.move', 'read', [ids, ['x_studio_itau_nosso_numero', 'x_studio_boleto_cancelado']]], function(e, r) {
        if (e) fail(e); else ok(r);
      });
    });

    if (records && records[0]) {
      var nn = records[0].x_studio_itau_nosso_numero || '';
      var canceled = records[0].x_studio_boleto_cancelado || false;
      if (nn && !canceled) {
        console.log('[ODOO-DEDUP] Fatura ' + (faturaName || faturaId) + ' JA TEM boleto: NN=' + nn + ' — PULANDO emissao');
        return { nosso_numero: nn, id: records[0].id };
      }
    }
    return null; // no existing boleto
  } catch (err) {
    console.warn('[ODOO-DEDUP] Erro ao checar Odoo (nao bloqueia emissao):', err.message);
    return null;
  }
}
var BOLETO_CACHE_TTL = 120000; // 120s - reusa resultado se Odoo reenviar

/**
 * POST /api/v1/itau/gerar - Simplificado para Odoo Server Actions
 * COM dedup/lock: se a mesma fatura ja tem boleto emitido recentemente, reusa o resultado
 */
router.post('/gerar', async function(req, res) {
  var gerarBolLockKey = null;
  var gerarLockResolve = null;

  try {
    var formaPag = req.body.forma_pagamento || '';
    var fatName = req.body.fatura_name || '';
    var fatValor = parseFloat(req.body.fatura_valor) || 0;
    var fatVenc = req.body.fatura_vencimento || '';

    // === DEDUPLICACAO BOLETO: verificar se ja tem requisicao em curso ou resultado recente ===
    var isPix = formaPag.trim().toUpperCase().indexOf('PIX') === 0;
    if (!isPix && fatName) {
      var boletoLockKey = fatName;

      // === ODOO-SIDE DEDUP (definitivo — funciona mesmo apos restart do Render) ===
      var odooExisting = await checkOdooBoletoExists(fatName, 0);
      if (odooExisting) {
        console.log('[API/GERAR] ODOO-DEDUP: Fatura', fatName, 'ja tem boleto NN=' + odooExisting.nosso_numero + ' — PULANDO');
        var dedupResp = 'OK|0\nDEDUP|NN=' + odooExisting.nosso_numero;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(dedupResp);
      }

      // Se tem resultado cacheado (mesma fatura, menos de 120s atras), reusa
      if (_boletoCache[boletoLockKey]) {
        var cached = _boletoCache[boletoLockKey];
        var age = Date.now() - cached.timestamp;
        if (age < BOLETO_CACHE_TTL) {
          console.log('[API/GERAR] REUSANDO boleto cacheado (' + (age / 1000).toFixed(1) + 's atras) para', boletoLockKey);
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          return res.send(cached.response);
        }
        delete _boletoCache[boletoLockKey];
      }
      // Se tem requisicao em curso, espera ela terminar
      if (_boletoLocks[boletoLockKey]) {
        console.log('[API/GERAR] AGUARDANDO lock boleto existente para', boletoLockKey);
        try {
          var cachedResult = await _boletoLocks[boletoLockKey];
          console.log('[API/GERAR] Lock boleto liberado, retornando resultado da requisicao original');
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          return res.send(cachedResult);
        } catch (lockErr) {
          console.log('[API/GERAR] Requisicao boleto original falhou, tentando novamente...');
        }
      }
    }
    var pagNome = req.body.pagador_nome || '';
    var pagCpf = req.body.pagador_cpf || '';
    var pagStreet = req.body.pagador_street || '';
    var pagCity = req.body.pagador_city || '';
    var pagState = req.body.pagador_state || '';
    var pagZip = req.body.pagador_zip || '';
    var gerarFaturaId = parseInt(req.body.fatura_id || req.body.invoice_id) || 0;

    // Criar lock boleto (para dedup)
    var _boletoLockResolve;
    if (!isPix && fatName) {
      _boletoLocks[boletoLockKey] = new Promise(function(resolve) { _boletoLockResolve = resolve; });
    }

    // === PIX ===
    if (formaPag.trim().toUpperCase().indexOf('PIX') === 0) {
      console.log('[API/GERAR] PIX detectado:', formaPag, '| Valor:', fatValor);
      try {
        var devedor = buildDevedorFromDoc(pagNome, pagCpf);
        if (!devedor && pagNome) {
          console.warn('[API/GERAR] PIX: pagador com nome mas sem CPF/CNPJ valido, criando PIX sem devedor');
        }
        var pixResult = await criarCobrancaPix({
          valor: fatValor,
          devedor: devedor,
          solicitacaoPagador: fatName || '',
          expiracao: 86400, // 24h
        });
        var pixTxid = pixResult.txid || '';
        var pixCopiaCola = pixResult.pixCopiaECola || '';
        console.log('[API/GERAR] PIX criado: TXID=' + pixTxid);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send('OK|1\nTXID=' + pixTxid + '|PIX=' + pixCopiaCola + '|VD=' + fatValor.toFixed(2));
      } catch (pixErr) {
        console.error('[API/GERAR] PIX ERRO:', pixErr.message);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send('ERRO|PIX: ' + (pixErr.message || 'Erro desconhecido'));
      }
      return;
    }

    // === BOLETO ===
    var plano = parseFormaPagamento(formaPag);
    if (plano.tipo !== 'boleto' || plano.parcelas.length === 0) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('ERRO|Forma de pagamento nao suportada: ' + formaPag);
      return;
    }

    // === GUARDA: Verificar boleto ativo antes de emitir ===
    var boletoCheckGerar = await checkBoletoAtivo(gerarFaturaId, fatName);
    if (!boletoCheckGerar.podeEmitir) {
      console.warn('[API/GERAR] Boleto ativo encontrado. Bloqueando emissao.');
      // Postar chatter na fatura para rastreabilidade
      try { await postBoletoBlockedChatter(gerarFaturaId, boletoCheckGerar.motivo); } catch(cErr) {}
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send('ERRO|' + boletoCheckGerar.motivo);
      return;
    }

    // === DEDUPLICACAO: Lock anti-concorrencia boleto ===
    // (Antes so existia no /pagar; agora tambem no /gerar para evitar
    //  duplicacao por cliques multiplos no Odoo Server Action)
    gerarBolLockKey = getBoletoLockKey(gerarFaturaId, fatName);

    // Se tem resultado cacheado (mesma fatura, menos de 90s atras), reusa
    if (_boletoCache[gerarBolLockKey]) {
      var gerarCached = _boletoCache[gerarBolLockKey];
      var gerarAge = Date.now() - gerarCached.timestamp;
      if (gerarAge < BOLETO_CACHE_TTL) {
        console.log('[API/GERAR] REUSANDO resultado cacheado (' + (gerarAge / 1000).toFixed(1) + 's atras) para', gerarBolLockKey);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(gerarCached.response);
        return;
      }
      delete _boletoCache[gerarBolLockKey];
    }

    // Se tem requisicao em curso, espera ela terminar
    if (_boletoLocks[gerarBolLockKey]) {
      console.log('[API/GERAR] AGUARDANDO lock existente para', gerarBolLockKey);
      try {
        var gerarCachedResult = await _boletoLocks[gerarBolLockKey];
        console.log('[API/GERAR] Lock liberado, retornando resultado da requisicao original');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(gerarCachedResult);
        return;
      } catch (gerarLockErr) {
        console.log('[API/GERAR] Requisicao original falhou, tentando novamente...');
      }
    }

    // Criar lock
    _boletoLocks[gerarBolLockKey] = new Promise(function(resolve) { gerarLockResolve = resolve; });

    // Auto-limpar lock apos TTL
    setTimeout(function() {
      if (_boletoLocks[gerarBolLockKey]) {
        console.warn('[API/GERAR] Lock expirou por TTL para', gerarBolLockKey);
        delete _boletoLocks[gerarBolLockKey];
      }
    }, BOLETO_LOCK_TTL);

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

    var gerarResult = lines.join('\n');

    // Cache resultado e liberar lock
    _boletoCache[gerarBolLockKey] = { timestamp: Date.now(), response: gerarResult };
    delete _boletoLocks[gerarBolLockKey];
    if (gerarLockResolve) gerarLockResolve(gerarResult);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(gerarResult);
  } catch (e) {
    console.error('[API/GERAR] ERRO:', e.message);
    // Liberar lock em caso de erro
    var errGerarResult = 'ERRO|' + e.message;
    if (gerarBolLockKey) {
      delete _boletoLocks[gerarBolLockKey];
      if (gerarLockResolve) gerarLockResolve(errGerarResult);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(errGerarResult);
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

// === PIX: handler para /pagar ===
async function handlePix(req, res, d) {
  var fat = d.fatura || {};
  var faturaName = fat.name || fat.seu_numero || d.fatura_name || '';
  var faturaId = (fat.id || d.fatura_id) ? parseInt(String(fat.id || d.fatura_id)) : 0;
  var valorTotal = parseFloat(fat.valor_nominal || d.fatura_valor) || 0;
  var pag = d.pagador || {};
  var pagNome = pag.nome || d.pagador_nome || '';
  var pagCpf = pag.cpf_cnpj || d.pagador_cpf || '';

  console.log('[API/PIX] Fatura:', faturaName, '| Valor:', valorTotal);

  if (valorTotal <= 0) {
    return res.json({ success: false, message: 'Valor invalido para PIX' });
  }

  // === DEDUPLICACAO: verificar se ja tem requisicao em curso ou resultado recente ===
  var lockKey = getPixLockKey(faturaId, faturaName);

  // Se tem resultado cacheado (mesma fatura, menos de 60s atras), reusa
  if (_pixCache[lockKey]) {
    var cached = _pixCache[lockKey];
    var age = Date.now() - cached.timestamp;
    if (age < PIX_CACHE_TTL) {
      console.log('[API/PIX] REUSANDO resultado cacheado (' + (age / 1000).toFixed(1) + 's atras) para', lockKey);
      return res.json(cached.response);
    }
    delete _pixCache[lockKey];
  }

  // Se tem requisicao em curso, espera ela terminar
  if (_pixLocks[lockKey]) {
    console.log('[API/PIX] AGUARDANDO lock existente para', lockKey);
    try {
      var cachedResult = await _pixLocks[lockKey];
      console.log('[API/PIX] Lock liberado, retornando resultado da requisicao original');
      return res.json(cachedResult);
    } catch (lockErr) {
      console.log('[API/PIX] Requisicao original falhou, tentando novamente...');
    }
  }

  // Criar lock
  var lockResolve;
  _pixLocks[lockKey] = new Promise(function(resolve) { lockResolve = resolve; });

  // Auto-limpar lock apos TTL
  setTimeout(function() {
    if (_pixLocks[lockKey]) {
      console.warn('[API/PIX] Lock expirou por TTL para', lockKey);
      delete _pixLocks[lockKey];
    }
  }, PIX_LOCK_TTL);

  try {
    var devedor = buildDevedorFromDoc(pagNome, pagCpf);
    if (!devedor && pagNome) {
      console.warn('[API/PIX] Pagador com nome mas sem CPF/CNPJ valido, criando PIX sem devedor');
    }
    var pixResult = await criarCobrancaPix({
      valor: valorTotal,
      devedor: devedor,
      solicitacaoPagador: faturaName || '',
      expiracao: 86400,
    });

    console.log('[API/PIX] PIX criado: TXID=' + (pixResult.txid || 'N/A'));

    var pixCopiaCola = pixResult.pixCopiaECola || '';
    var qrcodeBase64 = '';
    var htmlPix = '';

    // Gerar QR code a partir do pixCopiaECola (bwip-js v4 e async)
    if (pixCopiaCola) {
      try {
        var qrPng = await bwipjs.toBuffer({
          bcid: 'qrcode',
          text: pixCopiaCola,
          scale: 5,
          width: 12,
          height: 12,
        });
        qrcodeBase64 = 'data:image/png;base64,' + qrPng.toString('base64');
        console.log('[API/PIX] QR code gerado:', (qrPng.length / 1024).toFixed(1) + 'KB');
      } catch (qrErr) {
        console.error('[API/PIX] Erro ao gerar QR code:', qrErr.message);
      }
    }

    // Montar HTML para o campo Odoo
    var valorFmt = 'R$ ' + valorTotal.toFixed(2).replace('.', ',');
    htmlPix = '<div style="text-align:center; font-family:Arial,sans-serif; padding:10px;">' +
      '<div style="font-size:18px; font-weight:bold; color:#333; margin-bottom:8px;">PIX</div>' +
      '<div style="font-size:14px; color:#666; margin-bottom:12px;">' + faturaName + ' - ' + valorFmt + '</div>' +
      (qrcodeBase64 ? '<img src="' + qrcodeBase64 + '" style="width:200px; height:200px; margin:0 auto 12px auto; display:block;" />' : '') +
      (pixCopiaCola ? '<div style="font-size:10px; color:#999; word-break:break-all; max-width:400px; margin:0 auto; line-height:1.4;">' + pixCopiaCola + '</div>' : '') +
      '</div>';

    // Montar responseData ANTES do push (responde pro Odoo imediatamente)
    var responseData = {
      success: true,
      data: {
        forma_pagamento: 'PIX',
        total_parcelas: 1,
        valor_total: valorTotal.toFixed(2),
        fatura_name: faturaName || '(nao informado)',
        fatura_id: faturaId || 0,
        pagamentos: [{
          tipo: 'pix',
          parcela: 1,
          total_parcelas: 1,
          valor_titulo: valorTotal.toFixed(2),
          txid: pixResult.txid || '',
          pix_copia_cola: pixCopiaCola,
          qrcode_base64: qrcodeBase64,
          html_pix: htmlPix,
        }],
        odoo_push: 'pending',
      },
    };

    // Cache resultado e liberar lock
    _pixCache[lockKey] = { timestamp: Date.now(), response: responseData };
    delete _pixLocks[lockKey];
    lockResolve(responseData);

    // Responde pro Odoo IMEDIATAMENTE (o modulo Odoo grava os campos)
    res.json(responseData);
  } catch (err) {
    console.error('[API/PIX] ERRO:', err.message);
    var errResponse = { success: false, message: 'Erro ao criar PIX: ' + (err.message || 'Erro desconhecido') };
    delete _pixLocks[lockKey];
    lockResolve(errResponse);
    res.json(errResponse);
  }
}

// === PIX: consultar status ===
router.get('/pix/status/:txid', async function(req, res) {
  try {
    var txid = req.params.txid;
    console.log('[API/PIX-STATUS] Consultando:', txid);
    var resultado = await consultarCobrancaPix(txid);
    var status = resultado.status || 'ATIVA';
    var pago = status === 'CONCLUIDA';
    res.json({
      success: true,
      txid: txid,
      status: status,
      situacao: pago ? 'pago' : 'pendente',
      valor: resultado.valor ? resultado.valor.original : null,
      pixCopiaECola: resultado.pixCopiaECola || '',
    });
  } catch (err) {
    console.error('[API/PIX-STATUS] ERRO:', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// === CANCELAR BOLETO ===
// POST /api/v1/itau/cancelar
// Body: { nosso_numero: string }
// Cancela um boleto no Itau (baixa por cancelamento)
router.post('/cancelar', apiKeyAuth, async function(req, res) {
  try {
    var nn = req.body.nosso_numero || '';
    if (!nn) {
      return res.status(400).json({ success: false, message: 'nosso_numero obrigatorio' });
    }
    console.log('[API/CANCELAR] Cancelando boleto NN:', nn);
    var resultado = await cancelarBoleto(nn);
    res.json({ success: true, message: 'Boleto cancelado com sucesso', dados: resultado.dados, metodo: resultado.metodo, idBoleto: resultado.idBoleto || undefined });
  } catch (err) {
    console.error('[API/CANCELAR] ERRO:', err.message);
    // Retorna detalhes do erro para diagnostico
    res.status(500).json({ success: false, message: 'Erro ao cancelar boleto: ' + err.message, hint: 'Cash Management API pode requerer credenciais separadas (clientId/cert) distintas do BoleCode/PIX. Verifique com o Itau se o escopo cash_management esta habilitado no seu registro.' });
  }
});

// GET /api/v1/itau/cancelar/web?odoo_id=XXX
// Le resposta_json do Odoo, cancela boletos no Itau, posta resultado no chatter e redireciona de volta
router.get('/cancelar/web', async function(req, res) {
  var odooId = req.query.odoo_id || '';
  var oc = config.odoo;
  var returnUrl = (oc && oc.url ? oc.url.replace(/\/+$/, '') : '') + '/web#id=' + odooId + '&model=account.move&view_type=form';

  function odooRpc(model, method, args, kwargs) {
    var xmlrpc = require('xmlrpc');
    var base = oc.url.replace(/\/+$/, '');
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
      await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style="color:red">Fatura nao possui dados de boleto.</span>');
      return res.redirect(returnUrl);
    }

    var jsonStr = rawJson.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null');
    var data = JSON.parse(jsonStr);
    var pagamentos = data.pagamentos || [];
    if (pagamentos.length === 0) {
      await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style="color:red">Nenhum pagamento encontrado.</span>');
      return res.redirect(returnUrl);
    }
    for (var i = 0; i < pagamentos.length; i++) {
      if (pagamentos[i].nosso_numero) nossoNumeros.push(pagamentos[i].nosso_numero);
    }
    if (nossoNumeros.length === 0) {
      await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style="color:red">Nenhum nosso numero encontrado.</span>');
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
      chatBody += '<span style="color:green">' + sucesso + ' boleto(s) cancelado(s) com sucesso no Itau.</span>';
    } else if (sucesso === 0) {
      chatBody += '<span style="color:red">Falha ao cancelar todos os boletos:</span><br/>';
      for (var i = 0; i < resultados.length; i++) chatBody += 'NN ' + resultados[i].nn + ': ' + resultados[i].erro + '<br/>';
    } else {
      chatBody += '<span style="color:orange">' + sucesso + ' cancelado(s), ' + falha + ' falha(s):</span><br/>';
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
    try { await postChatter(odooId, '<b>Cancelar Boleto</b><br/><span style="color:red">Erro: ' + err.message + '</span>'); } catch(e) {}
    res.redirect(returnUrl);
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

// ============================================================
// EXTRATO BANCARIO — Importacao para Odoo
// ============================================================

// POST /api/v1/itau/extrato/importar
// Body: { data_inicial?: "YYYY-MM-DD", data_final?: "YYYY-MM-DD" }
// Se nao informar, busca ontem (D-1)
router.post('/extrato/importar', async function(req, res) {
  try {
    var ontem = new Date(Date.now() - 24 * 3600000);
    var di = req.body.data_inicial || ontem.toISOString().substring(0, 10);
    var df = req.body.data_final || di;

    console.log('[EXTRATO-IMPORT] Buscando extrato: ' + di + ' ate ' + df);
    var transacoes = await buscarExtratoNormalizado(di, df);

    if (!transacoes.length) {
      return res.json({ success: true, message: 'Extrato vazio (' + di + ' a ' + df + ')', transacoes: 0 });
    }

    // Cria o extrato no Odoo
    var resultado = await criarExtrato(df, transacoes);

    res.json({
      success: true,
      message: transacoes.length + ' transacoes importadas para o diario ' + resultado.journalName,
      transacoes: transacoes.length,
      saldo: resultado.balance,
      statement_id: resultado.statementId,
    });
  } catch (err) {
    console.error('[EXTRATO-IMPORT] ERRO:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao importar extrato: ' + err.message });
  }
});

// GET /api/v1/itau/extrato/preview
// Preview do extrato (nao cria no Odoo)
router.get('/extrato/preview', async function(req, res) {
  try {
    var di = req.query.data_inicial || new Date(Date.now() - 24 * 3600000).toISOString().substring(0, 10);
    var df = req.query.data_final || di;

    var transacoes = await buscarExtratoNormalizado(di, df);
    res.json({ success: true, data_inicial: di, data_final: df, transacoes: transacoes });
  } catch (err) {
    console.error('[EXTRATO-PREVIEW] ERRO:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao buscar extrato: ' + err.message });
  }
});

// GET /api/v1/itau/extrato/cron — Chamada diaria automatica
// Protegido por secret separado (CRON_SECRET)
router.get('/extrato/cron', async function(req, res) {
  var cronSecret = process.env.ODOO_BANK_STATEMENT_IMPORT_CRON_SECRET || '';
  if (!cronSecret || req.query.secret !== cronSecret) {
    return res.status(403).json({ success: false, message: 'Secret invalido' });
  }

  try {
    var ontem = new Date(Date.now() - 24 * 3600000);
    var di = ontem.toISOString().substring(0, 10);
    var df = di;

    console.log('[EXTRATO-CRON] Execucao automatica diaria: ' + di);
    var transacoes = await buscarExtratoNormalizado(di, df);

    if (!transacoes.length) {
      console.log('[EXTRATO-CRON] Nenhuma transacao em ' + di);
      return res.json({ success: true, message: 'Extrato vazio', transacoes: 0 });
    }

    var resultado = await criarExtrato(df, transacoes);
    console.log('[EXTRATO-CRON] Extrato criado: ' + resultado.statementId + ' (' + transacoes.length + ' linhas)');

    res.json({ success: true, transacoes: transacoes.length, statement_id: resultado.statementId, saldo: resultado.balance });
  } catch (err) {
    console.error('[EXTRATO-CRON] ERRO:', err.message);
    res.status(500).json({ success: false, message: 'Erro cron extrato: ' + err.message });
  }
});

module.exports = router;