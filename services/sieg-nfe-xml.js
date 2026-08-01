/**
 * services/sieg-nfe-xml.js — Gerador de XML NF-e v4.00 a partir de dados Odoo
 * 
 * Gera o <NFe> para envio ao SIEG via POST /api/v1/send-xml
 * O SIEG adiciona: XMLDSig (assinatura) + envia à SEFAZ + retorna nfeProc
 * 
 * Baseado no XML real emitido pela AJL via SIEG (29/07/2026)
 */

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

/**
 * Preenche campos de endereço comuns (emit/dest)
 */
function xmlEndereco(end, tagPrefix) {
  if (!end) return '';
  const parts = [];
  parts.push(`    <${tagPrefix}>`);
  parts.push(`      <xLgr>${esc(end.street || end.xLgr || '')}</xLgr>`);
  parts.push(`      <nro>${esc(String(end.number || end.nro || 'S/N'))}</nro>`);
  if (end.street2 || end.xBairro) {
    parts.push(`      <xBairro>${esc(end.street2 || end.xBairro || '')}</xBairro>`);
  }
  parts.push(`      <cMun>${esc(String(end.city_ibge_code || end.cMun || ''))}</cMun>`);
  parts.push(`      <xMun>${esc(end.city || end.xMun || '')}</xMun>`);
  parts.push(`      <UF>${esc(end.state || end.UF || '')}</UF>`);
  parts.push(`      <CEP>${cepFmt(end.zip || end.CEP || '')}</CEP>`);
  parts.push(`      <cPais>1058</cPais>`);
  parts.push(`      <xPais>Brasil</xPais>`);
  if (end.phone || end.fone) {
    parts.push(`      <fone>${foneFmt(end.phone || end.fone || '')}</fone>`);
  }
  parts.push(`    </${tagPrefix}>`);
  return parts.join('\n');
}

/**
 * Gera bloco de impostos por item — dinâmico baseado nos dados reais do Odoo
 * Suporta: ICMS (Simples Nacional CSOSN / Regime Normal CST), PIS, COFINS
 */
function xmlImpostoItem(line) {
  const csosn  = line.csosn  || '';
  const cstIcms = line.cst_icms || '';
  const orig   = line.orig   || '0';
  const modBC  = line.mod_bc || '';
  const vBC    = num(line.vbc_icms  || line.vbc  || '0.00');
  const vICMS  = num(line.vicms || '0.00');
  const pICMS  = num(line.picms || '0.00');
  const cstPis   = line.cst_pis   || '01';
  const vBCPis   = num(line.vbc_pis   || line.vbc || '0.00');
  const pPis     = num(line.ppis      || line.pis_aliquota || '0.00');
  const vPIS     = num(line.vpis      || '0.00');
  const cstCof   = line.cst_cofins || '01';
  const vBCCof   = num(line.vbc_cofins || line.vbc || '0.00');
  const pCofins  = num(line.pcofins    || line.cofins_aliquota || '0.00');
  const vCOFINS  = num(line.vcofins    || '0.00');

  // --- ICMS ---
  let icmsBlock = '';
  if (csosn) {
    // Simples Nacional: CSOSN 101-500
    const csosnNum = csosn.replace(/\D/g, '');
    // CSOSN 101,102,103 → ICMSSN101,102,103  |  201,202,203 → ICMSSN201..  |  900 → ICMSSN900
    let tag = 'ICMSSN' + csosnNum;
    if (csosnNum === '900') {
      tag = 'ICMSSN900';
    } else if (['101','102','103'].includes(csosnNum)) {
      tag = 'ICMSSN' + csosnNum;
    } else if (['201','202','203'].includes(csosnNum)) {
      tag = 'ICMSSN' + csosnNum;
    } else if (csosnNum === '300') {
      tag = 'ICMSSN300';
    } else if (csosnNum === '400') {
      tag = 'ICMSSN400';
    } else if (csosnNum === '500') {
      tag = 'ICMSSN500';
    } else {
      tag = 'ICMSSN102';
    }

    if (csosnNum === '900') {
      // CSOSN 900 precisa de mais campos
      icmsBlock = `          <ICMS>
            <${tag}>
              <orig>${orig}</orig>
              <CSOSN>${csosn}</CSOSN>
              <vICMS>${vICMS}</vICMS>
              <vBC>${vBC}</vBC>
              <pICMS>${pICMS}</pICMS>
            </${tag}>
          </ICMS>`;
    } else {
      icmsBlock = `          <ICMS>
            <${tag}>
              <orig>${orig}</orig>
              <CSOSN>${csosn}</CSOSN>
            </${tag}>
          </ICMS>`;
    }
  } else if (cstIcms) {
    // Regime Normal: CST 00-90
    const cstNum = String(cstIcms).replace(/\D/g, '');
    let tag = 'ICMS' + cstNum;
    if (['00','10','20','30','40','41','50','51','60','70','90'].includes(cstNum)) {
      tag = 'ICMS' + cstNum;
    } else {
      tag = 'ICMS00';
    }
    icmsBlock = `          <ICMS>
            <${tag}>
              <orig>${orig}</orig>
              <CST>${cstIcms}</CST>
              <modBC>${modBC || '0'}</modBC>
              <vBC>${vBC}</vBC>
              <pICMS>${pICMS}</pICMS>
              <vICMS>${vICMS}</vICMS>
            </${tag}>
          </ICMS>`;
  } else {
    // Fallback CSOSN 103
    icmsBlock = `          <ICMS>
            <ICMSSN102>
              <orig>${orig}</orig>
              <CSOSN>103</CSOSN>
            </ICMSSN102>
          </ICMS>`;
  }

  // --- PIS ---
  let pisBlock = '';
  const pisCstNum = String(cstPis).replace(/\D/g, '');
  if (['04','05','06','07','08','09'].includes(pisCstNum)) {
    // PIS nao tributado
    pisBlock = `          <PIS>
            <PISNT>
              <CST>${cstPis}</CST>
            </PISNT>
          </PIS>`;
  } else {
    // PIS Aliq (CST 01,02,03,49,50,51,52,53,54,55,56,60,61,62,63,64,65,66,67,70,71,72,73,74,75,98,99)
    pisBlock = `          <PIS>
            <PISAliq>
              <CST>${cstPis}</CST>
              <vBC>${vBCPis}</vBC>
              <pPIS>${pPis}</pPIS>
              <vPIS>${vPIS}</vPIS>
            </PISAliq>
          </PIS>`;
  }

  // --- COFINS ---
  let cofinsBlock = '';
  const cofCstNum = String(cstCof).replace(/\D/g, '');
  if (['04','05','06','07','08','09'].includes(cofCstNum)) {
    cofinsBlock = `          <COFINS>
            <COFINSNT>
              <CST>${cstCof}</CST>
            </COFINSNT>
          </COFINS>`;
  } else {
    cofinsBlock = `          <COFINS>
            <COFINSAliq>
              <CST>${cstCof}</CST>
              <vBC>${vBCCof}</vBC>
              <pCOFINS>${pCofins}</pCOFINS>
              <vCOFINS>${vCOFINS}</vCOFINS>
            </COFINSAliq>
          </COFINS>`;
  }

  return `\n        <imposto>${icmsBlock}${pisBlock}${cofinsBlock}\n        </imposto>`;
}

/**
 * Gera XML NF-e completo a partir dos dados extraidos do Odoo
 * 
 * @param {Object} data - Dados do Odoo (sale.order + company + partner + lines)
 * @param {Object} data.company - Dados da empresa (emitente)
 * @param {Object} data.partner - Dados do cliente (destinatario)
 * @param {Object} data.order - Dados do pedido
 * @param {Array}  data.lines - Linhas do pedido (produtos)
 * @param {Array}  [data.duplicatas] - Parcelas de cobranca
 * @param {Array}  [data.pagamentos] - Pagamentos recebidos
 * @param {Object} [data.config] - Configuracoes adicionais
 * @returns {string} XML string do <NFe>
 */
function gerarXmlNFe(data) {
  const { company, partner, order, lines, config: cfg = {} } = data;
  const dup = data.duplicatas || [];
  const pag = data.pagamentos || [];

  // === Validacao de campos obrigatorios ===
  const cUF = company.state_ibge || '41';
  const cNF = randomCnf();
  const serie = cfg.serie || '100';
  const nNF = String(order.number || order.name || '1').replace(/\D/g, '');
  const dhEmi = formatDh(order.date_order || new Date().toISOString());
  const tpNF = '1'; // saida
  const idDest = calcIdDest(company.state || company.UF, partner.state || partner.UF);
  const cMunFG = company.city_ibge_code || '';
  const tpAmb = cfg.tpAmb || process.env.SIEG_TP_AMB || '1'; // 1=producao, 2=homologacao
  const finNFe = cfg.finNFe || '1'; // 1=normal
  const indFinal = (partner.is_consumer || partner.indFinal) ? '1' : '0';
  const indPres = cfg.indPres || '0'; // 0=nao presencial
  const verProc = cfg.verProc || 'Odoo19-SIEG-1.0';

  // Validar campos obrigatorios antes de gerar XML
  var xmlWarnings = [];
  if (!cMunFG) xmlWarnings.push('cMunFG vazio (empresa sem codigo IBGE da cidade)');
  if (!company.cnpj_cpf) xmlWarnings.push('CNPJ emitente vazio');
  if (!company.inscr_est) xmlWarnings.push('IE emitente vazia');
  if (!company.street) xmlWarnings.push('Logradouro emitente vazio');
  if (!partner.cnpj_cpf && !partner.xNome) xmlWarnings.push('Dados destinatario vazios');
  lines.forEach(function(l, i) {
    if (!l.ncm) xmlWarnings.push('NCM vazio no item ' + (i+1) + ' (' + (l.xProd || l.product_name || '?') + ')');
  });
  if (xmlWarnings.length > 0) {
    console.warn('[NFE-XML] *** CAMPOS OBRIGATORIOS FALTANDO ***');
    for (var w = 0; w < xmlWarnings.length; w++) {
      console.warn('[NFE-XML]   - ' + xmlWarnings[w]);
    }
  }

  const ideId = `NFe${cUF}${dhEmi.slice(0,4)}${dhEmi.slice(5,7)}${company.cnpj_cpf}${String(cfg.mod || '55')}${serie.padStart(3,'0')}${nNF.padStart(9,'0')}${cNF}`;
  // Nota: o Id real inclui a chave de 44 digitos, calculada apos montagem completa
  // Por enquanto usamos placeholder — a SIEG ira processar e assinar

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="${NFE_NS}">
  <infNFe versao="4.00">
    <ide>
      <cUF>${cUF}</cUF>
      <cNF>${cNF}</cNF>
      <natOp>${esc(cfg.natOp || 'Venda de Mercadoria')}</natOp>
      <mod>55</mod>
      <serie>${serie}</serie>
      <nNF>${nNF}</nNF>
      <dhEmi>${dhEmi}</dhEmi>
      <dhSaiEnt>${dhEmi}</dhSaiEnt>
      <tpNF>${tpNF}</tpNF>
      <idDest>${idDest}</idDest>
      <cMunFG>${cMunFG}</cMunFG>
      <tpImp>1</tpImp>
      <tpEmis>1</tpEmis>
      <cDV>0</cDV>
      <tpAmb>${tpAmb}</tpAmb>
      <finNFe>${finNFe}</finNFe>
      <indFinal>${indFinal}</indFinal>
      <indPres>${indPres}</indPres>
      <procEmi>0</procEmi>
      <verProc>${esc(verProc)}</verProc>
    </ide>`;

  // === emit ===
  xml += `
    <emit>
      <CNPJ>${onlyNum(company.cnpj_cpf)}</CNPJ>
      <xNome>${esc(company.legal_name || company.xNome)}</xNome>
      <xFant>${esc(company.name || company.xFant || '')}</xFant>
${xmlEndereco(company, 'enderEmit')}
      <IE>${onlyNum(company.inscr_est || company.IE || '')}</IE>
      <CRT>${company.crt || '1'}</CRT>
    </emit>`;

  // === dest ===
  const docDest = onlyNum(partner.cnpj_cpf || '');
  const destTag = docDest.length === 14 ? 'CNPJ' : (docDest.length === 11 ? 'CPF' : '');
  const indIEDest = calcIndIEDest(partner);

  xml += `
    <dest>
      ${destTag ? `<${destTag}>${docDest}</${destTag}>` : '<CPF>00000000000</CPF>'}
      <xNome>${esc(partner.legal_name || partner.xNome || '')}</xNome>
${xmlEndereco(partner, 'enderDest')}
      <indIEDest>${indIEDest}</indIEDest>
      ${partner.inscr_est ? `<IE>${onlyNum(partner.inscr_est)}</IE>` : ''}
      ${partner.email ? `<email>${esc(partner.email)}</email>` : ''}
    </dest>`;

  // === det (items) ===
  let vProdTotal = 0;
  lines.forEach((line, idx) => {
    const nItem = String(idx + 1);
    const vProd = num(line.price_subtotal || (line.qty * line.price_unit));
    vProdTotal += parseFloat(vProd);

    xml += `
    <det nItem="${nItem}">
      <prod>
        <cProd>${esc(String(line.default_code || line.cProd || ''))}</cProd>
        <cEAN>${line.barcode || 'SEM GTIN'}</cEAN>
        <xProd>${esc(line.product_name || line.xProd || '')}</xProd>
        <NCM>${esc(String(line.ncm || line.NCM || process.env.SIEG_DEFAULT_NCM || ''))}</NCM>
        <CFOP>${esc(String(line.cfop || '5102'))}</CFOP>
        <uCom>${esc(line.uom || 'UN')}</uCom>
        <qCom>${num(line.qty)}</qCom>
        <vUnCom>${num(line.price_unit)}</vUnCom>
        <vProd>${vProd}</vProd>
        <cEANTrib>SEM GTIN</cEANTrib>
        <uTrib>${esc(line.uom || 'UN')}</uTrib>
        <qTrib>${num(line.qty)}</qTrib>
        <vUnTrib>${num(line.price_unit)}</vUnTrib>
        <indTot>1</indTot>
      </prod>${xmlImpostoItem(line)}
    </det>`;
  });

  // === total (somar impostos reais das linhas) ===
  let vBC_total = 0, vICMS_total = 0, vPIS_total = 0, vCOFINS_total = 0;
  lines.forEach(line => {
    vBC_total += parseFloat(line.vbc_icms || line.vbc || 0);
    vICMS_total += parseFloat(line.vicms || 0);
    vPIS_total += parseFloat(line.vpis || 0);
    vCOFINS_total += parseFloat(line.vcofins || 0);
  });

  const vNF = num(order.amount_total || vProdTotal);
  xml += `
    <total>
      <ICMSTot>
        <vBC>${num(vBC_total)}</vBC>
        <vICMS>${num(vICMS_total)}</vICMS>
        <vICMSDeson>0.00</vICMSDeson>
        <vFCPUFDest>0.00</vFCPUFDest>
        <vICMSUFDest>0.00</vICMSUFDest>
        <vFCP>0.00</vFCP>
        <vBCST>0.00</vBCST>
        <vST>0.00</vST>
        <vFCPST>0.00</vFCPST>
        <vFCPSTRet>0.00</vFCPSTRet>
        <vProd>${num(vProdTotal)}</vProd>
        <vFrete>0.00</vFrete>
        <vSeg>0.00</vSeg>
        <vDesc>0.00</vDesc>
        <vII>0.00</vII>
        <vIPI>0.00</vIPI>
        <vIPIDevol>0.00</vIPIDevol>
        <vPIS>${num(vPIS_total)}</vPIS>
        <vCOFINS>${num(vCOFINS_total)}</vCOFINS>
        <vOutro>0.00</vOutro>
        <vNF>${vNF}</vNF>
        <vTotTrib>0.00</vTotTrib>
      </ICMSTot>
    </total>`;

  // === transp ===
  xml += `
    <transp>
      <modFrete>${cfg.modFrete || '9'}</modFrete>
    </transp>`;

  // === cobr (duplicatas) ===
  if (dup.length > 0) {
    xml += `
    <cobr>
      <fat>
        <nFat>${esc(String(order.name || nNF))}</nFat>
        <vOrig>${vNF}</vOrig>
        <vDesc>0.00</vDesc>
        <vLiq>${vNF}</vLiq>
      </fat>`;
    dup.forEach((d, i) => {
      xml += `
      <dup>
        <nDup>${String(i + 1).padStart(3, '0')}</nDup>
        <dVenc>${d.dVenc || ''}</dVenc>
        <vDup>${num(d.vDup)}</vDup>
      </dup>`;
    });
    xml += `\n    </cobr>`;
  }

  // === pag ===
  if (pag.length > 0) {
    xml += `\n    <pag>`;
    pag.forEach(p => {
      xml += `
      <detPag>
        <indPag>1</indPag>
        <tPag>${p.tPag || '15'}</tPag>
        <vPag>${num(p.vPag)}</vPag>
      </detPag>`;
    });
    xml += `\n    </pag>`;
  }

  // === infAdic ===
  var infCplText = stripHtml(order.note || order.infCpl || '');
  if (infCplText) {
    xml += `\n    <infAdic>
      <infCpl>${esc(infCplText.substring(0, 2000))}</infCpl>
    </infAdic>`;
  }

  xml += `\n  </infNFe>\n</NFe>`;
  return xml;
}

// === Helper functions ===

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').trim();
}

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

function foneFmt(s) {
  return onlyNum(s);
}

function randomCnf() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

function formatDh(iso) {
  // 2026-07-29T07:56:51-03:00
  if (!iso) {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const offH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const offM = String(Math.abs(offset) % 60).padStart(2, '0');
    const sign = offset >= 0 ? '+' : '-';
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}${sign}${offH}:${offM}`;
  }
  // If already formatted
  if (iso.includes('T')) return iso;
  return iso + 'T00:00:00-03:00';
}

function calcIdDest(ufEmit, ufDest) {
  if (!ufEmit || !ufDest) return '1';
 if (ufEmit === ufDest) return '1'; // mesma UF
 if (ufDest === 'EX') return '3'; // exterior
 return '2'; // fora UF
}

function calcIndIEDest(partner) {
  const ie = partner.inscr_est || '';
  const uf = partner.state || partner.UF || '';
  if (!ie || onlyNum(ie) === 'ISENTO' || onlyNum(ie) === '') return '9';
  return '1'; // contribuinte ICMS
}

module.exports = { gerarXmlNFe };
