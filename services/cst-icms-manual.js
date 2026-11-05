/**
 * CST ICMS MANUAL (AJL 06/11/2026, v1.2.26)
 * Campo x_studio_cst_icms editável na fatura (grupo "ICMS Manual (NF-e)"):
 *   vazio/'00' -> automático (regras atuais: CST 00 + regra PR);
 *   40/41/50   -> TODAS as linhas saem com esse CST, SEM destaque de ICMS
 *                 (vBC/vICMS 0, modBC 3, sem CSOSN, sem DIFAL).
 * cBenef PR800044 entra para 40/41/50 quando o EMITENTE é do Paraná
 * (rejeição 930 — NT 2019.001 regra 930_N12-85; tabela oficial SEFAZ-PR).
 * CST 40 sem código de isenção aplicável é sempre rejeitado, então em PR o
 * código é sempre enviado (mesma política do bloco 6b / teste 930 de 30/10).
 * Fundamento: Remessa para industrialização por conta e ordem do adquirente
 * = CST 41, sem destaque (RICMS-PR Anexo VIII, arts. 8 e 9).
 */
var CSTS_SEM_DESTAQUE = ['40', '41', '50'];

function aplicarCstIcmsManualLinhas(linesData, cstManual, ufEmpresa) {
  var cst = String(cstManual || '').replace(/\D/g, '');
  if (CSTS_SEM_DESTAQUE.indexOf(cst) < 0) return 0;
  var uf = String(ufEmpresa || '').toUpperCase();
  var cBenef = (uf === 'PR')
    ? ((process.env.NFE_CBENEF_INDUSTRIALIZACAO != null && process.env.NFE_CBENEF_INDUSTRIALIZACAO !== '')
        ? process.env.NFE_CBENEF_INDUSTRIALIZACAO : 'PR800044')
    : '';
  for (var i = 0; i < linesData.length; i++) {
    var ld = linesData[i];
    ld.cst_icms = cst;
    ld.mod_bc = '3';
    ld.csosn = '';
    ld.vbc_icms = '0.00';
    ld.picms = '0.00';
    ld.vicms = '0.00';
    ld.difal = 0;
    if (cBenef) ld.cbenef = cBenef;
  }
  return linesData.length;
}

module.exports = { aplicarCstIcmsManualLinhas, CSTS_SEM_DESTAQUE };
