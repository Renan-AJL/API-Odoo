/**
 * Teste do AUTO-BOLETO (services/boleto-auto.js + hook no sieg-odoo-emit.js)
 * Demanda AJL 22/10/2026: ao autorizar a NF-e, emitir os boletos automaticamente.
 *
 * Cenarios:
 *  1. deveEmitirBoletoAuto para todas as formas que geram boleto no /pagar
 *  2. Nao emite para PIX / cartao / entrega / vazio
 *  3. agendarBoletosAutomaticos monta o payload /pagar corretamente (mock HTTP)
 *  4. falha do /pagar NAO propagada (fire-and-forget) e chatter de erro chamado
 *  5. guardas: boleto ja existente, pagador sem CPF/CNPJ, kill-switch AUTO_BOLETO_NF=off
 */
process.env.MIDDLEWARE_API_KEY = 'test-key';
process.env.PORT = '3999';
process.env.PUBLIC_BASE_URL = 'https://mw.exemplo.com'; // p/ validar reescrita dos links no chatter

var assert = require('assert');
var http = require('http');
var { deveEmitirBoletoAuto, agendarBoletosAutomaticos } = require('../services/boleto-auto');

var checks = 0;
function ok(cond, label) {
  if (!cond) throw new Error('FALHOU: ' + label);
  checks++;
  console.log('  OK: ' + label);
}

console.log('--- 1) Formas que GERAM boleto (mesmo parser do /pagar) ---');
['BOLETO', 'BOLETO 30/60/90', 'boleto 2x', '28DD', 'BOL 14/28/42',
 '1 + 30 BOLETO', 'ENTRADA+PARCELADO 3', 'ENTRADA + PARCELAMENTO 10'].forEach(function(f) {
  ok(deveEmitirBoletoAuto(f) === true, 'gera boleto: "' + f + '"');
});

console.log('--- 2) Formas que NAO geram boleto ---');
['', 'PIX', 'PIX 500', 'CREDITO', 'MASTER 3X', 'VISA DEBITO', 'ENTREGA', 'DINHEIRO', 'DEPOSITO 24H'].forEach(function(f) {
  ok(deveEmitirBoletoAuto(f) === false, 'nao gera: "' + f + '"');
});

console.log('--- 3) Payload enviado ao /pagar interno (mock HTTP) ---');
var recebidos = [];
var server = http.createServer(function(req, res) {
  var chunks = [];
  req.on('data', function(c) { chunks.push(c); });
  req.on('end', function() {
    recebidos.push({
      url: req.url,
      apiKey: req.headers['x-api-key'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      data: {
        forma_pagamento: 'BOLETO 30/60/90', total_parcelas: 3,
        valor_total: '8376.00', odoo_push: 'OK_3_attachments',
        pagamentos: [
          { tipo: 'boleto', parcela: 1, total_parcelas: 3, nosso_numero: '111', valor_titulo: '2792.00', data_vencimento: '2026-11-21', linha_digitavel: '34191.1', pdf_url_txid: 'http://127.0.0.1:3999/api/v1/itau/boletos/pdf/tx1' },
          { tipo: 'boleto', parcela: 2, total_parcelas: 3, nosso_numero: '222', valor_titulo: '2792.00', data_vencimento: '2026-12-21', linha_digitavel: '', pdf_url_txid: '' },
          { tipo: 'boleto', parcela: 3, total_parcelas: 3, nosso_numero: '333', valor_titulo: '2792.00', data_vencimento: '2027-01-21', linha_digitavel: '', pdf_url_txid: '' },
        ],
      },
    }));
  });
});
var notas = [];
function postChatter(html) { notas.push(html); return Promise.resolve(); }

function agendar(ctx, ms) {
  return new Promise(function(resolve) {
    var r0 = recebidos.length, n0 = notas.length;
    var timer = setInterval(function() {
      // resolve quando chega chamada OU quando o chatter postou nota (cenário de falha)
      if (recebidos.length > r0 || notas.length > n0) { clearInterval(timer); resolve(); }
    }, ms || 50);
    agendarBoletosAutomaticos(Object.assign({ postChatter: postChatter }, ctx));
  });
}

(async function() {
  await new Promise(function(r) { server.listen(3999, r); });

  // 3a) Fluxo OK com 3 parcelas
  await agendar({
    moveId: 1234, faturaName: 'NFe 00072944', formaPagamento: 'BOLETO 30/60/90',
    valorNF: 8376.00, dataVencBase: '2026-11-21',
    pagador: { nome: 'DJONATA VIEIRA', cpf_cnpj: '123.456.789-00', street: 'Av Brasil 100', city: 'Pato Branco', state: 'PR', zip: '85501-000' },
    boletoJaExiste: false,
  });
  ok(recebidos.length === 1, '1 chamada ao /pagar interno');
  var r = recebidos[0];
  ok(r.url === '/api/v1/itau/pagar', 'URL correta: ' + r.url);
  ok(r.apiKey === 'test-key', 'X-API-Key propagada');
  ok(r.body.fatura.id === 1234 && r.body.fatura.name === 'NFe 00072944', 'fatura id+name corretos');
  ok(r.body.fatura.valor_nominal === 8376 && r.body.fatura.data_vencimento === '2026-11-21', 'valor+venc corretos');
  ok(r.body.pagador.cpf_cnpj === '123.456.789-00' && r.body.pagador.state === 'PR', 'pagador correto');
  ok(r.body.forma_pagamento === 'BOLETO 30/60/90', 'forma propagada');
  ok(notas.length === 1 && notas[0].indexOf('Boletos emitidos automaticamente') >= 0, 'chatter de sucesso postado');
  ok(notas[0].indexOf('NN 111') >= 0 && notas[0].indexOf('NN 222') >= 0 && notas[0].indexOf('NN 333') >= 0, '3 NNs no chatter');
  ok(notas[0].indexOf('127.0.0.1') < 0, 'URL 127.0.0.1 reescrita no chatter');

  // 3b) Guarda: boleto ja existe (nao chama, nao postaa nada — valida por tempo)
  var antes = recebidos.length;
  agendarBoletosAutomaticos({ moveId: 2, faturaName: 'NFe 00000001', formaPagamento: 'BOLETO', valorNF: 100,
    pagador: { nome: 'X', cpf_cnpj: '1' }, boletoJaExiste: true, postChatter: postChatter });
  await new Promise(function(r) { setTimeout(r, 1900); });
  ok(recebidos.length === antes, 'guarda boleto-ja-existente: nenhuma chamada');

  // 3c) Guarda: pagador sem CPF/CNPJ (chama o chatter mas nao o /pagar)
  var notasAntes = notas.length;
  await agendar({ moveId: 3, faturaName: 'NFe 00000002', formaPagamento: 'BOLETO 2X', valorNF: 100,
    pagador: { nome: 'Sem CPF' }, boletoJaExiste: false });
  ok(recebidos.length === antes, 'guarda sem-CPF: nenhuma chamada');
  ok(notas.length === notasAntes + 1 && notas[notas.length - 1].indexOf('CPF/CNPJ') >= 0, 'chatter avisa CPF/CNPJ ausente');

  // 3d) Guarda: forma nao-boleto (valida por tempo)
  agendarBoletosAutomaticos({ moveId: 4, faturaName: 'NFe 00000003', formaPagamento: 'PIX', valorNF: 100,
    pagador: { nome: 'X', cpf_cnpj: '1' }, boletoJaExiste: false, postChatter: postChatter });
  await new Promise(function(r) { setTimeout(r, 1900); });
  ok(recebidos.length === antes, 'guarda PIX: nenhuma chamada');

  // 4) Falha do /pagar -> nao propaga, chatter de falha
  server.close();
  var notasAntes2 = notas.length;
  await agendar({ moveId: 5, faturaName: 'NFe 00000004', formaPagamento: 'BOLETO 30', valorNF: 100,
    pagador: { nome: 'X', cpf_cnpj: '1' }, boletoJaExiste: false }, 900);
  ok(recebidos.length === antes, 'apos fechar server: sem nova chamada recebida');
  ok(notas.length === notasAntes2 + 1 && notas[notas.length - 1].indexOf('NAO emitidos') >= 0, 'chatter de falha postado');

  // 5) Kill-switch (retorna sem agendar — valida por tempo, sem agendar)
  process.env.AUTO_BOLETO_NF = 'off';
  var antesKS = recebidos.length;
  agendarBoletosAutomaticos({ moveId: 6, faturaName: 'NFe 00000005', formaPagamento: 'BOLETO', valorNF: 100,
    pagador: { nome: 'X', cpf_cnpj: '1' }, boletoJaExiste: false, postChatter: postChatter });
  await new Promise(function(r) { setTimeout(r, 1900); }); // > AUTO_DELAY_MS (1500ms)
  ok(recebidos.length === antesKS, 'kill-switch AUTO_BOLETO_NF=off respeitado');
  delete process.env.AUTO_BOLETO_NF;

  console.log('\n--- 6) Registro da flag de auto-boleto (sieg-odoo-emit) ---');
  var emit = require('../services/sieg-odoo-emit');
  emit.marcarAutoBoleto([9001, 9002]);
  ok(emit.consumirAutoBoleto(9001) === true, 'flag marcada -> consumida (armada)');
  ok(emit.consumirAutoBoleto(9001) === false, 'flag consumida 1x (nao rearma sozinha)');
  ok(emit.consumirAutoBoleto(9999) === false, 'id sem flag -> false (fluxo comum)');
  ok(emit.consumirAutoBoleto(9002) === true, 'segunda fatura marcada tambem arme');
  ok(emit.consumirAutoBoleto('9002') === false, 'apos consumo por numero, string equivalente nao rearma');

  console.log('\n=== ' + checks + ' CHECKS OK — AUTO-BOLETO VALIDADO ===');
  process.exit(0);
})().catch(function(e) {
  console.error('ERRO:', e);
  process.exit(1);
});
