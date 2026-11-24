/**
 * ST ICMS MANUAL (AJL 24/11/2026, v1.2.44) — Substituição Tributária que
 * SOMA no valor da NF (demanda: fatura OURO PRETO COMERCIO DE FERRO E ACO
 * #5975, 30x43.22 = 1296.60; "a ST vai somar no valor da NF" — Marcus).
 *
 * Campos x_studio na fatura (grupo "ICMS Manual (NF-e)"):
 *   x_studio_st_icms      (Selection: '' = Sem ST | '10' = Com ST)
 *   x_studio_mva_st       (Float %) ex.: 95.39
 *   x_studio_aliquota_st  (Float %) ex.: 19.5
 * ICMS próprio vem do bloco 6b (ICMS Manual 12%: BC=vProd, vICMS=12%) ou
 * do cálculo automático por linha — o módulo lê o vicms FINAL de cada linha.
 *
 * Regra: vProd fica INTACTO (preço de tabela da fatura) e a ST é destacada
 * e somada no total: vNF = vProd + vICMSST (feita pelo chamador, seção 7).
 * Por linha: BCST = vProd×(1+MVA); vICMSST = BCST×pST − vICMS (convenção
 * CST 10: ST a recolher já deduzindo o próprio destacado). Ex. OURO PRETO:
 *   vProd 1296.60 | próprio 155.59 | BCST 2533.43 | vICMSST 338.43
 *   | vNF 1635.03  (= 1296.60 + 338.43)
 *
 * CST por linha vira 10 (Tributada e com cobrança do ICMS por ST) e DIFAL
 * é zerado (item com ST não recebe ICMSUFDest). Campo ST vazio = NADA é
 * chamado — emissão idêntica à de hoje (regressão testada).
 */
var round2 = function (v) { return Math.round((v + Number.EPSILON) * 100) / 100; };

/**
 * Aplica a ST por linha (vProd intocado, ST somada no total). st = {
 *   mva: 95.39, aliquotaSt: 19.5,
 * } opts = { isInterstate: bool } — CFOP 5401 (interno) / 6401 (interestadual),
 * modelo AJL NF 62346 (venda de produto ST do antigo emissor; AJL 24/11, v1.2.46).
 * Retorna { vProdTotal, vICMSTotal, vBCSTTotal, vICMSSTTotal, natOpSt } — o chamador
 * soma vICMSSTTotal no vNF (seção 7 do emit / ICMSTot do XML) e usa natOpSt na natOp.
 * Lança Erro com mensagem de negócio se faltar dado (emissão NÃO sai errada).
 */
function aplicarStManualLinhas(linesData, st, opts) {
  var mva = parseFloat(st.mva);
  var pSTpct = parseFloat(st.aliquotaSt);
  if (!(mva > 0) || !(pSTpct > 0)) {
    throw new Error('ST ativada na fatura, mas MVA ST (%) e/ou Alíq. ICMS ST (%) não preenchidos'
      + ' (recebido MVA=' + st.mva + ' / Alíq. ST=' + st.aliquotaSt + ').'
      + ' Preencha os campos do grupo ICMS Manual ou desative o campo ST.');
  }
  var mvaDec = mva / 100;
  var pST = pSTpct / 100;
  var cfopSt = (opts && opts.isInterstate) ? '6401' : '5401';
  var natOpSt = 'Vendas de produto ST';
  var vProdTotal = 0, vICMSTotal = 0, vBCSTTotal = 0, vICMSSTTotal = 0;
  for (var i = 0; i < linesData.length; i++) {
    var ld = linesData[i];
    var vProd = parseFloat(ld.price_subtotal) || 0;
    var vicms = parseFloat(ld.vicms) || 0; // próprio FINAL da linha (6b manual ou auto)
    var vbcst = round2(vProd * (1 + mvaDec));
    var vicmsst = round2(vbcst * pST - vicms);
    ld.vbcst = String(vbcst);
    ld.picmsst = String(pSTpct);
    ld.vicmsst = String(vicmsst);
    ld.pmvast = String(mva);
    ld.modbcst = '4';
    ld.mod_bc = '3';
    ld.cst_icms = '10';
    ld.cfop = cfopSt;
    ld.difal = 0;
    vProdTotal += vProd;
    vICMSTotal += vicms;
    vBCSTTotal += vbcst;
    vICMSSTTotal += vicmsst;
  }
  vProdTotal = round2(vProdTotal);
  vICMSTotal = round2(vICMSTotal);
  vBCSTTotal = round2(vBCSTTotal);
  vICMSSTTotal = round2(vICMSSTTotal);
  console.log('[SIEG-EMIT] ST MANUAL (soma no vNF): vProd=' + vProdTotal.toFixed(2)
    + ' | ICMS próprio=' + vICMSTotal.toFixed(2)
    + ' | BCST=' + vBCSTTotal.toFixed(2) + ' (MVA ' + mva + '%)'
    + ' | vICMSST=' + vICMSSTTotal.toFixed(2) + ' (alíq ' + pSTpct + '%)'
    + ' | vNF = vProd + vICMSST = ' + round2(vProdTotal + vICMSSTTotal).toFixed(2)
    + ' | CFOP ' + cfopSt + " | natOp '" + natOpSt + "'");
  return { vProdTotal: vProdTotal, vICMSTotal: vICMSTotal, vBCSTTotal: vBCSTTotal, vICMSSTTotal: vICMSSTTotal, cfopSt: cfopSt, natOpSt: natOpSt };
}

module.exports = { aplicarStManualLinhas, round2 };
