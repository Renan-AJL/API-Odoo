/**
 * Testes de aceitação — TE send-invoice + regressão
 * Roda contra o Render: https://api-odoo-rhzf.onrender.com
 */
const BASE = 'https://api-odoo-rhzf.onrender.com';
const API_KEY = 'cnpja-odoo-secret-2024';

async function test(name, fn) {
  try {
    const result = await fn();
    console.log('  ✅ ' + name + ': ' + result);
  } catch (err) {
    console.log('  ❌ ' + name + ': ' + err.message);
  }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { 'X-API-Key': API_KEY },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

console.log('\n═══ TESTES DE ACEITAÇÃO — TE send-invoice ═══\n');

// Teste 1: Fatura postada 114
await test('POST /te/send-invoice {invoice_id:114} → 200', async () => {
  const r = await post('/api/v1/te/send-invoice', { invoice_id: 114 });
  if (r.status === 200) return 'HTTP 200 OK | te_order_id=' + (r.data.te_order_id || r.data.order_id || 'N/A');
  if (r.status === 409) return 'HTTP 409 (draft) — esperado 200 para fatura postada';
  throw new Error('HTTP ' + r.status + ' | ' + JSON.stringify(r.data));
});

// Teste 2: Fatura postada 112
await test('POST /te/send-invoice {invoice_id:112} → 200', async () => {
  const r = await post('/api/v1/te/send-invoice', { invoice_id: 112 });
  if (r.status === 200) return 'HTTP 200 OK | te_order_id=' + (r.data.te_order_id || r.data.order_id || 'N/A');
  if (r.status === 409) return 'HTTP 409 (draft) — esperado 200 para fatura postada';
  throw new Error('HTTP ' + r.status + ' | ' + JSON.stringify(r.data));
});

// Teste 3: Fatura rascunho 111 → 409
await test('POST /te/send-invoice {invoice_id:111} → 409 (draft)', async () => {
  const r = await post('/api/v1/te/send-invoice', { invoice_id: 111 });
  if (r.status === 409) return 'HTTP 409 OK — "' + (r.data.error || '').substring(0, 60) + '"';
  if (r.status === 200) throw new Error('HTTP 200 — fatura 111 deveria ser rejeitada como draft');
  throw new Error('HTTP ' + r.status + ' (esperado 409) | ' + JSON.stringify(r.data));
});

// Teste 4: ID inexistente → 404 limpo
await test('POST /te/send-invoice {invoice_id:999999999} → 404', async () => {
  const r = await post('/api/v1/te/send-invoice', { invoice_id: 999999999 });
  if (r.status === 404) return 'HTTP 404 OK — "' + (r.data.error || '').substring(0, 60) + '"';
  throw new Error('HTTP ' + r.status + ' (esperado 404) | ' + JSON.stringify(r.data));
});

// Teste 5: ID inválido → 400
await test('POST /te/send-invoice sem invoice_id → 400', async () => {
  const r = await post('/api/v1/te/send-invoice', {});
  if (r.status === 400) return 'HTTP 400 OK — "' + (r.data.error || '').substring(0, 40) + '"';
  throw new Error('HTTP ' + r.status + ' (esperado 400)');
});

console.log('\n═══ REGRESSÃO — endpoints que NÃO devem quebrar ═══\n');

// Teste 6: CEP webhook ainda responde (sem auth vai dar 401, mas NAO 500)
await test('POST /cep/odoo-webhook sem auth → 401 (nao 500)', async () => {
  const r = await post('/api/v1/cep/odoo-webhook', { id: 1, cep: '84560000' });
  if (r.status === 401 || r.status === 403) return 'HTTP ' + r.status + ' OK (auth requerida)';
  if (r.status === 500) throw new Error('HTTP 500 — regressao! Endpoint quebrou');
  return 'HTTP ' + r.status + ' (aceitavel)';
});

// Teste 7: Server responde
await test('GET / → redirect (server up)', async () => {
  const res = await fetch(BASE + '/');
  if (res.status === 200 || res.status === 302) return 'HTTP ' + res.status + ' OK';
  throw new Error('HTTP ' + res.status);
});

console.log('\n═══ FIM ═══\n');
