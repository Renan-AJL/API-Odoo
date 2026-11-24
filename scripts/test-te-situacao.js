/**
 * Testes offline — corrente TudoEntregue -> Odoo (situacao da entrega)
 * AJL 24/11/2026: corrige o furo em que x_studio_te_situation nunca recebia a
 * situacao real (mapper gravava campos inexistentes + webhook nao configurado).
 * Nao chama Odoo nem TE — testa puro mapeamento + consistencia do fonte.
 * Rodar: node scripts/test-te-situacao.js  (exit 0 = OK)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mapper = require('../services/mapper-te');
const tePoll = require('../services/te-situation-poll');
const odooTe = require('../services/odoo-te');

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  OK  ' + name);
  } catch (err) {
    fail++;
    console.log('  FALHOU ' + name + ' -> ' + err.message);
  }
}

console.log('== mapper.teWebhookToOdoo ==');
check('Status 1 (Recepcionada no Active, catalogo TE) -> "0" Aguardando + te_order_id', function() {
  const d = mapper.teWebhookToOdoo({
    OrderID: '4321',
    Status: [{ Status: 1, StatusDescription: 'Recepcionada no Active TudoEntregue' }],
  });
  assert.strictEqual(d.x_studio_te_situation, '0', 'TE Status 1 = Recepcionada, NAO "Em Rota"');
  assert.strictEqual(d.x_studio_te_order_id, '4321');
  assert.strictEqual('x_studio_te_situacao' in d, false, 'campo inexistente nao pode mais ser gravado');
  assert.strictEqual('x_studio_te_situacao_desc' in d, false);
});
check('Status 2/3 (com motorista, catalogo TE) -> "1" Em Rota — NUNCA 3 Entregue', function() {
  assert.strictEqual(mapper.teWebhookToOdoo({ Status: [{ Status: 2, StatusDescription: 'Enviada ao Motorista e Aguardando Aceite' }] }).x_studio_te_situation, '1');
  assert.strictEqual(mapper.teWebhookToOdoo({ Status: [{ Status: 3, StatusDescription: 'Enviada ao Motorista e Aceita' }] }).x_studio_te_situation, '1');
});
check('Status 5 (Finalizada pelo Motorista) sem ocorrência 01 -> NAO grava (ambiguo)', function() {
  const d = mapper.teWebhookToOdoo({ Status: [{ Status: 5, StatusDescription: 'Finalizada pelo Motorista' }] });
  assert.strictEqual('x_studio_te_situation' in d, false, 'finalização sem ocorrência não pode virar 5 Não Entregue nem 3 Entregue');
});
check('Status 10/12 do TE nao tem traducao provada -> nao grava codigo', function() {
  assert.strictEqual('x_studio_te_situation' in mapper.teWebhookToOdoo({ Status: [{ Status: 10 }] }), false);
  assert.strictEqual('x_studio_te_situation' in mapper.teWebhookToOdoo({ Status: [{ Status: 12 }] }), false);
});
check('Status fora do catalogo (7) -> nao grava selection, nao quebra', function() {
  const d = mapper.teWebhookToOdoo({ Status: [{ Status: 7, StatusDescription: 'Operacao finalizada' }] });
  assert.strictEqual('x_studio_te_situation' in d, false);
  assert.strictEqual(d.x_studio_te_order_id, undefined);
});
check('Ocorrencias -> x_studio_te_ocorrencias (nunca te_observacao)', function() {
  const d = mapper.teWebhookToOdoo({
    Status: [{ Status: 1 }],
    Occurrences: [{ Observation: 'Cliente ausente', OccurrenceName: 'Nao entregue' }],
  });
  assert.strictEqual(d.x_studio_te_ocorrencias, 'Cliente ausente - Nao entregue');
  assert.strictEqual('x_studio_te_observacao' in d, false);
});
check('Payload vazio/sem status -> objeto seguro', function() {
  assert.deepStrictEqual(mapper.teWebhookToOdoo(null), {});
  assert.deepStrictEqual(mapper.teWebhookToOdoo({}), {});
  const d = mapper.teWebhookToOdoo({ OrderID: '1', Status: [], Occurrences: [] });
  assert.deepStrictEqual(d, { x_studio_te_order_id: '1' });
});
check('teCreateToOdoo -> tracking no campo real (x_studio_te_tracking_code)', function() {
  const d = mapper.teCreateToOdoo({ OrderID: '9', TrackingCode: 'TE-TRK-1' });
  assert.strictEqual(d.x_studio_te_tracking_code, 'TE-TRK-1');
  assert.strictEqual('x_studio_te_rastreio' in d, false);
});
check('chatter inclui codigo e label do catalogo TE', function() {
  const msg = mapper.chatterWebhookMessage({ OrderID: '5', Status: [{ Status: 3 }] });
  assert.ok(msg.indexOf('(codigo 3)') !== -1, 'sem codigo: ' + msg);
  assert.ok(msg.indexOf('Entregue') !== -1, 'sem label: ' + msg);
});

console.log('== te-situation-poll.parseSituation ==');
check('ultima situacao vence + label/description', function() {
  const s = tePoll.parseSituation({
    Status: [
      { Status: 1, StatusDescription: 'Saiu' },
      { Status: 3, StatusDescription: 'Entregue pelo motorista', Date: '2026-11-24 10:00' },
    ],
  });
  assert.strictEqual(s.code, '3');
  assert.strictEqual(s.description, 'Entregue pelo motorista');
  assert.strictEqual(s.label, 'Entregue');
  assert.strictEqual(s.date, '2026-11-24 10:00');
});
check('shape alternativo Result[0].Status', function() {
  assert.strictEqual(tePoll.parseSituation({ Result: [{ Status: [{ Status: 10 }] }] }).code, '10');
});
check('codigo desconhecido / vazio / null -> null', function() {
  assert.strictEqual(tePoll.parseSituation({ Status: [{ Status: 7 }] }), null);
  assert.strictEqual(tePoll.parseSituation({ Status: [] }), null);
  assert.strictEqual(tePoll.parseSituation({}), null);
  assert.strictEqual(tePoll.parseSituation(null), null);
});
check('terminais: 3/5/6/8/12 — 1/0/9/10/11 continuam sendo pollados', function() {
  assert.deepStrictEqual(tePoll.TERMINAL_SITUATIONS, ['3', '5', '6', '8', '12']);
  const nc = tePoll.TE_SITUATION_CODES;
  ['0', '1', '9', '10', '11'].forEach(function(c) {
    assert.ok(nc.indexOf(c) !== -1, 'codigo ' + c + ' fora do catalogo');
  });
});

console.log('== te-situation-poll.buildPollDomain (piso de datas) ==');
check('dominio mantem sincronizados + | em andamento OU recentes', function() {
  const d = tePoll.buildPollDomain();
  const flat = JSON.stringify(d);
  assert.ok(flat.indexOf('x_studio_te_order_id') !== -1, 'sem te_order_id');
  assert.ok(flat.indexOf('x_studio_te_sync') !== -1, 'sem te_sync');
  assert.ok(flat.indexOf('"|",') !== -1, 'falta o OU em-andamento/ recentes');
  assert.ok(flat.indexOf('"&",') !== -1, 'falta o E (sem-situacao E agendada>=corte)');
  assert.ok(flat.indexOf('x_studio_te_situation') !== -1, 'sem filtro de situacao');
  assert.ok(flat.indexOf('scheduled_date') !== -1, 'sem piso de scheduled_date');
});
check('dominio ACHATADO (Odoo Online rejeita item aninhado [& folha folha])', function() {
  // Prod comprovou 24/11: ['&', folha, folha] como ITEM -> TypeError unhashable
  const d = tePoll.buildPollDomain();
  d.forEach(function(item) {
    if (Array.isArray(item)) {
      assert.ok(typeof item[0] === 'string' && typeof item[1] === 'string',
        'folha invalida (item[1] nao pode ser lista): ' + JSON.stringify(item).slice(0, 80));
    }
  });
});
check('ACTIVE_SITUATIONS = codigos nao-terminais do catalogo', function() {
  assert.deepStrictEqual(tePoll.ACTIVE_SITUATIONS, ['0', '1', '9', '10', '11']);
  tePoll.TERMINAL_SITUATIONS.forEach(function(t) {
    assert.ok(tePoll.ACTIVE_SITUATIONS.indexOf(t) === -1,
      'codigo terminal ' + t + ' nao pode estar em ACTIVE_SITUATIONS');
  });
});
check('piso desativado (TE_SITUATION_POLL_FLOOR_DAYS=0) usa o dominio antigo', function() {
  const src = fs.readFileSync(path.join(ROOT, 'services/te-situation-poll.js'), 'utf8');
  assert.ok(src.indexOf("'not in', TERMINAL_SITUATIONS") !== -1,
    'branch sem piso deve manter o dominio antigo (not in terminal)');
  assert.ok(src.indexOf('TE_SITUATION_POLL_FLOOR_DAYS') !== -1);
});

console.log('== odoo-te (campos reais, verificados na base prod) ==');
check('FIELDS: situation -> x_studio_te_situation nos 3 modelos', function() {
  assert.strictEqual(odooTe.FIELDS['sale.order'].teSituation, 'x_studio_te_situation');
  assert.strictEqual(odooTe.FIELDS['stock.picking'].teSituation, 'x_studio_te_situation');
  assert.strictEqual(odooTe.FIELDS['account.move'].teSituation, 'x_studio_te_situation');
});
check('FIELDS: tracking do picking -> x_studio_te_tracking_code', function() {
  assert.strictEqual(odooTe.FIELDS['stock.picking'].teTrackingCode, 'x_studio_te_tracking_code');
  assert.strictEqual(odooTe.FIELDS['sale.order'].teDeliveryType, 'x_studio_te_delivery_type');
});
check('nenhum campo morto nas listas de leitura custom', function() {
  const src = fs.readFileSync(path.join(ROOT, 'services/odoo-te.js'), 'utf8');
  ['x_studio_te_situacao_desc', 'x_studio_te_tipo_pedido', 'x_studio_te_rastreio',
   'x_studio_te_observacao', 'x_studio_te_ultimo_webhook', 'x_studio_te_situacao\'',
   'x_studio_te_protocolo_coleta', 'x_studio_te_data_coleta', 'x_studio_te_placa_veiculo'].forEach(function(bad) {
    const re = new RegExp("[" + "'" + '"' + "]" + bad.replace(/'/g, '') + "[" + "'" + '"' + "]");
    assert.ok(!re.test(src), 'lista de leitura ainda usa campo morto: ' + bad);
  });
});

console.log('== mapper.teToOdooPicking / teToOdooSaleOrder (pull, AJL 24/11) ==');
check('OCORRENCIA vence Status: fixture REAL 2917/S02983 (app Entregue) -> "3", nunca "5"', function() {
  // fixture capturada 24/11/2026 no poll-debug: o Status do TE termina em 5
  // (Finalizada pelo Motorista) e a ocorrência é 01 ENTREGUE Finisher=true —
  // o mapper antigo copiava o 5 cru e gravava "Não Entregue" (bug relatado)
  const rec = {
    OrderID: '2917',
    OrderNumber: 'S02983',
    Status: [
      { ID: 94075242, Status: 1, StatusDescription: 'Recepcionada no Active TudoEntregue', Date: '2026-11-16T08:12:59' },
      { ID: 94078134, Status: 2, StatusDescription: 'Enviada ao Motorista e Aguardando Aceite', Date: '2026-11-16T08:41:48' },
      { ID: 94078142, Status: 3, StatusDescription: 'Enviada ao Motorista e Aceita', Date: '2026-11-16T08:41:49' },
      { ID: 94078396, Status: 5, StatusDescription: 'Finalizada pelo Motorista', Date: '2026-11-16T08:46:26' },
    ],
    Occurrences: [
      { OccurrenceCode: '01', OccurrenceDescription: 'ENTREGUE', OccurrenceName: 'ENTREGUE',
        Finisher: true, OccurrenceDate: '2026-11-16T08:46:19' },
    ],
  };
  const d = mapper.teToOdooPicking(rec);
  assert.strictEqual(d.x_studio_te_situation, '3', 'ocorrência 01 ENTREGUE Finisher vence o Status 5 do TE');
  assert.strictEqual('x_studio_te_order_id' in d, false, 'pull nao pode sobrescrever o id gravado no envio');
});
check('Status 3 sem ocorrência -> "1" Em Rota (era "3" Entregue errado)', function() {
  const d = mapper.teToOdooPicking({
    OrderID: '5802',
    Status: [{ Status: 3, StatusDescription: 'Enviada ao Motorista e Aceita' }],
  });
  assert.strictEqual(d.x_studio_te_situation, '1', 'aceite do motorista NAO é entrega');
  assert.strictEqual('x_studio_te_order_id' in d, false, 'pull nao pode sobrescrever o id gravado no envio');
});
check('Status [] + ocorrencia 01 Finisher=true -> situacao 3', function() {
  const d = mapper.teToOdooPicking({
    OrderID: '5802',
    Status: [],
    Occurrences: [{ OccurrenceCode: '01', OccurrenceDescription: 'ENTREGUE', Finisher: true }],
  });
  assert.strictEqual(d.x_studio_te_situation, '3');
});
check('Status [] + ocorrencia 01 SEM Finisher -> nao grava situacao', function() {
  const d = mapper.teToOdooPicking({
    OrderID: '5802',
    Status: [],
    Occurrences: [{ OccurrenceCode: '01', OccurrenceDescription: 'ENTREGUE', Finisher: false }],
  });
  assert.strictEqual('x_studio_te_situation' in d, false, 'recusa/desacordo/nao-finalizado nao pode virar codigo terminal');
});
check('ocorrencia 102 -> situacao 8 (cancelada, terminal mesmo sem Finisher)', function() {
  const d = mapper.teToOdooPicking({
    Status: [],
    Occurrences: [{ OccurrenceCode: '102', OccurrenceDescription: 'ENTREGA CANCELADA', Finisher: false }],
  });
  assert.strictEqual(d.x_studio_te_situation, '8');
});
check('ocorrencia 03 (recusa) COM Finisher -> "5" Nao Entregue', function() {
  const d = mapper.teToOdooPicking({
    Status: [{ Status: 5, StatusDescription: 'Finalizada pelo Motorista' }],
    Occurrences: [{ OccurrenceCode: '03', OccurrenceDescription: 'CLIENTE RECUSOU', Finisher: true }],
  });
  assert.strictEqual(d.x_studio_te_situation, '5');
});
check('ocorrencia 03/09 SEM Finisher -> nao grava codigo (pode continuar)', function() {
  const d = mapper.teToOdooPicking({
    Status: [],
    Occurrences: [{ OccurrenceCode: '09', OccurrenceDescription: 'MERCADORIA EM DESACORDO', Finisher: false }],
  });
  assert.strictEqual('x_studio_te_situation' in d, false);
});
check('teToOdooSaleOrder nao leva x_studio_te_ocorrencias', function() {
  const d = mapper.teToOdooSaleOrder({
    Status: [],
    Occurrences: [{ OccurrenceCode: '01', OccurrenceDescription: 'ENTREGUE', Finisher: true, Observation: 'ok' }],
  });
  assert.strictEqual(d.x_studio_te_situation, '3');
  assert.strictEqual('x_studio_te_ocorrencias' in d, false);
});
check('entrega sem situacao nem ocorrencia -> payload vazio (pull pula)', function() {
  const d = mapper.teToOdooPicking({ OrderID: '5802', Status: [], Occurrences: [] });
  assert.strictEqual(Object.keys(d).length, 0);
});
check('REGISTRO REAL da prod (finish?OrderType+OrderID, GUID a852ab66) -> situacao 3', function() {
  // fixture capturada 24/11/2026: entrega real 261307, 2 ocorrências, motorista
  // atribuído pela operação normal (NADA foi atribuído para teste)
  const rec = {
    OrderID: 'a852ab66-44df-4c64-b71e-55549068912d',
    OrderNumber: '261307',
    Status: [],
    TrackingUrl: 'https://app.tudoentregue.com.br/Tracking?Code=xxx',
    Occurrences: [
      { OccurrenceCode: '01', OccurrenceDescription: 'ENTREGUE', Finisher: true,
        OccurrenceDate: '2026-01-13T10:11:00', OccurrenceName: 'Wilson' },
    ],
  };
  const d = mapper.teToOdooPicking(rec);
  assert.strictEqual(d.x_studio_te_situation, '3', 'ENTREGUE com Finisher deve virar codigo 3');
  assert.ok(String(d.x_studio_te_ocorrencias).indexOf('Wilson') !== -1, 'texto da ocorrencia vai junto');
});

console.log('== consistencia do fonte ==');
check('poll usa /v1/orders/finish?OrderType+OrderID (nao situation), v1.2.37', function() {
  const src = fs.readFileSync(path.join(ROOT, 'services/te-situation-poll.js'), 'utf8');
  assert.ok(src.indexOf('getDeliveries({ OrderType: 1, OrderID: teOrderId, page: 1 })') !== -1,
    'poll deve consultar finish com OrderType+OrderID capitalizados');
  assert.ok(src.indexOf('Mapper.teToOdooPicking') !== -1,
    'poll deve mapear o registro completo pelo mapper');
});
const webhookSrc = fs.readFileSync(path.join(ROOT, 'routes/webhook-te.js'), 'utf8');
check('webhook marca x_studio_te_webhook_received no sale.order', function() {
  assert.ok(webhookSrc.indexOf('x_studio_te_webhook_received = true') !== -1);
});
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
check('server.js inicia o polling TE com TE_SITUATION_POLL_MS', function() {
  assert.ok(serverSrc.indexOf('TE_SITUATION_POLL_MS') !== -1);
  assert.ok(serverSrc.indexOf('startTeSituationPolling();') !== -1);
  assert.ok(serverSrc.indexOf('te-situation-poll') !== -1);
});
const renderSrc = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
check('render.yaml declara TE_SITUATION_POLL_MS', function() {
  assert.ok(renderSrc.indexOf('TE_SITUATION_POLL_MS') !== -1);
});
const pollSrc = fs.readFileSync(path.join(ROOT, 'services/te-situation-poll.js'), 'utf8');
check('poll grava no picking E no sale.order + chatter', function() {
  assert.ok(pollSrc.indexOf("safeWriteCustom('stock.picking'") !== -1);
  assert.ok(pollSrc.indexOf("safeWriteCustom('sale.order'") !== -1);
  assert.ok(pollSrc.indexOf("postChatter('stock.picking'") !== -1);
  assert.ok(pollSrc.indexOf("postChatter('sale.order'") !== -1);
  assert.ok(pollSrc.indexOf("'not in', TERMINAL_SITUATIONS") !== -1);
});

console.log('');
console.log('Total: ' + pass + ' OK, ' + fail + ' falhas');
process.exit(fail ? 1 : 0);
