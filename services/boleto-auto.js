/**
 * services/boleto-auto.js — AUTO-BOLETO NA EMISSAO DA NF
 * ======================================================
 * Demanda AJL 22/10/2026: "ao emitir NF-e já emitir o(s) boleto(s) também".
 * O numero da fatura no Odoo é o numero da NF e é o numero que vai no boleto
 * (seu_numero), então quando a NF-e é AUTORIZADA disparamos na sequencia a
 * emissao dos boletos Itau na fatura.
 *
 * COMO: reusa o MESMO fluxo do botao manual do financeiro (POST
 * /api/v1/itau/pagar via self-call HTTP com a propria API key) — assim:
 *   - parse da forma de pagamento (BOLETO 30/60/90, Nx, NN DD, ENTRADA+PARCELADO...)
 *   - entrada + parcelamento E+P (valores/data configurados pelo financeiro)
 *   - guardas anti-duplicidade (checkBoletoAtivo + dedup x_studio_itau_nosso_numero)
 *   - PDFs por parcela + push Odoo (anexos na fatura + HTML no pedido)
 *   - lock anti-concorrencia contra cliques manuais simultaneos
 * A emissao MANUAL de boletos continua funcionando normalmente (demanda explicita).
 *
 * SEGURANCA:
 *   - fire-and-forget: a falha do boleto NUNCA derruba a NF (ja autorizada);
 *     o resultado (ou erro) vai como nota no chatter da fatura.
 *   - kill-switch: env AUTO_BOLETO_NF=off desativa sem deploy de codigo novo.
 *   - so dispara para forma de pagamento do tipo BOLETO (parseFormaPagamento);
 *     PIX/cartao/entrega/a vista nao geram boleto no Itau (comportamento atual).
 *   - se a fatura JA tem boleto ativo (nosso numero preenchido, nao cancelado),
 *     pula — o botao manual segue como reemissao (cancelar -> emitir).
 */

var axios = require('axios');
var config = require('../config');
var { parseFormaPagamento } = require('./itau-boleto');

var SELF_HOST = '127.0.0.1';
var AUTO_DELAY_MS = 1500;     // deixa o chatter da NF terminar antes de comecar
var CALL_TIMEOUT_MS = 240000; // ate ~8 boletos com PDF + push Odoo

/** URL publica para links de PDF no chatter (o self-call e interno 127.0.0.1). */
function publicBaseUrl() {
  return process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL ||
    ('http://127.0.0.1:' + config.port);
}

/**
 * True quando a forma de pagamento da fatura resulta em BOLETO(S) Itau.
 * Usa o MESMO parser do /pagar (fonte unica de verdade) + filtro semantico:
 * formas que citam outro metodo (PIX, cartao, deposito, entrega...) nao geram
 * boleto automatico, mesmo que o parser historico as trate como parcela.
 * Vazio = comportamento historico (PIX a vista) -> sem boleto.
 */
function deveEmitirBoletoAuto(formaPagamento) {
  var forma = String(formaPagamento || '').trim();
  if (!forma) return false;
  var up = forma.toUpperCase();
  var plano;
  try {
    plano = parseFormaPagamento(forma);
  } catch (e) {
    return false;
  }
  if (!plano || plano.tipo !== 'boleto' || !plano.parcelas || !plano.parcelas.length) return false;
  // Forma menciona boleto explicitamente (ou ENTRADA+PARCELADO): segue o /pagar
  var mencionaBoleto = up.indexOf('BOLETO') >= 0 || up.indexOf('BOL ') >= 0 ||
    (up.indexOf('ENTRADA') >= 0 && up.indexOf('PARCEL') >= 0);
  if (mencionaBoleto) return true;
  // Sem mencao a boleto: so auto-emite se a forma NAO citar outro metodo
  // (ex: "DEPOSITO 24H" e "TRANSFERENCIA 7" eram tratados como boleto pelo
  // parser numerico — mas nao sao boleto semantico)
  var citaOutro = /PIX|CART|CRED|DEB|ENTREGA|DEPOSITO|DEP\b|TRANSFER|DIN|CHEQUE|ESPECIE/.test(up);
  return !citaOutro;
}

/**
 * Agenda (fire-and-forget) a emicao de boletos da fatura recem-autorizada.
 * @param {Object} ctx {
 *   moveId, faturaName (nome FINAL 'NFe NNNNNNNN'), formaPagamento,
 *   valorNF (vNF fiscal calculada no middleware),
 *   dataVencBase (vencimento da 1a parcela / data da fatura),
 *   pagador: { nome, cpf_cnpj, street, city, state, zip },
 *   boletoJaExiste (bool — fatura ja tinha boleto ativo),
 *   postChatter: async fn(htmlBody) para notificar na fatura
 * }
 */
function agendarBoletosAutomaticos(ctx) {
  if (String(process.env.AUTO_BOLETO_NF || '').toLowerCase() === 'off') {
    console.log('[BOLETO-AUTO] desativado por AUTO_BOLETO_NF=off');
    return;
  }
  if (!ctx || !ctx.moveId) return;

  var forma = String(ctx.formaPagamento || '').trim();
  if (!deveEmitirBoletoAuto(forma)) {
    console.log('[BOLETO-AUTO] fatura ' + ctx.moveId + ': forma "' + forma +
      '" nao gera boleto — auto-boleto nao aplicado');
    return;
  }
  if (ctx.boletoJaExiste) {
    console.log('[BOLETO-AUTO] fatura ' + ctx.moveId + ': JA tem boleto ativo — pulando (manual segue disponivel)');
    return;
  }
  if (!ctx.pagador || !String(ctx.pagador.cpf_cnpj || '').replace(/\D/g, '')) {
    console.warn('[BOLETO-AUTO] fatura ' + ctx.moveId + ': pagador sem CPF/CNPJ — pulando (Itau exige)');
    if (ctx.postChatter) {
      ctx.postChatter(
        '<b>Boletos (auto):</b> nao emitidos — cliente sem CPF/CNPJ no cadastro.<br/>' +
        '<i>Corrija o cadastro e use o botao de boleto manual.</i>'
      ).catch(function() {});
    }
    return;
  }

  console.log('[BOLETO-AUTO] NF autorizada -> agendando boletos em ' + AUTO_DELAY_MS + 'ms | fatura ' +
    (ctx.faturaName || ctx.moveId) + ' | forma: ' + forma);

  setTimeout(function() {
    emitirBoletosAuto(ctx).catch(function(e) {
      console.error('[BOLETO-AUTO] erro inesperado fora do fluxo:', e.message);
    });
  }, AUTO_DELAY_MS);
}

async function emitirBoletosAuto(ctx) {
  var t0 = Date.now();
  var faturaName = ctx.faturaName || String(ctx.moveId);
  var base = 'http://' + SELF_HOST + ':' + config.port + '/api/v1/itau/pagar';
  var body = {
    forma_pagamento: ctx.formaPagamento,
    fatura: {
      id: ctx.moveId,
      name: faturaName,
      valor_nominal: ctx.valorNF || 0,
      data_vencimento: ctx.dataVencBase || '',
    },
    pagador: {
      nome: ctx.pagador.nome || '',
      cpf_cnpj: ctx.pagador.cpf_cnpj || '',
      street: ctx.pagador.street || '',
      city: ctx.pagador.city || '',
      state: ctx.pagador.state || '',
      zip: ctx.pagador.zip || '',
    },
    _origem: 'auto-boleto-nf', // marcador de rastreio (ignorado pelo /pagar)
  };

  console.log('[BOLETO-AUTO] chamando /pagar interno para fatura ' + faturaName + '...');
  var resp;
  try {
    resp = await axios.post(base, body, {
      headers: { 'X-API-Key': config.middlewareApiKey, 'Content-Type': 'application/json' },
      timeout: CALL_TIMEOUT_MS,
      validateStatus: function() { return true; }, // /pagar responde JSON mesmo em erro
    });
  } catch (eHttp) {
    var msgHttp = 'falha HTTP interna: ' + (eHttp.message || eHttp);
    console.error('[BOLETO-AUTO] ' + msgHttp);
    await chatterFalha(ctx, faturaName, msgHttp);
    return;
  }

  var data = (resp.data && typeof resp.data === 'object') ? resp.data : {};
  if (!data.success) {
    var motivo = data.message || ('HTTP ' + resp.status);
    // Bloqueio por boleto ja existente nao é erro — informa como "já tinha"
    var jaTem = String(motivo).toLowerCase().indexOf('cancele') >= 0 ||
      String(motivo).toLowerCase().indexOf('cancelar o boleto') >= 0;
    console.warn('[BOLETO-AUTO] /pagar nao emitiu (' + (jaTem ? 'boleto ja existente' : 'erro') + '): ' + motivo);
    if (!jaTem) await chatterFalha(ctx, faturaName, motivo);
    else await chatterInfo(ctx, '<b>Boletos (auto):</b> a fatura ja possui boleto ativo — nada emitido.');
    return;
  }

  var d = data.data || {};
  var pags = d.pagamentos || [];
  var pub = publicBaseUrl();
  var linhas = [];
  for (var i = 0; i < pags.length; i++) {
    var p = pags[i];
    var pdfUrl = (p.pdf_url_txid || '').replace(/^https?:\/\/127\.0\.0\.1:\d+/, pub);
    linhas.push(
      'Boleto ' + (p.parcela || (i + 1)) + '/' + (p.total_parcelas || pags.length) +
      ' — NN ' + (p.nosso_numero || '?') +
      ' — R$ ' + (p.valor_titulo || '?') +
      ' — venc. ' + (p.data_vencimento || '?') +
      (p.linha_digitavel ? '<br/>&nbsp;&nbsp;Linha: <code>' + p.linha_digitavel + '</code>' : '') +
      (pdfUrl ? ' — <a href="' + pdfUrl + '">PDF</a>' : '')
    );
  }
  var html =
    '<b>Boletos emitidos automaticamente junto com a NF (' + pags.length + ')</b><br/>' +
    linhas.join('<br/>') +
    (d.aviso_config ? '<br/><b style="color:#b45309">Aviso: ' + String(d.aviso_config).replace(/</g, '&lt;') + '</b>' : '') +
    '<br/><i>Forma: ' + (d.forma_pagamento || ctx.formaPagamento) +
    ' | Odoo: ' + (d.odoo_push || 'n/d') + ' | ' + ((Date.now() - t0) / 1000).toFixed(1) + 's</i>';
  console.log('[BOLETO-AUTO] OK: ' + pags.length + ' boleto(s) em ' + (Date.now() - t0) + 'ms | push Odoo: ' + (d.odoo_push || 'n/d'));
  await chatterInfo(ctx, html);
}

async function chatterInfo(ctx, html) {
  try {
    if (ctx.postChatter) await ctx.postChatter(html);
  } catch (e) {
    console.warn('[BOLETO-AUTO] chatter falhou (nao critico): ' + e.message);
  }
}

async function chatterFalha(ctx, faturaName, motivo) {
  await chatterInfo(ctx,
    '<b>Boletos (auto): NAO emitidos</b><br/>' +
    'Motivo: ' + String(motivo || '?').replace(/</g, '&lt;').slice(0, 400) + '<br/>' +
    '<i>A NF foi autorizada normalmente. Use a opcao manual de boletos na fatura ' + faturaName + '.</i>'
  );
}

module.exports = { agendarBoletosAutomaticos, deveEmitirBoletoAuto, publicBaseUrl };
