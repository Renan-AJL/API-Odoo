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
 * Extrai numero do logradouro quando o campo 'number' esta vazio/S/N.
 * Odoo frequentemente armazena o endereco completo no campo 'street':
 *   "Avenida Juscelino Kubitschek de Oliveira, 7525"
 *   "Rua Bom Jesus, 212"
 *   "Rua Augusta, 1200 Sala 53"
 * Retorna { street, number }
 */
function parseStreetNumber(street, number) {
  if (!street) return { street: '', number: number || 'S/N' };
  // Se ja tem numero valido, retorna como esta
  if (number && number !== 'S/N' && String(number).trim() !== '') {
    return { street: street, number: String(number) };
  }
  // Padrão 1: "Logradouro, NNNN" (virgula + espaco + numero)
  var m = street.match(/^(.+?),\s*(\d+[\w]?(?:\s*[A-Za-zÀ-ÿ]+)?)\s*$/);
  if (m) return { street: m[1].trim(), number: m[2].trim() };
  // Padrao 2: "Logradouro, NNNN complemento" (virgula + numero + complemento)
  m = street.match(/^(.+?),\s*(\d+)\s+(.+)$/);
  if (m) return { street: m[1].trim(), number: m[2].trim() };
  // Padrao 3: "Logradouro NNNN" (espaco + numero no final, sem virgula)
  m = street.match(/^(.+?)\s+(\d+)\s*$/);
  if (m) return { street: m[1].trim(), number: m[2].trim() };
  // Nenhum padrao encontrado
  return { street: street, number: number || 'S/N' };
}

/**
 * Preenche campos de endereço comuns (emit/dest)
 */
function xmlEndereco(end, tagPrefix) {
  if (!end) return '';
  // Separar logradouro e numero
  var parsed = parseStreetNumber(end.street || end.xLgr || '', end.number || end.nro);
  const parts = [];
  parts.push(`    <${tagPrefix}>`);
  parts.push(`      <xLgr>${esc(parsed.street)}</xLgr>`);
  parts.push(`      <nro>${esc(parsed.number)}</nro>`);
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
  const cstPis   = line.cst_pis   || '49';
  const vBCPis   = num(line.vbc_pis   || line.vbc || '0.00');
  const pPis     = num(line.ppis      || line.pis_aliquota || '0.00');
  const vPIS     = num(line.vpis      || '0.00');
  const cstCof   = line.cst_cofins || '49';
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

  // === VALIDACAO DETALHADA POR CAMPO ===
  var xmlErrors = [];
  var xmlWarnings = [];

  console.log('[NFE-XML] ========== VALIDACAO CAMPOS XML ==========');

  // --- Emitente ---
  console.log('[NFE-XML] [EMITENTE]');
  logField('cUF', cUF);
  logField('CNPJ', onlyNum(company.cnpj_cpf), !onlyNum(company.cnpj_cpf));
  logField('xNome', company.legal_name || company.xNome, !(company.legal_name || company.xNome));
  logField('xFant', company.name || company.xFant);
  logField('xLgr', company.street, !company.street);
  logField('nro', company.number || 'S/N');
  logField('xBairro', company.street2, !company.street2);
  logField('cMun', company.city_ibge_code, !company.city_ibge_code);
  logField('xMun', company.city, !company.city);
  logField('UF', company.state, !company.state);
  logField('CEP', company.zip, !company.zip);
  logField('fone', company.phone);
  logField('IE', company.inscr_est, !company.inscr_est);
  logField('CRT', company.crt || '1');

  if (!onlyNum(company.cnpj_cpf)) xmlErrors.push('CNPJ emitente vazio');
  if (!company.inscr_est) xmlErrors.push('IE emitente vazia');
  if (!company.street) xmlErrors.push('Logradouro emitente vazio');
  if (!company.city_ibge_code) xmlErrors.push('cMunFG/cMun emitente vazio');
  if (!company.city) xmlWarnings.push('xMun emitente vazio');
  if (!company.state) xmlErrors.push('UF emitente vazia');

  // --- Destinatario ---
  console.log('[NFE-XML] [DESTINATARIO]');
  var docDest2 = onlyNum(partner.cnpj_cpf || '');
  logField('CNPJ/CPF', docDest2, !docDest2);
  logField('xNome', partner.legal_name || partner.xNome, !(partner.legal_name || partner.xNome));
  logField('xLgr', partner.street, !partner.street);
  logField('nro', partner.number || 'S/N');
  logField('xBairro', partner.street2, !partner.street2);
  logField('cMun', partner.city_ibge_code, !partner.city_ibge_code);
  logField('xMun', partner.city, !partner.city);
  logField('UF', partner.state, !partner.state);
  logField('CEP', partner.zip, !partner.zip);
  logField('fone', partner.phone);
  logField('email', partner.email);

  if (!docDest2) xmlErrors.push('CNPJ/CPF destinatario vazio');
  if (!(partner.legal_name || partner.xNome)) xmlErrors.push('Nome destinatario vazio');
  if (!partner.street) xmlErrors.push('Logradouro destinatario vazio');
  if (!partner.city_ibge_code) xmlErrors.push('cMun destinatario vazio');
  if (!partner.city) xmlWarnings.push('xMun destinatario vazio');
  if (!partner.state) xmlErrors.push('UF destinatario vazia');

  // --- IDE ---
  console.log('[NFE-XML] [IDE]');
  logField('cMunFG', cMunFG, !cMunFG);
  logField('natOp', cfg.natOp || 'Venda de Mercadoria');
  logField('serie', serie);
  logField('nNF', nNF);
  logField('dhEmi', dhEmi);
  logField('tpAmb', tpAmb);
  logField('mod', cfg.mod || '55');

  if (!cMunFG) xmlErrors.push('cMunFG vazio (empresa sem codigo IBGE da cidade)');

  // --- Itens (linhas) ---
  lines.forEach(function(l, i) {
    console.log('[NFE-XML] [ITEM ' + (i+1) + ']');
    logField('  cProd', l.cProd || l.default_code, !(l.cProd || l.default_code));
    logField('  xProd', l.xProd || l.product_name);
    logField('  NCM', l.ncm || l.NCM, !(l.ncm || l.NCM));
    logField('  CFOP', l.cfop || '5102');
    logField('  uCom', l.uom || 'UN');
    logField('  qCom', l.qty);
    logField('  vUnCom', l.price_unit);
    logField('  vProd', l.price_subtotal || (l.qty * l.price_unit));
    logField('  CSOSN', l.csosn || '103');
    logField('  CST_ICMS', l.cst_icms || '(vazio - usara CSOSN)');
    logField('  vICMS', l.vicms || '0.00');
    logField('  CST_PIS', l.cst_pis || '49');
    logField('  vPIS', l.vpis || '0.00');
    logField('  CST_COFINS', l.cst_cofins || '49');
    logField('  vCOFINS', l.vcofins || '0.00');

    if (!(l.ncm || l.NCM)) xmlErrors.push('NCM vazio no item ' + (i+1) + ' (' + (l.xProd || l.product_name || '?') + ')');
    if (!(l.cProd || l.default_code)) xmlWarnings.push('cProd vazio no item ' + (i+1) + ' (codigo interno do produto)');
  });

  // --- Totais / Pagamento ---
  // Calcular vProdTotal antes da validacao (usado nos logs)
  var vProdTotal = 0;
  for (var vi = 0; vi < lines.length; vi++) {
    vProdTotal += parseFloat(lines[vi].price_subtotal || (lines[vi].qty * lines[vi].price_unit));
  }
  console.log('[NFE-XML] [TOTAIS]');
  logField('vNF', order.amount_total || vProdTotal);
  logField('vProd', vProdTotal);
  if (pag.length > 0) {
    logField('tPag', pag[0].tPag || '15');
    logField('vPag', pag[0].vPag);
  } else {
    xmlWarnings.push('Nenhum pagamento informado (bloco <pag> vazio)');
  }

  // --- Resumo da validacao ---
  console.log('[NFE-XML] ========== RESUMO VALIDACAO ==========');
  if (xmlErrors.length > 0) {
    console.error('[NFE-XML] *** ERROS (' + xmlErrors.length + ') — XML provavelmente sera REJEITADO ***');
    for (var e = 0; e < xmlErrors.length; e++) {
      console.error('[NFE-XML]   ERRO: ' + xmlErrors[e]);
    }
  }
  if (xmlWarnings.length > 0) {
    console.warn('[NFE-XML] *** AVISOS (' + xmlWarnings.length + ') ***');
    for (var w = 0; w < xmlWarnings.length; w++) {
      console.warn('[NFE-XML]   AVISO: ' + xmlWarnings[w]);
    }
  }
  if (xmlErrors.length === 0 && xmlWarnings.length === 0) {
    console.log('[NFE-XML] Todos os campos validados com sucesso!');
  }
  console.log('[NFE-XML] ========================================');

  // Calcular chave de acesso NF-e (44 digitos)
  var tpEmis = '1'; // emissao normal
  var accessKey = calcAccessKey(cUF, dhEmi, company.cnpj_cpf, '55', serie, nNF, tpEmis, cNF);
  var cDV = accessKey[43]; // ultimo digito = DV
  console.log('[NFE-XML] Chave de acesso: ' + accessKey + ' (cDV=' + cDV + ')');

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="${NFE_NS}">
  <infNFe versao="4.00" Id="NFe${accessKey}">
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
      <tpEmis>${tpEmis}</tpEmis>
      <cDV>${cDV}</cDV>
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
  lines.forEach((line, idx) => {
    const nItem = String(idx + 1);
    const vProd = num(line.price_subtotal || (line.qty * line.price_unit));
    // vProdTotal ja foi calculado no bloco de validacao acima

    xml += `
    <det nItem="${nItem}">
      <prod>
        <cProd>${esc(String(line.default_code || line.cProd || ''))}</cProd>
        <cEAN>${line.barcode || 'SEM GTIN'}</cEAN>
        <xProd>${esc(line.product_name || line.xProd || '')}</xProd>
        <NCM>${esc(String(line.ncm || line.NCM || ''))}</NCM>
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

function logField(fieldName, value, isError) {
  var displayVal = value === undefined || value === null ? '(undefined)' : JSON.stringify(value);
  if (isError) {
    console.error('[NFE-XML]   ' + fieldName + ': ' + displayVal + ' *** VAZIO/INVALIDO ***');
  } else {
    console.log('[NFE-XML]   ' + fieldName + ': ' + displayVal);
  }
}

/**
 * Calcula a chave de acesso da NF-e (44 digitos) com DV.
 * Formato: cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + serie(3) + nNF(9) + tpEmis(1) + cNF(8) + cDV(1) = 44
 */
function calcAccessKey(cUF, dhEmi, cnpj, mod, serie, nNF, tpEmis, cNF) {
  var aamm = dhEmi.slice(2, 4) + dhEmi.slice(5, 7);
  var key =
    String(cUF).padStart(2, '0') +
    aamm +
    onlyNum(cnpj).padStart(14, '0') +
    String(mod).padStart(2, '0') +
    String(serie).padStart(3, '0') +
    String(nNF).padStart(9, '0') +
    String(tpEmis) +
    String(cNF).padStart(8, '0');
  // DV = modulo 11 dos 43 digitos, pesos 2-9 ciclicos do direita para esquerda
  var weights = [2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4];
  var sum = 0;
  for (var i = 0; i < 43; i++) {
    sum += parseInt(key[i]) * weights[i];
  }
  var remainder = sum % 11;
  var cDV = 11 - remainder;
  if (cDV === 10 || cDV === 11) cDV = 0;
  return key + String(cDV);
}

module.exports = { gerarXmlNFe };
