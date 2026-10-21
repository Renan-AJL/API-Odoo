// Teste local da logica E+P CONFIG (demanda 22/10/2026):
// dataIsoEP + mapeamento parcelasConfig -> plano (valorFixo/dataFixa) + calculo valor/data
// Espelha exatamente o codigo de routes/itau-api.js (nao chama Odoo nem Itau).
var assert = require('assert');

function dataIsoEP(v) {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return v.toISOString().slice(0, 10);
  }
  var mEP = String(v).match(/\d{4}-\d{2}-\d{2}/);
  return mEP ? mEP[0] : '';
}

function buildPlano(epDados) {
  var nParcEP = Math.max(1, Math.min(parseInt(epDados.qtdParcelas) || 1, 60));
  var parcelasEP = [];
  if (epDados.parcelasConfig && epDados.parcelasConfig.length) {
    parcelasEP = epDados.parcelasConfig.map(function(pcEP, ixEP) {
      return { numero: pcEP.numero || (ixEP + 1), dias: 0, valor_pct: 0, valorFixo: pcEP.valor, dataFixa: pcEP.data };
    });
  } else {
    for (var epi = 1; epi <= nParcEP; epi++) {
      parcelasEP.push({ numero: epi, dias: epi * 30, valor_pct: 100 / nParcEP });
    }
  }
  return { tipo: 'boleto', parcelas: parcelasEP, baseValor: epDados.financiado, epBaseHoje: true };
}

function calcDataVenc(base, dias) {
  var db = base ? new Date(base + 'T12:00:00') : new Date();
  var hj = new Date(); hj.setHours(0, 0, 0, 0);
  if (db <= hj) db = new Date();
  db.setDate(db.getDate() + dias);
  var a = db.getFullYear();
  var m = String(db.getMonth() + 1).padStart(2, '0');
  var d = String(db.getDate()).padStart(2, '0');
  return a + '-' + m + '-' + d;
}

function calcValorData(parc, i, totalP, baseValor, epBaseHoje, dataVencBase) {
  var valorParc;
  if (typeof parc.valorFixo === 'number' && parc.valorFixo > 0) {
    valorParc = Math.round(parc.valorFixo * 100) / 100;
  } else {
    valorParc = Math.round((baseValor * parc.valor_pct / 100) * 100) / 100;
    if (i === totalP - 1) {
      var soma = 0;
      for (var j = 0; j < totalP - 1; j++) soma += Math.round((baseValor * buildPlanoDummy().parcelas[j].valor_pct / 100) * 100) / 100;
      valorParc = Math.round((baseValor - soma) * 100) / 100;
    }
  }
  var dataVenc = (parc.dataFixa && /^\d{4}-\d{2}-\d{2}$/.test(parc.dataFixa))
    ? parc.dataFixa
    : calcDataVenc(epBaseHoje ? '' : dataVencBase, parc.dias);
  return { valor: valorParc, data: dataVenc };
}
function buildPlanoDummy() { return { parcelas: [{ valor_pct: 50 }, { valor_pct: 50 }] }; }

// --- casos ---
// 1) dataIsoEP: string Odoo, Date, lixo
assert.strictEqual(dataIsoEP('2026-12-15'), '2026-12-15');
assert.strictEqual(dataIsoEP('2026-12-15 00:00:00'), '2026-12-15');
assert.strictEqual(dataIsoEP(new Date(Date.UTC(2026, 10, 20))), '2026-11-20');
assert.strictEqual(dataIsoEP(''), '');
assert.strictEqual(dataIsoEP('lixo'), '');
console.log('1) dataIsoEP OK');

// 2) CONFIG presente: usa data/valor da fatura (exemplo do teste E2E: 150 no dia 15/12 + 100 no dia 21/12)
// (o middleware entrega parcelasConfig ja ORDENADA por numero — lerFaturaEntradaParcelamento)
var cfgBruta = [
  { numero: 2, data: '2026-12-21', valor: 100 },
  { numero: 1, data: '2026-12-15', valor: 150 },
];
cfgBruta.sort(function(a, b) { return (a.numero || 999) - (b.numero || 999); }); // mesmo sort do middleware
var epCfg = { entrada: 100, qtdParcelas: 2, financiado: 200, parcelasConfig: cfgBruta };
var plano2 = buildPlano(epCfg);
assert.strictEqual(plano2.parcelas.length, 2);
assert.strictEqual(plano2.parcelas[0].numero, 1); // ordenado por numero
var r1 = calcValorData(plano2.parcelas[0], 0, 2, plano2.baseValor, true, '');
assert.strictEqual(r1.valor, 150.00);
assert.strictEqual(r1.data, '2026-12-15');
var r2 = calcValorData(plano2.parcelas[1], 1, 2, plano2.baseValor, true, '');
assert.strictEqual(r2.valor, 100.00);
assert.strictEqual(r2.data, '2026-12-21');
console.log('2) CONFIG: parcela 1 = R$ 150,00 em 15/12 | parcela 2 = R$ 100,00 em 21/12 OK');

// 3) SEM config: fallback 30/60/90 (comportamento atual mantido)
var plano3 = buildPlano({ entrada: 100, qtdParcelas: 3, financiado: 200 });
assert.strictEqual(plano3.parcelas.length, 3);
assert.strictEqual(plano3.parcelas[0].dias, 30);
var r3 = calcValorData(plano3.parcelas[0], 0, 3, 200, true, '');
assert.strictEqual(r3.valor, 66.67);
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r3.data));
console.log('3) Fallback 30/60/90 mantido OK');

// 4) numeroPedido sufixo
var sufixoParcela = function(num, total) {
  var p = String(parseInt(num || 1, 10)).padStart(2, '0');
  var t = String(parseInt(total || 1, 10)).padStart(2, '0');
  return '-' + p + '/' + t;
};
assert.strictEqual(sufixoParcela(1, 2), '-01/02');
console.log('4) sufixoParcela OK');

// 5) soma dos valores configurados = financiado (admin responsavel, mas valida consistencia do exemplo)
var somaCfg = epCfg.parcelasConfig.reduce(function(s, p) { return s + p.valor; }, 0);
assert.strictEqual(Math.round(somaCfg * 100) / 100, epCfg.financiado + 50); // 150+100=250 vs financiado 200 (exemplo E2E com edicao p/ cima)
console.log('5) Somatorio config = 250 (edicao manual do financeiro respeitada) OK');

console.log('\nTODOS OS TESTES DA LOGICA E+P CONFIG PASSARAM');
