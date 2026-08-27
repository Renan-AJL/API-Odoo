/**
 * services/itau-boleto.js - v6.9.2
 * =============================================
 * Emissao de Boletos via Itau BoleCode API
 * FORMATO OFICIAL Itau (conforme JSON fornecido pelo banco)
 * FIX: CNPJ incluso no campo tipo_pessoa do pagador
 * FIX: Nosso numero com timestamp (nunca repete apos restart)
 * =============================================
 */
const { getAccessToken, invalidateToken } = require('./itau-auth');
const { callBolecode, callBolecodeGet } = require('./itau-api');
const config = require('../config');

/**
 * Gera nosso numero com 8 digitos usando timestamp (nunca repete)
 * Evita 422 "id de boleto ja existente" apos restart do Render
 */
function gerarNossoNumero(numeroPedido) {
  var ts = Date.now();
  var rnd = Math.floor(Math.random() * 10);
  var num = String(ts * 10 + rnd);
  var seq = num.substring(num.length - 8);
  console.log('[BOLETO] Nosso Numero gerado (timestamp):', seq);
  return seq;
}

/**
 * Converte valor para formato Itau (15 digitos, centavos)
 * Ex: 287.10 -> "000000000028710"
 */
function formatarValorItau(valor) {
  const num = Math.round(parseFloat(valor) * 100);
  return String(num).padStart(15, '0');
}

/**
 * Retorna data atual no formato YYYY-MM-DD (horario de Brasilia UTC-3)
 * Render usa UTC; Itau valida no horario do Brasil.
 * Se UTC ja virou o dia seguinte, subtrai 3h para ficar em Brasilia.
 */
function getDataHoje() {
  var d = new Date(Date.now() - 3 * 3600000); // UTC-3 (Brasilia)
  var ano = d.getUTCFullYear();
  var mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  var dia = String(d.getUTCDate()).padStart(2, '0');
  console.log('[BOLETO] Data emissao (Brasilia):', ano + '-' + mes + '-' + dia);
  return ano + '-' + mes + '-' + dia;
}

/**
 * Calcula data de vencimento (+dias a partir de hoje, horario Brasilia)
 */
function calcularDataVencimento(dias) {
  var d = new Date(Date.now() - 3 * 3600000); // UTC-3 (Brasilia)
  d.setUTCDate(d.getUTCDate() + dias);
  var ano = d.getUTCFullYear();
  var mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  var dia = String(d.getUTCDate()).padStart(2, '0');
  return ano + '-' + mes + '-' + dia;
}

/**
 * Monta payload no formato OFICIAL BoleCode Itau
 * Conforme JSON fornecido pelo banco em 26/05/2026
 */
function montaPayloadBolecode(dadosBoleto) {
  const idBeneficiario = config.banco.idBeneficiario || '776400223389';
  const codigoCarteira = config.banco.codigoCarteira || '109';
  const nossoNumero = dadosBoleto.nossoNumero || gerarNossoNumero(dadosBoleto.numeroPedido);

  // Data vencimento (se no passado, ajusta +30 dias)
  let dataVencimento = dadosBoleto.dataVencimento || calcularDataVencimento(30);
  if (dadosBoleto.dataVencimento) {
    const v = new Date(dadosBoleto.dataVencimento + 'T12:00:00');
    const hj = new Date();
    hj.setHours(0, 0, 0, 0);
    if (v <= hj) {
      console.log('[BOLETO] Data vencimento no passado, ajustando +30 dias');
      dataVencimento = calcularDataVencimento(30);
    }
  }

  // Etapa: Simulacao (homologacao) ou Efetivacao (producao)
  const etapa = dadosBoleto.etapa || 'Efetivacao';

  // Determina tipo pessoa (F ou J) baseado no CPF/CNPJ
  const cpfCnpj = dadosBoleto.cpfCnpjPagador || '';
  const tipoPessoa = cpfCnpj.length <= 11 ? 'F' : 'J';
  const campoPessoa = tipoPessoa === 'F' ? 'numero_cadastro_pessoa_fisica' : 'numero_cadastro_nacional_pessoa_juridica';

  // Monta objeto tipo_pessoa com codigo + numero cadastro (CPF ou CNPJ)
  const tipoPessoaObj = {
    codigo_tipo_pessoa: tipoPessoa
  };
  tipoPessoaObj[campoPessoa] = String(cpfCnpj).replace(/\D/g, '');

  const payload = {
    etapa_processo_boleto: etapa,
    beneficiario: {
      id_beneficiario: idBeneficiario
    },
    dado_boleto: {
      descricao_instrumento_cobranca: 'boleto_pix',
      tipo_boleto: 'a vista',
      texto_seu_numero: String(dadosBoleto.numeroPedido || '000001').substring(0, 10),
      codigo_carteira: dadosBoleto.codigoCarteira || codigoCarteira,
      codigo_especie: '01',
      data_emissao: getDataHoje(),
      valor_abatimento: '00000000000000000',
      pagador: {
        pessoa: {
          nome_pessoa: dadosBoleto.nomePagador || '',
          tipo_pessoa: tipoPessoaObj
        },
        endereco: {
          nome_logradouro: dadosBoleto.logradouro || 'Rua Nao Informada',
          nome_bairro: dadosBoleto.bairro || 'Nao Informado',
          nome_cidade: dadosBoleto.cidade || 'Nao Informado',
          sigla_UF: dadosBoleto.estado || 'SP',
          numero_CEP: String(dadosBoleto.cep || '00000000').replace(/\D/g, '')
        }
      },
      dados_individuais_boleto: [
        {
          numero_nosso_numero: nossoNumero,
          data_vencimento: dataVencimento,
          texto_uso_beneficiario: String(dadosBoleto.numeroPedido || '000001').substring(0, 25),
          valor_titulo: formatarValorItau(dadosBoleto.valor),
          texto_seu_numero: String(dadosBoleto.numeroPedido || '000001').substring(0, 10),
          data_limite_pagamento: dataVencimento
        }
      ]
    },
    dados_qrcode: {
      chave: config.itau.pixChave || dadosBoleto.chavePix || ''
    }
  };

  return payload;
}

/**
 * Emite um boleto via BoleCode API
 */
async function emitirBoleto(dadosBoleto) {
  console.log('[BOLETO] Iniciando emissao de boleto...');
  console.log('[BOLETO] Valor:', dadosBoleto.valor);
  console.log('[BOLETO] CPF/CNPJ pagador:', dadosBoleto.cpfCnpjPagador);
  console.log('[BOLETO] Pedido:', dadosBoleto.numeroPedido || 'N/A');

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.error('[BOLETO] Falha ao obter token:', err.message);
    throw new Error('Falha na autenticacao Itau: ' + err.message);
  }

  const payload = montaPayloadBolecode(dadosBoleto);
  console.log('[BOLETO] Emitindo boleto no Itau... etapa:', payload.etapa_processo_boleto);
  console.log('[BOLETO] Payload BoleCode:', JSON.stringify(payload, null, 2));

  try {
    const response = await callBolecode(accessToken, '/boletos_pix', payload);
    console.log('[BOLETO] Boleto emitido com sucesso!');
    console.log('[BOLETO] Resposta:', JSON.stringify(response, null, 2));
    return { sucesso: true, dados: response };
  } catch (error) {
    if (error.message && (error.message.includes('401') || error.message.includes('403'))) {
      console.log('[BOLETO] Token pode ter expirado, invalidando cache...');
      invalidateToken();
      try {
        accessToken = await getAccessToken();
        const response = await callBolecode(accessToken, '/boletos_pix', payload);
        console.log('[BOLETO] Boleto emitido com sucesso na 2a tentativa!');
        return { sucesso: true, dados: response };
      } catch (retryError) {
        console.error('[BOLETO] Falha na 2a tentativa:', retryError.message);
        throw retryError;
      }
    }
    console.error('[BOLETO] Erro ao processar pagamento:', error.message);
    throw error;
  }
}

async function consultarBoleto(txid) {
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    throw new Error('Falha na autenticacao Itau: ' + err.message);
  }
  try {
    const { callBolecode } = require('./itau-api');
    const response = await callBolecode(accessToken, '/boletos_pix/' + txid, {});
    return { sucesso: true, dados: response };
  } catch (error) {
    throw error;
  }
}

/**
 * Parse forma_pagamento string into installment plan
 * Retorna: { tipo: 'boleto'|'cartao'|'entrega'|'desconhecido', parcelas: [{ numero, dias, valor_pct }] }
 * Exemplos:
 *   "BOLETO 14/28/42"       -> 3 boletos (14, 28, 42 dias)
 *   "1 + 30 BOLETO"         -> 1 boleto (30 dias)
 *   "1 + boleto 30/60"      -> 2 boletos (30, 60 dias)
 *   "1+ 03 BOLETOS"         -> 3 boletos (30, 60, 90 dias)
 *   "BOLETO 10X"            -> 10 boletos (30d intervalo)
 *   "BOL 15/30/45/60/75/90"  -> 6 boletos (15,30,45,60,75,90 dias)
 *   "1+28/42/56/70"          -> 4 boletos (28,42,56,70 dias)
 *   "BOLETO 07DD"           -> 1 boleto (7 dias)
 */
function parseFormaPagamento(forma) {
  if (!forma) return { tipo: 'desconhecido', parcelas: [] };
  var upper = String(forma).toUpperCase().trim();

  // Detectar tipo de pagamento
  var isBoleto = upper.indexOf('BOLETO') >= 0 || upper.indexOf('BOL ') >= 0;
  var isCartao = upper.indexOf('AMEX') >= 0 || upper.indexOf('MASTER') >= 0 ||
                 upper.indexOf('CART') >= 0 || upper.indexOf('CREDIT') >= 0;
  var isEntrega = upper.indexOf('ENTREGA') >= 0 && !isBoleto;
  var hasSlash = upper.indexOf('/') >= 0;

  // Formas nao-boleto
  if (isEntrega && !hasSlash) return { tipo: 'entrega', parcelas: [] };
  if (isCartao && !isBoleto) return { tipo: 'cartao', parcelas: [] };

  // Pagamento misto (BOLETO + DIN + C.CRED etc) -> emitir 1 boleto
  if (isBoleto && (upper.indexOf('DIN') >= 0 || upper.indexOf('C.CRED') >= 0 || upper.indexOf('C.CARD') >= 0)) {
    return { tipo: 'boleto', parcelas: [{ numero: 1, dias: 30, valor_pct: 100 }] };
  }

  // Formas com "N+" prefixo (entrada + parcelas)
  var clean = upper.replace(/^\d+\s*\+\s*/, '');

  // Parser de dias via "/" (ex: "14/28/42", "30/60", "15/30/45")
  if (hasSlash) {
    var parts = clean.split('/');
    var days = [];
    for (var i = 0; i < parts.length; i++) {
      var nums = parts[i].match(/\d+/g);
      if (nums) days.push(parseInt(nums[nums.length - 1]));
    }
    if (days.length >= 1) {
      return {
        tipo: 'boleto',
        parcelas: days.map(function(d, i) {
          return { numero: i + 1, dias: d, valor_pct: 100 / days.length };
        })
      };
    }
  }

  // Limpar texto restante
  clean = clean.replace(/BOLETO/g, '').replace(/BOL/g, '').replace(/DD/g, '').replace(/\bD\b/g, '').trim();

  // Padrao contador: "N BOLETOS", "NX", "N VEZES"
  var countMatch = clean.match(/(\d+)\s*(?:BOLETOS|X\b|VEZES)/);
  if (countMatch) {
    var n = parseInt(countMatch[1]);
    if (n > 0) {
      var parcelas = [];
      for (var i = 0; i < n; i++) {
        parcelas.push({ numero: i + 1, dias: (i + 1) * 30, valor_pct: 100 / n });
      }
      return { tipo: 'boleto', parcelas: parcelas };
    }
  }

  // Dia unico (ex: "30 BOLETO", "07DD", "21D")
  var singleMatch = clean.match(/(\d+)/);
  if (singleMatch) {
    var d = parseInt(singleMatch[1]);
    if (d > 0 && d <= 365) {
      return { tipo: 'boleto', parcelas: [{ numero: 1, dias: d, valor_pct: 100 }] };
    }
  }

  // Padrao boleto padrao: 1 boleto 30 dias
  if (isBoleto) return { tipo: 'boleto', parcelas: [{ numero: 1, dias: 30, valor_pct: 100 }] };

  return { tipo: 'desconhecido', parcelas: [] };
}

/**
 * Consulta boleto por nosso_numero no BoleCode Itau
 * Quando o middleware reinicia (Render sleep), a memoria e zerada.
 * Esta funcao consulta o Itaú diretamente para recuperar os dados do boleto.
 */
async function consultarBoletoPorNossoNumero(nossoNumero, beneficiaryId) {
  console.log('[BOLETO] Consultando boleto por nosso_numero:', nossoNumero);
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    throw new Error('Falha na autenticacao Itau: ' + err.message);
  }
  try {
    var endpoint = '/boletos_pix?beneficiario=' + (beneficiaryId || config.banco.idBeneficiario || '776400223389') + '&nosso_numero=' + nossoNumero;
    var response = await callBolecodeGet(accessToken, endpoint);
    console.log('[BOLETO] Boleto encontrado por nosso_numero:', JSON.stringify(response).substring(0, 500));
    return { sucesso: true, dados: response };
  } catch (error) {
    console.error('[BOLETO] Erro ao consultar por nosso_numero:', error.message);
    throw error;
  }
}

module.exports = { emitirBoleto, consultarBoleto, consultarBoletoPorNossoNumero, montaPayloadBolecode, parseFormaPagamento };
