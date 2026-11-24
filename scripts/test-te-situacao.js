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
check('Status 1 -> x_studio_te_situation "1" + te_order_id', function() {
  const d = mapper.teWebhookToOdoo({
    OrderID: '4321',
    Status: [{ Status: 1, StatusDescription: 'Saiu para entrega' }],
  });
  assert.strictEqual(d.x_studio_te_situation, '1');
  assert.strictEqual(d.x_studio_te_order_id, '4321');
  assert.strictEqual('x_studio_te_situacao' in d, false, 'campo inexistente nao pode mais ser gravado');
  assert.strictEqual('x_studio_te_situacao_desc' in d, false);
});
check('Status 10 (Em Separacao) e 12 (Baixada) mapeiam', function() {
  assert.strictEqual(mapper.teWebhookToOdoo({ Status: [{ Status: 10 }] }).x_studio_te_situation, '10');
  assert.strictEqual(mapper.teWebhookToOdoo({ Status: [{ Status: 12 }] }).x_studio_te_situation, '12');
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
  assert.ok(flat.indexOf('"|")') === -1, 'operador OU não pode virar string');
  assert.ok(flat.indexOf('"|",') !== -1, 'falta o OU em-andamento/ recentes');
  assert.ok(flat.indexOf('x_studio_te_situation') !== -1, 'sem filtro de situacao');
  assert.ok(flat.indexOf('scheduled_date') !== -1, 'sem piso de scheduled_date');
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
check('Status preenchido mapeia e NAO sobrescreve te_order_id', function() {
  const d = mapper.teToOdooPicking({
    OrderID: '5802',
    Status: [{ Status: 3, StatusDescription: 'Entregue' }],
  });
  assert.strictEqual(d.x_studio_te_situation, '3');
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

console.log('== consistencia do fonte ==');
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
