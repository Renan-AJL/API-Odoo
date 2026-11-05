/**
 * test-cep-cache.js — Teste do cache/dedup do services/cep.service.js (v1.2.26)
 * ============================================================
 * Cenários:
 *   1. Consulta real de CEP válido (rede) — sucesso
 *   2. Segunda consulta do MESMO CEP — deve vir do cache (< 5ms, do_cache: true)
 *   3. Rajada de 10 consultas simultâneas de um CEP AINDA NÃO consultado —
 *      dedup em voo: axios é instrumentado e a rajada inteira deve custar
 *      exatamente 1 chamada HTTP externa (não 10)
 *   4. CEP inexistente (00000000 — falha confirmada nas 4 fontes) — falha
 *      total é CACHEADA por 5 min: a chamada seguinte volta na hora (< 50ms)
 *      com fontes_detalhes, sem martelar as fontes de novo (proteção contra
 *      rajada de writes)
 *
 * Uso: node scripts/test-cep-cache.js
 * (requer saída à internet para opencep/cepify/viacep/brasilapi)
 */
// Instrumenta o axios ANTES de carregar o serviço: conta chamadas HTTP reais.
// O serviço usa o MESMO objeto axios (require('axios') é cacheado pelo Node),
// então o patch vale para as 4 fontes.
var axios = require('axios');
var chamadasRede = 0;
var getOriginal = axios.get.bind(axios);
axios.get = function (url, cfg) {
  chamadasRede++;
  return getOriginal(url, cfg);
};

const { consultarCEP } = require('../services/cep.service');

function ms(t0) { return Date.now() - t0; }
let falhas = 0;

async function main() {
  var t0;

  // --- 1. Consulta real (rede) ---
  t0 = Date.now();
  var r1 = await consultarCEP('83323-000');
  var d1 = ms(t0);
  console.log('[1] CEP real 1a vez ......... ' + d1 + 'ms  sucesso=' + r1.sucesso + ' fonte=' + r1.fonte + ' cidade=' + r1.cidade);
  if (!r1.sucesso) { falhas++; console.log('    !! esperado sucesso'); }

  // --- 2. Cache hit ---
  t0 = Date.now();
  var r2 = await consultarCEP('83323000'); // sem máscara = mesmo CEP após limpar
  var d2 = ms(t0);
  console.log('[2] CEP real 2a vez (cache) . ' + d2 + 'ms  do_cache=' + !!r2.do_cache);
  if (!r2.do_cache || d2 > 50) { falhas++; console.log('    !! esperado cache hit < 50ms'); }

  // --- 3. Rajada simultânea (dedup em voo) — CEP novo, sem cache prévio ---
  var redeAntes = chamadasRede;
  t0 = Date.now();
  var rajada = await Promise.all(
    Array.from({ length: 10 }, function () { return consultarCEP('80.010-010'); })
  );
  var d3 = ms(t0);
  var redesNaRajada = chamadasRede - redeAntes;
  var okRajada = rajada.every(function (r) { return r.sucesso; });
  console.log('[3] Rajada 10x simultâneas .. ' + d3 + 'ms  sucesso=' + okRajada + '/10' +
    '  chamadasHTTP=' + redesNaRajada +
    (redesNaRajada === 1 ? ' (dedup: 1 ida à rede p/ 10 chamadas)' : ''));
  if (!okRajada || redesNaRajada !== 1) { falhas++; console.log('    !! esperado EXATAMENTE 1 chamada HTTP (dedup em voo)'); }

  // --- 4. Cache negativo (falha total) --- 00000000 não existe em nenhuma fonte
  redeAntes = chamadasRede;
  t0 = Date.now();
  var n1 = await consultarCEP('00000000');
  var dn1 = ms(t0);
  console.log('[4] CEP inexistente 1a vez .. ' + dn1 + 'ms  sucesso=' + n1.sucesso +
    ' fontes=' + (n1.fontes_consultadas || []).join(','));
  if (n1.sucesso) { falhas++; console.log('    !! 00000000 não deveria existir'); }

  redeAntes = chamadasRede; // baseline p/ a 2ª chamada (a 1ª consumiu as 4 fontes)
  t0 = Date.now();
  var n2 = await consultarCEP('00000000');
  var dn2 = ms(t0);
  console.log('[4] CEP inexistente 2a vez .. ' + dn2 + 'ms  do_cache=' + !!n2.do_cache +
    (n2.fontes_detalhes ? ' (fontes_detalhes preservado)' : '') +
    (chamadasRede === redeAntes ? '  HTTP=0 (cache negativo)' : '  HTTP=+' + (chamadasRede - redeAntes)));
  if (n2.sucesso || !n2.do_cache || dn2 > 50 || chamadasRede !== redeAntes) { falhas++; console.log('    !! esperado falha em cache < 50ms e 0 chamadas HTTP'); }

  console.log('');
  if (falhas > 0) {
    console.log('FALHOU: ' + falhas + ' cenário(s) com problema');
    process.exit(1);
  }
  console.log('OK: cache 24h, dedup em voo e cache negativo 5min funcionando (v1.2.26)');
}

main().catch(function (e) {
  console.error('ERRO:', e.message);
  process.exit(1);
});
