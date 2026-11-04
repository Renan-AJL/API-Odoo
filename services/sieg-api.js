/**
 * services/sieg-api.js — Emissao fiscal
 * =====================================
 * NF-e (mod 55): emissao PROPRIA — o XML e assinado com o certificado A1 da
 * AJL e autorizado direto na SEFAZ (services/sefaz-client.js). O DANFE em PDF
 * eh gerado localmente (services/danfe-pdf.js). A SIEG deixa de ser necessaria
 * para emitir; continua opcional como cofre de XML (SIEG_IMPORT_XML=1).
 *
 * NFS-e: continua via SIEG (prefeitura/DPS).
 *
 * Variaveis de ambiente:
 *   NFE_EMISSAO_MODO   proprio (default) | sieg
 *   NFE_UF             UF do emitente (default PR)
 *   SIEG_TP_AMB        1=producao, 2=homologacao
 *   NFE_DANFE_PROVIDER local (default) | sieg
 *   SIEG_IMPORT_XML    1 = apos autorizar, importa o nfeProc no cofre SIEG
 */
const axios = require('axios');
const AdmZip = require('adm-zip');
const { getAuthHeaders } = require('./sieg-auth');
const { gerarXmlNFe } = require('./sieg-nfe-xml');
const { corrigirCmunNoXml } = require('./nfe-xml-sanitize');
const { gerarXmlDPS } = require('./sieg-nfse-xml');
const { autorizarNFe } = require('./sefaz-client');
const { gerarDanfePdf } = require('./danfe-pdf');

const SIEG_BASE = 'https://api.sieg.com';

function modoEmissao() {
  return String(process.env.NFE_EMISSAO_MODO || 'proprio').toLowerCase();
}

/** Importa um XML ja autorizado (nfeProc) no cofre da SIEG — opcional. */
async function importarXmlSieg(xmlAutorizado) {
  const xmlMin = String(xmlAutorizado).replace(/>\s+</g, '><');
  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
    Xml: Buffer.from(xmlMin, 'utf-8').toString('base64'),
  }, { headers, timeout: 60000, validateStatus: function (s) { return s < 500; } });
  console.log('[SIEG-API] Import no cofre HTTP ' + resp.status + ': ' + JSON.stringify(resp.data).slice(0, 500));
  return { httpStatus: resp.status, resposta: resp.data };
}

/**
 * Emissao propria: gera XML -> corrige cMun -> assina com A1 -> autoriza na SEFAZ.
 * Retorna o mesmo formato de resultado consumido por sieg-odoo-emit.
 */
async function emitirNFePropria(dadosOdoo) {
  const xmlMontado = gerarXmlNFe(dadosOdoo);
  // AJL 21/10/2026 (pedido Renan): ao finalizar a montagem do XML, o middleware
  // ABRIR o XML pronto, troca o cMun errado pelo codigo correto da tabela IBGE
  // e continua (assinatura + SEFAZ). Roda ANTES de assinar — depois quebraria
  // o digest. Fix permanente da rejeicao 274 (Codigo Municipio inexistente).
  const fixCmun = corrigirCmunNoXml(xmlMontado);
  const xml = fixCmun.xml;
  if (fixCmun.correcoes.length) {
    console.log('[NFE] cMun corrigido no XML pos-montagem: ' + JSON.stringify(fixCmun.correcoes));
  }
  console.log('[NFE] Emissao propria — XML gerado (' + xml.length + ' chars, ' + fixCmun.correcoes.length + ' correcao(oes) cMun)');

  let r;
  try {
    r = await autorizarNFe(xml);
  } catch (err) {
    console.error('[NFE] Falha antes do envio a SEFAZ: ' + err.message);
    return {
      sucesso: false,
      httpStatus: err.code === 'CERT_AUSENTE' || err.code === 'CERT_EXPIRADO' ? 422 : 500,
      xmlEnviado: xml,
      resposta: { xMotivo: err.message },
      data: null,
      erro: err.message,
      statusCode: err.code || null,
    };
  }

  const resultado = {
    sucesso: !!r.autorizada,
    httpStatus: 200,
    xmlEnviado: r.nfeProc || r.xmlAssinado || xml,
    xmlAssinado: r.xmlAssinado,
    nfeProc: r.nfeProc || null,
    resposta: {
      chNFe: r.chave,
      nProt: r.protocolo,
      cStat: r.cStat,
      xMotivo: r.xMotivo,
      ambiente: r.ambiente,
      uf: r.uf,
      endpoint: r.endpoint,
      respostaSefaz: r.respostaSefaz,
    },
    data: r.nfeProc || null,
    erro: r.autorizada ? null : (r.erro || r.xMotivo || 'NF-e nao autorizada'),
    statusCode: r.cStat || null,
  };

  // Cofre SIEG (opcional): guarda o XML autorizado
  if (resultado.sucesso && String(process.env.SIEG_IMPORT_XML || '') === '1') {
    try {
      resultado.cofreSieg = await importarXmlSieg(r.nfeProc);
    } catch (e) {
      console.error('[SIEG-API] Falha ao importar no cofre (nota continua autorizada): ' + e.message);
      resultado.cofreSieg = { erro: e.message };
    }
  }

  return resultado;
}

/**
 * Caminho legado: importa no SIEG um XML de NF-e ja assinado/autorizado.
 * So eh usado com NFE_EMISSAO_MODO=sieg.
 */
async function enviarNFeViaSieg(dadosOdoo) {
  // Mesma rede de seguranca pos-montagem do caminho proprio (cMun x tabela IBGE)
  const fixCmunSieg = corrigirCmunNoXml(gerarXmlNFe(dadosOdoo));
  const xml = fixCmunSieg.xml;
  if (fixCmunSieg.correcoes.length) {
    console.log('[SIEG-API] cMun corrigido no XML pos-montagem: ' + JSON.stringify(fixCmunSieg.correcoes));
  }
  const xmlMin = xml.replace(/>\s+</g, '><');

  if (xmlMin.indexOf('<Signature') === -1 || xmlMin.indexOf('<protNFe') === -1) {
    return {
      sucesso: false,
      httpStatus: 422,
      xmlEnviado: xml,
      resposta: null,
      data: null,
      erro: 'O endpoint SIEG /send-xml aceita apenas XML de NF-e ja assinado e autorizado (nfeProc). Use NFE_EMISSAO_MODO=proprio para emitir com o certificado A1.',
      statusCode: 422,
    };
  }

  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
    Xml: Buffer.from(xmlMin, 'utf-8').toString('base64'),
  }, { headers, timeout: 60000, validateStatus: function (s) { return s < 500; } });

  const result = resp.data || {};
  return {
    sucesso: result.IsSuccess === true,
    httpStatus: resp.status,
    xmlEnviado: xml,
    resposta: result,
    data: result.Data || null,
    erro: result.ErrorMessage || result.Message || null,
    statusCode: result.StatusCode || null,
  };
}

/**
 * AJL 04/11/2026 — TRANSFERÊNCIA ENTRE FILIAIS (AJL Florianópolis -> AJL Curitiba
 * Matriz, CFOP 6152). O certificado A1 da filial está no COFRE SIEG (só a Matriz
 * tem .pfx local para SEFAZ-direta). O XML (NÃO assinado, montado com os dados
 * do cadastro + NFref do modelo autorizado 422609...562740) é ENVIADO a SIEG:
 *   1) REST api.sieg.com/api/v1/send-xml (JWT+OAuth — getAuthHeaders) — caminho
 *      principal (o classic api_key ficou rejeitando tudo em 04/11);
 *   2) fallback classic up.sieg.com/EnviarXml?api_key — apenas erro de rede.
 * A SIEG assina com o cert da filial, envia à SEFAZ e importa no cofre. A
 * autorizacao é ASSÍNCRONA: a chave já é calculada aqui; o fechamento
 * (chave/protocolo/cStat) acontece no poll verificarTransferenciasSieg
 * (sieg-odoo-emit.js) consultando baixar-xmls.
 * Matriz e demais emissoes NAO passam por aqui (config.viaSiegTransferencia).
 */
async function enviarNFeSiegTransferencia(dadosOdoo) {
  const fixCmunTransf = corrigirCmunNoXml(gerarXmlNFe(dadosOdoo));
  const xml = fixCmunTransf.xml;
  if (fixCmunTransf.correcoes.length) {
    console.log('[SIEG-API] cMun corrigido no XML pos-montagem (transferencia): ' + JSON.stringify(fixCmunTransf.correcoes));
  }
  const xmlMin = xml.replace(/>\s+</g, '><');
  const chave = (xmlMin.match(/Id="NFe(\d{44})"/) || [])[1] || '';
  if (!chave) {
    return { sucesso: false, httpStatus: 422, xmlEnviado: xml, resposta: null, data: null,
      erro: 'Chave de acesso nao calculada no XML da transferencia', statusCode: 422 };
  }
  const apiKey = process.env.SIEG_API_KEY_TRANSF || process.env.SIEG_API_KEY || '';
  // AJL 05/11 (v1.2.19) — CLASSIC ENVIARXML PRIMEIRO (servico de EMISSAO da SIEG):
  // o REST api.sieg.com send-xml/enviar-xml e IMPORT de cofre — 409 'XML invalido
  // ou mal formatado' para NFe NAO assinada (bisect 04/11, re-teste 05/11 nos dois
  // endpoints). O classic up.sieg.com/EnviarXml (form-urlencoded Xml=<b64>) assina
  // com o cert da conta no cofre SIEG e transmite a SEFAZ. 401 'Nao Autenticado:
  // Erro ao obter dados de usuario' = Chave de API invalida/antiga -> confira no
  // painel SIEG (Configuracoes > API / Chave para envio de XML) e atualize no
  // Render a env SIEG_API_KEY (ou SIEG_API_KEY_TRANSF). REST fica so como
  // fallback de erro de REDE (nunca apos erro de negocio, p/ nao duplicar chave).
  const xmlB64Send = Buffer.from(xmlMin, 'utf-8').toString('base64');
  let resp;
  let via = 'classic';
  if (!apiKey) {
    via = 'rest';
    try {
      const headersNoKey = await getAuthHeaders();
      console.log('[SIEG-API] Transferencia chave ' + chave + ' -> REST send-xml (SEM SIEG_API_KEY configurada)');
      resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', { Xml: xmlB64Send },
        { headers: headersNoKey, timeout: 90000, validateStatus: function (s) { return s < 500; } });
    } catch (errNoKey) {
      return { sucesso: false, httpStatus: 422, xmlEnviado: xml, resposta: null, data: null,
        erro: 'SIEG_API_KEY nao configurada (emissao classic indisponivel) e REST falhou: ' + errNoKey.message, statusCode: 422 };
    }
  } else {
    try {
      const url = 'https://up.sieg.com/EnviarXml?api_key=' + encodeURIComponent(apiKey);
      console.log('[SIEG-API] Transferencia chave ' + chave + ' -> classic up.sieg.com/EnviarXml (' + xmlMin.length + ' chars)');
      resp = await axios.post(url, new URLSearchParams({ Xml: xmlB64Send }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 90000,
          validateStatus: function (s) { return s < 500; } });
    } catch (errClassic) {
      console.error('[SIEG-API] Erro de conexao EnviarXml (transferencia):', errClassic.message);
      via = 'rest';
      try {
        const headers = await getAuthHeaders();
        console.log('[SIEG-API] Transferencia chave ' + chave + ' -> api.sieg.com/api/v1/send-xml REST (fallback rede)');
        resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', { Xml: xmlB64Send },
          { headers, timeout: 90000, validateStatus: function (s) { return s < 500; } });
      } catch (err) {
        console.error('[SIEG-API] Erro de conexao EnviarXml (transferencia):', err.message);
        return { sucesso: false, httpStatus: err.response ? err.response.status : 500, xmlEnviado: xml,
          resposta: err.response ? err.response.data : null, data: null,
          erro: 'Falha de conexao com a SIEG (classic EnviarXml: ' + errClassic.message + ' | REST: ' + err.message + ')', statusCode: null };
      }
    }
  }
  const result = resp.data;
  const txt = typeof result === 'string' ? result : JSON.stringify(result || {});
  console.log('[SIEG-API] Resposta ' + (via === 'rest' ? 'send-xml REST' : 'EnviarXml classic') + ' (transferencia) HTTP ' + resp.status + ': ' + txt.slice(0, 400));
  // AJL 05/11 (v1.2.19) — 401 'Nao Autenticado' = chave invalida: erro CLARO p/ o
  // financeiro (nao e problema de XML nem do certificado do cofre)
  if (resp.status === 401 || /n[aã]o autenticado|erro ao obter dados de usu[aá]rio/i.test(txt)) {
    return { sucesso: false, httpStatus: resp.status, xmlEnviado: xml, resposta: result, data: null,
      erro: 'SIEG recusou a Chave de API (' + txt.slice(0, 140) + ') — a Chave de API do painel SIEG (Configurações › API › envio de XML) precisa ser conferida/atualizada na env SIEG_API_KEY do Render.',
      statusCode: 'SIEG_AUTH' };
  }
  const importOk = resp.status === 200 && (
    txt.toLowerCase().indexOf('sucesso') >= 0 ||
    txt.toLowerCase().indexOf('enviado') >= 0 ||
    (result && (result.IsSuccess === true || result.Status === 200 || result.status === 200)));
  return {
    sucesso: importOk,
    aguardandoSieg: importOk,
    chave: chave,
    httpStatus: resp.status,
    xmlEnviado: xml,
    resposta: result,
    data: null,
    erro: importOk ? null : (typeof result === 'object' && result ?
      (result.ErrorMessage || result.Message || result.Erro || txt.slice(0, 500)) : txt.slice(0, 500)) ||
      'SIEG nao confirmou o import do XML da transferencia',
    statusCode: importOk ? null : 'SIEG_IMPORT',
  };
}

/**
 * AJL 04/11/2026 — Baixa XMLs do cofre SIEG (mesmo endpoint usado pelo Painel
 * admin: api.sieg.com/api/v1/baixar-xmls, JWT+OAuth). Retorna itens parseados
 * (chave/cStat/nProt/xMotivo/xml) do periodo [hoje-dias, hoje].
 * AJL 05/11/2026 (v1.2.20) — SIEG limitou Take <= 50 ("take invalido. Informar
 * valor menor ou igual a 50"): paginacao Skip em paginas de 50 ate esgotar o
 * periodo ou atingir o teto (take arredondado p/ cima em paginas de 50, max
 * 600 docs — 12 paginas). Pagina 404 = fim da paginacao (nao e erro).
 */
async function baixarXmlsSieg(dias, take) {
  const headers = await getAuthHeaders();
  const ini = new Date(Date.now() - (parseInt(dias, 10) || 4) * 86400000);
  const PAGINA = 50;
  const teto = Math.max(PAGINA, Math.min(parseInt(take, 10) || 300, 600));
  const maxPaginas = Math.ceil(teto / PAGINA);
  const itens = [];
  let httpStatus = 0;
  for (let pag = 0; pag < maxPaginas; pag++) {
    const body = {
      TipoXml: 1, Take: PAGINA, Skip: pag * PAGINA,
      DataEmissaoInicio: ini.toISOString(), DataEmissaoFim: new Date().toISOString(),
    };
    const resp = await axios.post('https://api.sieg.com/api/v1/baixar-xmls', body,
      { headers, timeout: 60000, responseType: 'arraybuffer', validateStatus: function (s) { return s < 500; } });
    httpStatus = resp.status;
    if (resp.status !== 200) {
      // 404 = "Nenhum arquivo XML localizado" nesta pagina -> fim da paginacao.
      if (resp.status === 404 && itens.length) break;
      if (resp.status === 404) break;
      return { sucesso: false, httpStatus: resp.status, itens: [], erro: 'HTTP ' + resp.status };
    }
    const nAntes = itens.length;
    try {
      const zip = new AdmZip(resp.data);
      zip.getEntries().forEach(function (entry) {
        if (entry.isDirectory) return;
        let xmlStr = '';
        try { xmlStr = zip.readAsText(entry); } catch (e) { return; }
        const m = xmlStr.match(/Id="(?:NFe|CTe|MDFe)?(\d{44})"/i);
        const chave = m ? m[1] : '';
        if (chave && itens.some(function (it) { return it.chave === chave; })) return;
        const cStatM = xmlStr.match(/<cStat>(\d+)<\/cStat>/);
        const nProtM = xmlStr.match(/<nProt>([^<]+)<\/nProt>/);
        const xMotM = xmlStr.match(/<xMotivo>([^<]*)<\/xMotivo>/);
        itens.push({
          chave: chave,
          cStat: cStatM ? cStatM[1] : '',
          nProt: nProtM ? nProtM[1] : '',
          xMotivo: xMotM ? xMotM[1] : '',
          xml: xmlStr,
        });
      });
    } catch (eZip) {
      return { sucesso: false, httpStatus: resp.status, itens: [], erro: 'ZIP invalido: ' + eZip.message };
    }
    // Pagina veio vazia (ou so duplicados) -> esgotou o periodo.
    if (itens.length === nAntes) break;
  }
  console.log('[SIEG-API] baixar-xmls: ' + itens.length + ' documento(s) no periodo (' + maxPaginas + ' paginas max)');
  return { sucesso: true, httpStatus: httpStatus, itens: itens };
}

async function enviarNFe(dadosOdoo) {
  if (dadosOdoo.config && dadosOdoo.config.viaSiegTransferencia) {
    return enviarNFeSiegTransferencia(dadosOdoo);
  }
  return modoEmissao() === 'sieg' ? enviarNFeViaSieg(dadosOdoo) : emitirNFePropria(dadosOdoo);
}

/**
 * Emitir NFS-e via SIEG (DPS)
 */
async function emitirNFSe(dadosOdoo) {
  const xml = gerarXmlDPS(dadosOdoo);
  console.log('[SIEG-API] Emitindo NFS-e DPS (' + xml.length + ' chars)');

  const headers = await getAuthHeaders();
  let resp;
  try {
    resp = await axios.post(SIEG_BASE + '/api/v1/send-xml', {
      Xml: Buffer.from(xml, 'utf-8').toString('base64'),
    }, { headers, timeout: 60000, validateStatus: function (s) { return s < 500; } });
  } catch (err) {
    console.error('[SIEG-API] Erro de conexao SIEG:', err.message);
    throw err;
  }

  const result = resp.data;
  const httpStatus = resp.status;
  console.log('[SIEG-API] Resposta send-xml NFS-e HTTP ' + httpStatus + ':', JSON.stringify(result).slice(0, 2000));

  if (httpStatus >= 400 && httpStatus < 500) {
    console.error('[SIEG-API] *** ERRO SIEG NFS-e HTTP ' + httpStatus + ' *** ' + (result.ErrorMessage || result.Message || ''));
  }

  return {
    sucesso: !!(result.IsSuccess === true),
    httpStatus: httpStatus,
    xmlEnviado: xml,
    resposta: result,
    data: result.Data || null,
    erro: result.ErrorMessage || result.Message || null,
    statusCode: result.StatusCode || null,
  };
}

/**
 * AJL 04/11/2026 — REMESSA DESTINADA A ARMAZENAGEM (CFOP 5905/6905):
 * DANFE com PESO BRUTO/LIQUIDO. O XML fiscal autorizado sai SEM <vol>
 * (builder: modFrete 9 => sem volumes, regra 845). A injecao abaixo vale
 * SOMENTE para o PDF de impressao — mesmo padrao da remonta manual da
 * NF 73487 (download/DANFE_NFe_00073487_com_peso_liquido.pdf); o XML fiscal
 * anexado na fatura permanece intocado. Peso = soma(qCom): TO x1000, KG x1.
 * Unidade diferente de TO/KG ou <vol> ja presente => nao injeta (nada inventado).
 */
function injetarVolArmazenagemPrint(xml) {
  try {
    if (!xml || /<vol>/.test(xml)) return xml;
    var natOp = (String(xml).match(/<natOp>([^<]*)<\/natOp>/) || [])[1] || '';
    if (!/armazenagem/i.test(natOp)) return xml;
    var transpPadrao = '<transp><modFrete>9</modFrete></transp>';
    if (xml.indexOf(transpPadrao) === -1) return xml;
    var dets = String(xml).match(/<det nItem="\d+">[\s\S]*?<\/det>/g) || [];
    if (!dets.length) return xml;
    var peso = 0;
    for (var i = 0; i < dets.length; i++) {
      var q = parseFloat((dets[i].match(/<qCom>([^<]*)<\/qCom>/) || [])[1] || '0');
      var u = ((dets[i].match(/<uCom>([^<]*)<\/uCom>/) || [])[1] || '').toUpperCase();
      if (!(q > 0)) return xml;
      if (u === 'TO') peso += q * 1000;
      else if (u === 'KG') peso += q;
      else return xml;
    }
    if (!(peso > 0)) return xml;
    var sNum = peso.toFixed(3).split('.');
    var ip = sNum[0], dp = sNum[1] || '000';
    var out = '';
    while (ip.length > 3) { out = '.' + ip.slice(-3) + out; ip = ip.slice(0, -3); }
    var sPeso = ip + out + ',' + dp; // pt-BR '2.920,000' (igual remonta 73487)
    console.log('[DANFE] [ARMAZENAGEM] <vol> injetado no XML de impressao: pesoL/pesoB=' + sPeso + ' kg (XML fiscal intocado)');
    return xml.replace(transpPadrao,
      '<transp><modFrete>9</modFrete><vol><pesoL>' + sPeso + '</pesoL><pesoB>' + sPeso + '</pesoB></vol></transp>');
  } catch (eVol) {
    console.warn('[DANFE] [ARMAZENAGEM] Falha ao injetar vol (PDF segue sem peso): ' + eVol.message);
    return xml;
  }
}

/**
 * DANFE (PDF) — local por padrao; SIEG apenas se NFE_DANFE_PROVIDER=sieg
 * @param {string} xmlAutorizado XML nfeProc autorizado
 * @param {Object} [opts] Opcoes adicionais para o DANFE
 * @param {string} [opts.saleOrderNumber] Numero do pedido de venda
 * @param {Array} [opts.boletoData] Dados do boleto [{nosso_numero, linha_digitavel, codigo_barras}]
 */
async function gerarDanfe(xmlAutorizado, opts) {
  if (String(process.env.NFE_DANFE_PROVIDER || 'local').toLowerCase() === 'sieg') {
    const headers = await getAuthHeaders();
    const resp = await axios.post(SIEG_BASE + '/api/v1/gerarDanfeViaXml', {
      Xml: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
    }, { headers, timeout: 30000 });
    return resp.data;
  }
  const pdf = await gerarDanfePdf(xmlAutorizado, opts);
  console.log('[DANFE] PDF gerado localmente (' + pdf.length + ' bytes)');
  return pdf.toString('base64');
}

/**
 * DANFSE (PDF) via SIEG
 */
async function gerarDanfse(xmlAutorizado) {
  const headers = await getAuthHeaders();
  const resp = await axios.post(SIEG_BASE + '/api/v1/gerarDanfseViaXml', {
    Xml: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
  }, { headers, timeout: 30000 });
  return resp.data;
}

/**
 * Emitir nota fiscal (auto-detect NF-e ou NFS-e)
 */
async function emitirNota(dadosOdoo) {
  let tipo = dadosOdoo.tipo;
  if (!tipo) {
    tipo = (dadosOdoo.service && dadosOdoo.lines && dadosOdoo.lines.every(function (l) { return l.detailed_type === 'service'; })) ? 'nfse' : 'nfe';
  }

  let resultado;
  if (tipo === 'nfse') {
    resultado = await emitirNFSe(dadosOdoo);
  } else {
    resultado = await enviarNFe(dadosOdoo);
  }
  resultado.tipo = tipo;

  // Se autorizado, gerar PDF
  if (resultado.sucesso && resultado.data) {
    try {
      let xmlAutorizado = resultado.data;
      if (typeof xmlAutorizado === 'string' && xmlAutorizado.length < 500 && xmlAutorizado.indexOf('<') === -1) {
        xmlAutorizado = Buffer.from(xmlAutorizado, 'base64').toString('utf-8');
      }
      resultado.pdfBase64 = tipo === 'nfse'
        ? await gerarDanfse(xmlAutorizado)
        : await gerarDanfe(injetarVolArmazenagemPrint(xmlAutorizado), {
            saleOrderNumber: (dadosOdoo.order && dadosOdoo.order.sale_order_number) || '',
            boletoData: dadosOdoo.boletoData || [],
          });
      resultado.pdfGerado = true;
    } catch (errPdf) {
      console.error('[SIEG-API] Erro ao gerar PDF (nota ainda pode estar autorizada):', errPdf.message);
      resultado.pdfGerado = false;
      resultado.pdfErro = errPdf.message;
    }
  }

  return resultado;
}

module.exports = {
  enviarNFe,
  emitirNFSe,
  emitirNFePropria,
  enviarNFeSiegTransferencia,
  baixarXmlsSieg,
  importarXmlSieg,
  gerarDanfe,
  gerarDanfse,
  emitirNota,
  injetarVolArmazenagemPrint,
};
