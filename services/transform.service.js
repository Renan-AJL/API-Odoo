/**
 * Serviço de transformação de dados.
 * Converte a resposta da API CNP Já para o formato dos campos nativos do Odoo l10n_br.
 *
 * CAMPOS NATIVOS l10n_br UTILIZADOS:
 *   vat              → CNPJ formatado (00.000.000/0000-00)
 *   l10n_br_ie_code  → Inscrição Estadual
 *   l10n_br_tax_regime → Regime tributário (selection com código)
 *   l10n_br_taxpayer → Tipo de contribuinte (selection com código)
 *   name, street, zip, city_id, state_id, country_id → nativos do Odoo
 *
 * REGRA DE IMPOSTO (EXTREMA IMPORTÂNCIA):
 * - Se tem IE (Inscrição Estadual) → 12%
 * - Se não tem IE → 19%
 *
 * REGRA DE PESSOA:
 * - Sempre marcar como PJ (is_company = true), inclusive MEI
 */

// ============================================================
// Mapeamento l10n_br_tax_regime (código → descrição)
// Estes códigos correspondem ao campo selection do l10n_br
// ============================================================
const TAX_REGIME = {
  '1': 'Lucro real',
  '2': 'Lucro presumido',
  '3': 'Optante do SIMPLES',
  '4': 'Optante do SIMPLES com limite de faturamento bruto',
  '5': 'Empreendedor do Simples Nacional',
  '6': 'Não aplicável',
  '7': 'Indivíduo',
  '8': 'Variável',
};

// ============================================================
// Mapeamento l10n_br_taxpayer (código → descrição)
// ============================================================
const TAXPAYER = {
  '1': 'Contribuinte do ICMS',
  '2': 'Contribuinte isento',
  '3': 'Não contribuinte',
};

/**
 * Formata CNPJ para o padrão Odoo VAT: 00.000.000/0000-00
 */
function formatarCNPJ(cnpj) {
  const digits = (cnpj || '').replace(/\D/g, '');
  if (digits.length !== 14) return cnpj || '';
  return digits.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    '$1.$2.$3/$4-$5'
  );
}

/**
 * Determina se a empresa tem inscrição estadual ativa
 * @param {Array} registrations - Array de inscrições estaduais do CNP Já
 * @returns {Object} { hasIE, ie, ieState, ieDetails }
 */
function verificarIE(registrations) {
  if (!registrations || !Array.isArray(registrations) || registrations.length === 0) {
    return { hasIE: false, ie: null, ieState: null, ieDetails: [] };
  }

  // Filtra IE ativas e do tipo "IE Normal"
  const ieAtivas = registrations.filter(r =>
    r.enabled &&
    r.type &&
    r.type.id === 1 && // IE Normal
    r.status &&
    r.status.id === 1  // Sem restrição
  );

  // Se não tem IE normal ativa, verifica qualquer IE ativa
  const ieQualquerAtiva = registrations.filter(r => r.enabled);

  if (ieAtivas.length > 0) {
    const iePrincipal = ieAtivas[0];
    return {
      hasIE: true,
      ie: iePrincipal.number,
      ieState: iePrincipal.state,
      ieDetails: ieAtivas.map(r => ({
        number: r.number,
        state: r.state,
        type: r.type?.text || 'IE Normal',
        status: r.status?.text || 'Desconhecida',
        statusDate: r.statusDate || null,
      })),
    };
  }

  if (ieQualquerAtiva.length > 0) {
    return {
      hasIE: true,
      ie: ieQualquerAtiva[0].number,
      ieState: ieQualquerAtiva[0].state,
      ieDetails: ieQualquerAtiva.map(r => ({
        number: r.number,
        state: r.state,
        type: r.type?.text || 'Desconhecido',
        status: r.status?.text || 'Desconhecida',
        statusDate: r.statusDate || null,
      })),
    };
  }

  return { hasIE: false, ie: null, ieState: null, ieDetails: [] };
}

/**
 * Aplica a regra de imposto com base na IE
 * @returns {number} 12 ou 19
 */
function calcularImposto(ieInfo) {
  return ieInfo.hasIE ? 12 : 19;
}

/**
 * Determina o regime tributário (l10n_br_tax_regime) e tipo de contribuinte
 * a partir dos dados do CNP Já.
 *
 * Mapeamento:
 *   simei.optant = true  → código '5' (Empreendedor do Simples Nacional / MEI)
 *   simples.optant=true → código '3' (Optante do SIMPLES)
 *   nenhum dos dois     → código '1' (Lucro real) como padrão
 *
 *   Tem IE → l10n_br_taxpayer = '1' (Contribuinte do ICMS)
 *   Sem IE → l10n_br_taxpayer = '3' (Não contribuinte)
 */
function determinarRegimeETipo(ieInfo, company) {
  const isMEI = company?.simei?.optant || false;
  const isSimples = company?.simples?.optant || false;

  // Determina l10n_br_tax_regime
  let taxRegime = '1'; // default Lucro real
  if (isMEI) {
    taxRegime = '5'; // Empreendedor do Simples Nacional
  } else if (isSimples) {
    taxRegime = '3'; // Optante do SIMPLES
  }

  // Determina l10n_br_taxpayer
  let taxpayer = '3'; // default Não contribuinte
  if (ieInfo.hasIE) {
    taxpayer = '1'; // Contribuinte do ICMS
  } else if (ieInfo.ie === null && ieInfo.ieDetails.length === 0) {
    taxpayer = '3'; // Não contribuinte
  }

  return {
    isMEI,
    isSimples,
    taxRegime,         // código para l10n_br_tax_regime
    taxRegimeText: TAX_REGIME[taxRegime] || '',
    taxpayer,          // código para l10n_br_taxpayer
    taxpayerText: TAXPAYER[taxpayer] || '',
  };
}

/**
 * Formata telefone para padrão brasileiro
 */
function formatarTelefone(phone) {
  if (!phone) return null;
  const area = phone.area || '';
  const number = phone.number || '';
  return `(${area}) ${number}`;
}

/**
 * Monta a lista de e-mails
 */
function extrairEmails(emails) {
  if (!emails || !Array.isArray(emails)) return [];
  return emails.map(e => e.address).filter(Boolean);
}

/**
 * Monta a atividade principal + secundárias
 */
function montarAtividades(mainActivity, sideActivities) {
  let cnaePrincipal = '';
  let cnaesSecundarios = [];

  if (mainActivity) {
    cnaePrincipal = `${mainActivity.id} - ${mainActivity.text}`;
  }

  if (sideActivities && Array.isArray(sideActivities)) {
    cnaesSecundarios = sideActivities.map(s => `${s.id} - ${s.text}`);
  }

  return { cnaePrincipal, cnaePrincipalId: mainActivity?.id || null, cnaesSecundarios };
}

/**
 * Transforma os dados completos da API CNP Já para o formato dos campos l10n_br do Odoo.
 *
 * @param {Object} cnpjaData - Resposta da API CNP Já
 * @param {Object} ieExterna - IE obtida de fonte externa (Consultar.IO/SINTEGRA)
 * @returns {Object} Dados formatados com campos nativos do Odoo l10n_br
 */
function transformarParaOdoo(cnpjaData, ieExterna) {
  if (!cnpjaData) {
    throw new Error('Dados do CNP Já não fornecidos');
  }

  const {
    company, address, phones, emails, mainActivity, sideActivities,
    registrations, suframa, founded, status, taxId
  } = cnpjaData;

  // ---- IE e regra de imposto ----
  const ieInfoCnpja = verificarIE(registrations);

  // Se veio IE de fonte externa (Consultar.IO/SINTEGRA), usa ela
  let ieInfoFinal = ieInfoCnpja;
  let ieSource = 'cnpja';
  if (!ieInfoCnpja.hasIE && ieExterna && ieExterna.hasIE) {
    ieInfoFinal = {
      hasIE: true,
      ie: ieExterna.ie,
      ieState: ieExterna.ieState,
      ieDetails: ieExterna.ieDetails || [],
    };
    ieSource = ieExterna.source || 'externa';
  }
  const aliquotaImposto = calcularImposto(ieInfoFinal);

  // ---- Regime tributário e tipo de contribuinte ----
  const regimeInfo = determinarRegimeETipo(ieInfoFinal, company);

  // ---- Atividades ----
  const atividadesInfo = montarAtividades(mainActivity, sideActivities);

  // ---- Comentário com dados adicionais ----
  let comments = [];
  if (company?.nature?.text) comments.push(`Natureza Juridica: ${company.nature.text}`);
  if (company?.size?.text) comments.push(`Porte: ${company.size.text}`);
  if (regimeInfo.taxRegimeText) comments.push(`Regime Tributario: ${regimeInfo.taxRegimeText}`);
  if (regimeInfo.taxpayerText) comments.push(`Tipo Contribuinte: ${regimeInfo.taxpayerText}`);
  if (founded) comments.push(`Data de Abertura: ${founded}`);
  if (status?.text) comments.push(`Situacao: ${status.text}`);
  if (cnpjaData.statusDate) comments.push(`Data Situacao: ${cnpjaData.statusDate}`);

  // IE
  if (ieInfoFinal.hasIE) {
    comments.push(`Inscricao Estadual: ${ieInfoFinal.ie} (${ieInfoFinal.ieState}) [Fonte: ${ieSource}]`);
  } else {
    comments.push('Inscricao Estadual: Nao encontrada (API publica sem IE / Configure token Consultar.IO)');
  }

  // Alíquota
  comments.push(`Aliquota ICMS-ST: ${aliquotaImposto}% (${ieInfoFinal.hasIE ? 'Possui IE - Fonte: ' + ieSource : 'Sem IE - Nao contribuinte'})`);

  // SUFRAMA
  if (suframa && suframa.length > 0) {
    suframa.forEach(s => {
      comments.push(`SUFRAMA: ${s.number} - ${s.status?.text || ''}`);
    });
  }

  // Sócios
  if (company?.members && company.members.length > 0) {
    comments.push('');
    comments.push('Quadro Societario:');
    company.members.slice(0, 10).forEach(m => {
      const nome = m.person?.name || 'N/A';
      const cargo = m.role?.text || 'N/A';
      comments.push(`  - ${nome} (${cargo})`);
    });
    if (company.members.length > 10) {
      comments.push(`  ... e mais ${company.members.length - 10} socio(s)`);
    }
  }

  // ---- Telefone e email ----
  let phone = null;
  let mobile = null;
  if (phones && Array.isArray(phones) && phones.length > 0) {
    phone = formatarTelefone(phones[0]);
    if (phones.length > 1) {
      mobile = formatarTelefone(phones[1]);
    }
  }
  const emailList = extrairEmails(emails);

  // ==========================
  // RETORNO COM CAMPOS l10n_br
  // ==========================
  return {
    // ---- DADOS PRINCIPAIS (campos nativos Odoo + l10n_br) ----
    name: company?.name || '',                                  // name
    vat: formatarCNPJ(taxId),                                   // vat (CNPJ formatado)
    is_company: true,                                           // SEMPRE PJ
    company_type: 'company',                                    // company_type

    // ---- CAMPOS NATIVOS l10n_br ----
    l10n_br_ie_code: ieInfoFinal.ie || '',                      // l10n_br_ie_code (vazio = isento)
    l10n_br_tax_regime: regimeInfo.taxRegime,                   // l10n_br_tax_regime (codigo)
    l10n_br_taxpayer: regimeInfo.taxpayer,                      // l10n_br_taxpayer (codigo)

    // ---- REGRA DE IMPOSTO (EXTREMA IMPORTÂNCIA) ----
    aliquota_icms: aliquotaImposto,                             // 12 ou 19
    has_ie: ieInfoFinal.hasIE,                                  // boolean
    ie_source: ieSource,                                        // origem da IE: 'cnpja', 'consultar.io-sintegra', 'externa', 'nenhuma'

    // ---- TIPO DE EMPRESA ----
    is_mei: regimeInfo.isMEI,

    // ---- ENDEREÇO (campos nativos Odoo) ----
    street: [address?.street, address?.number].filter(Boolean).join(', '),
    street2: address?.district || '',
    city: address?.city || '',
    state: address?.state || '',                                // UF (sigla) para buscar state_id
    zip: address?.zip || '',
    country: address?.country?.name || 'Brasil',
    country_code: 'BR',

    // ---- CONTATO ----
    phone: phone,
    mobile: mobile,
    email: emailList.length > 0 ? emailList[0] : '',

    // ---- ATIVIDADE ECONÔMICA ----
    cnae: atividadesInfo.cnaePrincipal,
    cnae_id: atividadesInfo.cnaePrincipalId,
    cnaes_secundarios: atividadesInfo.cnaesSecundarios,

    // ---- DADOS COMPLEMENTARES (para comment/informação) ----
    natureza_juridica: company?.nature?.text || '',
    porte_empresa: company?.size?.text || '',
    data_abertura: founded || null,
    data_situacao: cnpjaData.statusDate || null,
    situacao_cadastral: status?.text || '',
    suframa: suframa && suframa.length > 0 ? suframa.map(s => s.number).join(', ') : '',

    // ---- IE detalhes (todas as IEs da empresa) ----
    ie_details: ieInfoFinal.ieDetails,

    // ---- TEXTO INFORMATIVO ----
    comment: comments.join('\n'),

    // ---- QUADRO SOCIETÁRIO ----
    members: company?.members?.map(m => ({
      name: m.person?.name || '',
      role: m.role?.text || '',
      since: m.since || null,
    })) || [],

    // ---- METADADOS ----
    source: 'cnpja-middleware',
    consulted_at: new Date().toISOString(),
    cnpja_updated: cnpjaData.updated || null,
  };
}

/**
 * Gera um resumo para retorno simplificado
 */
function gerarResumo(odooData) {
  return {
    cnpj: odooData.vat,
    razao_social: odooData.name,
    ie: odooData.l10n_br_ie_code || 'ISENTO',
    has_ie: odooData.has_ie,
    ie_source: odooData.ie_source || 'desconhecida',
    aliquota_icms: odooData.aliquota_icms,
    is_company: odooData.is_company,
    is_mei: odooData.is_mei,
    tax_regime: odooData.l10n_br_tax_regime,
    taxpayer: odooData.l10n_br_taxpayer,
    cidade: odooData.city,
    estado: odooData.state,
    situacao: odooData.situacao_cadastral,
  };
}

module.exports = {
  transformarParaOdoo,
  gerarResumo,
  verificarIE,
  calcularImposto,
  determinarRegimeETipo,
  formatarCNPJ,
  TAX_REGIME,
  TAXPAYER,
};
