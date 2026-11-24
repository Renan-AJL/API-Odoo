/**
 * services/te-situation-poll.js — Sincroniza a situação da entrega TudoEntregue
 * (x_studio_te_situation) para o Odoo por POLLING, independente do webhook.
 *
 * POR QUE EXISTE (AJL 24/11/2026):
 * O webhook do TE (/api/v1/te/webhook/tudoentregue) só chega se estiver
 * configurado no painel do TudoEntregue — e hoje não chega nenhuma atualização
 * (verificado: 400 mensagens TE no chatter, nenhuma de status). Além disso, o
 * mapper do webhook gravava campos que não existem no Odoo
 * (x_studio_te_situacao/_desc), de modo que mesmo webhook chegando o write
 * morria em silêncio. Este polling garante que o "Status da fabricação"
 * acompanhe a entrega real: consulta GET /v1/orders/situation (por OrderID)
 * para cada picking sincronizado cuja situação não é terminal, e grava o
 * código no picking + no sale.order — as automações AJL (260/261/263) fazem
 * o resto (liberação após conclusão das OFs, espelho picking→pedido, CRM).
 *
 * NÃO ALTERA nenhum fluxo existente (send-invoice, webhook, dashboard, Itaú,
 * SIEG): é um worker novo, próprio, controlado por TE_SITUATION_POLL_MS.
 * Piso de datas (TE_SITUATION_POLL_FLOOR_DAYS, default 7): entregas SEM situação
 * com scheduled_date mais antiga que a janela ficam fora da rodada — a API do
 * TE só informa situação depois da atribuição ao motorista, então fila velha
 * sem código é chamada desperdiçada (24/11/2026: 521 sincronizados, 100% vazios).
 *
 * Códigos TE (mesmos da selection x_studio_te_situation no Odoo):
 *   '0' Aguardando, '1' Em Rota, '3' Entregue, '5' Não Entregue,
 *   '6' Entrega Parcial, '8' Cancelada, '9' Atrasada, '10' Em Separação,
 *   '11' Transferida, '12' Baixada.
 */
const config = require('../config');
const logger = require('../utils/logger');
const odooTe = require('./odoo-te');
const teApi = require('./tudoentregue');
const Mapper = require('./mapper-te');

// Última rodada (p/ diagnóstico via /api/v1/te/poll-debug)
var LAST_RUN = { ts: null, result: null, error: null };

function getLastRun() { return LAST_RUN; }

// Catálogo completo de códigos aceitos pela selection do Odoo
const TE_SITUATION_CODES = ['0', '1', '3', '5', '6', '8', '9', '10', '11', '12'];
// Situações terminais: quando o picking já está numa delas, para de ser pollado
const TERMINAL_SITUATIONS = ['3', '5', '6', '8', '12'];
// Situações em andamento: com um desses códigos o picking é SEMPRE acompanhado,
// mesmo antigo (a entrega tá rodando — precisa chegar ao fim)
const ACTIVE_SITUATIONS = ['0', '1', '9', '10', '11'];
// Pausa entre chamadas ao TE (cortesia com rate limit da API)
const GAP_BETWEEN_CALLS_MS = 800;
// Limite de pickings por rodada (proteção contra rajadas após instabilidade)
const MAX_PICKINGS_PER_RUN = 100;
// Piso de datas (dias): entregas SEM situação cuja scheduled_date é mais antiga
// que isso são IGNORADAS — a API /v1/orders/situation só devolve dados depois
// que a entrega é atribuída a um motorista (especificação do TE), então
// entregas antigas sem situação nunca teriam dado e só gastariam chamadas.
// 521 pickings sincronizados estavam todos vazios em 24/11: sem o piso, cada
// rodada queimava 100 chamadas no TE por nada. 0 desativa o piso.
const FLOOR_DAYS = parseInt(process.env.TE_SITUATION_POLL_FLOOR_DAYS, 10) || 7;

function floorCutoff() {
  if (FLOOR_DAYS <= 0) return null;
  return new Date(Date.now() - FLOOR_DAYS * 86400000)
    .toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Domínio da rodada: sincronizados + (em andamento | sem situação e recentes).
 * NOTA (AJL 24/11/2026): Odoo Online (saas-19.3) REJEITA item aninhado
 * ['&', folha, folha] com "TypeError: unhashable type: 'list'" em Domain()
 * (provado na prod: a forma aninhada crasha, a achatada retorna 59) —
 * notação polonesa ACHATADA, operadores como strings de topo.
 */
function buildPollDomain() {
  const cutoff = floorCutoff();
  const base = [
    ['x_studio_te_order_id', '!=', false],
    ['x_studio_te_sync', '=', true],
  ];
  if (!cutoff) {
    return base.concat([['x_studio_te_situation', 'not in', TERMINAL_SITUATIONS]]);
  }
  // base AND (em andamento OR (sem situação AND agendada >= corte))
  return base.concat([
    '|',
    ['x_studio_te_situation', 'in', ACTIVE_SITUATIONS],
    '&',
    ['x_studio_te_situation', '=', false],
    ['scheduled_date', '>=', cutoff],
  ]);
}

/**
 * Extrai a última situação de uma resposta de /v1/orders/situation.
 * Aceita { Status: [...] } ou { Result: [{ Status: [...] }] } (defensivo).
 * Retorna { code, label, description, date } ou null se não houver código válido.
 */
function parseSituation(teResponse) {
  if (!teResponse) return null;
  let list = teResponse.Status;
  if (!list && teResponse.Result && teResponse.Result.length) {
    list = teResponse.Result[0].Status;
  }
  if (!list || !list.length) return null;
  const last = list[list.length - 1];
  if (!last || last.Status === undefined || last.Status === null) return null;
  const code = String(last.Status);
  if (TE_SITUATION_CODES.indexOf(code) === -1) return null;
  return {
    code: code,
    label: (teApi.SITUATION_LABELS || {})[code] || '',
    description: last.StatusDescription || '',
    date: last.Date || '',
  };
}

/**
 * Uma rodada do polling:
 *  1. busca pickings de saída enviados ao TE (te_order_id + te_sync) cuja
 *     situação atual não é terminal (inclui situação vazia);
 *  2. consulta a situação real de cada um no TE;
 *  3. se mudou, grava x_studio_te_situation no picking E no sale.order e
 *     registra no chatter — as automações AJL propagam pro "Status da fabricação".
 */
async function runTeSituationPoll() {
  const res = { processados: 0, atualizados: 0, erros: 0, jaAtual: 0, semSituacaoNoTe: 0, janelaDias: FLOOR_DAYS };
  try {

  const pickings = await odooTe.searchRead(
    'stock.picking',
    buildPollDomain(),
    ['id', 'name', 'sale_id', 'x_studio_te_order_id', 'x_studio_te_situation'],
    MAX_PICKINGS_PER_RUN,
    0,
    'id desc'
  );
  if (!pickings || !pickings.length) {
    LAST_RUN = { ts: new Date().toISOString(), result: res, error: null };
    return res;
  }

  logger.info('[TE-POLL] ' + pickings.length + ' entrega(s) em acompanhamento' +
    (FLOOR_DAYS > 0 ? ' (janela ' + FLOOR_DAYS + 'd ou em andamento)' : ''));

  for (let i = 0; i < pickings.length; i++) {
    const picking = pickings[i];
    const teOrderId = String(picking.x_studio_te_order_id || '').trim();
    if (!teOrderId) continue;

    let situ = null;
    let occTxt = null;
    try {
      // AJL 24/11/2026: fonte trocada de /v1/orders/situation para
      // /v1/orders/finish?OrderType+OrderID (spec oficial, params capitalizados).
      // O situation devolve [] mesmo para entrega real concluída com motorista
      // (provado no debug); o finish devolve a entrega COMPLETA — Occurrences,
      // TrackingUrl, Driver — assim que há ocorrência lançada pelo app.
      const resp = await teApi.client.getDeliveries({ OrderType: 1, OrderID: teOrderId, page: 1 });
      // /v1/orders/finish devolve ARRAY NU (verificado na prod) — aceita também
      // {Result:[...]} defensivamente.
      const list = Array.isArray(resp) ? resp : ((resp && resp.Result) || []);
      const rec = list[0] || null;
      if (rec) {
        const mapped = Mapper.teToOdooPicking(rec);
        situ = mapped.x_studio_te_situation
          ? { code: mapped.x_studio_te_situation,
              label: (teApi.SITUATION_LABELS || {})[mapped.x_studio_te_situation] || '',
              description: '', date: '' }
          : null;
        occTxt = mapped.x_studio_te_ocorrencias || null;
        // complementa com a data da última ocorrência p/ chatter
        if (rec.Occurrences && rec.Occurrences.length) {
          const lastOcc = rec.Occurrences[rec.Occurrences.length - 1];
          if (situ && lastOcc.OccurrenceDate) situ.date = String(lastOcc.OccurrenceDate);
          if (!occTxt && lastOcc.OccurrenceDescription) occTxt = String(lastOcc.OccurrenceDescription);
        }
      }
      if (!situ) {
        res.semSituacaoNoTe++;
        if (res.semSituacaoNoTe <= 3) {
          logger.warn('[TE-POLL] TE sem situacao para OrderID ' + teOrderId +
            ' (temRegistro: ' + (rec ? 'sim' : 'nao') + ')');
        }
      }
    } catch (err) {
      res.erros++;
      logger.warn('[TE-POLL] /orders/finish falhou para OrderID ' + teOrderId + ': ' + err.message);
      continue;
    }
    res.processados++;

    if (!situ) continue;

    const atual = (picking.x_studio_te_situation === false || picking.x_studio_te_situation == null)
      ? '' : String(picking.x_studio_te_situation);
    if (situ.code === atual) { res.jaAtual++; continue; }

    // Grava no picking e espelha no pedido (mesma escrita do webhook)
    try {
      const vals = { x_studio_te_situation: situ.code };
      if (occTxt) vals.x_studio_te_ocorrencias = occTxt;
      await odooTe.safeWriteCustom('stock.picking', [picking.id], vals);
      let soId = null;
      if (picking.sale_id) {
        soId = Array.isArray(picking.sale_id) ? picking.sale_id[0] : picking.sale_id;
        if (soId) await odooTe.safeWriteCustom('sale.order', [soId], { x_studio_te_situation: situ.code });
      }
      const situacaoTxt = situ.description || situ.label || situ.code;
      const msg = '<b>AJL · TudoEntregue (polling)</b> — Situação da entrega: <b>' + situacaoTxt + '</b>' +
        (situ.date ? ' (' + situ.date + ')' : '') +
        (occTxt ? '<br/>Ocorrência: ' + occTxt : '') + '<br/>' +
        'Picking: ' + (picking.name || picking.id) + ' | OrderID TE: ' + teOrderId +
        ' | Código: ' + situ.code;
      await odooTe.postChatter('stock.picking', picking.id, msg);
      if (soId) await odooTe.postChatter('sale.order', soId, msg);
      res.atualizados++;
      logger.info('[TE-POLL] ' + (picking.name || picking.id) + ': ' + (atual || '(vazia)') + ' -> ' + situ.code + ' ' + situacaoTxt);
    } catch (err) {
      res.erros++;
      logger.error('[TE-POLL] Falha gravando situação de ' + (picking.name || picking.id) + ': ' + err.message);
    }

    // Cortesia entre chamadas de TE dentro da mesma rodada
    await new Promise(r => setTimeout(r, GAP_BETWEEN_CALLS_MS));
  }

  // AJL 24/11/2026: registra o resultado E a exceção (antes o finally gravava
  // error:null sempre e rodadas quebradas ficavam indistinguíveis de vazias).
  LAST_RUN = { ts: new Date().toISOString(), result: res, error: null };
  return res;
  } catch (err) {
    LAST_RUN = {
      ts: new Date().toISOString(),
      result: res,
      error: (err && err.message) ? err.message : String(err),
    };
    throw err;
  }
}

/**
 * Diagnóstico: testa várias formas de consultar a situação do TE para UM
 * OrderID (situation com orderID/OrderID/orderNumber + finish) e devolve
 * tudo cru, além do resultado da última rodada do polling.
 */
async function debugOrderSituation(orderId) {
  const id = String(orderId);
  const variants = {};
  const tentativas = {
    // finish com params capitalizados (spec oficial) — fonte do polling v1.2.37
    'finish?OrderType+OrderID': { OrderType: 1, OrderID: id, page: 1 },
    'finish?OrderID': { OrderID: id, page: 1 },
    'finish?partial+OrderType+OrderID': { OrderType: 1, OrderID: id, partial: 'true', page: 1 },
    // referência: situation (devolve [] comprovado) e as antigas minúsculas
    'situation?orderType+orderID': { orderType: 1, orderID: id },
    'finish?orderNumber (antigo, filtro ignorado)': { orderNumber: id, page: 1 },
  };
  for (const [nome, params] of Object.entries(tentativas)) {
    try {
      const call = nome.startsWith('finish?')
        ? teApi.client.getDeliveries(params)
        : teApi.client.getOrderSituation(params);
      const r = await call;
      // resume registros completos p/ não estourar o payload do debug
      const lista = Array.isArray(r) ? r : ((r && r.Result) || []);
      if (lista.length && lista[0].OrderID) {
        variants[nome] = {
          total: lista.length,
          registros: lista.slice(0, 3).map(function(rec) {
            return {
              OrderID: rec.OrderID,
              OrderNumber: rec.OrderNumber,
              TrackingUrl: rec.TrackingUrl || null,
              Status: rec.Status || null,
              ultimaOcorrencia: (rec.Occurrences && rec.Occurrences.length)
                ? {
                    code: rec.Occurrences[rec.Occurrences.length - 1].OccurrenceCode,
                    descricao: rec.Occurrences[rec.Occurrences.length - 1].OccurrenceDescription,
                    data: rec.Occurrences[rec.Occurrences.length - 1].OccurrenceDate,
                    finisher: rec.Occurrences[rec.Occurrences.length - 1].Finisher,
                  }
                : null,
            };
          }),
        };
      } else {
        variants[nome] = r;
      }
    } catch (e) {
      variants[nome] = 'ERRO: ' + e.message;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { orderID: id, variants: variants, lastPoll: LAST_RUN };
}

module.exports = {
  runTeSituationPoll,
  parseSituation,
  debugOrderSituation,
  getLastRun,
  buildPollDomain,
  TE_SITUATION_CODES,
  TERMINAL_SITUATIONS,
  ACTIVE_SITUATIONS,
};
