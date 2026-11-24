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

// Catálogo completo de códigos aceitos pela selection do Odoo
const TE_SITUATION_CODES = ['0', '1', '3', '5', '6', '8', '9', '10', '11', '12'];
// Situações terminais: quando o picking já está numa delas, para de ser pollado
const TERMINAL_SITUATIONS = ['3', '5', '6', '8', '12'];
// Pausa entre chamadas ao TE (cortesia com rate limit da API)
const GAP_BETWEEN_CALLS_MS = 800;
// Limite de pickings por rodada (proteção contra rajadas após instabilidade)
const MAX_PICKINGS_PER_RUN = 100;

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
  const res = { processados: 0, atualizados: 0, erros: 0, jaAtual: 0 };

  const pickings = await odooTe.searchRead(
    'stock.picking',
    [
      ['x_studio_te_order_id', '!=', false],
      ['x_studio_te_sync', '=', true],
      ['x_studio_te_situation', 'not in', TERMINAL_SITUATIONS],
    ],
    ['id', 'name', 'sale_id', 'x_studio_te_order_id', 'x_studio_te_situation'],
    MAX_PICKINGS_PER_RUN,
    0,
    'id desc'
  );
  if (!pickings || !pickings.length) return res;

  logger.info('[TE-POLL] ' + pickings.length + ' entrega(s) em acompanhamento');

  for (let i = 0; i < pickings.length; i++) {
    const picking = pickings[i];
    const teOrderId = String(picking.x_studio_te_order_id || '').trim();
    if (!teOrderId) continue;

    let situ = null;
    try {
      const resp = await teApi.client.getOrderSituation({ orderType: 1, orderID: teOrderId });
      situ = parseSituation(resp);
    } catch (err) {
      res.erros++;
      logger.warn('[TE-POLL] /orders/situation falhou para OrderID ' + teOrderId + ': ' + err.message);
      continue;
    }
    res.processados++;

    if (!situ) continue;

    const atual = (picking.x_studio_te_situation === false || picking.x_studio_te_situation == null)
      ? '' : String(picking.x_studio_te_situation);
    if (situ.code === atual) { res.jaAtual++; continue; }

    // Grava no picking e espelha no pedido (mesma escrita do webhook)
    try {
      await odooTe.safeWriteCustom('stock.picking', [picking.id], { x_studio_te_situation: situ.code });
      let soId = null;
      if (picking.sale_id) {
        soId = Array.isArray(picking.sale_id) ? picking.sale_id[0] : picking.sale_id;
        if (soId) await odooTe.safeWriteCustom('sale.order', [soId], { x_studio_te_situation: situ.code });
      }
      const situacaoTxt = situ.description || situ.label || situ.code;
      const msg = '<b>AJL · TudoEntregue (polling)</b> — Situação da entrega: <b>' + situacaoTxt + '</b>' +
        (situ.date ? ' (' + situ.date + ')' : '') + '<br/>' +
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

  return res;
}

module.exports = {
  runTeSituationPoll,
  parseSituation,
  TE_SITUATION_CODES,
  TERMINAL_SITUATIONS,
};
