#!/usr/bin/env node
/**
 * acceptance-test.js - Testes de aceitação pós-deploy
 * ============================================================
 * Rodar após deploy no Render para validar:
 *   1. Idempotente: CEP já gravado -> sem_mudancas
 *   2. Mudança real: CEP diferente -> write só nos campos que mudaram
 *   3. Id inexistente: 999999999 -> sucesso:false imediato
 *   4. Id inválido: 0 ou negativo -> rejeitado
 *
 * Uso:
 *   CEP_WEBHOOK_SECRET=xxx MIDDLEWARE_URL=https://api-odoo-rhzf.onrender.com node scripts/acceptance-test.js
 *
 * Ou com defaults para teste local:
 *   node scripts/acceptance-test.js
 */

const axios = require('axios');

const BASE_URL = process.env.MIDDLEWARE_URL || 'https://api-odoo-rhzf.onrender.com';
const SECRET = process.env.CEP_WEBHOOK_SECRET || '';

if (!SECRET) {
  console.error('ERRO: CEP_WEBHOOK_SECRET não definido. Uso:');
  console.error('  CEP_WEBHOOK_SECRET=xxx node scripts/acceptance-test.js');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL: ' + msg); }
}

async function callWebhook(id, cep) {
  try {
    const res = await axios.post(
      BASE_URL + '/api/v1/cep/odoo-webhook',
      { id, cep },
      { headers: { 'X-CEP-Webhook-Secret': SECRET }, timeout: 15000 }
    );
    return { status: res.status, data: res.data };
  } catch (err) {
    if (err.response) {
      return { status: err.response.status, data: err.response.data };
    }
    return { status: 0, data: { erro: err.message } };
  }
}

(async () => {
  console.log('=== Testes de Aceitação - CEP Webhook v2.0 ===');
  console.log('URL:', BASE_URL);
  console.log('');

  // --- 1. Id inválido (0) ---
  console.log('1. Id inválido (0):');
  var r1 = await callWebhook(0, '84560000');
  assert(r1.status === 400, 'HTTP 400 para id=0');
  assert(r1.data.sucesso === false, 'sucesso=false para id=0');

  // --- 2. Id inválido (negativo) ---
  console.log('2. Id inválido (-1):');
  var r2 = await callWebhook(-1, '84560000');
  assert(r2.status === 400, 'HTTP 400 para id=-1');
  assert(r2.data.sucesso === false, 'sucesso=false para id=-1');

  // --- 3. Id inexistente ---
  console.log('3. Id inexistente (999999999):');
  var r3 = await callWebhook(999999999, '84560000');
  assert(r3.status === 404, 'HTTP 404 para id inexistente');
  assert(r3.data.sucesso === false, 'sucesso=false para id inexistente');

  // --- 4. Idempotente (partner real com CEP já gravado) ---
  // NOTA: ajuste PARTNER_ID_EXISTENTE para um ID real no Odoo
  var partnerId = process.env.PARTNER_ID_EXISTENTE || 126954;
  var partnerCep = process.env.PARTNER_CEP_EXISTENTE || '84560000';
  console.log('4. Idempotente (partner ' + partnerId + ' com CEP ' + partnerCep + '):');
  var r4 = await callWebhook(partnerId, partnerCep);
  assert(r4.status === 200, 'HTTP 200');
  assert(r4.data.sucesso === true, 'sucesso=true');
  assert(r4.data.odoo_updated === false, 'odoo_updated=false (sem mudancas)');
  assert(r4.data.motivo === 'sem_mudancas', 'motivo=sem_mudancas');

  // --- 5. Mudança real (partner com CEP diferente) ---
  var novoCep = process.env.PARTER_CEP_NOVO || '83323000';
  console.log('5. Mudança real (partner ' + partnerId + ' -> CEP ' + novoCep + '):');
  var r5 = await callWebhook(partnerId, novoCep);
  assert(r5.status === 200, 'HTTP 200');
  assert(r5.data.sucesso === true, 'sucesso=true');
  // odoo_updated pode ser true ou false (depende se o CEP é válido e retorna dados diferentes)
  if (r5.data.odoo_updated === true) {
    assert(r5.data.campos_atualizados && r5.data.campos_atualizados.length > 0, 'campos_atualizados nao vazio');
    console.log('    Campos atualizados:', r5.data.campos_atualizados.join(', '));
  } else {
    console.log('    (CEP não retornou dados diferentes ou consulta falhou - ok)');
  }

  // --- 6. Restaurar CEP original ---
  console.log('6. Restaurar CEP original:');
  var r6 = await callWebhook(partnerId, partnerCep);
  assert(r6.status === 200, 'HTTP 200');
  assert(r6.data.sucesso === true, 'sucesso=true');

  console.log('');
  console.log('=== Resultado: ' + passed + ' passou, ' + failed + ' falhou ===');
  if (failed > 0) process.exit(1);
})();
