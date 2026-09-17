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
function xmlImpostoItem(line, crt, ibsInfo) {
  const csosn  = line.csosn  || '';
  const cstIcms = line.cst_icms || '';
  const orig   = line.orig   || '0';
  const modBC  = line.mod_bc || '';
  const vBC    = num(line.vbc_icms  || line.vbc  || '0.00');
  const vICMS  = num(line.vicms || '0.00');
  const pICMS  = num(line.picms || '0.00');
  const cstPis   = line.cst_pis   || '01';
  const baseItem = line.vbc_icms || line.vbc || line.price_subtotal || 0;
  const vBCPis   = num(line.vbc_pis   || baseItem || '0.00');
  const pPis     = num(line.ppis      || line.pis_aliquota || '0.00');
  const vPIS     = num(line.vpis      || '0.00');
  const cstCof   = line.cst_cofins || '01';
  const vBCCof   = num(line.vbc_cofins || baseItem || '0.00');
  const pCofins  = num(line.pcofins    || line.cofins_aliquota || '0.00');
  const vCOFINS  = num(line.vcofins    || '0.00');

  // --- ICMS ---
  // Mapeamento CSOSN → Grupo XSD (NT 2024.001 / NF-e 4.00):
  //   CSOSN 101 → ICMSSN101
  //   CSOSN 102,103,300,400 → ICMSSN102
  //   CSOSN 201 → ICMSSN201
  //   CSOSN 202,203 → ICMSSN202
  //   CSOSN 500 → ICMSSN500
  //   CSOSN 900 → ICMSSN900
  let icmsBlock = '';
  if (csosn) {
    const csosnNum = csosn.replace(/\D/g, '');
    let tag = 'ICMSSN102'; // fallback
    if (csosnNum === '101') {
      tag = 'ICMSSN101';
    } else if (['102','103','300','400'].includes(csosnNum)) {
      tag = 'ICMSSN102';
    } else if (csosnNum === '201') {
      tag = 'ICMSSN201';
    } else if (['202','203'].includes(csosnNum)) {
      tag = 'ICMSSN202';
    } else if (csosnNum === '500') {
      tag = 'ICMSSN500';
    } else if (csosnNum === '900') {
      tag = 'ICMSSN900';
    }

    if (csosnNum === '900') {
      icmsBlock = `<ICMS><${tag}><orig>${orig}</orig><CSOSN>${csosn}</CSOSN><vICMS>${vICMS}</vICMS><vBC>${vBC}</vBC><pICMS>${pICMS}</pICMS></${tag}></ICMS>`;
    } else {
      icmsBlock = `<ICMS><${tag}><orig>${orig}</orig><CSOSN>${csosn}</CSOSN></${tag}></ICMS>`;
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
    icmsBlock = `<ICMS><${tag}><orig>${orig}</orig><CST>${cstIcms}</CST><modBC>${modBC || '0'}</modBC><vBC>${vBC}</vBC><pICMS>${pICMS}</pICMS><vICMS>${vICMS}</vICMS></${tag}></ICMS>`;
  } else {
    // Fallback CSOSN 103
    icmsBlock = `<ICMS><ICMSSN102><orig>${orig}</orig><CSOSN>103</CSOSN></ICMSSN102></ICMS>`;
  }

  // --- PIS ---
  // PISAliq: CST 01,02,03 | PISNT: CST 04,05,06,07,08,09 | PISOutr: CST 49,50,51,52,53,54,55,56,60-75,98,99
  let pisBlock = '';
  const pisCstNum = String(cstPis).replace(/\D/g, '');
  if (['04','05','06','07','08','09'].includes(pisCstNum)) {
    pisBlock = `<PIS><PISNT><CST>${cstPis}</CST></PISNT></PIS>`;
  } else if (['01','02','03'].includes(pisCstNum)) {
    pisBlock = `<PIS><PISAliq><CST>${cstPis}</CST><vBC>${vBCPis}</vBC><pPIS>${pPis}</pPIS><vPIS>${vPIS}</vPIS></PISAliq></PIS>`;
  } else {
    pisBlock = `<PIS><PISOutr><CST>${cstPis}</CST><vBC>${vBCPis}</vBC><pPIS>${pPis}</pPIS><vPIS>${vPIS}</vPIS></PISOutr></PIS>`;
  }

  // --- COFINS ---
  // COFINSAliq: CST 01,02,03 | COFINSNT: CST 04,05,06,07,08,09 | COFINSOutr: CST 49,50,51,52,53,54,55,56,60-75,98,99
  let cofinsBlock = '';
  const cofCstNum = String(cstCof).replace(/\D/g, '');
  if (['04','05','06','07','08','09'].includes(cofCstNum)) {
    cofinsBlock = `<COFINS><COFINSNT><CST>${cstCof}</CST></COFINSNT></COFINS>`;
  } else if (['01','02','03'].includes(cofCstNum)) {
    cofinsBlock = `<COFINS><COFINSAliq><CST>${cstCof}</CST><vBC>${vBCCof}</vBC><pCOFINS>${pCofins}</pCOFINS><vCOFINS>${vCOFINS}</vCOFINS></COFINSAliq></COFINS>`;
  } else {
    cofinsBlock = `<COFINS><COFINSOutr><CST>${cstCof}</CST><vBC>${vBCCof}</vBC><pCOFINS>${pCofins}</pCOFINS><vCOFINS>${vCOFINS}</vCOFINS></COFINSOutr></COFINS>`;
  }

  // --- IPI ---
  // Emitir IPI somente quando o Odoo realmente fornecer o CST do item.
  let ipiBlock = '';
  if (String(crt || '') === '3' && line.cst_ipi) {
    const cstIpi = String(line.cst_ipi).replace(/\D/g, '').padStart(2, '0');
    const vBCIpi = num(line.vbc_ipi || '0.00');
    const pIpi   = num4(line.pipi || '0.00');
    const vIpi   = num(line.vipi || '0.00');
    const cEnq   = line.cenq || '999';
    if (['51','52','53','54','55'].includes(cstIpi)) {
      ipiBlock = `<IPI><cEnq>${cEnq}</cEnq><IPINT><CST>${cstIpi}</CST></IPINT></IPI>`;
    } else if (['00','49','50','99'].includes(cstIpi)) {
      ipiBlock = `<IPI><cEnq>${cEnq}</cEnq><IPITrib><CST>${cstIpi}</CST><vBC>${vBCIpi}</vBC><pIPI>${pIpi}</pIPI><vIPI>${vIpi}</vIPI></IPITrib></IPI>`;
    }
  }

  // --- IBS/CBS (Reforma Tributaria - obrigatorio no layout vigente 2026) ---
  let ibsBlock = '';
  if (ibsInfo) {
    ibsBlock = `<IBSCBS><CST>${ibsInfo.cst}</CST><cClassTrib>${ibsInfo.cClassTrib}</cClassTrib>`
      + `<gIBSCBS><vBC>${ibsInfo.vBC}</vBC>`
      + `<gIBSUF><pIBSUF>${ibsInfo.pIBSUF}</pIBSUF><vIBSUF>${ibsInfo.vIBSUF}</vIBSUF></gIBSUF>`
      + `<gIBSMun><pIBSMun>${ibsInfo.pIBSMun}</pIBSMun><vIBSMun>${ibsInfo.vIBSMun}</vIBSMun></gIBSMun>`
      + `<vIBS>${ibsInfo.vIBS}</vIBS>`
      + `<gCBS><pCBS>${ibsInfo.pCBS}</pCBS><vCBS>${ibsInfo.vCBS}</vCBS></gCBS>`
      + `</gIBSCBS></IBSCBS>`;
  }

  // NT2024/004 (IBSCBS): o schema PR-v4_9_86 nao aceita <vTrib> como filho de <imposto>
  // quando IBSCBS esta presente. A informacao de tributos flui pelo proprio IBS/CBS.
  // Ordem exigida pelo XSD: ICMS → IPI → PIS → COFINS → IBSCBS
  return `<imposto>${icmsBlock}${ipiBlock}${pisBlock}${cofinsBlock}${ibsBlock}</imposto>`;
}

/**
 * Calcula IBS/CBS de um item conforme o padrao do XML real da AJL:
 *   vBC = vProd - ICMS - PIS - COFINS (tributos "por dentro" excluidos)
 *   vIBSUF = vBC * pIBSUF% | vIBSMun = vBC * pIBSMun% | vCBS = vBC * pCBS%
 */
function calcIbsCbsItem(line, vProdNum, cfg) {
  const pIBSUF  = parseFloat(cfg.pIBSUF  != null ? cfg.pIBSUF  : (process.env.NFE_P_IBS_UF  || '0.10'));
  const pIBSMun = parseFloat(cfg.pIBSMun != null ? cfg.pIBSMun : (process.env.NFE_P_IBS_MUN || '0.00'));
  const pCBS    = parseFloat(cfg.pCBS    != null ? cfg.pCBS    : (process.env.NFE_P_CBS     || '0.90'));
  const vICMS   = parseFloat(line.vicms   || 0) || 0;
  const vPIS    = parseFloat(line.vpis    || 0) || 0;
  const vCOFINS = parseFloat(line.vcofins || 0) || 0;
  let base = vProdNum - vICMS - vPIS - vCOFINS;
  if (!(base > 0)) base = vProdNum;
  const vIBSUF  = round2(base * pIBSUF  / 100);
  const vIBSMun = round2(base * pIBSMun / 100);
  const vCBS    = round2(base * pCBS    / 100);
  return {
    cst: line.cst_ibscbs || cfg.cstIBSCBS || '000',
    cClassTrib: line.cclass_trib || cfg.cClassTrib || '000001',
    vBCNum: round2(base),
    vBC: num(base),
    pIBSUF: num4(pIBSUF), vIBSUF: num(vIBSUF), vIBSUFNum: vIBSUF,
    pIBSMun: num4(pIBSMun), vIBSMun: num(vIBSMun), vIBSMunNum: vIBSMun,
    vIBS: num(vIBSUF + vIBSMun), vIBSNum: round2(vIBSUF + vIBSMun),
    pCBS: num4(pCBS), vCBS: num(vCBS), vCBSNum: vCBS,
  };
}

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

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
  const tpAmb = cfg.tpAmb || process.env.SIEG_TP_AMB || '2'; // 2=homologacao (padrao seguro), 1=producao — defina SIEG_TP_AMB=1 para producao
  const finNFe = cfg.finNFe || '1'; // 1=normal
  // indFinal: '1' quando consumidor final OU quando nao contribuinte (indIEDest=9)
  // Regra SEFAZ cStat 696: operacao com nao contribuinte DEVE ter indFinal=1
  const _indIEDestCalc = calcIndIEDest(partner);
  const indFinal = (partner.is_consumer || partner.indFinal || _indIEDestCalc === '9') ? '1' : '0';
  const indPres = cfg.indPres || process.env.NFE_IND_PRES || '9'; // 9=operacao nao presencial, outros
  // indIntermed obrigatorio quando indPres = 2, 3, 4 ou 9 (NT2015.003 / cStat 434 SEFAZ PR)
  const indIntermed = ['2','3','4','9'].includes(String(indPres)) ? (cfg.indIntermed || '0') : null;
  const ibsCbsAtivo = String(cfg.ibsCbs != null ? cfg.ibsCbs : (process.env.NFE_IBSCBS || 'true')) !== 'false';
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

  // IE destinatário: log info (validacao já feita pelo calcIndIEDest)
  var destIeVal = (partner.inscr_est || '').replace(/\D/g, '');
  var destIeDisplay = '';
  if (destIeVal && destIeVal.length >= 2) {
    destIeDisplay = destIeVal; // IE numerica valida
  } else if (docDest2.length === 14) {
    destIeDisplay = '(vazio — indIEDest=2, isento)';
  } else {
    destIeDisplay = '(vazio — indIEDest=9, nao contribuinte)';
  }
  logField('IE', destIeDisplay, false);
  logField('indIEDest', _indIEDestCalc);

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
    logField('  CSOSN', l.csosn || '');
    logField('  CST_ICMS', l.cst_icms || '(vazio - usara CSOSN)');
    logField('  vICMS', l.vicms || '0.00');
    logField('  CST_PIS', l.cst_pis || '01');
    logField('  vPIS', l.vpis || '0.00');
    logField('  CST_COFINS', l.cst_cofins || '01');
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

  // Calcular cDV e adicionar Id na infNFe (obrigatorio pelo schema NF-e 4.00)
  var tpEmis = '1';
  var accessKey = calcAccessKey(cUF, dhEmi, company.cnpj_cpf, '55', serie, nNF, tpEmis, cNF);
  var cDV = accessKey[43];
  console.log('[NFE-XML] cDV calculado: ' + cDV + ' (chave sem DV: ' + accessKey.slice(0, 43) + ')');

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
      <cMunFG>${cMunFG}</cMunFG>${ibsCbsAtivo ? `
      <cMunFGIBS>${cMunFG}</cMunFGIBS>` : ''}
      <tpImp>1</tpImp>
      <tpEmis>${tpEmis}</tpEmis>
      <cDV>${cDV}</cDV>
      <tpAmb>${tpAmb}</tpAmb>
      <finNFe>${finNFe}</finNFe>
      <indFinal>${indFinal}</indFinal>
      <indPres>${indPres}</indPres>${indIntermed ? `
      <indIntermed>${indIntermed}</indIntermed>` : ''}
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
      <indIEDest>${indIEDest}</indIEDest>${(() => { const ieNum = onlyNum(partner.inscr_est || ''); return (ieNum && ieNum.length >= 2 && ieNum !== 'ISENTO') ? `\n      <IE>${ieNum}</IE>` : ''; })()}${partner.email ? `
      <email>${esc(partner.email)}</email>` : ''}
    </dest>`;

  // === det (items) ===
  const ibsTot = { vBC: 0, vIBSUF: 0, vIBSMun: 0, vIBS: 0, vCBS: 0 };
  lines.forEach((line, idx) => {
    const nItem = String(idx + 1);
    const vProdNum = round2(line.price_subtotal || (line.qty * line.price_unit));
    const vProd = num(vProdNum);
    // vProdTotal ja foi calculado no bloco de validacao acima
    const ibsItem = ibsCbsAtivo ? calcIbsCbsItem(line, vProdNum, cfg) : null;
    if (ibsItem) {
      ibsTot.vBC     += ibsItem.vBCNum;
      ibsTot.vIBSUF  += ibsItem.vIBSUFNum;
      ibsTot.vIBSMun += ibsItem.vIBSMunNum;
      ibsTot.vIBS    += ibsItem.vIBSNum;
      ibsTot.vCBS    += ibsItem.vCBSNum;
    }

    xml += `
    <det nItem="${nItem}">
      <prod>
        <cProd>${esc(String(line.default_code || line.cProd || ''))}</cProd>
        <cEAN>${line.barcode || 'SEM GTIN'}</cEAN>
        <xProd>${esc(line.product_name || line.xProd || '')}</xProd>
        <NCM>${esc(String(line.ncm || line.NCM || ''))}</NCM>
        <CFOP>${esc(String(line.cfop || '5102'))}</CFOP>
        <uCom>${esc(line.uom || 'UN')}</uCom>
        <qCom>${num3(line.qty)}</qCom>
        <vUnCom>${num3(line.price_unit)}</vUnCom>
        <vProd>${vProd}</vProd>
        <cEANTrib>SEM GTIN</cEANTrib>
        <uTrib>${esc(line.uom || 'UN')}</uTrib>
        <qTrib>${num3(line.qty)}</qTrib>
        <vUnTrib>${num3(line.price_unit)}</vUnTrib>
        <indTot>1</indTot>
      </prod>${xmlImpostoItem(line, company.crt || '1', ibsItem)}${ibsItem ? `
      <vItem>${vProd}</vItem>` : ''}
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

  // vTotTrib: NT2024/004 com IBSCBS — a SEFAZ PR-v4_9_86 calcula como 0.00 quando nao ha
  // <vTrib> por item. Zeramos aqui para manter consistencia (0.00 = 0.00, sem cStat 685).
  var vTotTrib = 0;
  // (loop removido: vTrib por item nao e permitido no schema com IBSCBS)

  const vNF = num(order.amount_total || vProdTotal);
  xml += `
    <total>
      <ICMSTot>
        <vBC>${num(vBC_total)}</vBC>
        <vICMS>${num(vICMS_total)}</vICMS>
        <vICMSDeson>0.00</vICMSDeson>
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
        <vTotTrib>${num(vTotTrib)}</vTotTrib>
      </ICMSTot>${ibsCbsAtivo ? `
      <IBSCBSTot>
        <vBCIBSCBS>${num(ibsTot.vBC)}</vBCIBSCBS>
        <gIBS>
          <gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>${num(ibsTot.vIBSUF)}</vIBSUF></gIBSUF>
          <gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>${num(ibsTot.vIBSMun)}</vIBSMun></gIBSMun>
          <vIBS>${num(ibsTot.vIBS)}</vIBS>
          <vCredPres>0.00</vCredPres>
          <vCredPresCondSus>0.00</vCredPresCondSus>
        </gIBS>
        <gCBS>
          <vDif>0.00</vDif>
          <vDevTrib>0.00</vDevTrib>
          <vCBS>${num(ibsTot.vCBS)}</vCBS>
          <vCredPres>0.00</vCredPres>
          <vCredPresCondSus>0.00</vCredPresCondSus>
        </gCBS>
      </IBSCBSTot>
      <vNFTot>${num(round2(parseFloat(vNF) + ibsTot.vIBS + ibsTot.vCBS))}</vNFTot>` : ''}
    </total>`;

  // === transp ===
  const modFrete = String(cfg.modFrete || '9');
  const hasVolume = cfg.qVol != null && Number(cfg.qVol) > 0;
  xml += `
    <transp>
      <modFrete>${modFrete}</modFrete>${hasVolume ? `
      <vol>
        <qVol>${Math.trunc(Number(cfg.qVol))}</qVol>
      </vol>` : ''}
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

  // === infRespTec (obrigatorio na NF-e 4.00 desde a NT 2018.005) ===
  // O CNPJ informado DEVE estar cadastrado na SEFAZ como responsavel tecnico do emitente.
  var respCnpj  = onlyNum(cfg.respTecCnpj    || process.env.NFE_RESP_TEC_CNPJ    || '');
  var respNome  = cfg.respTecContato          || process.env.NFE_RESP_TEC_CONTATO  || '';
  var respEmail = cfg.respTecEmail            || process.env.NFE_RESP_TEC_EMAIL    || '';
  var respFone  = onlyNum(cfg.respTecFone     || process.env.NFE_RESP_TEC_FONE     || '');
  // idCSRT/hashCSRT: opcionais. Se NFE_RESP_TEC_TOKEN_CSRT estiver definido,
  // o hash é calculado dinamicamente: base64(sha1(chave44 + token_csrt))
  var respIdCSRT = cfg.respTecIdCSRT || process.env.NFE_RESP_TEC_ID_CSRT || '';
  var respTokenCSRT = process.env.NFE_RESP_TEC_TOKEN_CSRT || '';
  var respHashCSRT = '';
  if (respIdCSRT && respTokenCSRT) {
    var crypto = require('crypto');
    // chave de 44 digitos sem o digito verificador prefixo 'NFe'
    var chave44 = String(accessKey).replace(/\D/g, '').slice(0, 44);
    respHashCSRT = crypto.createHash('sha1').update(chave44 + respTokenCSRT).digest('base64');
  }
  if (respCnpj && respNome && respEmail && respFone) {
    console.log('[NFE-XML] infRespTec CNPJ=' + respCnpj + ' contato=' + respNome + (respIdCSRT ? ' idCSRT=' + respIdCSRT : ' (sem CSRT)'));
    xml += '\n    <infRespTec>'
      + '\n      <CNPJ>' + respCnpj + '</CNPJ>'
      + '\n      <xContato>' + esc(respNome) + '</xContato>'
      + '\n      <email>' + esc(respEmail) + '</email>'
      + '\n      <fone>' + respFone + '</fone>'
      + (respIdCSRT && respHashCSRT ? '\n      <idCSRT>'   + respIdCSRT   + '</idCSRT>'   : '')
      + (respIdCSRT && respHashCSRT ? '\n      <hashCSRT>' + respHashCSRT + '</hashCSRT>' : '')
      + '\n    </infRespTec>';
  } else {
    console.error('[NFE-XML] *** infRespTec ausente — configure NFE_RESP_TEC_CNPJ, NFE_RESP_TEC_CONTATO, NFE_RESP_TEC_EMAIL e NFE_RESP_TEC_FONE ***');
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

function num(v, decimals) {
  if (v === null || v === undefined) return '0.00';
  const n = parseFloat(String(v).replace(',', '.'));
  if (isNaN(n)) return decimals === 3 ? '0.000' : '0.00';
  return n.toFixed(decimals || 2);
}

function num4(v) {
  const n = parseFloat(String(v == null ? 0 : v).replace(',', '.'));
  return (isNaN(n) ? 0 : n).toFixed(4);
}

function num3(v) {
  return num(v, 3);
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
  var str = String(iso).trim();

  // Odoo (XML-RPC) devolve "YYYY-MM-DD HH:MM:SS" em UTC, sem 'T' e sem offset.
  // Converter para horario de Brasilia (-03:00) no formato exigido pelo XSD.
  var mOdoo = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (mOdoo) {
    var utc = Date.UTC(+mOdoo[1], +mOdoo[2] - 1, +mOdoo[3], +mOdoo[4], +mOdoo[5], +(mOdoo[6] || 0));
    var d = new Date(utc - 3 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
           'T' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + '-03:00';
  }

  // Ja veio com data + hora + offset (ISO completo)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(str)) {
    var dIso = new Date(str);
    if (!isNaN(dIso.getTime())) {
      var b = new Date(dIso.getTime() - 3 * 3600 * 1000);
      return b.getUTCFullYear() + '-' + pad2(b.getUTCMonth() + 1) + '-' + pad2(b.getUTCDate()) +
             'T' + pad2(b.getUTCHours()) + ':' + pad2(b.getUTCMinutes()) + ':' + pad2(b.getUTCSeconds()) + '-03:00';
    }
  }

  // Apenas data "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str + 'T00:00:00-03:00';

  // Fallback: nao arriscar um valor invalido no XML — usar agora
  console.warn('[NFE-XML] dhEmi em formato desconhecido ("' + str + '"), usando data/hora atual');
  return formatDh(null);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function calcIdDest(ufEmit, ufDest) {
  if (!ufEmit || !ufDest) return '1';
 if (ufEmit === ufDest) return '1'; // mesma UF
 if (ufDest === 'EX') return '3'; // exterior
 return '2'; // fora UF
}

function calcIndIEDest(partner) {
  const ie = partner.inscr_est || '';
  const ieNum = onlyNum(ie);
  const uf = partner.state || partner.UF || '';
  const docDest = onlyNum(partner.cnpj_cpf || '');
  // IE preenchida com valor numerico valido -> contribuinte ICMS
  if (ie && ieNum !== '' && ieNum !== 'ISENTO' && ieNum.length >= 2) return '1';
  // CNPJ sem IE numerica:
  //   indIEDest=2 (Isento/nao contribuinte ICMS) — NAO enviar tag <IE>
  //   O XSD TIeDestNaoIsento so aceita [0-9]{2,14}, literal ISENTO e REJEITADO (cStat 225)
  //   SEFAZ-PR aceita indIEDest=2 sem tag <IE> (validado em producao 17/09/2026)
  if (docDest.length === 14) return '2'; // isento/nao contribuinte ICMS
  // CPF sem IE: nao contribuinte
  return '9';
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
  // DV = modulo 11 dos 43 digitos, pesos 2-9 ciclicos do DIREITA para ESQUERDA
  // Para iterar da esquerda, o peso do digito i (0=esquerda, 42=direita) e:
  //   pesos_ciclicos[(42 - i) % 8]
  var cycle = [2,3,4,5,6,7,8,9];
  var sum = 0;
  for (var i = 0; i < 43; i++) {
    sum += parseInt(key[i]) * cycle[(42 - i) % 8];
  }
  var remainder = sum % 11;
  var cDV = 11 - remainder;
  if (cDV === 10 || cDV === 11) cDV = 0;
  return key + String(cDV);
}

module.exports = { gerarXmlNFe };
