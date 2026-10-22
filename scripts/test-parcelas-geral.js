/**
 * Teste: PARCELAS EDITAVEIS para TODAS as formas com boleto (demanda 22/10/2026).
 * Espelha exatamente aplicarConfigBoleto() de routes/itau-api.js
 * (nao chama Odoo nem Itau — validacao de logica pura).
 *
 * Cenarios:
 *  1. Sem config/entrada/qtd -> null (mantem plano do parse, comportamento atual)
 *  2. parcelasConfig (x_fatura.parcela) -> valorFixo/dataFixa por boleto + aviso quando soma difere
 *  3. Entrada em formas nao-E+P ('DIN + BOLETO', 'BOLETO 30/60') -> financia total-entrada,
 *     preservando os dias do parse quando a contagem bate
 *  4. qtd sem config -> split igual i*30 (E+P style), qtd do campo da fatura
 *  5. Valor/data por parcela aplicados no calculo (valorFixo ignora split; dataFixa vira vencimento)
 */
var assert = require('assert');

// ==== ESPELHO de routes/itau-api.js (manter sincronizado) ====
function aplicarConfigBoleto(planoParse, ep) {
  if (!ep) return null;
  var temConfig = ep.parcelasConfig && ep.parcelasConfig.length > 0;
  var temQtd = (parseInt(ep.qtdParcelas) || 0) > 0;
  var temEntrada = (parseFloat(ep.entrada) || 0) > 0;
  if (!temConfig && !temQtd && !temEntrada) return null;

  var nParc = temConfig ? ep.parcelasConfig.length
    : Math.max(1, Math.min(parseInt(ep.qtdParcelas) || (planoParse && planoParse.parcelas ? planoParse.parcelas.length : 1), 60));
  var parcelas = [];
  if (temConfig) {
    parcelas = ep.parcelasConfig.map(function (pc, ix) {
      return { numero: pc.numero || (ix + 1), dias: 0, valor_pct: 0, valorFixo: pc.valor, dataFixa: pc.data };
    });
    var somaCfg = 0;
    for (var s = 0; s < parcelas.length; s++) somaCfg += parcelas[s].valorFixo;
    somaCfg = Math.round(somaCfg * 100) / 100;
    var dif = Math.round((somaCfg - (ep.financiado || 0)) * 100) / 100;
    var aviso = (Math.abs(dif) > 0.05)
      ? ('Soma das parcelas configuradas (R$ ' + somaCfg.toFixed(2) + ') difere do financiado (R$ ' +
        (ep.financiado || 0).toFixed(2) + ') — boletos emitidos com os valores configurados')
      : '';
    return { plano: { tipo: 'boleto', parcelas: parcelas, baseValor: ep.financiado, epBaseHoje: true }, aviso: aviso };
  }
  var diasParse = (planoParse && planoParse.tipo === 'boleto' && planoParse.parcelas &&
    planoParse.parcelas.length === nParc) ? planoParse.parcelas.map(function (p) { return p.dias; }) : null;
  for (var i = 1; i <= nParc; i++) {
    parcelas.push({ numero: i, dias: diasParse ? diasParse[i - 1] : i * 30, valor_pct: 100 / nParc });
  }
  return { plano: { tipo: 'boleto', parcelas: parcelas, baseValor: ep.financiado, epBaseHoje: true }, aviso: '' };
}

// ==== ESPELHO de parseFormaPagamento (services/itau-boleto.js) — resumo p/ cenarios ====
function parse(forma) {
  var upper = String(forma).toUpperCase().trim();
  var isBoleto = upper.indexOf('BOLETO') >= 0 || upper.indexOf('BOL ') >= 0;
  var isCartao = upper.indexOf('AMEX') >= 0 || upper.indexOf('MASTER') >= 0 || upper.indexOf('CART') >= 0 || upper.indexOf('CREDIT') >= 0;
  var isEntrega = upper.indexOf('ENTREGA') >= 0 && !isBoleto;
  var hasSlash = upper.indexOf('/') >= 0;
  if (isEntrega && !hasSlash) return { tipo: 'entrega', parcelas: [] };
  if (isCartao && !isBoleto) return { tipo: 'cartao', parcelas: [] };
  if (isBoleto && (upper.indexOf('DIN') >= 0 || upper.indexOf('C.CRED') >= 0 || upper.indexOf('C.CARD') >= 0)) {
    return { tipo: 'boleto', parcelas: [{ numero: 1, dias: 30, valor_pct: 100 }] };
  }
  var clean = upper.replace(/^\d+\s*\+\s*/, '');
  if (hasSlash) {
    var days = [];
    upper.split('/').forEach(function (part) {
      var nums = part.match(/\d+/g);
      if (nums) days.push(parseInt(nums[nums.length - 1]));
    });
    if (days.length >= 1) {
      return { tipo: 'boleto', parcelas: days.map(function (d, i) { return { numero: i + 1, dias: d, valor_pct: 100 / days.length }; }) };
    }
  }
  clean = clean.replace(/BOLETO/g, '').replace(/BOL/g, '').replace(/DD/g, '').replace(/\bD\b/g, '').trim();
  var countMatch = clean.match(/(\d+)\s*(?:BOLETOS|X\b|VEZES)/);
  if (countMatch) {
    var n = parseInt(countMatch[1]);
    if (n > 0) {
      var parcelas = [];
      for (var i = 0; i < n; i++) parcelas.push({ numero: i + 1, dias: (i + 1) * 30, valor_pct: 100 / n });
      return { tipo: 'boleto', parcelas: parcelas };
    }
  }
  var singleMatch = clean.match(/(\d+)/);
  if (singleMatch) {
    var d2 = parseInt(singleMatch[1]);
    if (d2 > 0 && d2 <= 365) return { tipo: 'boleto', parcelas: [{ numero: 1, dias: d2, valor_pct: 100 }] };
  }
  if (isBoleto) return { tipo: 'boleto', parcelas: [{ numero: 1, dias: 30, valor_pct: 100 }] };
  return { tipo: 'desconhecido', parcelas: [] };
}

var checks = 0;
function ok(cond, label) {
  if (!cond) throw new Error('FALHOU: ' + label);
  checks++;
  console.log('  OK: ' + label);
}

console.log('--- 1) Sem configuracao -> mantem plano do parse (comportamento atual) ---');
var epVazio = { entrada: 0, qtdParcelas: 0, financiado: 1000 };
ok(aplicarConfigBoleto(parse('BOLETO 30/60/90'), epVazio) === null, 'BOLETO 30/60/90 sem nada: null (parse mantido)');
ok(aplicarConfigBoleto(parse('BOLETO 07DD'), epVazio) === null, 'BOLETO 07DD sem nada: null');
ok(aplicarConfigBoleto(parse('ENTRADA + PARCELAMENTO'), { entrada: 0, qtdParcelas: 0, financiado: 100 }) === null,
  'E+P sem campos preenchidos: null (parse = 1 boleto 30d, igual comportamento antigo)');

console.log('--- 2) parcelasConfig (valores/datas do financeiro) ---');
var r2 = aplicarConfigBoleto(parse('ENTRADA + PARCELAMENTO'), {
  entrada: 1000, qtdParcelas: 3, financiado: 2000,
  parcelasConfig: [
    { numero: 1, data: '2026-11-10', valor: 800 },
    { numero: 2, data: '2026-12-10', valor: 700 },
    { numero: 3, data: '2027-01-10', valor: 500 },
  ],
});
ok(r2 && r2.plano.parcelas.length === 3, 'CONFIG: 3 boletos');
ok(r2.plano.parcelas[0].valorFixo === 800 && r2.plano.parcelas[2].valorFixo === 500, 'CONFIG: valores exatos (800/500)');
ok(r2.plano.parcelas[0].dataFixa === '2026-11-10', 'CONFIG: dataFixa 1a parcela');
ok(r2.plano.baseValor === 2000, 'CONFIG: baseValor = financiado');
ok(r2.aviso === '', 'CONFIG: sem aviso quando soma bate (2000)');

var r2b = aplicarConfigBoleto(parse('ENTRADA + PARCELAMENTO'), {
  entrada: 1000, qtdParcelas: 3, financiado: 2000,
  parcelasConfig: [
    { numero: 1, data: '2026-11-10', valor: 900 },
    { numero: 2, data: '2026-12-10', valor: 900 },
  ],
});
ok(r2b && r2b.aviso.indexOf('1800.00') >= 0 && r2b.aviso.indexOf('2000.00') >= 0, 'CONFIG com soma errada: aviso com os dois valores');
ok(r2b.plano.parcelas.length === 2, 'CONFIG: usa a quantidade de linhas configuradas (2)');

console.log('--- 3) Entrada em formas NAO-E+P (generalizacao) ---');
var r3 = aplicarConfigBoleto(parse('DIN + BOLETO'), { entrada: 300, qtdParcelas: 0, financiado: 700 });
ok(r3 && r3.plano.parcelas.length === 1 && r3.plano.parcelas[0].dias === 30, 'DIN + BOLETO c/ entrada: 1 boleto 30d (dias do parse preservado)');
ok(r3.plano.baseValor === 700, 'DIN + BOLETO c/ entrada: base = financiado (total-entrada)');

var r3b = aplicarConfigBoleto(parse('BOLETO 30/60'), { entrada: 200, qtdParcelas: 0, financiado: 800 });
ok(r3b.plano.parcelas.length === 2 && r3b.plano.parcelas[0].dias === 30 && r3b.plano.parcelas[1].dias === 60,
  'BOLETO 30/60 c/ entrada: dias 30/60 preservados, 2 boletos');
ok(r3b.plano.parcelas[0].valor_pct === 50, 'BOLETO 30/60 c/ entrada: split igual do financiado');

console.log('--- 4) qtd sem config (campo Quantidade de Parcelas da fatura) ---');
var r4 = aplicarConfigBoleto(parse('BOLETO 30/60/90'), { entrada: 0, qtdParcelas: 5, financiado: 1000 });
ok(r4.plano.parcelas.length === 5, 'qtd=5 sobrepoe o parse (5 boletos)');
ok(r4.plano.parcelas[4].dias === 150, 'qtd=5: 5o boleto em 150 dias (i*30)');
var r4b = aplicarConfigBoleto(parse('ENTRADA + PARCELAMENTO'), { entrada: 100, qtdParcelas: 4, financiado: 900 });
ok(r4b.plano.parcelas.length === 4 && r4b.plano.parcelas[0].dias === 30, 'E+P qtd=4: 4x30 (igual ao comportamento E+P atual)');

console.log('--- 5) Calculo por parcela: valorFixo/dataFixa vencem (loop do /pagar) ---');
var baseValorPag = r2.plano.baseValor;
var totalP = r2.plano.parcelas.length;
var valores = [];
for (var i = 0; i < totalP; i++) {
  var parc = r2.plano.parcelas[i];
  var valorParc;
  if (typeof parc.valorFixo === 'number' && parc.valorFixo > 0) {
    valorParc = Math.round(parc.valorFixo * 100) / 100; // valor configurado vence
  } else {
    valorParc = Math.round((baseValorPag * parc.valor_pct / 100) * 100) / 100;
  }
  valores.push(valorParc);
}
ok(JSON.stringify(valores) === JSON.stringify([800, 700, 500]), 'loop /pagar: usa valores configurados (800/700/500)');

var r5b = aplicarConfigBoleto(parse('ENTRADA + PARCELAMENTO'), { entrada: 500, qtdParcelas: 2, financiado: 1500 });
var bv = r5b.plano.baseValor, soma = 0;
for (var k = 0; k < 2; k++) soma += Math.round((bv * r5b.plano.parcelas[k].valor_pct / 100) * 100) / 100;
ok(Math.round(soma * 100) / 100 === 1500, 'split igual do financiado fecha em 1500 (1500/2 x2, ultimo absorve arredondamento)');

console.log('\n=== ' + checks + ' CHECKS OK — PARCELAS EDITAVEIS GENERALIZADAS VALIDADAS ===');
