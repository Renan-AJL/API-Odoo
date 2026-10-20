/**
 * services/ibge-municipios.js — Tabela de codigos IBGE de municipios no middleware.
 *
 * Pedido AJL 21/10/2026: TODAS as cidades com codigo oficial gravado no middleware;
 * quando o Odoo mandar codigo diferente/errado, o emissor usa o da tabela
 * (correcao pos-Odoo antes de enviar ao SIEG/SEFAZ).
 *
 * Fonte: servicodados.ibge.gov.br api/v1/localidades/municipios (base 2026)
 * 5570 municipios em 27 UFs — PR e SC primeiro (filiais AJL).
 * Chave: UF -> nome normalizado (upper, sem acento, sem pontuacao) -> codigo 7 dig.
 */
var fs = require('fs');
var path = require('path');

var TABELA = null;

function norm(s) {
  s = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^A-Za-z0-9 ]/g, ' ').toUpperCase();
  return s.replace(/\s+/g, ' ').trim();
}

function load() {
  if (TABELA) return TABELA;
  try {
    var raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'ibge-municipios.json'), 'utf8');
    TABELA = (JSON.parse(raw).ufs) || {};
    var total = 0;
    Object.keys(TABELA).forEach(function(uf) { total += Object.keys(TABELA[uf]).length; });
    console.log('[IBGE] Tabela municipios carregada: ' + Object.keys(TABELA).length + ' UFs / ' + total + ' municipios');
  } catch (e) {
    console.warn('[IBGE] Tabela ibge-municipios.json indisponivel: ' + e.message);
    TABELA = {};
  }
  return TABELA;
}

/**
 * lookup('PR', 'Reserva') -> '4121703' | ''
 * lookup('PR', 'São José dos Pinhais') -> '4125506'
 */
function lookup(uf, city) {
  var t = load();
  var u = String(uf || '').toUpperCase().trim();
  var n = norm(city);
  if (!u || !n || !t[u]) return '';
  return t[u][n] || '';
}

module.exports = { lookup: lookup, normalize: norm, _load: load };
