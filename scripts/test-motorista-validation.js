/**
 * Teste de validação do motorista obrigatório no send-invoice
 * Roda contra o Render: https://api-odoo-rhzf.onrender.com
 * 
 * Cenários:
 * 1. Invoice COM x_studio_motorista_te preenchido → deve enviar (200)
 * 2. Invoice SEM x_studio_motorista_te → deve rejeitar (400)
 */
const BASE = 'https://api-odoo-rhzf.onrender.com';
const API_KEY = 'cnpja-odoo-secret-2024';

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

console.log('\n═══ TESTE: Motorista obrigatório no send-invoice ═══\n');

// Teste 1: Invoice 114 — verificar se tem motorista
console.log('1. Testando invoice 114 (verificar se envia ou rejeita por motorista)...');
const r1 = await post('/api/v1/te/send-invoice', { invoice_id: 114 });
if (r1.status === 200) {
  console.log('   ✅ HTTP 200 — Invoice 114 tem motorista e foi enviada ao TE');
  console.log('   Motorista: ' + (r1.data.motorista || 'N/A'));
  console.log('   TE OrderID: ' + (r1.data.te_order_id || 'N/A'));
} else if (r1.status === 400 && r1.data.error && r1.data.error.includes('motorista')) {
  console.log('   ✅ HTTP 400 — Invoice 114 SEM motorista (corretamente rejeitada)');
  console.log('   Erro: ' + r1.data.error);
} else {
  console.log('   ⚠️ HTTP ' + r1.status + ' — Resposta inesperada: ' + JSON.stringify(r1.data));
}

// Teste 2: Invoice sem motorista (usar uma que sabemos não ter motorista)
console.log('\n2. Testando invoice 112 (sem motorista preenchido)...');
const r2 = await post('/api/v1/te/send-invoice', { invoice_id: 112 });
if (r2.status === 400 && r2.data.error && r2.data.error.includes('motorista')) {
  console.log('   ✅ HTTP 400 — Invoice 112 corretamente BLOQUEADA por falta de motorista');
  console.log('   Erro: ' + r2.data.error);
} else if (r2.status === 200) {
  console.log('   ⚠️ HTTP 200 — Invoice 112 enviou AO TE (tem motorista?)');
  console.log('   TE OrderID: ' + (r2.data.te_order_id || 'N/A'));
} else {
  console.log('   ⚠️ HTTP ' + r2.status + ' — Resposta: ' + JSON.stringify(r2.data));
}

console.log('\n═══ FIM ═══\n');
