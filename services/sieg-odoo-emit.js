/**
 * services/sieg-odoo-emit.js v2.0.0
 * =============================================
 * Processa emissoes pendentes de NF-e/NFS-e via polling Odoo XML-RPC.
 * 
 * CAMPOS USADOS (existentes no Odoo do cliente):
 *   account.move:
 *     x_studio_nfe_status     (Selection: vazio, pendente, processando, autorizada, erro)
 *     x_studio_nfe_chave      (Char)
 *     x_studio_nfe_protocolo  (Char)
 *     x_studio_nfse_numero    (Char)
 *     x_studio_nfse_status    (Selection: vazio, pendente, processando, autorizada, erro)
 *   res.company:
 *     x_studio_sieg_ultimo_nfe  (Integer)
 *     x_studio_sieg_ultimo_nfse (Integer)
 *     x_studio_sieg_serie_nfe   (Char, default 100)
 *     x_studio_sieg_serie_nfse  (Char, default 1)
 *   product.product:
 *     x_studio_c_trib_nac       (Char) — Codigo tributo nacional (NFS-e)
 *     x_studio_c_nbs            (Char) — Codigo NBS (NFS-e)
 *     x_studio_aliquota_iss    (Char) — Aliquota ISS (NFS-e)
 *     x_studio_ibge_code       (Char) — Codigo IBGE municipio
 *
 * Chatter: apos emissao, XML + PDF (DANFE/DANFSE) aparecem como anexos.
 */

var xmlrpc = require('xmlrpc');
var { emitirNota } = require('./sieg-api');
var config = require('../config');
var { IeService } = require('./ie.service');
var ibgeMunicipios = require('./ibge-municipios');
var _ieService = new IeService();

// ============================================================
// Helpers numéricos
// ============================================================
// round2: arredonda para 2 casas (usado no calculo de vNF/vIPI).
// Ja existia em sieg-nfe-xml.js mas NAO era definido aqui — commit 5fc180f
// passou a chamar round2() neste modulo sem importa-lo (ReferenceError).
function round2(n) {

  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

// ============================================================
// buildPagamentoInfo — Forma de pagamento da NF-e
// ============================================================
// Fonte da verdade: campo x_studio_forma_de_pagamento da fatura
// (fallback: pedido de venda). Mapeia o texto do campo para:
//   - pagamentos[]  : { indPag, tPag, vPag }  (NF-e 4.00)
//       indPag: 0 = a vista, 1 = a prazo
//       tPag:   01 dinheiro, 02 cheque, 03 cartao credito, 04 cartao debito,
//               13 boleto bancario, 14 deposito, 15 PIX, 16 transferencia,
//               99 outros
//   - duplicatas[]  : { dVenc (YYYY-MM-DD), vDup } — parcelas (a prazo)
//   - boletoDetalhes[] : texto rico p/ infCpl (parcela, valor, venc, NN, LD)
// Regras:
//   * PIX / a vista -> indPag 0, sem duplicatas
//   * BOLETO 28/56/84 -> 3 parcelas com venc = emissao + 28/56/84 dias
//   * BOLETO 30D / BOLETO 7 DIAS / BOLETO 15DD -> 1 parcela (+N dias)
//   * BOLETO 8X / 10X / 12X -> N parcelas mensais (30 em 30 dias)
//   * Vencimentos/valores da invoice (payment_term lines) tem PRIORIDADE
//     quando existem (>1 parcela real na fatura); valores sao reescalonados
//     para bater com vNF (fiscal), nunca com o total contabil do Odoo.
function buildPagamentoInfo(opts) {
  var forma = String(opts.forma || '').trim();
  var formaUp = forma.toUpperCase();
  var vNF = round2(opts.vNF || 0);
  var parcelasFatura = opts.parcelasFatura || [];
  var dataBase = opts.dataBase || '';
  var itauBoletos = opts.itauBoletos || [];

  function addDays(isoDate, days) {
    var d = isoDate ? new Date(isoDate + 'T12:00:00Z') : new Date();
    if (isNaN(d.getTime())) d = new Date();
    d.setUTCDate(d.getUTCDate() + (parseInt(days) || 0));
    return d.toISOString().slice(0, 10);
  }
  function splitValores(total, n) {
    // Divide total em n parcelas com ajuste de centavos na ultima
    var out = [];
    var base = Math.floor((total / n) * 100) / 100;
    var acumulado = 0;
    for (var i = 0; i < n; i++) {
      if (i < n - 1) {
        out.push(base);
        acumulado = Math.round((acumulado + base) * 100) / 100;
      } else {
        out.push(Math.round((total - acumulado) * 100) / 100);
      }
    }
    return out;
  }

  var pagamentos = [];
  var duplicatas = [];
  var boletoDetalhes = [];
  var formaLabel = 'Pagamento a vista';

  // --- Detecao do tipo de pagamento pelo texto do campo ---
  var tipoPag = 'avista';
  if (formaUp.indexOf('PIX') >= 0) tipoPag = 'pix';
  else if (formaUp.indexOf('BOLETO') >= 0 || formaUp.indexOf('BOL ') >= 0) tipoPag = 'boleto';
  else if (formaUp.indexOf('CHEQUE') >= 0) tipoPag = 'cheque';
  else if (formaUp.indexOf('DÉBITO') >= 0 || formaUp.indexOf('DEBITO') >= 0 || formaUp.indexOf('DÉB') >= 0 || formaUp.indexOf('DEB') >= 0) tipoPag = 'debito';
  else if (formaUp.indexOf('CRÉDITO') >= 0 || formaUp.indexOf('CREDITO') >= 0 || formaUp.indexOf('CRÉD') >= 0 || formaUp.indexOf('CRED') >= 0 || formaUp.indexOf('VISA') >= 0 || formaUp.indexOf('MASTER') >= 0 || formaUp.indexOf('ELO') >= 0 || formaUp.indexOf('AMEX') >= 0 || formaUp.indexOf('HIPERCARD') >= 0) tipoPag = 'credito';
  else if (formaUp.indexOf('DEPOSITO') >= 0 || formaUp.indexOf('DEP ') >= 0 || formaUp.indexOf('DEP+') >= 0) tipoPag = 'deposito';
  else if (formaUp.indexOf('TRANSFER') >= 0) tipoPag = 'transferencia';
  else if (formaUp.indexOf('DIN') >= 0) tipoPag = 'dinheiro';
  else if (formaUp.indexOf('A VISTA') >= 0) tipoPag = 'avista';

  // Compatibilidade: fatura SEM forma de pagamento -> mantém o comportamento
  // historico do middleware (tPag 15 = PIX, a vista, infCpl "Pagamento a vista").
  if (!forma) tipoPag = 'pix';

  var tPag = { avista: '01', pix: '15', boleto: '13', cheque: '02', credito: '03', debito: '04', deposito: '14', transferencia: '16', dinheiro: '01' }[tipoPag] || '99';

  // --- Parcelas: dias/meses declarados na forma ---
  var parcelas = [];
  if (tipoPag === 'boleto') {
    // BOLETO 28/56/84 | BOLETO 30/60/90 | 1+28/42/56 | 15/30/45DD ...
    var numsMatch = formaUp.match(/(\d{1,3}(?:\s*\/\s*\d{1,3})+)/);
    // BOLETO 8X / 10X / 12X (parcelas mensais)
    var nxMatch = formaUp.match(/(\d{1,2})\s*X\b/);
    // BOLETO 30D | BOLETO 7 DIAS | BOLETO 15DD | BOLETO 21DD ...
    var dMatch = formaUp.match(/(\d{1,3})\s*(?:D|DD|DIAS|DIA)\b/);

    if (numsMatch && !nxMatch) {
      var parts = numsMatch[1].split(/\s*\/\s*/);
      var temEntrada = /^\s*1\s*\+/.test(formaUp);
      for (var pi = 0; pi < parts.length; pi++) {
        var dias = parseInt(parts[pi].replace(/\D/g, '')) || 0;
        if (dias > 0) parcelas.push(dias);
      }
      if (temEntrada && parcelas.length) parcelas.unshift(0); // entrada no dia
    } else if (nxMatch) {
      var nVezes = Math.min(parseInt(nxMatch[1]) || 1, 36);
      for (var ni = 1; ni <= nVezes; ni++) parcelas.push(ni * 30);
    } else {
      // "1 + 30 BOLETO" -> entrada (dia 0) + boleto em N dias
      var entradaMatch = formaUp.match(/^\s*1\s*\+\s*(\d{1,3})/);
      var dMatch2 = formaUp.match(/(\d{1,3})\s*(?:D|DD|DIAS|DIA)\b/);
      if (entradaMatch) {
        parcelas.push(0);
        parcelas.push(parseInt(entradaMatch[1]) || 0);
      } else if (dMatch2) {
        parcelas.push(parseInt(dMatch2[1]) || 0);
      } else {
        parcelas.push(0); // boleto a vista
      }
    }
  }

  // --- Valor e vencimento de cada parcela ---
  var valores = [];
  var vencimentos = [];
  if (tipoPag === 'boleto') {
    var n = Math.max(parcelas.length, 1);
    if (parcelasFatura.length === n && n >= 1) {
      // Fatura tem as N parcelas reais -> usar vencimentos da invoice,
      // valores reescalonados para o vNF fiscal
      var somaFatura = 0;
      for (var fi = 0; fi < parcelasFatura.length; fi++) somaFatura += parcelasFatura[fi].valor;
      if (somaFatura > 0 && Math.abs(somaFatura - vNF) > 0.02) {
        valores = splitValores(vNF, n);
      } else {
        for (var fv = 0; fv < parcelasFatura.length; fv++) valores.push(round2(parcelasFatura[fv].valor));
      }
      for (var fv2 = 0; fv2 < parcelasFatura.length; fv2++) vencimentos.push(parcelasFatura[fv2].vencimento || addDays(dataBase, parcelas[fv2] || 0));
    } else {
      valores = splitValores(vNF, n);
      for (var pv = 0; pv < parcelas.length; pv++) vencimentos.push(addDays(dataBase, parcelas[pv]));
    }
    formaLabel = forma || 'Boleto bancário';
  } else {
    // A vista / PIX / cartao / etc: 1 pagamento no valor total
    valores = [vNF];
    vencimentos = [(parcelasFatura.length ? parcelasFatura[0].vencimento : '') || addDays(dataBase, 0)];
    formaLabel = forma || ({ pix: 'Pagamento a vista (PIX)', avista: 'Pagamento a vista', dinheiro: 'Pagamento a vista (dinheiro)', cheque: 'Pagamento em cheque', credito: 'Pagamento com cartão de crédito', debito: 'Pagamento com cartão de débito', deposito: 'Pagamento por depósito', transferencia: 'Pagamento por transferência' }[tipoPag] || 'Pagamento a vista');
  }

  var indPag = (valores.length > 1 || (tipoPag === 'boleto' && parseInt(parcelas[0] || 0) > 0)) ? '1' : '0';

  for (var pg = 0; pg < valores.length; pg++) {
    pagamentos.push({
      indPag: indPag,
      tPag: tPag,
      vPag: valores[pg].toFixed(2),
    });
    // Duplicatas somente para pagamentos a prazo (boleto com dias/parcelas).
    // A vista / PIX / cartao NAO tem cobr/dup.
    if (tipoPag === 'boleto') {
      duplicatas.push({
        dVenc: vencimentos[pg] || '',
        vDup: valores[pg].toFixed(2),
      });
    }
  }

  // --- boletoDetalhes p/ infCpl (texto rico) ---
  if (tipoPag === 'boleto') {
    for (var bd = 0; bd < valores.length; bd++) {
      var det = {
        parcela: String(bd + 1) + '/' + String(valores.length),
        valor: valores[bd].toFixed(2),
        vencimento: vencimentos[bd] || '',
        nosso_numero: '',
        linha_digitavel: '',
      };
      if (itauBoletos[bd]) {
        det.nosso_numero = itauBoletos[bd].nosso_numero || '';
        det.linha_digitavel = itauBoletos[bd].linha_digitavel || '';
      }
      boletoDetalhes.push(det);
    }
  }

  return {
    formaLabel: formaLabel,
    indPag: indPag,
    tPag: tPag,
    pagamentos: pagamentos,
    duplicatas: duplicatas,
    boletoDetalhes: boletoDetalhes,
    tipoPag: tipoPag,
  };
}

// ============================================================
// XML-RPC Helpers
// ============================================================
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
      if (err) reject(new Error('Auth Odoo falhou: ' + (err.message || JSON.stringify(err))));
      else if (uid === false || uid === null) reject(new Error('Credenciais Odoo invalidas'));
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

// ============================================================
// Main: Process Pending Emissions
// ============================================================
async function processPendingEmissions() {
  var odoo = config.odoo;
  if (!odoo || !odoo.enabled || !odoo.url) {
    console.log('[SIEG-EMIT] Odoo nao configurado');
    return { processed: 0, reason: 'odoo_not_configured' };
  }

  var client = createClient(odoo.url);
  var uid = await authenticate(client, odoo.db, odoo.user, odoo.password);
  var db = odoo.db;
  var pwd = odoo.password;

  console.log('[SIEG-EMIT] Buscando faturas pendentes...');

  // Buscar NF-e pendentes
  var nfeIds = await executeKw(client, db, uid, pwd, 'account.move', 'search', [[
    ['move_type', '=', 'out_invoice'],
    ['x_studio_nfe_status', '=', 'pendente'],
  ]], { order: 'id asc', limit: 5 });

  // Buscar NFS-e pendentes
  var nfseIds = await executeKw(client, db, uid, pwd, 'account.move', 'search', [[
    ['move_type', '=', 'out_invoice'],
    ['x_studio_nfse_status', '=', 'pendente'],
  ]], { order: 'id asc', limit: 5 });

  var allPending = [];
  for (var i = 0; i < nfeIds.length; i++) {
    allPending.push({ id: nfeIds[i], tipo: 'nfe' });
  }
  for (var j = 0; j < nfseIds.length; j++) {
    allPending.push({ id: nfseIds[j], tipo: 'nfse' });
  }

  if (!allPending.length) {
    console.log('[SIEG-EMIT] Nenhuma fatura pendente');
    return { processed: 0 };
  }

  console.log('[SIEG-EMIT] ' + allPending.length + ' fatura(s) pendente(s)');
  var results = [];

  for (var k = 0; k < allPending.length; k++) {
    var item = allPending[k];
    try {
      var r = await processOne(client, db, uid, pwd, item.id, item.tipo);
      results.push(r);
    } catch (err) {
      console.error('[SIEG-EMIT] ERRO fatura ' + item.id + ':', err.message);
      await safeUpdateError(client, db, uid, pwd, item.id, item.tipo, err.message);
      results.push({ move_id: item.id, sucesso: false, tipo: item.tipo, erro: err.message });
    }
  }

  var ok = results.filter(function(r) { return r.sucesso; }).length;
  console.log('[SIEG-EMIT] Concluido: ' + ok + '/' + results.length + ' sucesso');
  return { processed: results.length, sucesso: ok, detalhes: results };
}

// ============================================================
// Process Single Invoice
// ============================================================
async function processOne(client, db, uid, pwd, moveId, tipo) {
  console.log('[SIEG-EMIT] --- Fatura ID: ' + moveId + ' | Tipo: ' + tipo + ' ---');

  // 1. Read account.move (sem invoice_line_ids — pode ser computed nao-stored no Odoo 19)
  var moves = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], [
    'name', 'partner_id', 'company_id', 'invoice_date', 'date', 'journal_id',
    'amount_total', 'narration',
    'x_studio_nfe_status', 'x_studio_nfse_status', 'payment_state',
    'x_studio_itau_nosso_numero', 'x_studio_itau_resposta_json', 'x_studio_boleto_cancelado',
    'x_studio_forma_de_pagamento', 'invoice_payment_term_id',
    'invoice_line_ids', 'line_ids',
  ]]);
  if (!moves || !moves.length) throw new Error('Fatura ' + moveId + ' nao encontrada');
  var move = moves[0];
  console.log('[SIEG-EMIT] Fatura: ' + move.name + ' | R$ ' + (move.amount_total || 0));

  // 1c-2. DIARIO DE TRANSFERENCIA (ex: "Transferência entre Filiais" / FAT1)
  // AJL 21/10/2026: NF do diario de transferencia sai com CFOP 5152 (interna) /
  // 6152 (interestadual) e natOp pela nomenclatura do tipo de operacao do Odoo.
  // Se a fatura tiver o TIPO DE OPERACAO preenchido (ex: remessa p/ industriali-
  // zacao = 5901/6901), o tipo manda (ver 1c-3 e bloco de CFOP das linhas).
  var isTransferencia = false;
  try {
    var jId = (move.journal_id && move.journal_id[0]) || 0;
    var jName = (move.journal_id && move.journal_id[1]) ? String(move.journal_id[1]).toLowerCase() : '';
    var jEnv = (process.env.NFE_TRANSFER_JOURNAL_IDS || '').split(',').map(function(s){ return parseInt(s); }).filter(Boolean);
    isTransferencia = jEnv.indexOf(jId) >= 0 ||
      jName.indexOf('transfer') >= 0 || jName.indexOf('filial') >= 0 || jName.indexOf('remessa') >= 0;
    if (isTransferencia) {
      console.log('[SIEG-EMIT] Diario de TRANSFERENCIA: ' + (move.journal_id[1] || jId) + ' -> CFOP 5152/6152, natOp pelo tipo de operacao');
    }
  } catch (eJ) {
    console.log('[SIEG-EMIT] Journal read falhou (seguindo como venda): ' + eJ.message);
  }

  // 1c-3. TIPO DE OPERACAO (l10n_br.operation.type) — AJL 21/10/2026
  // A NF deve sair com a NOMENCLATURA usada no Odoo (nome do tipo em pt_BR) e o
  // CFOP correto: transferencia -> 5152/6152; remessa industrializacao -> 5901/6901.
  var opTypeId = 0, opTypeName = '', opTypeTech = '';
  try {
    var otVal = await executeKw(client, db, uid, pwd, 'account.move', 'read',
      [[moveId], ['l10n_br_goods_operation_type_id']], { context: { lang: 'pt_BR' } });
    var opRef = (otVal && otVal[0] && otVal[0].l10n_br_goods_operation_type_id) || false;
    if (opRef && opRef[0]) {
      opTypeId = opRef[0];
      opTypeName = opRef[1] || '';
      var otd = await executeKw(client, db, uid, pwd, 'l10n_br.operation.type', 'read',
        [[opTypeId], ['technical_name']]);
      if (otd && otd[0]) opTypeTech = otd[0].technical_name || '';
      console.log('[SIEG-EMIT] Tipo de operacao: id=' + opTypeId + ' "' + opTypeName + '" (' + opTypeTech + ')');
    }
  } catch (eOT) {
    console.log('[SIEG-EMIT] Tipo de operacao nao lido (segue padrao): ' + eOT.message);
  }

  // 1a. GUARDA ANTI-DUPLICAÇÃO: se a NF-e já foi autorizada (ou já tem chave),
  // NUNCA reemitir. Evita emissão duplicada em corrida de pollers
  // (ex: sobreposição de instâncias durante deploy no Render).
  // EXCEÇÃO (AJL 21/10/2026): chave STALE copiada por DUPLICAÇÃO de fatura
  // (ex: duplicar NF cancelada -> Odoo copia x_studio_nfe_chave/protocolo).
  // Se o nNF dentro da chave (pos. 26-34) NÃO bate com o número do NOME da
  // fatura, a chave pertence a OUTRA NF -> limpa e segue para emissão normal.
  var currentNfeStatus = move.x_studio_nfe_status || '';
  var currentKey = '';
  if (tipo === 'nfe') {
    try {
      var kv = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], ['x_studio_nfe_chave']]);
      currentKey = (kv && kv[0] && kv[0].x_studio_nfe_chave) || '';
    } catch (eKey) {}
    if (currentKey && currentNfeStatus !== 'autorizada') {
      var chaveDig = String(currentKey).replace(/\D/g, '');
      var nfNaChave = (chaveDig.length === 44) ? chaveDig.slice(25, 34).replace(/^0+/, '') : '';
      var mNomeNF = String(move.name || '').match(/(\d{5,})/);
      var nfNoNome = mNomeNF ? mNomeNF[1].replace(/^0+/, '') : '';
      if (nfNaChave && nfNoNome && nfNaChave !== nfNoNome) {
        console.log('[SIEG-EMIT] Fatura ' + moveId + ' (' + move.name + ') com chave STALE ' +
          chaveDig + ' (nNF ' + nfNaChave + ' != ' + nfNoNome + ') — limpando chave/protocolo copiados e emitindo');
        try {
          await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId],
            { x_studio_nfe_chave: false, x_studio_nfe_protocolo: false }]);
        } catch (eStale) {
          console.warn('[SIEG-EMIT] Falha ao limpar chave stale: ' + eStale.message);
        }
        currentKey = '';
      }
    }
    if (currentNfeStatus === 'autorizada' || currentKey) {
      console.log('[SIEG-EMIT] Fatura ' + moveId + ' ja AUTORIZADA (status=' + currentNfeStatus +
        ', chave=' + (currentKey || 'n/d') + ') — SKIP, não reemitir');
      return { move_id: moveId, tipo: tipo, sucesso: true, skip: true, motivo: 'ja_autorizada' };
    }
  } else if ((move.x_studio_nfse_status || '') === 'autorizada') {
    console.log('[SIEG-EMIT] NFS-e ' + moveId + ' ja AUTORIZADA — SKIP');
    return { move_id: moveId, tipo: tipo, sucesso: true, skip: true, motivo: 'ja_autorizada' };
  }

  // 1a-bis. FORMA DE PAGAMENTO (x_studio_forma_de_pagamento)
  // Fonte: campo correto da FATURA; fallback: pedido de venda de origem.
  var formaPagamento = String(move.x_studio_forma_de_pagamento || '').trim();
  var saleOrderIdForForma = 0;
  if (!formaPagamento) {
    try {
      var soForma = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], ['invoice_origin']]);
      var originName = (soForma && soForma[0] && soForma[0].invoice_origin) || '';
      if (originName) {
        var soIds2 = await executeKw(client, db, uid, pwd, 'sale.order', 'search', [[['name', '=', originName]]], { limit: 1 });
        if (soIds2 && soIds2.length) {
          saleOrderIdForForma = soIds2[0];
          var soRecs = await executeKw(client, db, uid, pwd, 'sale.order', 'read', [[soIds2[0]], ['x_studio_forma_de_pagamento']]);
          if (soRecs && soRecs[0] && soRecs[0].x_studio_forma_de_pagamento) {
            formaPagamento = String(soRecs[0].x_studio_forma_de_pagamento);
          }
        }
      }
    } catch (eForma) {
      console.log('[SIEG-EMIT] Forma de pagamento: fallback pedido falhou: ' + eForma.message);
    }
  }
  console.log('[SIEG-EMIT] Forma de pagamento: "' + (formaPagamento || '(vazia)') + '"');

  // 1b. Read sale order origin (invoice_origin / sale_order_ids) for pedido number
  var saleOrderNumber = '';
  try {
    // Try invoice_origin field first
    var moveOrigin = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], ['invoice_origin', 'ref']]);
    if (moveOrigin && moveOrigin[0]) {
      saleOrderNumber = moveOrigin[0].invoice_origin || moveOrigin[0].ref || '';
    }
    // If still empty, try sale_order_ids (M2M field)
    if (!saleOrderNumber) {
      var soIds = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], ['sale_order_ids']]);
      if (soIds && soIds[0] && soIds[0].sale_order_ids && soIds[0].sale_order_ids.length > 0) {
        var soNames = await executeKw(client, db, uid, pwd, 'sale.order', 'read', [[soIds[0].sale_order_ids[0]], ['name']]);
        if (soNames && soNames[0]) saleOrderNumber = soNames[0].name || '';
      }
    }
  } catch (e) {
    console.log('[SIEG-EMIT] Campo invoice_origin/sale_order_ids nao disponivel: ' + e.message);
  }
  if (saleOrderNumber) {
    console.log('[SIEG-EMIT] Pedido de venda origem: ' + saleOrderNumber);
  }

  // 1c. Read boleto data from Itaú response JSON
  var boletoInfo = '';
  var boletoDataList = [];
  try {
    var rawJson = move.x_studio_itau_resposta_json || '';
    if (rawJson) {
      var jsonStr = rawJson.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null');
      var parsed = JSON.parse(jsonStr);
      var pagamentos = parsed.pagamentos || [];
      var boletoParts = [];
      for (var pi = 0; pi < pagamentos.length; pi++) {
        var p = pagamentos[pi];
        if (p.nosso_numero) {
          var bolEntry = { nosso_numero: p.nosso_numero };
          var part = 'Boleto: NN=' + p.nosso_numero;
          if (p.linha_digitavel) {
            part += ' LD=' + p.linha_digitavel;
            bolEntry.linha_digitavel = p.linha_digitavel;
          }
          if (p.codigo_barras) {
            part += ' CB=' + p.codigo_barras;
            bolEntry.codigo_barras = p.codigo_barras;
          }
          boletoParts.push(part);
          boletoDataList.push(bolEntry);
        }
      }
      if (boletoParts.length > 0) {
        boletoInfo = boletoParts.join(' | ');
      }
    }
    // Also try nosso_numero directly if no JSON boletos found
    if (boletoDataList.length === 0 && move.x_studio_itau_nosso_numero) {
      boletoInfo = 'Boleto: NN=' + move.x_studio_itau_nosso_numero;
      boletoDataList.push({ nosso_numero: move.x_studio_itau_nosso_numero });
    }
  } catch (e) {
    console.log('[SIEG-EMIT] Erro ao ler dados de boleto: ' + e.message);
  }
  if (boletoInfo) {
    console.log('[SIEG-EMIT] Boleto info: ' + boletoInfo.substring(0, 200));
  }

  // 1d. PARCELAS / VENCIMENTOS da fatura (linhas de payment_term)
  // "tem tudo na invoice": cada linha payment_term tem date_maturity (venc)
  // e debit (valor da parcela). Usadas quando a forma de pagamento é boleto.
  var parcelasFatura = [];
  try {
    var termLineIds = await executeKw(client, db, uid, pwd, 'account.move.line', 'search', [[
      ['move_id', '=', moveId],
      ['display_type', '=', 'payment_term'],
    ]], { order: 'date_maturity asc' });
    if (termLineIds && termLineIds.length) {
      var termLines = await executeKw(client, db, uid, pwd, 'account.move.line', 'read', [termLineIds, [
        'date_maturity', 'debit', 'credit', 'amount_residual', 'name',
      ]]);
      for (var tli = 0; tli < termLines.length; tli++) {
        var tl = termLines[tli];
        var vParc = parseFloat(tl.debit) || parseFloat(tl.credit) || 0;
        if (vParc > 0) {
          parcelasFatura.push({ vencimento: tl.date_maturity || '', valor: vParc });
        }
      }
    }
  } catch (eTerm) {
    console.log('[SIEG-EMIT] Leitura de parcelas (payment_term) falhou: ' + eTerm.message);
  }
  if (parcelasFatura.length) {
    console.log('[SIEG-EMIT] Parcelas na fatura: ' + parcelasFatura.length +
      ' (venc1=' + parcelasFatura[0].vencimento + ')');
  }

  // 2. Read company
  var companyId = tupId(move.company_id);
  var company = await readCompany(client, db, uid, pwd, companyId);
  console.log('[SIEG-EMIT] [EMITENTE] CNPJ=' + company.cnpj_cpf + ' IE=' + company.inscr_est + ' cMun=' + company.city_ibge_code + ' xMun=' + company.city + ' UF=' + company.state + ' xLgr=' + company.street + ' nro=' + company.number);

  // 3. Read partner
  var partnerId = tupId(move.partner_id);
  if (!partnerId) throw new Error('Fatura sem parceiro');
  var partner = await readPartner(client, db, uid, pwd, partnerId);
  console.log('[SIEG-EMIT] [DESTINATARIO] CNPJ=' + partner.cnpj_cpf + ' IE=' + (partner.inscr_est || '(vazio)') + ' xNome=' + partner.xNome + ' cMun=' + partner.city_ibge_code + ' xMun=' + partner.city + ' UF=' + partner.state + ' xLgr=' + partner.street + ' nro=' + partner.number);

  // 3b. Auto-lookup IE do destinatario se vazio (SEFAZ cStat 232 exige IE para CFOP 5xxx/6xxx)
  if (!partner.inscr_est || String(partner.inscr_est).trim() === '') {
    var partnerCnpj = (partner.cnpj_cpf || '').replace(/\D/g, '');
    var partnerUf = partner.state || '';
    if (partnerCnpj.length === 14) {
      console.log('[SIEG-EMIT] [DEST-IE] IE vazia no Odoo. Tentando auto-lookup CNPJ=' + partnerCnpj + ' UF=' + partnerUf);
      try {
        var ieResult = await _ieService.obterIE(partnerCnpj, null, partnerUf);
        if (ieResult.hasIE && ieResult.ie) {
          partner.inscr_est = ieResult.ie;
          console.log('[SIEG-EMIT] [DEST-IE] IE encontrada: ' + ieResult.ie + ' (UF=' + (ieResult.ieState || partnerUf) + ') via ' + ieResult.source);
          // Tentar salvar IE no Odoo para futuras emissoes
          try {
            await executeKw(client, db, uid, pwd, 'res.partner', 'write', [[partnerId], { inscr_est: ieResult.ie }]);
            console.log('[SIEG-EMIT] [DEST-IE] IE salva no parceiro Odoo (id=' + partnerId + ')');
          } catch (writeErr) {
            console.warn('[SIEG-EMIT] [DEST-IE] Nao conseguiu salvar IE no Odoo: ' + writeErr.message);
          }
        } else {
          console.warn('[SIEG-EMIT] [DEST-IE] IE nao encontrada em nenhuma fonte. Motivos: ' + JSON.stringify(ieResult.reasons || []));
          console.warn('[SIEG-EMIT] [DEST-IE] Emissao provavelmente sera rejeitada pela SEFAZ (cStat 232) se CFOP exigir IE.');
        }
      } catch (ieErr) {
        console.error('[SIEG-EMIT] [DEST-IE] Erro no auto-lookup de IE: ' + ieErr.message);
      }
    } else if (partnerCnpj.length === 11) {
      console.log('[SIEG-EMIT] [DEST-IE] Destinatario CPF (consumidor final) — IE nao necessaria');
    } else {
      console.warn('[SIEG-EMIT] [DEST-IE] CNPJ/CPF invalido (' + partnerCnpj.length + ' digitos) — sem auto-lookup de IE');
    }
  } else {
    console.log('[SIEG-EMIT] [DEST-IE] IE ja preenchida no Odoo: ' + partner.inscr_est);
  }

  // 3c. Ler aliquota_icms do parceiro Odoo e determinar regra ICMS PR
  // REGRAS DENTRO DO ESTADO PR:
  //   - Com IE (Inscricao Estadual) → 12%
  //   - CNPJ sem IE ou CPF → 19.5%
  // FORA DO ESTADO (interestadual) → Difal (nao altera preco)
  var partnerAliquotaIcms = '';
  var partnerHasIe = !!(partner.inscr_est && String(partner.inscr_est).trim() !== '' && String(partner.inscr_est).trim() !== 'ISENTO');
  try {
    var aliRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], ['aliquota_icms', 'has_ie']]);
    if (aliRecs && aliRecs[0]) {
      partnerAliquotaIcms = String(aliRecs[0].aliquota_icms || '');
      if (aliRecs[0].has_ie) partnerHasIe = true;
    }
  } catch (eAli) {
    console.log('[SIEG-EMIT] Campo aliquota_icms nao disponivel no parceiro: ' + eAli.message);
  }
  // Determinar ICMS interno para PR
  var icmsInternoPR = 19.5; // default: sem IE
  if (partnerHasIe || partnerAliquotaIcms === '12') {
    icmsInternoPR = 12;
  }
  // Para CPF (consumidor final) sem CNPJ → 19.5%
  var partnerCnpjLimpo = (partner.cnpj_cpf || '').replace(/\D/g, '');
  if (partnerCnpjLimpo.length === 11) {
    icmsInternoPR = 19.5; // CPF = consumidor final
  }
  console.log('[SIEG-EMIT] [ICMS-PR] aliquota_icms=' + partnerAliquotaIcms + ' has_ie=' + partnerHasIe + ' cnpj_len=' + partnerCnpjLimpo.length + ' → icmsInternoPR=' + icmsInternoPR + '%');

  // 4. Read invoice lines diretamente de account.move.line (evita computed field)
  var allLineIds = await executeKw(client, db, uid, pwd, 'account.move.line', 'search', [[
    ['move_id', '=', moveId],
  ]], { order: 'id asc' });
  console.log('[SIEG-EMIT] Linhas encontradas na fatura: ' + allLineIds.length);
  var rawLines = await executeKw(client, db, uid, pwd, 'account.move.line', 'read', [allLineIds, [
    'display_type', 'product_id', 'name', 'quantity', 'price_unit',
    'price_subtotal', 'tax_ids', 'discount',
  ]]);
  // Debug: log todas as linhas
  for (var li = 0; li < rawLines.length; li++) {
    var l = rawLines[li];
    var pName = 'N/A';
    if (l.product_id) pName = Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id);
    console.log('[SIEG-EMIT]   Line ' + li + ': display_type=' + JSON.stringify(l.display_type) + ' product=' + pName + ' qty=' + l.quantity + ' price=' + l.price_unit);
  }
  // Filtro principal: linhas com produto associado (mais confiavel que display_type)
  var invoiceLines = rawLines.filter(function(l) { return l.product_id; });
  // Fallback: se nenhuma tem product_id, tenta por display_type
  if (!invoiceLines.length) {
    invoiceLines = rawLines.filter(function(l) {
      var dt = l.display_type;
      return !dt || dt === 'product' || dt === 'service';
    });
  }
  if (!invoiceLines.length) throw new Error('Fatura sem linhas de produto/servico (total: ' + rawLines.length + ', com product: 0)');
  console.log('[SIEG-EMIT] Linhas de produto: ' + invoiceLines.length);

  // 5. Get next NF number from company
  var serie, numField, nextNum;
  if (tipo === 'nfe') {
    serie = String(company.x_studio_sieg_serie_nfe || '100');
    numField = 'x_studio_sieg_ultimo_nfe';
  } else {
    serie = String(company.x_studio_sieg_serie_nfse || '1');
    numField = 'x_studio_sieg_ultimo_nfse';
  }
  nextNum = (parseInt(company[numField]) || 0) + 1;
  // MESMA SEQUENCIA PARA OS DOIS DIARIOS (Sales e Transferência entre Filiais):
  // o numero da NF segue o NOME da fatura ('NFe 000NNNNN') quando esse numero
  // ainda e novo (maior que o contador). Assim os dois diarios compartilham a
  // mesma sequencia — o contador global avanca para o numero efetivamente usado.
  try {
    var mNameNum = String(move.name || '').match(/(\d{4,9})\s*$/);
    if (mNameNum) {
      var namedNum = parseInt(mNameNum[1]);
      var contadorAtual = parseInt(company[numField]) || 0;
      if (namedNum > contadorAtual) {
        if (namedNum !== nextNum) {
          console.log('[SIEG-EMIT] nNF alinhado ao nome da fatura: ' + namedNum + ' (contador emitiria ' + nextNum + ')');
        }
        nextNum = namedNum;
      } else if (namedNum > 0 && namedNum < nextNum) {
        console.warn('[SIEG-EMIT] Numero do nome da fatura (' + namedNum + ') ja usado na serie — usando contador: ' + nextNum);
      }
    }
  } catch (eNum) {}
  console.log('[SIEG-EMIT] Serie: ' + serie + ' | nNF: ' + nextNum);

  // 6. Build line data with taxes + product x_studio_ fields
  var linesData = [];
  // 6a. Determinar CFOP e ICMS baseado na UF do emitente vs destinatario
  var ufEmit = (company.state || '').toUpperCase();
  var ufDest = (partner.state || '').toUpperCase();
  var isInterstate = ufEmit && ufDest && ufEmit !== ufDest;
  // ICMS interestadual: 12% para Sul/Sudeste, 7% para Norte/Nordeste/Centro-Oeste
  var ICMS_INTERSTATE_SUL_SE = ['PR','SC','RS','SP','MG','RJ','ES'];
  var picmsInterstate = ICMS_INTERSTATE_SUL_SE.includes(ufDest) ? 12 : 7;
  if (isInterstate) {
    console.log('[SIEG-EMIT] Operacao INTERESTADUAL: ' + ufEmit + ' → ' + ufDest + ' — CFOP 5xxx→6xxx, pICMS→' + picmsInterstate + '% (Difal aplicavel)');
  } else {
    console.log('[SIEG-EMIT] Operacao INTERNA: ' + ufEmit + ' → ' + ufDest + ' — CFOP 5xxx, pICMS=' + icmsInternoPR + '%');
  }
  for (var i = 0; i < invoiceLines.length; i++) {
    var ld = await buildLineData(client, db, uid, pwd, invoiceLines[i], icmsInternoPR);
    // Ajustar CFOP: se interestadual, 5xxx → 6xxx
    if (isInterstate && ld.cfop && /^5\d{3}$/.test(ld.cfop)) {
      var cfopOrig = ld.cfop;
      ld.cfop = '6' + ld.cfop.substring(1);
      console.log('[SIEG-EMIT] CFOP ajustado para interestadual: ' + ld.cfop + ' (original: ' + cfopOrig + ')');
    }
    // AJL 21/10/2026: CFOP pelo TIPO DE OPERACAO do Odoo (l10n_br.operation.type)
    //  - transferencia de produtos   -> 5152 (interna) / 6152 (interestadual)
    //  - remessa p/ industrializacao -> 5901 (interna) / 6901 (interestadual)
    var cfopOp = '';
    if (opTypeTech === 'itemsForManufacturingShippingOutbound') {
      cfopOp = isInterstate ? '6901' : '5901';
    } else if (opTypeTech === 'itemTransferShippingOutbound' ||
               opTypeTech === 'itemTransferShippingOutboundBetweenIPITaxPayer') {
      cfopOp = isInterstate ? '6152' : '5152';
    }
    if (cfopOp) {
      if (ld.cfop !== cfopOp) {
        console.log('[SIEG-EMIT] CFOP por tipo de operacao (' + opTypeTech + '): ' + ld.cfop + ' -> ' + cfopOp);
      }
      ld.cfop = cfopOp;
    } else if (isTransferencia) {
      // Diario de transferencia sem tipo definido -> transferencia de produtos
      var cfopTransf = isInterstate ? '6152' : '5152';
      if (ld.cfop !== cfopTransf) {
        console.log('[SIEG-EMIT] CFOP transferencia (diario): ' + ld.cfop + ' -> ' + cfopTransf);
      }
      ld.cfop = cfopTransf;
    }
    // Ajustar ICMS baseado na regra PR
    if (!isInterstate) {
      // INTERNO PR: IE→12%, sem IE/CPF→19.5% (sobrescrever o default 18%)
      if (ld.cst_icms === '00' && parseFloat(ld.picms) !== icmsInternoPR) {
        var picmsOrigInt = ld.picms;
        var vbcInt = parseFloat(ld.vbc_icms || ld.vbc || 0);
        ld.picms = String(icmsInternoPR);
        ld.vicms = String(Math.round(vbcInt * icmsInternoPR / 100 * 100) / 100);
        console.log('[SIEG-EMIT] ICMS interno PR: pICMS ' + picmsOrigInt + '%→' + ld.picms + '%, vICMS=' + ld.vicms + ' (vBC=' + vbcInt + ')');
      }
    } else {
      // INTERESTADUAL: CST 00 com pICMS interno → interestadual + Difal
      // Difal: nao altera preco. pICMS = aliquota interestadual
      // Diferencial partilhado entre UF origem e UF destino
      if (ld.cst_icms === '00' && parseFloat(ld.picms) > picmsInterstate) {
        var picmsOrig = ld.picms;
        var vbc = parseFloat(ld.vbc_icms || ld.vbc || 0);
        ld.picms = String(picmsInterstate);
        ld.vicms = String(Math.round(vbc * picmsInterstate / 100 * 100) / 100);
        console.log('[SIEG-EMIT] ICMS interestadual: pICMS ' + picmsOrig + '%→' + ld.picms + '%, vICMS=' + ld.vicms + ' (vBC=' + vbc + ')');
      }
      // Difal: calcular diferencial para infCpl (SOMENTE texto informativo;
      // Difal NUNCA soma no total da NF/cotação/pedido).
      // Aliquota preferida: a do imposto DIFAL aplicado na linha (tax_ids,
      // tabela por UF destino da Automação 2); fallback: interna PR - interestadual.
      if (ld.cst_icms === '00' && !ld.difal) {
        var vbcD = parseFloat(ld.vbc_icms || ld.vbc || 0);
        var difalRate = (parseFloat(ld.difal_aliquota) > 0)
          ? parseFloat(ld.difal_aliquota)
          : (icmsInternoPR - picmsInterstate);
        var difalVal = Math.round(vbcD * difalRate / 100 * 100) / 100;
        if (difalVal > 0) {
          ld.difal = difalVal;
          console.log('[SIEG-EMIT] Difal (informativo): vBC=' + vbcD + ' x ' + difalRate + '% = R$ ' + difalVal);
        }
      }
    }
    linesData.push(ld);
  }

  // 6a-bis. CONSISTENCIA SEFAZ (rejeicao 629): o XML envia vUnCom com 4 decimais
  // (TDec_1204) e a SEFAZ calcula vProd = qCom x vUnCom com os valores EFETIVOS
  // do XML. Normaliza: qCom 3 dec, vUnCom 4 dec, vProd derivado dos enviados.
  for (var ln = 0; ln < linesData.length; ln++) {
    var ldn = linesData[ln];
    var qty3 = Math.round((parseFloat(ldn.qty) || 0) * 1000) / 1000;
    var vUn4 = Math.round((parseFloat(ldn.price_unit) || 0) * 10000) / 10000;
    var vProdCons = Math.round(qty3 * vUn4 * 100) / 100;
    if (parseFloat(ldn.qty) !== qty3 || parseFloat(ldn.price_unit) !== vUn4 || parseFloat(ldn.price_subtotal) !== vProdCons) {
      console.log('[SIEG-EMIT] Consistencia 629 item ' + (ln + 1) + ' (' + (ldn.cProd || '?') + '): qCom=' + ldn.qty + ' vUnCom=' + ldn.price_unit + ' vProd=' + ldn.price_subtotal + ' -> qCom=' + qty3 + ' vUnCom=' + vUn4 + ' vProd=' + vProdCons);
    }
    ldn.qty = qty3;
    ldn.price_unit = vUn4;
    ldn.price_subtotal = vProdCons;
  }

  // 6b. ICMS MANUAL — campos x_studio na fatura (fallback quando o cálculo
  // automático não serve: usuário informa alíquota/BC/valor e a NF sai com eles)
  //   x_studio_icms_manual   (Boolean)  -> ativa o modo manual
  //   x_studio_icms_aliquota (Float %)  -> alíquota aplicada às linhas
  //   x_studio_icms_bc       (Monetary) -> BC total manual (opcional; rateia proporcional ao vProd)
  //   x_studio_icms_valor    (Monetary) -> vICMS total manual (opcional; rateia proporcional ao vProd)
  var icmsManual = { ativo: false, aliquota: 0, bc: 0, valor: 0 };
  try {
    var mvIcms = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], [
      'x_studio_icms_manual', 'x_studio_icms_aliquota', 'x_studio_icms_bc', 'x_studio_icms_valor',
    ]]);
    if (mvIcms && mvIcms[0] && mvIcms[0].x_studio_icms_manual) {
      icmsManual.ativo = true;
      icmsManual.aliquota = parseFloat(mvIcms[0].x_studio_icms_aliquota) || 0;
      icmsManual.bc = parseFloat(mvIcms[0].x_studio_icms_bc) || 0;
      icmsManual.valor = parseFloat(mvIcms[0].x_studio_icms_valor) || 0;
    }
  } catch (eIcmsMan) {
    console.log('[SIEG-EMIT] Campos ICMS manual nao disponiveis: ' + eIcmsMan.message);
  }
  if (icmsManual.ativo) {
    var vProdManual = 0;
    for (var vm = 0; vm < linesData.length; vm++) vProdManual += parseFloat(linesData[vm].price_subtotal) || 0;
    var vIcmsManualTotal = 0;
    var vBcManualTotal = 0;
    for (var mi = 0; mi < linesData.length; mi++) {
      var mld = linesData[mi];
      var mSub = parseFloat(mld.price_subtotal) || 0;
      var mProp = vProdManual > 0 ? mSub / vProdManual : 0;
      var mBc = icmsManual.bc > 0 ? round2(icmsManual.bc * mProp) : round2(mSub);
      var mVicms = icmsManual.valor > 0 ? round2(icmsManual.valor * mProp) : round2(mBc * icmsManual.aliquota / 100);
      var mPicms = mBc > 0 ? Math.round((mVicms / mBc) * 100 * 100) / 100 : icmsManual.aliquota;
      mld.vbc_icms = String(mBc);
      mld.picms = String(mPicms);
      mld.vicms = String(mVicms);
      // Alíquota 0 e valor 0 => ICMS isento (CST 40); senão mantém CST atual
      if (icmsManual.aliquota === 0 && icmsManual.valor === 0) {
        mld.cst_icms = '40';
        mld.mod_bc = '3';
      }
      vIcmsManualTotal += mVicms;
      vBcManualTotal += mBc;
      console.log('[SIEG-EMIT] ICMS MANUAL linha ' + mi + ': vBC=' + mBc + ' pICMS=' + mPicms + '% vICMS=' + mVicms);
    }
    console.log('[SIEG-EMIT] ICMS MANUAL ATIVO — alíquota=' + icmsManual.aliquota + '% BC=' + vBcManualTotal.toFixed(2) + ' vICMS=' + vIcmsManualTotal.toFixed(2));
  }

  // 7. Build emission payload
  // vNF = vProd + vIPI (unico imposto que soma no valor da NF)
  // vProd = soma dos price_subtotal (sem IPI incluso)
  var vProdSum = 0;
  var vIPISum = 0;
  for (var li = 0; li < linesData.length; li++) {
    vProdSum += parseFloat(linesData[li].price_subtotal) || 0;
    vIPISum += parseFloat(linesData[li].vipi || 0);
  }
  var vNFValue = round2(vProdSum + vIPISum);
  console.log('[SIEG-EMIT] vNF = vProd(' + vProdSum.toFixed(2) + ') + vIPI(' + vIPISum.toFixed(2) + ') = ' + vNFValue.toFixed(2));

  // Pagamentos + duplicatas a partir da FORMA DE PAGAMENTO do campo correto
  // da fatura (x_studio_forma_de_pagamento). Somente IPI soma no vNF.
  var pagInfo = buildPagamentoInfo({
    forma: formaPagamento,
    vNF: vNFValue,
    parcelasFatura: parcelasFatura,
    dataBase: move.invoice_date || move.date || '',
    itauBoletos: boletoDataList || [],
  });

  // Calcular Difal total para infCpl (Difal NAO soma no total — só informativo)
  var difalTotal = 0;
  for (var di = 0; di < linesData.length; di++) {
    if (linesData[di].difal) difalTotal += linesData[di].difal;
  }

  // Determinar ICMS alíquota para infCpl
  var icmsAliquotaInfCpl = '';
  if (icmsManual.ativo) {
    icmsAliquotaInfCpl = 'ICMS informado manualmente: ' + icmsManual.aliquota + '%';
  } else if (isInterstate) {
    icmsAliquotaInfCpl = String(picmsInterstate) + ' (interestadual)';
    if (difalTotal > 0) {
      icmsAliquotaInfCpl += ' Difal R$ ' + difalTotal.toFixed(2);
    }
  } else {
    icmsAliquotaInfCpl = String(icmsInternoPR);
  }

  var emitData = {
    company: company,
    partner: partner,
    order: {
      name: move.name,
      number: String(nextNum),
      date_order: move.invoice_date || move.date,
      amount_total: vNFValue, // vNF = vProd + vIPI (somente IPI soma)
      note: move.narration || '',
      sale_order_number: saleOrderNumber || '',
      boleto_info: boletoInfo || '',
      icms_aliquota: icmsAliquotaInfCpl,
      boleto_detalhes: pagInfo.boletoDetalhes,
      forma_pagamento: formaPagamento || '',
      forma_pagamento_label: pagInfo.formaLabel,
      duplicatas: pagInfo.duplicatas,
    },
    lines: linesData,
    pagamentos: pagInfo.pagamentos,
    boletoData: boletoDataList || [],
    config: {
      serie: serie,
      tpAmb: process.env.SIEG_TP_AMB || config.sieg.tpAmb || '2',
      natOp: opTypeName || (isTransferencia ? 'Transferência de produtos' : 'Venda de Mercadoria'),
      mod: tipo === 'nfe' ? '55' : '01',
    },
    tipo: tipo,
  };
  console.log('[SIEG-EMIT] Pagamento NF: ' + pagInfo.formaLabel + ' | tPag=' +
    (pagInfo.pagamentos[0] || {}).tPag + ' | indPag=' + (pagInfo.pagamentos[0] || {}).indPag +
    ' | parcelas=' + (pagInfo.duplicatas ? pagInfo.duplicatas.length : 0));

  // NFS-e: build service block from product x_studio_ fields
  if (tipo === 'nfse') {
    emitData.service = buildServiceBlock(linesData, move);
  }

  // 8. Set status to 'processando'
  var processVals = {};
  if (tipo === 'nfe') processVals.x_studio_nfe_status = 'processando';
  else processVals.x_studio_nfse_status = 'processando';
  await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], processVals]);

  // 9. Call SIEG API
  console.log('[SIEG-EMIT] Enviando ao SIEG...');
  var resultado;
  try {
    resultado = await emitirNota(emitData);
  } catch (siegErr) {
    // Captura erros HTTP (ex: 409 com detalhes no body)
    var siegDetail = siegErr.response && siegErr.response.data;
    var errMsg = 'SIEG HTTP ' + (siegErr.response ? siegErr.response.status : 'erro') + ': ';
    if (siegDetail) {
      // Tentar extrair ErrorMessage do formato SIEG (PascalCase)
      var siegMsg = siegDetail.ErrorMessage || siegDetail.Message || siegDetail.message || '';
      if (siegMsg) {
        errMsg += siegMsg;
      } else {
        errMsg += typeof siegDetail === 'string' ? siegDetail : JSON.stringify(siegDetail).slice(0, 800);
      }
    } else {
      errMsg += siegErr.message;
    }
    console.error('[SIEG-EMIT] Erro SIEG:', errMsg);
    throw new Error(errMsg);
  }
  console.log('[SIEG-EMIT] SIEG retornou - sucesso: ' + resultado.sucesso + (resultado.httpStatus ? ' (HTTP ' + resultado.httpStatus + ')' : ''));

  // Se SIEG retornou erro (IsSuccess=false), extrair mensagem detalhada
  if (!resultado.sucesso && resultado.erro) {
    console.error('[SIEG-EMIT] SIEG rejeitou o XML: ' + resultado.erro);
  }

  // 10. Parse result
  var info = parseResult(resultado, tipo);
  var xmlRetornoText = '';
  var rawXmlAuth = resultado.resposta && (resultado.resposta.Xml || resultado.resposta.xml || resultado.resposta.xmlBase64);
  if (rawXmlAuth) {
    xmlRetornoText = (typeof rawXmlAuth === 'string' && rawXmlAuth.length > 200)
      ? rawXmlAuth
      : Buffer.from(rawXmlAuth, 'base64').toString('utf-8');
  }

  // 11. Update account.move with results
  var updateVals = {};
  if (info.sucesso) {
    if (tipo === 'nfe') {
      updateVals.x_studio_nfe_status = 'autorizada';
      updateVals.x_studio_nfe_chave = info.chave;
      updateVals.x_studio_nfe_protocolo = info.protocolo;
    } else {
      updateVals.x_studio_nfse_status = 'autorizada';
      updateVals.x_studio_nfse_numero = String(nextNum);
    }

    // Increment NF number (only on authorization)
    try {
      var companyUpdate = {};
      companyUpdate[numField] = nextNum;
      await executeKw(client, db, uid, pwd, 'res.company', 'write', [[companyId], companyUpdate]);
      console.log('[SIEG-EMIT] Sequencia ' + numField + ' = ' + nextNum);
    } catch (seqErr) {
      console.error('[SIEG-EMIT] Erro ao atualizar sequencia:', seqErr.message);
    }
  } else {
    // Falha: NUNCA gravar texto livre num campo Selection (o Odoo descarta e a
    // fatura some da fila). Grava um valor valido ('erro' ou 'pendente') e
    // mantem o motivo detalhado no chatter.
    var errStatus = statusOnError();
    if (tipo === 'nfe') {
      updateVals.x_studio_nfe_status = errStatus;
    } else {
      updateVals.x_studio_nfse_status = errStatus;
    }
    console.warn('[SIEG-EMIT] Emissao NAO autorizada -> status "' + errStatus
      + '" (motivo: ' + (info.cStat ? info.cStat + ' - ' : '') + (info.motivo || 'n/d') + ')');
  }

  await writeStatusSafe(client, db, uid, pwd, moveId, tipo, updateVals);
  console.log('[SIEG-EMIT] Fatura atualizada');

  // 12. Post XML + PDF to Chatter
  await postChatterResult(client, db, uid, pwd, moveId, move.name, tipo, info, resultado, xmlRetornoText);

  return {
    move_id: moveId, sucesso: info.sucesso, tipo: tipo,
    chave: info.chave, numero: nextNum, serie: serie,
  };
}

// ============================================================
// Post XML + PDF to Odoo Chatter
// ============================================================
async function postChatterResult(client, db, uid, pwd, moveId, moveName, tipo, info, resultado, xmlRetornoText) {
  var attachIds = [];
  var safeName = (moveName || 'Fatura').replace(/[^a-zA-Z0-9\-_]/g, '_');
  var nfLabel = tipo === 'nfe' ? 'NF-e' : 'NFS-e';
  var xmlContent = xmlRetornoText || resultado.xmlEnviado || '';
  var pdfBase64 = resultado.pdfBase64 || '';

  // Attach XML
  if (xmlContent) {
    try {
      var xmlB64 = Buffer.from(xmlContent, 'utf-8').toString('base64');
      var xmlAttach = await executeKw(client, db, uid, pwd, 'ir.attachment', 'create', [{
        name: nfLabel + '_' + safeName + '.xml',
        raw: xmlB64,
        res_model: 'account.move',
        res_id: moveId,
        mimetype: 'application/xml',
      }]);
      attachIds.push(xmlAttach);
      console.log('[SIEG-EMIT] XML anexado (ID: ' + xmlAttach + ')');
    } catch (e) { console.error('[SIEG-EMIT] Erro anexar XML:', e.message); }
  }

  // Attach PDF (DANFE / DANFSE)
  if (pdfBase64) {
    try {
      var pdfLabel = tipo === 'nfe' ? 'DANFE' : 'DANFSE';
      var pdfAttach = await executeKw(client, db, uid, pwd, 'ir.attachment', 'create', [{
        name: pdfLabel + '_' + safeName + '.pdf',
        raw: pdfBase64,
        res_model: 'account.move',
        res_id: moveId,
        mimetype: 'application/pdf',
      }]);
      attachIds.push(pdfAttach);
      console.log('[SIEG-EMIT] PDF anexado (ID: ' + pdfAttach + ')');
    } catch (e) { console.error('[SIEG-EMIT] Erro anexar PDF:', e.message); }
  }

  // Post chatter message
  var body = '';
  if (info.sucesso) {
    body = '<b>' + nfLabel + ' Emitida com Sucesso!</b><br/>';
    if (tipo === 'nfe') {
      body += 'Chave: ' + info.chave + '<br/>';
      body += 'Protocolo: ' + info.protocolo + '<br/>';
    } else {
      body += 'Numero: ' + info.numero + '<br/>';
    }
    body += 'Status: ' + info.cStat + ' - ' + info.motivo;
    body += '<br/><br/><i>Arquivos anexados: XML e ' + (tipo === 'nfe' ? 'DANFE' : 'DANFSE') + ' (PDF)</i>';
  } else {
    body = '<b>Erro na Emissao de ' + nfLabel + '</b><br/>';
    body += 'Status: ' + info.cStat + ' - ' + info.motivo;
  }

  try {
    var msgVals = {
      model: 'account.move',
      res_id: moveId,
      body: body,
      message_type: 'comment',
    };
    if (attachIds.length > 0) {
      msgVals.attachment_ids = [[6, 0, attachIds]];
    }
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [msgVals]);
    console.log('[SIEG-EMIT] Mensagem postada no chatter');
  } catch (e) { console.error('[SIEG-EMIT] Erro postar chatter:', e.message); }
}

// ============================================================
// Read Company
// ============================================================
async function readCompany(client, db, uid, pwd, companyId) {
  var recs = await executeKw(client, db, uid, pwd, 'res.company', 'read', [[companyId], [
    'name', 'partner_id', 'street', 'city', 'state_id', 'zip', 'phone', 'email', 'vat',
    'x_studio_sieg_ultimo_nfe', 'x_studio_sieg_ultimo_nfse',
    'x_studio_sieg_serie_nfe', 'x_studio_sieg_serie_nfse',
  ]]);
  if (!recs || !recs.length) throw new Error('Empresa ' + companyId + ' nao encontrada');
  var c = recs[0];

  var pId = tupId(c.partner_id);
  var p = {};
  if (pId) {
    try { p = await readPartnerSafe(client, db, uid, pwd, pId); } catch (e) {
      console.warn('[SIEG-EMIT] Erro ao ler partner da empresa:', e.message);
    }
  }

  var stateCode = '', stateIbge = '';
  var stateId = tupId(c.state_id || p.state_id);
  if (stateId) {
    try {
      var sts = await executeKw(client, db, uid, pwd, 'res.country.state', 'read', [[stateId], ['code', 'ibge_code', 'x_ibge_code']]);
      if (sts && sts[0]) { stateCode = sts[0].code || ''; stateIbge = sts[0].x_ibge_code || sts[0].ibge_code || ''; }
    } catch (e) {}
  }

  var cityIbge = '';
  var cityRef = p.l10n_br_city_id || p.city_id;
  if (cityRef && Array.isArray(cityRef)) cityIbge = await readCityIbge(client, db, uid, pwd, cityRef[0]);

  // AJL 21/10/2026: emitente tambem segue a tabela IBGE do middleware
  var tabelaIbgeEmp = ibgeMunicipios.lookup(stateCode || 'PR', c.city || p.city);
  if (tabelaIbgeEmp) {
    if (cityIbge && cityIbge !== tabelaIbgeEmp) {
      console.log('[SIEG-EMIT] cMun EMITENTE corrigido pela tabela IBGE: %s/%s %s -> %s', c.city, stateCode, cityIbge, tabelaIbgeEmp);
    }
    cityIbge = tabelaIbgeEmp;
  }

  // AJL 21/10/2026 (pedido Renan): campo x_studio_codigo_municipio do cadastro
  // MANDA como cMun — APENAS para emitente do PARANA. Prioridade maxima,
  // acima da tabela e do Odoo (deterministico, sem depender de nome de cidade).
  var campoMunEmp = String(p.x_studio_codigo_municipio || '').replace(/\D/g, '');
  var ufEmp = (stateCode || 'PR').toUpperCase();
  if ((ufEmp === 'PR' || ufEmp === 'SC') && campoMunEmp.length === 7) {
    if (cityIbge !== campoMunEmp) {
      console.log('[SIEG-EMIT] cMun EMITENTE pelo campo do cadastro (' + ufEmp + '): %s -> %s', cityIbge || '(vazio)', campoMunEmp);
    }
    cityIbge = campoMunEmp;
  }

  return {
    cnpj_cpf: p.cnpj_cpf || c.vat || '22603750000190',
    legal_name: p.legal_name || c.name || 'AJL FERRO E ACO LTDA',
    name: c.name || 'AJL',
    inscr_est: p.inscr_est || '9069585890',
    street: c.street || p.street || '',
    number: p.number || 'S/N',
    street2: p.street2 || p.district || '',
    city: c.city || p.city || 'Curitiba',
    state: stateCode || 'PR',
    zip: c.zip || p.zip || '',
    city_ibge_code: cityIbge || '4106902',
    state_ibge: stateIbge || '41',
    crt: '3',
    phone: c.phone || p.phone || '',
    email: c.email || p.email || '',
    x_studio_sieg_ultimo_nfe: c.x_studio_sieg_ultimo_nfe || 0,
    x_studio_sieg_ultimo_nfse: c.x_studio_sieg_ultimo_nfse || 0,
    x_studio_sieg_serie_nfe: c.x_studio_sieg_serie_nfe || '100',
    x_studio_sieg_serie_nfse: c.x_studio_sieg_serie_nfse || '1',
  };
}

// ============================================================
// Read Partner (safe for Odoo 19 SaaS — l10n_br fields may not exist)
// ============================================================
var PARTNER_SAFE_FIELDS = [
  'name', 'vat', 'street', 'street2', 'city', 'state_id', 'zip',
  'phone', 'email', 'is_company', 'city_id', 'country_id',
];
var PARTNER_BR_FIELDS = ['cnpj_cpf', 'inscr_est', 'l10n_br_ie_code', 'legal_name', 'number', 'l10n_br_city_id', 'district'];

/**
 * Leitura segura de res.partner: campos core + l10n_br opcionais.
 * No Odoo 19 SaaS, campos como cnpj_cpf, inscr_est, legal_name, number,
 * l10n_br_city_id, district podem nao existir. Fazemos duas leituras:
 *   1. Campos core (sempre existem)
 *   2. Campos l10n_br (try/catch, ignora se falhar)
 *   3. Discovery: tenta encontrar campos x_studio_* para IE/CNPJ/razao social
 */

// Cache de campos IE descobertos no Odoo (para nao descobrir toda vez)
var _discoveredIeField = null;
var _discoveredCnpjField = null;
var _discoveredLegalNameField = null;
var _discoveredNumberField = null;

async function discoverPartnerFields(client, db, uid, pwd) {
  // Se ja descobrimos antes, reusa
  if (_discoveredIeField !== null) return;

  try {
    // fields_get() retorna metadados de todos os campos
    var allFields = await executeKw(client, db, uid, pwd, 'res.partner', 'fields_get', [[], ['string', 'type']]);
    var fieldNames = Object.keys(allFields);

    // Procurar campo IE
    var ieCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'inscr_est' || fl === 'l10n_br_ie' ||
             fl.indexOf('inscricao_estadual') >= 0 ||
             fl.indexOf('inscr_est') >= 0 ||
             (fl.indexOf('ie') >= 0 && fl.indexOf('x_studio') >= 0 && fl.indexOf('email') < 0 && fl.indexOf('field') < 0);
    });
    // Prioridade: inscr_est > l10n_br_ie > x_studio_*
    ieCandidates.sort(function(a, b) {
      if (a === 'inscr_est') return -1;
      if (b === 'inscr_est') return 1;
      if (a === 'l10n_br_ie') return -1;
      if (b === 'l10n_br_ie') return 1;
      return a.localeCompare(b);
    });
    _discoveredIeField = ieCandidates.length > 0 ? ieCandidates[0] : false;

    // Procurar campo CNPJ/CPF (alem de cnpj_cpf e vat)
    var cnpjCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'cnpj_cpf' || fl === 'l10n_br_cnpj_cpf' ||
             (fl.indexOf('cnpj') >= 0 && fl.indexOf('x_studio') >= 0);
    });
    _discoveredCnpjField = cnpjCandidates.length > 0 ? cnpjCandidates[0] : false;

    // Procurar campo razao social (alem de legal_name)
    var nameCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'legal_name' || fl === 'l10n_br_legal_name' ||
             (fl.indexOf('razao_social') >= 0 || fl.indexOf('legal_name') >= 0) && fl.indexOf('x_studio') >= 0;
    });
    _discoveredLegalNameField = nameCandidates.length > 0 ? nameCandidates[0] : false;

    // Procurar campo numero do endereco
    var numCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'number' || fl === 'l10n_br_number' ||
             (fl.indexOf('numero') >= 0 && fl.indexOf('x_studio') >= 0);
    });
    _discoveredNumberField = numCandidates.length > 0 ? numCandidates[0] : false;

    console.log('[SIEG-EMIT] [DISCOVERY] Campos IE: ' + JSON.stringify(ieCandidates) + ' -> usando: ' + (_discoveredIeField || 'nenhum'));
    console.log('[SIEG-EMIT] [DISCOVERY] Campos CNPJ: ' + JSON.stringify(cnpjCandidates) + ' -> usando: ' + (_discoveredCnpjField || 'vat'));
    if (_discoveredLegalNameField) console.log('[SIEG-EMIT] [DISCOVERY] Razao social: ' + _discoveredLegalNameField);
    if (_discoveredNumberField && _discoveredNumberField !== 'number') console.log('[SIEG-EMIT] [DISCOVERY] Numero endereco: ' + _discoveredNumberField);
  } catch (e) {
    console.warn('[SIEG-EMIT] [DISCOVERY] Erro ao descobrir campos: ' + e.message);
    _discoveredIeField = false;
    _discoveredCnpjField = false;
    _discoveredLegalNameField = false;
    _discoveredNumberField = false;
  }
}

async function readPartnerSafe(client, db, uid, pwd, partnerId, extraFields) {
  var fields = PARTNER_SAFE_FIELDS.slice();
  if (extraFields) fields = fields.concat(extraFields);
  var recs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], fields]);
  if (!recs || !recs.length) throw new Error('Parceiro ' + partnerId + ' nao encontrado');
  var p = recs[0];
  // Try Brazilian fields separately
  try {
    var brRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], PARTNER_BR_FIELDS]);
    if (brRecs && brRecs[0]) {
      for (var k in brRecs[0]) { if (brRecs[0][k] !== undefined) p[k] = brRecs[0][k]; }
    }
  } catch (e) {
    console.log('[SIEG-EMIT] Campos l10n_br nao disponiveis, usando vat como CNPJ/CPF');
  }

  // AJL 21/10/2026: campo do cadastro com o codigo IBGE do municipio (NF-e).
  // Leitura separada: o campo pode nao existir em outro ambiente Odoo.
  try {
    var munRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], ['x_studio_codigo_municipio']]);
    if (munRecs && munRecs[0]) p.x_studio_codigo_municipio = munRecs[0].x_studio_codigo_municipio || '';
  } catch (eMun) {
    console.log('[SIEG-EMIT] Campo x_studio_codigo_municipio nao disponivel (segue sem ele)');
  }

  // Discovery: tenta encontrar campos IE/CNPJ/razao social via fields_get
  await discoverPartnerFields(client, db, uid, pwd);

  // Leitura direta da Inscricao Estadual do Odoo Brasil
  // Separada dos demais campos l10n_br para nao falhar se outro campo opcional nao existir.
  if (p.inscr_est === undefined || p.inscr_est === null || String(p.inscr_est).trim() === "") {
    try {
      var ieDirectRecs = await executeKw(client, db, uid, pwd, "res.partner", "read", [[partnerId], ["l10n_br_ie_code"]]);
      if (ieDirectRecs && ieDirectRecs[0] && ieDirectRecs[0].l10n_br_ie_code) {
        p.inscr_est = ieDirectRecs[0].l10n_br_ie_code;
        console.log("[SIEG-EMIT] [DEST-IE] IE lida diretamente de l10n_br_ie_code = " + p.inscr_est);
      }
    } catch (e) {
      console.warn("[SIEG-EMIT] [DEST-IE] Leitura direta de l10n_br_ie_code falhou: " + e.message);
    }
  }

  // Se inscr_est ainda vazio, tenta campo descoberto
  if ((!p.inscr_est || String(p.inscr_est).trim() === '') && _discoveredIeField && _discoveredIeField !== 'inscr_est') {
    try {
      var ieRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], [_discoveredIeField]]);
      if (ieRecs && ieRecs[0] && ieRecs[0][_discoveredIeField]) {
        p.inscr_est = ieRecs[0][_discoveredIeField];
        console.log('[SIEG-EMIT] [DEST-IE] IE lida do campo descoberto: ' + _discoveredIeField + ' = ' + p.inscr_est);
      }
    } catch (e) {
      console.warn('[SIEG-EMIT] [DEST-IE] Campo descoberto ' + _discoveredIeField + ' falhou: ' + e.message);
    }
  }

  // Se cnpj_cpf ainda vazio, tenta campo descoberto
  if ((!p.cnpj_cpf || String(p.cnpj_cpf).trim() === '') && _discoveredCnpjField) {
    try {
      var cnpjRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], [_discoveredCnpjField]]);
      if (cnpjRecs && cnpjRecs[0] && cnpjRecs[0][_discoveredCnpjField]) {
        p.cnpj_cpf = cnpjRecs[0][_discoveredCnpjField];
      }
    } catch (e) {}
  }

  // Se legal_name ainda vazio, tenta campo descoberto
  if ((!p.legal_name || String(p.legal_name).trim() === '') && _discoveredLegalNameField) {
    try {
      var nameRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], [_discoveredLegalNameField]]);
      if (nameRecs && nameRecs[0] && nameRecs[0][_discoveredLegalNameField]) {
        p.legal_name = nameRecs[0][_discoveredLegalNameField];
      }
    } catch (e) {}
  }

  return p;
}

async function readPartner(client, db, uid, pwd, partnerId) {
  var p = await readPartnerSafe(client, db, uid, pwd, partnerId);

  var stateCode = '';
  var stId = tupId(p.state_id);
  if (stId) {
    try {
      var sts = await executeKw(client, db, uid, pwd, 'res.country.state', 'read', [[stId], ['code']]);
      if (sts && sts[0]) stateCode = sts[0].code || '';
    } catch (e) {}
  }

  var cityIbge = '';
  var cityRef = p.l10n_br_city_id || p.city_id;
  if (cityRef && Array.isArray(cityRef)) cityIbge = await readCityIbge(client, db, uid, pwd, cityRef[0]);

  // AJL 21/10/2026: a tabela IBGE 2026 gravada no middleware manda sobre o Odoo.
  // Se o codigo do Odoo divergir (ou faltar) -> usa o da tabela (fix rejeicao 274).
  var tabelaIbgeDest = ibgeMunicipios.lookup(stateCode, p.city);
  if (tabelaIbgeDest) {
    if (cityIbge && cityIbge !== tabelaIbgeDest) {
      console.log('[SIEG-EMIT] cMun DEST CORRIGIDO pela tabela IBGE: %s/%s %s -> %s', p.city, stateCode, cityIbge, tabelaIbgeDest);
    } else if (!cityIbge) {
      console.log('[SIEG-EMIT] cMun DEST da tabela IBGE: %s/%s = %s', p.city, stateCode, tabelaIbgeDest);
    }
    cityIbge = tabelaIbgeDest;
  }

  // AJL 21/10/2026 (pedido Renan): campo x_studio_codigo_municipio no cadastro
  // do cliente MANDA como cMun — APENAS para PARANA. Prioridade maxima,
  // acima da tabela IBGE e do codigo vindo do Odoo (deterministico).
  var campoMunDest = String(p.x_studio_codigo_municipio || '').replace(/\D/g, '');
  var ufDest = String(stateCode || '').toUpperCase();
  if ((ufDest === 'PR' || ufDest === 'SC') && campoMunDest.length === 7) {
    if (cityIbge !== campoMunDest) {
      console.log('[SIEG-EMIT] cMun DEST pelo campo do cadastro (' + ufDest + '): %s/%s %s -> %s', p.city, stateCode, cityIbge || '(vazio)', campoMunDest);
    }
    cityIbge = campoMunDest;
  }

  // Fallback 1: buscar res.city por nome + estado
  if (!cityIbge && p.city && stateCode) {
    cityIbge = await searchCityIbge(client, db, uid, pwd, p.city, stId);
  }
  // Fallback 2: tabela embutida de cidades principais
  if (!cityIbge && p.city && stateCode) {
    cityIbge = lookupIbgeFallback(p.city, stateCode);
  }
  if (!cityIbge) {
    console.warn('[SIEG-EMIT] cMun vazio para parceiro ' + partnerId + ' (' + (p.name || '?') + '): cidade=' + (p.city || '?') + ' UF=' + (stateCode || '?'));
  }

  return {
    cnpj_cpf: p.cnpj_cpf || p.vat || '',
    legal_name: p.legal_name || p.name || '',
    xNome: p.name || '',
    inscr_est: p.inscr_est || p.l10n_br_ie_code || p[_discoveredIeField] || '',
    street: p.street || '',
    number: p.number || 'S/N',
    street2: p.street2 || p.district || '',
    city: p.city || '',
    state: stateCode,
    zip: p.zip || '',
    city_ibge_code: cityIbge,
    phone: p.phone || '',
    email: p.email || '',
    is_consumer: !p.is_company,
    district: p.district || p.street2 || '',
  };
}

// ============================================================
// NCM Extraction Helper
// ============================================================
/**
 * Extrai codigo NCM (8 digitos) de um valor many2one do Odoo.
 * Aceita: [id, "7308.90.90"], [id, "7308.90.90 - Descricao"], string pura, numero
 */
function extractNcmFromRef(ref) {
  if (!ref) return '';
  var str = '';
  if (Array.isArray(ref)) {
    str = String(ref[1] || ref[0] || '');
  } else if (typeof ref === 'string') {
    str = ref;
  } else if (typeof ref === 'number') {
    return String(ref).length === 8 ? String(ref) : '';
  } else {
    str = String(ref);
  }
  // Tentar regex NNNN.NN.NN
  var m = str.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (m) return m[1] + m[2] + m[3];
  // Fallback: so digitos
  var digits = str.replace(/\D/g, '');
  return digits.length === 8 ? digits : '';
}

// ============================================================
// Build Line Data (with product x_studio_ fields for NFS-e)
// ============================================================
async function buildLineData(client, db, uid, pwd, line, icmsInternoPR) {
  // icmsInternoPR: aliquota ICMS interna do emitente (PR: IE=12%, sem IE/CPF=19.5%)
  // Fallback defensivo caso chamador nao passe (evita ReferenceError)
  if (typeof icmsInternoPR === 'undefined' || icmsInternoPR === null || isNaN(parseFloat(icmsInternoPR))) {
    icmsInternoPR = 12; // PR com IE (caso mais comum das vendas AJL)
    console.warn('[SIEG-EMIT] buildLineData sem icmsInternoPR — usando fallback 12%');
  } else {
    icmsInternoPR = parseFloat(icmsInternoPR);
  }
  var productId = tupId(line.product_id);
  var productName = Array.isArray(line.product_id) ? line.product_id[1] : (line.name || 'Item');
  var defaultCode = '', barcode = '', ncm = '', detailedType = 'product', uomName = 'UN';
  var prodStudio = {}; // x_studio_ fields from product

  if (productId) {
    try {
      // Campos core do produto (sempre existem) — SEM detailed_type (pode nao existir no SaaS)
      var prods = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], [
        'default_code', 'barcode', 'name', 'uom_id',
      ]]);
      if (prods && prods[0]) {
        var pr = prods[0];
        defaultCode = pr.default_code || '';
        barcode = pr.barcode || '';
        productName = pr.name || productName;
        if (pr.uom_id && Array.isArray(pr.uom_id)) uomName = pr.uom_id[1] || 'UN';
      }

      // Campo detailed_type (pode nao existir no Odoo 19 SaaS)
      try {
        var prodsDt = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['detailed_type']]);
        if (prodsDt && prodsDt[0] && prodsDt[0].detailed_type) detailedType = prodsDt[0].detailed_type;
      } catch (eDt) {
        console.log('[SIEG-EMIT] detailed_type nao disponivel, usando product');
      }

      // NCM do produto
      // Campo correto no Odoo 19 SaaS com l10n_br: l10n_br_ncm_code_id (many2one -> l10n_br.ncm.code)
      // Este campo esta em product.template (nao product.product)
      // Estrategia:
      //   T1: Ler product_tmpl_id + l10n_br_ncm_code_id do template
      //   T2: Tentar ncm_id em product.product (l10n_br_fiscal — pode nao existir)
      //   T3: fields_get para descobrir campo NCM alternativo

      // === T1: Ler l10n_br_ncm_code_id do product.template ===
      try {
        console.log('[SIEG-EMIT-NCM] [T1] Lendo product_tmpl_id + l10n_br_ncm_code_id...');
        var prodsTmpl = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['product_tmpl_id']]);
        if (prodsTmpl && prodsTmpl[0] && prodsTmpl[0].product_tmpl_id) {
          var tmplId = tupId(prodsTmpl[0].product_tmpl_id);
          console.log('[SIEG-EMIT-NCM] [T1] product_tmpl_id: ' + tmplId);
          var tmplNcm = await executeKw(client, db, uid, pwd, 'product.template', 'read', [[tmplId], ['l10n_br_ncm_code_id']]);
          console.log('[SIEG-EMIT-NCM] [T1] l10n_br_ncm_code_id bruto: ' + JSON.stringify(tmplNcm && tmplNcm[0] ? tmplNcm[0].l10n_br_ncm_code_id : 'N/A'));
          if (tmplNcm && tmplNcm[0] && tmplNcm[0].l10n_br_ncm_code_id) {
            ncm = extractNcmFromRef(tmplNcm[0].l10n_br_ncm_code_id);
            if (ncm) console.log('[SIEG-EMIT-NCM] [T1] *** NCM ENCONTRADO: ' + ncm + ' ***');
          } else {
            console.warn('[SIEG-EMIT-NCM] [T1] l10n_br_ncm_code_id vazio no template ' + tmplId);
          }
        } else {
          console.warn('[SIEG-EMIT-NCM] [T1] product_tmpl_id vazio para produto ' + productId);
        }
      } catch (eT1) {
        console.error('[SIEG-EMIT-NCM] [T1] FALHOU: ' + eT1.message);
      }

      // === T2: Tentar ncm_id em product.product (l10n_br_fiscal) ===
      if (!ncm) {
        try {
          console.log('[SIEG-EMIT-NCM] [T2] Tentando ncm_id em product.product...');
          var prodsNcm = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['ncm_id']]);
          if (prodsNcm && prodsNcm[0] && prodsNcm[0].ncm_id) {
            ncm = extractNcmFromRef(prodsNcm[0].ncm_id);
            if (ncm) console.log('[SIEG-EMIT-NCM] [T2] NCM via ncm_id: ' + ncm);
          }
        } catch (eT2) {
          console.log('[SIEG-EMIT-NCM] [T2] ncm_id nao disponivel: ' + eT2.message);
        }
      }

      // === T3: Descobrir campos NCM via fields_get ===
      if (!ncm) {
        try {
          console.log('[SIEG-EMIT-NCM] [T3] Buscando campos NCM via fields_get...');
          var fieldsInfo = await executeKw(client, db, uid, pwd, 'product.template', 'fields_get', [
            ['l10n_br_ncm_code_id', 'ncm_id', 'l10n_br_ncm_id', 'ncm_code_id'],
            ['type', 'relation', 'string']
          ]);
          console.log('[SIEG-EMIT-NCM] [T3] fields_get: ' + JSON.stringify(fieldsInfo));
          var fieldNames = Object.keys(fieldsInfo || {});
          for (var fi = 0; fi < fieldNames.length; fi++) {
            var fname = fieldNames[fi];
            if (fieldsInfo[fname].type === 'many2one') {
              try {
                var fv = await executeKw(client, db, uid, pwd, 'product.template', 'read', [[tmplId], [fname]]);
                if (fv && fv[0] && fv[0][fname]) {
                  var extracted = extractNcmFromRef(fv[0][fname]);
                  if (extracted) {
                    ncm = extracted;
                    console.log('[SIEG-EMIT-NCM] [T3] NCM via ' + fname + ': ' + ncm);
                    break;
                  }
                }
              } catch (ef3) {
                console.log('[SIEG-EMIT-NCM] [T3] ' + fname + ' falhou: ' + ef3.message);
              }
            }
          }
        } catch (eT3) {
          console.error('[SIEG-EMIT-NCM] [T3] FALHOU: ' + eT3.message);
        }
      }

      // x_studio fields documentados neste Odoo (NFS-e e customizacoes)
      try {
        var prods2 = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], [
          'x_studio_c_trib_nac', 'x_studio_c_nbs', 'x_studio_aliquota_iss', 'x_studio_ibge_code',
          'x_studio_peso', 'weight',
        ]]);
        if (prods2 && prods2[0]) {
          var pr2 = prods2[0];
          prodStudio = {
            c_trib_nac: pr2.x_studio_c_trib_nac || '',
            c_nbs: pr2.x_studio_c_nbs || '',
            aliquota_iss: pr2.x_studio_aliquota_iss || '',
            ibge_code: pr2.x_studio_ibge_code || '',
            peso_unitario: pr2.x_studio_peso || pr2.weight || 0,
          };
        }
      } catch (e2) {
        console.log('[SIEG-EMIT] Campos x_studio do produto nao disponiveis: ' + e2.message);
      }
      // Fallback final: NCM do env var (se configurado)
      if (!ncm && process.env.SIEG_DEFAULT_NCM) {
        ncm = String(process.env.SIEG_DEFAULT_NCM).replace(/\D/g, '');
        console.log('[SIEG-EMIT-NCM] NCM via SIEG_DEFAULT_NCM env: ' + ncm);
      }
      // ALERTA se NCM ainda vazio
      if (!ncm) {
        console.error('[SIEG-EMIT-NCM] *** NCM VAZIO para produto ' + productId + ' (' + productName + ') — XML sera invalido ***');
      }
    } catch (e) { console.warn('[SIEG-EMIT] Erro ao ler produto ' + productId + ':', e.message); }
  }

  // Tax extraction (inclui deteccao de IPI nos tax_ids do Odoo)
  // IMPOSTOS POR DENTRO (price_include=true): ICMS/Difal/PIS/COFINS etc. nao
  // somam no total. O valor BRUTO da linha (vProd fiscal) = price_subtotal x
  // PI(1 + aliquota/100) dos impostos incluidos. Todas as bases fiscais
  // (vBC ICMS, vBC IPI, PIS/COFINS) usam o bruto — nunca o subtotal liquido.
  var taxInfo = await readLineTaxesInfo(client, db, uid, pwd, line);
  var grossSubtotal = taxInfo.gross;
  var tax = await extractTaxes(client, db, uid, pwd, line, icmsInternoPR, taxInfo.taxes, grossSubtotal);

  // Alíquota DIFAL declarada nos tax_ids da linha (ex: AUTO DIFAL DIFAL PR 5%)
  // — usada apenas como texto informativo no infCpl; NUNCA soma no total.
  var difalAliquota = 0;
  for (var dxi = 0; dxi < taxInfo.taxes.length; dxi++) {
    var dtx = taxInfo.taxes[dxi];
    if (((dtx.name || dtx.description || '').toUpperCase().indexOf('DIFAL') >= 0) && parseFloat(dtx.amount) > 0) {
      difalAliquota += parseFloat(dtx.amount);
    }
  }

  // IPI extraction: tentar 1) tax_ids da invoice line, 2) x_studio_ fields do produto
  var cstIpi = '', vbcIpi = '0.00', pipi = '0.00', vipi = '0.00', cenq = '999';
  var ipiFromTaxIds = false;
  
  // ESTRATÉGIA 1: Ler IPI dos tax_ids da invoice line (mais confiável)
  var lineTaxes = taxInfo.taxes;
  if (lineTaxes.length > 0) {
    for (var txi = 0; txi < lineTaxes.length; txi++) {
      var tx = lineTaxes[txi];
      var txName = ((tx.name || tx.description || '').toUpperCase());
      var txAmt = parseFloat(tx.amount) || 0;
      if ((txName.indexOf('IPI') >= 0) && txAmt > 0) {
        // Encontrou IPI nos tax_ids da invoice line!
        pipi = String(txAmt);
        cstIpi = '00'; // CST 00 = tributado
        ipiFromTaxIds = true;
        console.log('[SIEG-EMIT-IPI] IPI encontrado nos tax_ids: aliquota=' + txAmt + '% tax=' + txName + ' price_include=' + !!tx.price_include);
        break;
      }
    }
  }
  
  // ESTRATÉGIA 2: Se não encontrou nos tax_ids, ler x_studio_ fields do produto
  if (!ipiFromTaxIds && productId) {
    try {
      var ipiFields = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], [
        'x_studio_cst_ipi', 'x_studio_aliquota_ipi',
      ]]);
      if (ipiFields && ipiFields[0]) {
        if (!cstIpi) cstIpi = String(ipiFields[0].x_studio_cst_ipi || '').replace(/\D/g, '');
        if (!ipiFromTaxIds) pipi = String(ipiFields[0].x_studio_aliquota_ipi || '0');
      }
    } catch (eIpi) {
      try {
        var tmplIpi = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['product_tmpl_id']]);
        if (tmplIpi && tmplIpi[0] && tmplIpi[0].product_tmpl_id) {
          var tmplIdIpi = tupId(tmplIpi[0].product_tmpl_id);
          var tmplIpiFields = await executeKw(client, db, uid, pwd, 'product.template', 'read', [[tmplIdIpi], [
            'x_studio_cst_ipi', 'x_studio_aliquota_ipi',
          ]]);
          if (tmplIpiFields && tmplIpiFields[0]) {
            if (!cstIpi) cstIpi = String(tmplIpiFields[0].x_studio_cst_ipi || '').replace(/\D/g, '');
            if (!ipiFromTaxIds) pipi = String(tmplIpiFields[0].x_studio_aliquota_ipi || '0');
          }
        }
      } catch (e2) {}
    }
  }
  
  // Calculate IPI values
  // vBC do IPI = valor BRUTO do produto (vProd fiscal, sem IPI) — nunca o
  // subtotal liquido do Odoo (que fica menor quando ha imposto por dentro).
  if (cstIpi && ['00','49','50','99'].includes(cstIpi.padStart(2, '0')) && parseFloat(pipi) > 0) {
    vbcIpi = String(grossSubtotal);
    vipi = String(round2(grossSubtotal * parseFloat(pipi) / 100));
    console.log('[SIEG-EMIT-IPI] IPI calculado: vBC=' + vbcIpi + ' pIPI=' + pipi + '% vIPI=' + vipi);
  } else if (!cstIpi && parseFloat(pipi) > 0) {
    // Tem alíquota mas sem CST - usar CST 00 como default
    cstIpi = '00';
    vbcIpi = String(grossSubtotal);
    vipi = String(round2(grossSubtotal * parseFloat(pipi) / 100));
    console.log('[SIEG-EMIT-IPI] IPI sem CST, usando CST 00: vBC=' + vbcIpi + ' pIPI=' + pipi + '% vIPI=' + vipi);
  }

  var lineData = {
    cProd: defaultCode, barcode: barcode,
    product_name: productName, xProd: productName,
    ncm: ncm, cfop: '5102', uom: uomName,
    qty: line.quantity || 0, price_unit: line.price_unit || 0,
    // price_subtotal aqui = valor BRUTO fiscal (vProd): subtotal Odoo x impostos
    // por dentro. Somente IPI soma depois (vNF = vProd + vIPI).
    price_subtotal: grossSubtotal || (line.price_subtotal || (line.quantity * line.price_unit)),
    detailed_type: detailedType,
    // Tributação Lucro Real (padrão) — sobrescrito se Odoo tiver impostos configurados
    csosn: tax.csosn || '',
    cst_icms: tax.cst_icms || '00',
    mod_bc: tax.mod_bc || '3',
    orig: '0',
    vbc_icms: String(tax.vbc || 0),
    vicms: String(tax.vicms || 0),
    picms: String(tax.picms || 0),
    cst_pis: tax.cst_pis || '01',
    vbc_pis: String(tax.vbc_pis || 0),
    ppis: String(tax.ppis || 0),
    vpis: String(tax.vpis || 0),
    cst_cofins: tax.cst_cofins || '01',
    vbc_cofins: String(tax.vbc_cofins || 0),
    pcofins: String(tax.pcofins || 0),
    vcofins: String(tax.vcofins || 0),
    // IPI
    cst_ipi: cstIpi || '',
    vbc_ipi: vbcIpi,
    pipi: pipi,
    vipi: vipi,
    cenq: cenq,
    // NFS-e fields from product
    x_studio_c_trib_nac: prodStudio.c_trib_nac,
    x_studio_c_nbs: prodStudio.c_nbs,
    x_studio_aliquota_iss: prodStudio.aliquota_iss,
    x_studio_ibge_code: prodStudio.ibge_code,
    // Peso unitário do produto (para cálculo peso total = peso_unitário × qtd)
    peso_unitario: prodStudio.peso_unitario || 0,
    // DIFAL (informativo, nao soma no total)
    difal_aliquota: difalAliquota,
  };

  // === LOG DETALHADO POR CAMPO (para debug de XML invalido) ===
  console.log('[SIEG-EMIT-LINE] === Dados da linha (product ' + productId + ') ===');
  console.log('[SIEG-EMIT-LINE]   cProd:      ' + JSON.stringify(lineData.cProd) + (lineData.cProd ? '' : ' *** VAZIO ***'));
  console.log('[SIEG-EMIT-LINE]   xProd:      ' + JSON.stringify(lineData.xProd));
  console.log('[SIEG-EMIT-LINE]   NCM:        ' + JSON.stringify(lineData.ncm) + (lineData.ncm ? '' : ' *** VAZIO ***'));
  console.log('[SIEG-EMIT-LINE]   CFOP:       ' + JSON.stringify(lineData.cfop));
  console.log('[SIEG-EMIT-LINE]   uCom:       ' + JSON.stringify(lineData.uom));
  console.log('[SIEG-EMIT-LINE]   qCom:       ' + lineData.qty);
  console.log('[SIEG-EMIT-LINE]   vUnCom:     ' + lineData.price_unit);
  console.log('[SIEG-EMIT-LINE]   vProd:      ' + lineData.price_subtotal);
  console.log('[SIEG-EMIT-LINE]   CSOSN:      ' + JSON.stringify(lineData.csosn));
  console.log('[SIEG-EMIT-LINE]   CST_ICMS:   ' + JSON.stringify(lineData.cst_icms));
  console.log('[SIEG-EMIT-LINE]   modBC:      ' + JSON.stringify(lineData.mod_bc));
  console.log('[SIEG-EMIT-LINE]   vBC_ICMS:   ' + lineData.vbc_icms);
  console.log('[SIEG-EMIT-LINE]   vICMS:      ' + lineData.vicms);
  console.log('[SIEG-EMIT-LINE]   pICMS:      ' + lineData.picms);
  console.log('[SIEG-EMIT-LINE]   CST_PIS:    ' + JSON.stringify(lineData.cst_pis));
  console.log('[SIEG-EMIT-LINE]   vBC_PIS:    ' + lineData.vbc_pis);
  console.log('[SIEG-EMIT-LINE]   pPIS:       ' + lineData.ppis);
  console.log('[SIEG-EMIT-LINE]   vPIS:       ' + lineData.vpis);
  console.log('[SIEG-EMIT-LINE]   CST_COFINS: ' + JSON.stringify(lineData.cst_cofins));
  console.log('[SIEG-EMIT-LINE]   vBC_COFINS: ' + lineData.vbc_cofins);
  console.log('[SIEG-EMIT-LINE]   pCOFINS:    ' + lineData.pcofins);
  console.log('[SIEG-EMIT-LINE]   vCOFINS:    ' + lineData.vcofins);
  console.log('[SIEG-EMIT-LINE]   CST_IPI:    ' + JSON.stringify(lineData.cst_ipi));
  console.log('[SIEG-EMIT-LINE]   vBC_IPI:    ' + lineData.vbc_ipi);
  console.log('[SIEG-EMIT-LINE]   pIPI:       ' + lineData.pipi);
  console.log('[SIEG-EMIT-LINE]   vIPI:       ' + lineData.vipi);

  return lineData;
}

// ============================================================
// Build Service Block for NFS-e (reads from product x_studio_ fields)
// ============================================================
function buildServiceBlock(linesData, move) {
  // Use first service line's x_studio_ fields
  var cTribNac = '';
  var cNBS = '999999999';
  var pAliq = '2.00';
  var cIntContrib = '';
  var xDescServ = move.narration || 'Servico prestado conforme contrato';

  for (var i = 0; i < linesData.length; i++) {
    var l = linesData[i];
    if (l.x_studio_c_trib_nac) cTribNac = l.x_studio_c_trib_nac;
    if (l.x_studio_c_nbs) cNBS = l.x_studio_c_nbs;
    if (l.x_studio_aliquota_iss) pAliq = String(l.x_studio_aliquota_iss);
    if (l.x_studio_ibge_code) cIntContrib = l.x_studio_ibge_code;
  }

  if (!cTribNac) cTribNac = '140101';

  return {
    cTribNac: cTribNac,
    xDescServ: xDescServ,
    cNBS: cNBS,
    cIntContrib: cIntContrib,
    valor: move.amount_total,
    pAliq: pAliq,
    tpRetISSQN: '1',
    pTotTribFed: '13.45',
    pTotTribEst: '0.00',
    pTotTribMun: '3.29',
  };
}

// ============================================================
// Tax Extraction
// ============================================================
/**
 * Le os impostos da linha UMA unica vez e calcula o valor BRUTO fiscal.
 * Impostos com price_include=true (ICMS/Difal/PIS/COFINS...) estao dentro
 * do preco e NAO somam no total. O bruto (vProd fiscal) reconstrói o valor
 * de tabela: bruto = subtotal Odoo x PI(1 + aliquota/100) dos incluidos.
 * Retorna { taxes: [...], includedFactor, gross }
 */
async function readLineTaxesInfo(client, db, uid, pwd, line) {
  var lineTaxIds = (line.tax_ids || []).map(function(t) { return Array.isArray(t) ? t[0] : t; }).filter(Boolean);
  var taxes = [];
  var includedFactor = 1;
  if (lineTaxIds.length > 0) {
    try {
      taxes = await executeKw(client, db, uid, pwd, 'account.tax', 'read', [lineTaxIds, [
        'name', 'amount', 'amount_type', 'description',
        'price_include', 'include_base_amount', 'sequence',
      ]]);
      // Ordena como o Odoo aplica (sequence, id) — compound na mesma ordem
      taxes.sort(function(a, b) {
        var s = (a.sequence || 0) - (b.sequence || 0);
        return s !== 0 ? s : (a.id - b.id);
      });
      for (var i = 0; i < taxes.length; i++) {
        var t = taxes[i];
        if (t.price_include && t.amount_type === 'percent' && parseFloat(t.amount)) {
          includedFactor *= (1 + parseFloat(t.amount) / 100);
        }
      }
    } catch (e) {
      console.warn('[SIEG-EMIT] Erro ao ler account.tax da linha: ' + e.message);
      taxes = [];
    }
  }
  var rawSubtotal = parseFloat(line.price_subtotal) || (parseFloat(line.quantity) * parseFloat(line.price_unit)) || 0;
  var gross = round2(rawSubtotal * includedFactor);
  if (includedFactor > 1.000001) {
    console.log('[SIEG-EMIT] Linha c/ imposto por dentro: subtotal=' + rawSubtotal.toFixed(2) +
      ' fator=' + includedFactor.toFixed(6) + ' -> bruto(vProd)=' + gross.toFixed(2));
  }
  return { taxes: taxes, includedFactor: includedFactor, gross: gross };
}

async function extractTaxes(client, db, uid, pwd, line, icmsInternoPR, lineTaxes, grossBase) {
  // Padrão: Lucro Real (CRT 3) — CST 00, ICMS conforme regra PR
  // Com IE → 12%, sem IE/CPF → 19.5%, interestadual → 12%/7% (Difal)
  // PIS/COFINS não-cumulativo com base no valor do produto
  // BASE = valor BRUTO fiscal (grossBase) — impostos por dentro fazem parte
  // do preço; ICMS "por dentro" incide sobre o valor cheio do produto.
  var defaultIcms = icmsInternoPR || 18; // fallback 18% se não informado
  var base = (typeof grossBase === 'number' && grossBase > 0)
    ? grossBase
    : (parseFloat(line.price_subtotal) || 0);
  // Arredondamento: SEFAZ exige 2 casas decimais por item.
  // Se nao arredondar aqui, o total pode divergir (cStat 602/603).
  var r2 = function(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; };
  var result = {
    csosn: '',
    cst_icms: '00',
    mod_bc: '3',
    vbc: r2(base),
    vicms: r2(base * (defaultIcms / 100)),
    picms: defaultIcms,
    cst_pis: '01',
    vbc_pis: r2(base),
    ppis: 1.65,
    vpis: r2(base * 0.0165),
    cst_cofins: '01',
    vbc_cofins: r2(base),
    pcofins: 7.60,
    vcofins: r2(base * 0.076),
  };

  var taxes = (lineTaxes && lineTaxes.length) ? lineTaxes : [];
  if (!taxes.length) {
    var taxIds = (line.tax_ids || []).map(function(t) { return Array.isArray(t) ? t[0] : t; }).filter(Boolean);
    if (!taxIds.length) return result;
    try {
      taxes = await executeKw(client, db, uid, pwd, 'account.tax', 'read', [taxIds, [
        'name', 'amount', 'amount_type', 'description',
      ]]);
    } catch (e) { console.warn('[SIEG-EMIT] Erro ao extrair impostos:', e.message); taxes = []; }
  }
  if (!taxes || !taxes.length) return result;

  var totalIcms = 0, totalPis = 0, totalCofins = 0;
  var foundCsosn = '';

  for (var i = 0; i < taxes.length; i++) {
    var tax = taxes[i];
    var n = ((tax.name || tax.description || '').toUpperCase());
    var amt = parseFloat(tax.amount) || 0;
    if (n.indexOf('ICMS') >= 0 || n.indexOf('CSOSN') >= 0) {
      totalIcms += amt;
      var m = n.match(/(10[0-9]|20[0-9]|300|400|500|900)/);
      if (m) foundCsosn = m[1];
    } else if (n.indexOf('PIS') >= 0) { totalPis += amt; }
    else if (n.indexOf('COFINS') >= 0) { totalCofins += amt; }
  }

  // Sobrescreve defaults apenas se o Odoo tiver impostos reais configurados (> 0)
  if (foundCsosn) {
    result.csosn = foundCsosn;
    result.cst_icms = '';
  }
  if (totalIcms > 0) {
    result.picms = totalIcms;
    result.vicms = r2(base * (totalIcms / 100));
  }
  if (totalPis > 0) {
    result.ppis = totalPis;
    result.vpis = r2(base * (totalPis / 100));
  }
  if (totalCofins > 0) {
    result.pcofins = totalCofins;
    result.vcofins = r2(base * (totalCofins / 100));
  }

  return result;
}

// ============================================================
// Helpers
// ============================================================
function parseResult(resultado, tipo) {
  var resp = resultado.resposta || {};
  var chave = '', protocolo = '', cStat = '', motivo = '', numero = '', sucesso = false;

  // Se SIEG retornou HTTP 4xx, usar ErrorMessage diretamente como motivo
  var siegErro = resultado.erro || '';
  if (resultado.httpStatus && resultado.httpStatus >= 400 && resultado.httpStatus < 500) {
    // Erro de validacao do XML — extrair mensagem do SIEG
    motivo = siegErro || 'Erro HTTP ' + resultado.httpStatus;
    if (tipo === 'nfe') {
      cStat = String(resultado.statusCode || resp.cStat || resp.status || '');
    }
    return { sucesso: false, chave: chave, protocolo: protocolo, cStat: cStat, motivo: motivo, numero: numero };
  }

  if (tipo === 'nfe') {
    chave = resp.chNFe || resp.chave || resp.ChaveXml || '';
    protocolo = resp.nProt || resp.protocolo || '';
    cStat = String(resp.cStat || resp.status || '');
    motivo = resp.xMotivo || resp.motivo || (siegErro || 'Processado');
    sucesso = (cStat === '100' || cStat === '104' || cStat === '150');
  } else {
    chave = resp.Chave || resp.chave || '';
    protocolo = resp.Protocolo || resp.protocolo || '';
    numero = resp.NumeroNfse || resp.nDFSe || resp.numero || '';
    cStat = String(resp.CodigoVerificacao || resp.codigo || '');
    motivo = resp.Motivo || resp.motivo || siegErro || (resultado.sucesso ? 'Autorizada' : 'Erro na emissao');
    sucesso = resultado.sucesso;
  }

  return { sucesso: sucesso, chave: chave, protocolo: protocolo, cStat: cStat, motivo: motivo, numero: numero };
}

async function readCityIbge(client, db, uid, pwd, cityId) {
  // Tenta varios nomes de campo IBGE possiveis no Odoo
  var ibgeFields = ['x_ibge_code', 'ibge_code', 'code', 'l10n_br_ibge_code', 'x_studio_ibge_code'];
  for (var i = 0; i < ibgeFields.length; i++) {
    try {
      var c = await executeKw(client, db, uid, pwd, 'res.city', 'read', [[cityId], [ibgeFields[i]]]);
      if (c && c[0] && c[0][ibgeFields[i]]) {
        var val = String(c[0][ibgeFields[i]]);
        if (val.length === 7 && /^\d{7}$/.test(val)) {
          if (ibgeFields[i] !== 'ibge_code') console.log('[SIEG-EMIT] IBGE lido de res.city.' + ibgeFields[i] + ': ' + val);
          return val;
        }
      }
    } catch (e) {}
  }
  // Tenta l10n_br.city
  try {
    var c2 = await executeKw(client, db, uid, pwd, 'l10n_br.city', 'read', [[cityId], ['ibge_code']]);
    if (c2 && c2[0] && c2[0].ibge_code) return String(c2[0].ibge_code);
  } catch (e2) {}
  return '';
}

/**
 * Busca IBGE de cidade pelo nome e estado_id no Odoo
 */
async function searchCityIbge(client, db, uid, pwd, cityName, stateId) {
  if (!cityName || !stateId) return '';
  try {
    var domain = [['name', 'ilike', cityName]];
    if (stateId) domain.push(['state_id', '=', stateId]);
    var ids = await executeKw(client, db, uid, pwd, 'res.city', 'search', [domain], { limit: 5 });
    if (ids && ids.length > 0) {
      // Ler ibge_code de todos os resultados encontrados
      var cities = await executeKw(client, db, uid, pwd, 'res.city', 'read', [ids, ['name', 'ibge_code', 'x_ibge_code']]);
      if (cities) {
        for (var i = 0; i < cities.length; i++) {
          var cityIbgeVal = cities[i].x_ibge_code || cities[i].ibge_code;
          if (cityIbgeVal) {
            console.log('[SIEG-EMIT] IBGE encontrado por busca: ' + cities[i].name + ' = ' + cityIbgeVal);
            return String(cityIbgeVal);
          }
        }
      }
    }
  } catch (e) {
    console.log('[SIEG-EMIT] Busca res.city falhou: ' + e.message);
  }
  return '';
}

/**
 * Tabela de fallback para cidades principais do BR
 * Chave: 'CIDADE/UF' (normalizado) -> codigo IBGE 7 digitos
 */
var IBGE_FALLBACK = {
  // SC - Santa Catarina (verificado via IBGE API 20/10/2026)
  'BRUSQUE/SC': '4202909',
  'JOINVILLE/SC': '4209102',
  'FLORIANOPOLIS/SC': '4205407',
  'SAO JOSE/SC': '4216602', // fix 21/10: 4209602 e Chapeco; Sao Jose/SC = 4216602 (rejeicao 274)
  'BLUMENAU/SC': '4202404',
  'ITAJAI/SC': '4208203',
  'LAGES/SC': '4209300',
  'CRICIUMA/SC': '4204608',
  'CHAPECO/SC': '4204200',
  'JARAGUA DO SUL/SC': '4208906',
  'PALHOCA/SC': '4211900',
  'INDAIAL/SC': '4208502',
  'NAVEGANTES/SC': '4211405',
  'ITAPEMA/SC': '4208302',
  'CAMBORIU/SC': '4203204',
  'TIMBO/SC': '4218304',
  'POMERODE/SC': '4218650',
  'RIO DO SUL/SC': '4214803',
  'SAO BENTO DO SUL/SC': '4202055',
  'MAFRA/SC': '4209607',
  'CANOINHAS/SC': '4203808',
  'CONCORDIA/SC': '4204707',
  'CACADOR/SC': '4203103',
  'JOACABA/SC': '4209003',
  'VIDEIRA/SC': '4216003',
  'ARARANGUA/SC': '4201406',
  'TUBARAO/SC': '4214304',
  'IMBITUBA/SC': '4207104',
  'LAGUNA/SC': '4209102',
  'SAO MIGUEL DO OESTE/SC': '4216250',
  'XANXERE/SC': '4217702',
  // MG - Minas Gerais
  'BELO HORIZONTE/MG': '3106200',
  'UBERLANDIA/MG': '3170206',
  'CONTAGEM/MG': '3118601',
  'JUIZ DE FORA/MG': '3136304',
  'BETIM/MG': '3106705',
  'MONTES CLAROS/MG': '3143302',
  // SP - Sao Paulo
  'SAO PAULO/SP': '3550308',
  'CAMPINAS/SP': '3509502',
  'GUARULHOS/SP': '3518800',
  'SOROCABA/SP': '3552205',
  'RIBEIRAO PRETO/SP': '3543402',
  'SANTOS/SP': '3548500',
  // RS - Rio Grande do Sul
  'PORTO ALEGRE/RS': '4314902',
  'CAXIAS DO SUL/RS': '4305108',
  'PELOTAS/RS': '4313407',
  'SANTA MARIA/RS': '4316907',
  'NOVO HAMBURGO/RS': '4313409',
  'CANOAS/RS': '4304606',
  // PR - Parana (verificado via IBGE API 17/09/2026)
  'CURITIBA/PR': '4106902',
  'LONDRINA/PR': '4113700',
  'MARINGA/PR': '4115200',
  'PONTA GROSSA/PR': '4119905',
  'FOZ DO IGUACU/PR': '4108304',
  'CASCAVEL/PR': '4104808',
  'CAMPO MOURAO/PR': '4104303',
  'PONTAL DO PARANA/PR': '4119954',
  'SAO JOSE DOS PINHAIS/PR': '4125506',
  'COLOMBO/PR': '4105805',
  'GUARAPUAVA/PR': '4109401',
  'PARANAGUA/PR': '4118204',
  'PINHAIS/PR': '4119152',
  'ARAUCARIA/PR': '4101804',
  'TOLEDO/PR': '4127700',
  'APUCARANA/PR': '4101408',
  'ALMIRANTE TAMANDARE/PR': '4100400',
  'UMUARAMA/PR': '4128104',
  'CAMBE/PR': '4103701',
  'IBIPORA/PR': '4109807',
  'ROLANDIA/PR': '4122404',
  'MARECHAL CANDIDO RONDON/PR': '4114609',
  'MAL. CANDIDO RONDON/PR': '4114609',
  'SARANDI/PR': '4126256',
  'MEDIANEIRA/PR': '4115804',
  'PALOTINA/PR': '4117909',
  'MATINHOS/PR': '4115705',
  'IMBITUVA/PR': '4110102',
  'TELEMACO BORBA/PR': '4127106',
  'IRATI/PR': '4110706',
  'GUARANIACU/PR': '4109302',
  'PATO BRANCO/PR': '4118501',
  'FRANCISCO BELTRAO/PR': '4108403',
  'PRIMEIRO DE MAIO/PR': '4120507',
  '2 DE MAIO/PR': '4120507',
  'GUARATUBA/PR': '4109609',
  'ANTONINA/PR': '4101200',
  'MORRETES/PR': '4116208',
  'SAO MIGUEL DO IGUACU/PR': '4125704',
  'CAMPO LARGO/PR': '4104204',
  'CAMPO MAGRO/PR': '4104253',
  'FAZENDA RIO GRANDE/PR': '4107652',
  'PIRAQUARA/PR': '4119509',
  'QUATRO BARRAS/PR': '4120804',
  'ITAPERUCU/PR': '4111258',
  'BALSE NOVA/PR': '4102307',
  'RIO NEGRO/PR': '4122305',
  'SAO MATEUS DO SUL/PR': '4125605',
  'UNIAO DA VITORIA/PR': '4128203',
  'CASTRO/PR': '4104907',
  'IPIRANGA/PR': '4110508',
  'PALMEIRA/PR': '4117701',
  'LAPA/PR': '4113205',
  'PORTO AMAZONAS/PR': '4120101',
  'REBOUCAS/PR': '4121505',
  'GENERAL CARNEIRO/PR': '4108502',
  'BITURUNA/PR': '4102901',
  'CERRO AZUL/PR': '4105201',
  'JAGUARIAIVA/PR': '4112009',
  'SENGES/PR': '4126306',
  'QUEDAS DO IGUACU/PR': '4120903',
  'GUARAPUAVA/PR': '4109401',
  'PINHAO/PR': '4119301',
  'RESERVA/PR': '4121703',
  'VALE DO RIO DOCE/PR': '4119954',
  'CRUZEIRO DO OESTE/PR': '4106605',
  'CIANORTE/PR': '4105508',
  'GOIOERE/PR': '4108601',
  'ASSIS CHATEAUBRIAND/PR': '4102000',
  'MARECHAL CANDIDO RONDON/PR': '4114609',
  'PALMAS/PR': '4117602',
  'PATO BRAGADO/PR': '4118451',
  'SANTA HELENA/PR': '4123501',
  'NOVA LONDRINA/PR': '4117107',
  'JABOTI/PR': '4111704',
  // SP - Sao Paulo (verificado via IBGE API 17/09/2026)
  'SAO PAULO/SP': '3550308',
  'GUARULHOS/SP': '3518800',
  'CAMPINAS/SP': '3509502',
  'SAO BERNARDO DO CAMPO/SP': '3548708',
  'SANTOS/SP': '3548500',
  'RIBEIRAO PRETO/SP': '3543402',
  'ITU/SP': '3523909',
  'JUNDIAI/SP': '3525904',
  'SOROCABA/SP': '3552205',
  'SAO JOSE DOS CAMPOS/SP': '3549904',
  'SANTO ANDRE/SP': '3547809',
  'SAO JOSE DO RIO PRETO/SP': '3549805',
  'MAUA/SP': '3529401',
  'DIADEMA/SP': '3513801',
  'OSASCO/SP': '3534401',
  'CARAPICUIBA/SP': '3510609',
  'MOGI DAS CRUZES/SP': '3530607',
  'SUZANO/SP': '3552502',
  'TABOAO DA SERRA/SP': '3552809',
  'BAURU/SP': '3506003',
  'PIRACICABA/SP': '3538709',
  'LIMEIRA/SP': '3526902',
  // RJ - Rio de Janeiro (verificado via IBGE API 17/09/2026)
  'RIO DE JANEIRO/RJ': '3304557',
  'VOLTA REDONDA/RJ': '3306305',
  'NILOPOLIS/RJ': '3303203',
  'MESQUITA/RJ': '3302858',
  'DUQUE DE CAXIAS/RJ': '3301702',
  'NOVA IGUACU/RJ': '3303500',
  'SAO GONCALO/RJ': '3304904',
  'NITEROI/RJ': '3303302',
  'PETROPOLIS/RJ': '3303906',
  // MG - Minas Gerais (verificado via IBGE API 17/09/2026)
  'BELO HORIZONTE/MG': '3106200',
  'UBERLANDIA/MG': '3170206',
  'CONTAGEM/MG': '3118601',
  'JUIZ DE FORA/MG': '3136702',
  // RS - Rio Grande do Sul (verificado via IBGE API 17/09/2026)
  'PORTO ALEGRE/RS': '4314902',
  'CAXIAS DO SUL/RS': '4305108',
  'PELOTAS/RS': '4314407',
  'SANTA MARIA/RS': '4316907',
  // SC - Santa Catarina (verificado via IBGE API 17/09/2026)
  'JOINVILLE/SC': '4209102',
  'FLORIANOPOLIS/SC': '4205407',
  'BALNEARIO CAMBORIU/SC': '4202008',
  'BLUMENAU/SC': '4202404',
  'LAGES/SC': '4209300',
  'CRICIUMA/SC': '4204608',
  'CHAPECO/SC': '4204202',
  // Outros (verificados)
  'SALVADOR/BA': '2927408',
  'BRASILIA/DF': '5300108',
  'FORTALEZA/CE': '2304400',
  'RECIFE/PE': '2611606',
  'MANAUS/AM': '1302603',
  'BELEM/PA': '1501402',
  'GOIANIA/GO': '5208707',
  'VITORIA/ES': '3205309',
};

/**
 * Normaliza nome de cidade: remove acentos, cedilha, etc.
 * Para matching na tabela IBGE fallback.
 */
function normalizeCityName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacriticos
    .replace(/\u00e7/g, 'c')          // cedilha -> c
    .replace(/\u00c7/g, 'C')
    .toUpperCase()
    .trim();
}

function lookupIbgeFallback(cityName, stateCode) {
  if (!cityName || !stateCode) return '';
  // AJL 21/10/2026: tabela IBGE 2026 completa (5570 municipios) tem prioridade
  var full = ibgeMunicipios.lookup(stateCode, cityName);
  if (full) return full;
  var key = (normalizeCityName(cityName) + '/' + stateCode.toUpperCase().trim());
  var code = IBGE_FALLBACK[key];
  if (code) {
    console.log('[SIEG-EMIT] IBGE via tabela fallback: ' + key + ' = ' + code);
    return code;
  }
  // Fallback: tenta sem preposicoes comuns ("do", "da", "de", "das", "dos")
  var simplified = key.replace(/\b(D|DA|DE|DO|DAS|DOS)\b/g, '').replace(/\s+/g, ' ').trim();
  code = IBGE_FALLBACK[simplified];
  if (code) {
    console.log('[SIEG-EMIT] IBGE via tabela fallback (simplificado): ' + simplified + ' = ' + code);
    return code;
  }
  return '';
}

function tupId(val) {
  if (Array.isArray(val)) return val[0] || 0;
  if (typeof val === 'number') return val;
  return parseInt(val) || 0;
}

/**
 * Valor gravado no campo Selection quando a emissao falha.
 * NFE_STATUS_ON_ERROR=pendente -> a fatura volta para a fila e e retentada.
 * Padrao 'erro' -> exige reprocessamento manual.
 */
function statusOnError() {
  var v = String(process.env.NFE_STATUS_ON_ERROR || 'erro').trim().toLowerCase();
  return v === 'pendente' ? 'pendente' : 'erro';
}

/**
 * Grava o status com fallback: se o Odoo recusar o valor da Selection,
 * tenta 'pendente' para a fatura nunca ficar fora da fila silenciosamente.
 */
async function writeStatusSafe(client, db, uid, pwd, moveId, tipo, vals) {
  var field = tipo === 'nfe' ? 'x_studio_nfe_status' : 'x_studio_nfse_status';
  // GUARDA: NUNCA rebaixar 'autorizada' para 'erro'/'pendente' (corrida de pollers
  // pode registrar erro de um processamento antigo POR CIMA de uma autorização real)
  var newVal = vals[field];
  if (newVal && newVal !== 'autorizada' && newVal !== 'cancelando' && newVal !== 'cancelada') {
    try {
      var cur = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], [field, tipo === 'nfe' ? 'x_studio_nfe_chave' : 'x_studio_nfse_numero']]);
      if (cur && cur[0]) {
        var curSt = cur[0][field] || '';
        var hasKey = tipo === 'nfe' ? !!cur[0].x_studio_nfe_chave : !!cur[0].x_studio_nfse_numero;
        if (curSt === 'autorizada' || hasKey) {
          console.warn('[SIEG-EMIT] BLOQUEADO downgrade de status: fatura ' + moveId + ' ja AUTORIZADA' +
            ' (tentou gravar "' + newVal + '") — status preservado');
          delete vals[field]; // remove o status do vals, mantém outros campos se houver
          if (!Object.keys(vals).length) return;
        }
      }
    } catch (eGuard) {
      console.warn('[SIEG-EMIT] Guard de status falhou (seguindo): ' + eGuard.message);
    }
  }
  try {
    await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], vals]);
  } catch (e) {
    console.error('[SIEG-EMIT] Falha ao gravar status (' + vals[field] + '): ' + e.message);
    var fb = {};
    fb[field] = 'pendente';
    try {
      await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], fb]);
      console.warn('[SIEG-EMIT] Status revertido para "pendente" (retentativa possivel)');
    } catch (e2) { console.error('[SIEG-EMIT] Falha no fallback de status:', e2.message); }
  }
}

async function safeUpdateError(client, db, uid, pwd, moveId, tipo, errMsg) {
  try {
    var vals = {};
    var st = statusOnError();
    if (tipo === 'nfe') vals.x_studio_nfe_status = st;
    else vals.x_studio_nfse_status = st;
    await writeStatusSafe(client, db, uid, pwd, moveId, tipo, vals);
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
      model: 'account.move', res_id: moveId,
      body: '<b>Erro na Emissao de ' + (tipo === 'nfe' ? 'NF-e' : 'NFS-e') + '</b><br/>' + errMsg.substring(0, 500),
      message_type: 'comment',
    }]);
  } catch (e) { console.error('[SIEG-EMIT] Falha ao registrar erro:', e.message); }
}

// ============================================================
// Process Pending Cancellations (polling para status 'cancelando')
// ============================================================
/**
 * Busca faturas com x_studio_nfe_status = 'cancelando' e envia o
 * evento de cancelamento à SEFAZ PR, depois atualiza o Odoo.
 * Chamado pelo runSiegPoll no server.js junto com processPendingEmissions.
 */
async function processPendingCancellations() {
  var odoo = config.odoo;
  if (!odoo || !odoo.enabled || !odoo.url) {
    return { processed: 0, reason: 'odoo_not_configured' };
  }

  var client = createClient(odoo.url);
  var uid = await authenticate(client, odoo.db, odoo.user, odoo.password);
  var db = odoo.db;
  var pwd = odoo.password;

  var ids = await executeKw(client, db, uid, pwd, 'account.move', 'search', [[
    ['move_type', '=', 'out_invoice'],
    ['x_studio_nfe_status', '=', 'cancelando'],
  ]], { order: 'id asc', limit: 5 });

  if (!ids.length) return { processed: 0 };

  console.log('[SIEG-CANCEL-POLL] ' + ids.length + ' fatura(s) aguardando cancelamento');

  var { cancelarNFe } = require('./nfe-cancelamento');

  var results = [];
  for (var i = 0; i < ids.length; i++) {
    var moveId = ids[i];
    try {
      var r = await cancelOneInvoice(client, db, uid, pwd, moveId, cancelarNFe);
      results.push(r);
    } catch (err) {
      console.error('[SIEG-CANCEL-POLL] ERRO fatura ' + moveId + ':', err.message);
      try {
        await executeKw(client, db, uid, pwd, 'account.move', 'write',
          [[moveId], { x_studio_nfe_status: 'erro' }]);
        await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
          model: 'account.move', res_id: moveId,
          body: '<b>Erro no Cancelamento</b><br/>' + err.message.substring(0, 500),
          message_type: 'comment',
        }]);
      } catch (e2) { console.error('[SIEG-CANCEL-POLL] Falha ao gravar erro:', e2.message); }
      results.push({ move_id: moveId, sucesso: false, erro: err.message });
    }
  }

  var ok = results.filter(function(r) { return r.sucesso; }).length;
  console.log('[SIEG-CANCEL-POLL] Concluido: ' + ok + '/' + results.length + ' cancelada(s)');
  return { processed: results.length, sucesso: ok };
}

async function cancelOneInvoice(client, db, uid, pwd, moveId, cancelarNFe) {
  var moves = await executeKw(client, db, uid, pwd, 'account.move', 'read',
    [[moveId], ['name', 'x_studio_nfe_chave', 'x_studio_nfe_protocolo',
                'x_studio_nfe_status', 'company_id']]);
  if (!moves || !moves.length) throw new Error('Fatura ' + moveId + ' nao encontrada');
  var move = moves[0];

  var chave     = (move.x_studio_nfe_chave || '').replace(/\D/g, '');
  var protocolo = String(move.x_studio_nfe_protocolo || '').trim();
  var justificativa = 'Cancelamento solicitado pelo emitente via Odoo';
  if (justificativa.length < 15) justificativa = 'Cancelamento solicitado pelo emitente via Odoo';

  console.log('[SIEG-CANCEL-POLL] Fatura ' + move.name + ' | chave=' + chave.slice(0, 15) + '...');

  if (!chave || chave.length !== 44) throw new Error('Chave de acesso invalida (' + chave.length + ' digitos). Nota precisa estar autorizada.');
  if (!protocolo) throw new Error('Protocolo de autorizacao ausente na fatura ' + move.name);

  var companyId = Array.isArray(move.company_id) ? move.company_id[0] : move.company_id;
  var companies = await executeKw(client, db, uid, pwd, 'res.company', 'read', [[companyId], ['vat']]);
  var cnpj = ((companies && companies[0] && companies[0].vat) || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ do emitente nao encontrado na empresa');

  // Marcar como processando para nao processar duas vezes em paralelo
  await executeKw(client, db, uid, pwd, 'account.move', 'write',
    [[moveId], { x_studio_nfe_status: 'processando' }]);

  var resultado = await cancelarNFe({ chave, protocolo, cnpj, justificativa });

  var statusNovo = resultado.sucesso ? 'cancelada' : 'erro';
  await executeKw(client, db, uid, pwd, 'account.move', 'write',
    [[moveId], {
      x_studio_nfe_status: statusNovo,
      x_studio_nfe_protocolo: resultado.nProt || protocolo,
    }]);

  if (resultado.sucesso) {
    try {
      await executeKw(client, db, uid, pwd, 'account.move', 'button_draft', [[moveId]]);
      await executeKw(client, db, uid, pwd, 'account.move', 'button_cancel', [[moveId]]);
      console.log('[SIEG-CANCEL-POLL] Fatura ' + move.name + ' revertida no Odoo');
    } catch (e) {
      console.warn('[SIEG-CANCEL-POLL] Nao foi possivel reverter a fatura: ' + e.message);
    }
  }

  var msgCorpo = resultado.sucesso
    ? '<b>NF-e Cancelada na SEFAZ</b><br/>'
      + 'Protocolo: ' + (resultado.nProt || protocolo) + '<br/>'
      + 'Data: ' + (resultado.dhRecbto || '') + '<br/>'
      + 'Justificativa: ' + justificativa
    : '<b>Cancelamento rejeitado pela SEFAZ</b><br/>'
      + 'Status: ' + resultado.cStat + ' - ' + resultado.xMotivo + '<br/>'
      + 'Justificativa enviada: ' + justificativa;

  try {
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
      model: 'account.move', res_id: moveId,
      body: msgCorpo, message_type: 'comment',
    }]);
  } catch (e) { console.warn('[SIEG-CANCEL-POLL] Erro ao postar chatter:', e.message); }

  return { move_id: moveId, sucesso: resultado.sucesso, fatura: move.name, cStat: resultado.cStat };
}

module.exports = { processPendingEmissions, processPendingCancellations, buildPagamentoInfo };
