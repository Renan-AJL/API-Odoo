/**
 * services/nfe-texto.js — PADRÃO AJL para TODO texto que entra na NF-e.
 *
 * Motivação (rejeições 225 — cvc-pattern-valid, NFe 00073124 e 00073133):
 * o schema TString da SEFAZ usado em xProd, xNome, xLgr, xBairro, xMun,
 * infCpl, xFant, xPed, obs... aceita APENAS:
 *    [!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}   |   [!-ÿ]{1}
 * ou seja: caracteres 0x21..0xFF (Latin-1) + espaço 0x20 NO MEIO,
 * sem começar/terminar com espaço.
 *
 * Texto colado do WhatsApp/Excel no Odoo costuma trazer:
 *  - zero-width space (U+200B), BOM (U+FEFF), soft hyphen (U+00AD) — INVISÍVEIS
 *  - quebras de linha e tabs
 *  - aspas tipográficas (' ' " "), travessão (—), reticências (…), bullet (•),
 *    €, TM, setas, emojis — todos FORA do Latin-1 → rejeição 225
 *
 * Este módulo é o ÚNICO ponto de saneamento: aplicado dentro de esc()
 * (sieg-nfe-xml.js) cobre todos os campos TString do XML de uma vez.
 */

function saneiaTextoNFe(s, maxLen) {
  var t = String(s == null ? '' : s);
  if (!t) return '';

  // 1) Caracteres INVISÍVEIS que o schema NÃO aceita e NÃO podem virar espaço
  //    (zero-width space/joiner/non-joiner, BOM, isolates, soft hyphen,
  //    controles de formatação bidi, tag chars)
  t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u00AD\uFFF9-\uFFFB]/g, '');

  // 2) Pontuação/símbolos comuns fora do Latin-1 -> equivalente ASCII aceito
  var MAP = {
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"',
    '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
    '\u2026': '...', '\u2022': '-', '\u25CF': '-', '\u25AA': '-', '\u25A0': '-', '\u2023': '-',
    '\u20AC': 'R$', '\u2122': 'TM', '\u2192': '->', '\u2190': '<-',
    '\u2044': '/', '\u2215': '/', '\u02C6': '^', '\u2039': '<', '\u203A': '>',
    '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ', '\u3000': ' ',
  };
  t = t.replace(/[\u2018\u2019\u201A\u201B\u2032\u201C\u201D\u201E\u201F\u2033\u2013\u2014\u2015\u2212\u2026\u2022\u25CF\u25AA\u25A0\u2023\u20AC\u2122\u2192\u2190\u2044\u2215\u02C6\u2039\u203A\u00A0\u2007\u202F\u3000]/g, function (ch) {
    return MAP[ch];
  });

  // 3) Qualquer caractere RESTANTE fora do Latin-1 (> U+00FF):
  //    tenta decompôr acento (Ć->C, ņ->n, š->s...) e o que não virar
  //    Latin-1 (emoji, CJK, símbolos exóticos) é descartado.
  //    Acentos Latin-1 (á ç ã É Õ) NÃO são tocados — são aceitos pela SEFAZ.
  t = t.replace(/[^\u0000-\u00FF]/g, function (ch) {
    var d = ch.normalize('NFKD').replace(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\uFE20-\uFE2F]/g, '');
    d = d.replace(/[^\u0000-\u00FF]/g, '');
    return d;
  });

  // 4) Controles e quebras -> espaço; colapsa repetições; pontas limpas
  t = t
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 5) Teto de caracteres SEM terminar em espaço/separador vazio
  if (maxLen && t.length > maxLen) {
    t = t.substring(0, maxLen).replace(/[\s,;:\-]+$/, '').trim();
  }
  return t;
}

module.exports = { saneiaTextoNFe };
