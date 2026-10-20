// Teste rapido do buildPagamentoInfo (parcelas/duplicatas/forma de pagamento)
var { buildPagamentoInfo } = require('../services/sieg-odoo-emit');

function show(label, out) {
  console.log('---', label);
  console.log('  tipoPag:', out.tipoPag, '| tPag:', out.tPag, '| indPag:', out.indPag, '| label:', out.formaLabel);
  console.log('  pagamentos:', JSON.stringify(out.pagamentos));
  console.log('  duplicatas:', JSON.stringify(out.duplicatas));
  console.log('  boletoDetalhes:', JSON.stringify(out.boletoDetalhes).substring(0, 240));
}

// 1. BOLETO 28/56/84 — o caso da NF 72853 (S01555, DOBROFER)
show('BOLETO 28/56/84', buildPagamentoInfo({
  forma: 'BOLETO 28/56/84', vNF: 20880, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [],
}));

// 2. BOLETO 28/56/84 com parcelas reais na fatura (term lines) — valores reescalonados
show('BOLETO 28/56/84 c/ parcelas fatura', buildPagamentoInfo({
  forma: 'BOLETO 28/56/84', vNF: 1000.03,
  parcelasFatura: [
    { vencimento: '2026-11-17', valor: 333.35 },
    { vencimento: '2026-12-15', valor: 333.34 },
    { vencimento: '2027-01-12', valor: 333.34 },
  ],
  dataBase: '2026-10-20', itauBoletos: [],
}));

// 3. PIX
show('PIX', buildPagamentoInfo({ forma: 'PIX', vNF: 9116.65, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] }));

// 4. Vazio (compatibilidade historica = PIX a vista)
show('(vazio)', buildPagamentoInfo({ forma: '', vNF: 615, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] }));

// 5. BOLETO 30D
show('BOLETO 30D', buildPagamentoInfo({ forma: 'BOLETO 30D', vNF: 5192.28, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] }));

// 6. BOLETO 8X
show('BOLETO 8X', buildPagamentoInfo({ forma: 'BOLETO 8X', vNF: 8000, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] }));

// 7. PAGAMENTO A VISTA
show('PAGAMENTO A VISTA', buildPagamentoInfo({ forma: 'PAGAMENTO A VISTA', vNF: 500, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] }));

// 8. VISA CREDITO
show('VISA CREDITO', buildPagamentoInfo({ forma: 'VISA CREDITO', vNF: 300, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] }));

// 9. BOLETO 30/60/90
show('BOLETO 30/60/90', buildPagamentoInfo({ forma: 'BOLETO 30/60/90', vNF: 6524.4, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [{ nosso_numero: '123456', linha_digitavel: '34191...' }] }));

// 10. 1 + 30 BOLETO (entrada + 30d)
show('1 + 30 BOLETO', buildPagamentoInfo({ forma: '1 + 30 BOLETO', vNF: 1500, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] }));

// 11. soma das parcelas bate com vNF (3 casas)
var t = buildPagamentoInfo({ forma: 'BOLETO 28/56/84', vNF: 100.00, parcelasFatura: [], dataBase: '2026-10-20', itauBoletos: [] });
var soma = t.pagamentos.reduce(function(a, p) { return a + parseFloat(p.vPag); }, 0);
console.log('--- validacao soma parcelas:', soma, '(esperado 100.00)', Math.abs(soma - 100) < 0.005 ? 'OK' : 'FALHA');
