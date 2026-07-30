/**
 * services/sieg-nfse-xml.js — Gerador de XML DPS (NFS-e) v1.01 a partir de dados Odoo
 * 
 * Gera o <DPS><infDPS> para envio ao SIEG via POST /api/v1/emitir-nfse
 * Baseado no XML real emitido via SIEG (29/07/2026) - Schema Nacional NFS-e
 */

const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';

/**
 * Gera XML DPS completo a partir dos dados extraidos do Odoo
 * 
 * @param {Object} data - Dados do Odoo
 * @param {Object} data.company - Dados da empresa (prestador)
 * @param {Object} data.partner - Dados do cliente (tomador)
 * @param {Object} data.order - Dados do pedido
 * @param {Object} data.service - Dados do servico (cTribNac, cNBS, cIntContrib, xDescServ)
 * @param {Object} [data.config] - Configuracoes adicionais
 * @returns {string} XML string do <DPS>
 */
function gerarXmlDPS(data) {
  const { company, partner, order, service, config: cfg = {} } = data;
  
  const tpAmb = cfg.tpAmb || process.env.SIEG_TP_AMB || '1';
  const verAplic = '1.1.0';
  const serie = cfg.serie || '1';
  const nDPS = String(order.number || order.name || '1').replace(/\D/g, '');
  const dhEmi = formatDh(order.date_order || new Date().toISOString());
  const dCompet = dhEmi.slice(0, 10); // YYYY-MM-DD
  const tpEmit = '1'; // 1 = prestador emite
  const cLocEmi = company.city_ibge_code || '';
  
  // Regime tributario (Simples Nacional)
  const opSimpNac = company.op_simp_nac || '3'; // 3 = simples nacional (fator R)
  const regApTribSN = company.reg_ap_trib_sn || '1';
  const regEspTrib = '0';
  
  // Servico
  const cTribNac = service.cTribNac || '140101';
  const xDescServ = service.xDescServ || order.note || service.service_description || '';
  const cNBS = service.cNBS || '999999999';
  const cIntContrib = service.cIntContrib || '';
  
  // Valores
  const vServ = num(order.amount_total || service.valor || 0);
  const pAliq = service.pAliq || service.aliquota_issqn || '2.00';
  const tribISSQN = '1'; // 1 = sim
  const tpRetISSQN = service.tpRetISSQN || '1'; // 1 = retido
  
  // Tributos totais estimados (IBPT)
  const pTotTribFed = service.pTotTribFed || '13.45';
  const pTotTribEst = service.pTotTribEst || '0.00';
  const pTotTribMun = service.pTotTribMun || '3.29';

  const dpsId = `DPS${cLocEmi}${onlyNum(company.cnpj_cpf)}${String(cfg.mod || '01')}${serie.padStart(3,'0')}${nDPS.padStart(9,'0')}1`;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS versao="1.01" xmlns="${NFSE_NS}">
  <infDPS Id="${dpsId}">
    <tpAmb>${tpAmb}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>${verAplic}</verAplic>
    <serie>${serie}</serie>
    <nDPS>${nDPS}</nDPS>
    <dCompet>${dCompet}</dCompet>
    <tpEmit>${tpEmit}</tpEmit>
    <cLocEmi>${cLocEmi}</cLocEmi>
    <prest>
      <CNPJ>${onlyNum(company.cnpj_cpf)}</CNPJ>
      <IM>${onlyNum(company.inscr_mun || '')}</IM>
      <fone>${onlyNum(company.phone || '')}</fone>
      <email>${esc(company.email || '')}</email>
      <regTrib>
        <opSimpNac>${opSimpNac}</opSimpNac>
        <regApTribSN>${regApTribSN}</regApTribSN>
        <regEspTrib>${regEspTrib}</regEspTrib>
      </regTrib>
    </prest>
    <toma>
      <CNPJ>${onlyNum(partner.cnpj_cpf)}</CNPJ>
      <xNome>${esc(partner.legal_name || '')}</xNome>
      <end>
        <endNac>
          <cMun>${partner.city_ibge_code || ''}</cMun>
          <CEP>${cepFmt(partner.zip || '')}</CEP>
        </endNac>
        <xLgr>${esc(partner.street || '')}</xLgr>
        <nro>${esc(String(partner.number || 'S/N'))}</nro>
        <xBairro>${esc(partner.street2 || partner.district || '')}</xBairro>
      </end>
    </toma>
    <serv>
      <locPrest>
        <cLocPrestacao>${cfg.cLocPrestacao || cLocEmi}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${cTribNac}</cTribNac>
        <xDescServ>${esc(xDescServ)}</xDescServ>
        <cNBS>${cNBS}</cNBS>
        ${cIntContrib ? `<cIntContrib>${cIntContrib}</cIntContrib>` : ''}
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${vServ}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>${tribISSQN}</tribISSQN>
          <tpRetISSQN>${tpRetISSQN}</tpRetISSQN>
        </tribMun>
        <totTrib>
          <pTotTrib>
            <pTotTribFed>${pTotTribFed}</pTotTribFed>
            <pTotTribEst>${pTotTribEst}</pTotTribEst>
            <pTotTribMun>${pTotTribMun}</pTotTribMun>
          </pTotTrib>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`;

  return xml;
}

// === Helpers (mesmos do nfe) ===
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function num(v) {
  if (v === null || v === undefined) return '0.00';
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? '0.00' : n.toFixed(2);
}

function onlyNum(s) {
  return String(s || '').replace(/\D/g, '');
}

function cepFmt(s) {
  return onlyNum(s);
}

function formatDh(iso) {
  if (!iso) {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const offH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const offM = String(Math.abs(offset) % 60).padStart(2, '0');
    const sign = offset >= 0 ? '+' : '-';
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}${sign}${offH}:${offM}`;
  }
  if (iso.includes('T')) return iso;
  return iso + 'T00:00:00-03:00';
}

module.exports = { gerarXmlDPS };
