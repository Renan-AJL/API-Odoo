// ============================================
// SERVICO DE PROCESSAMENTO DE PAGAMENTO v5.0
// ============================================
// Roteador inteligente - interpreta o nome do
// metodo e processa automaticamente.
// v5: Chama API real quando MOCK_MODE=false

const logger = require('../utils/logger');
const dayjs = require('dayjs');
const boletoService = require('./itau-boleto');
const pixService = require('./itau-pix');
const mockService = require('./mock-itau');
const config = require('../config');

const BANDEIRAS = ['VISA', 'MASTER', 'ELO', 'AMEX', 'HIPERCARD', 'HIPER'];

const MANUAIS = [
  'DINHEIRO', 'CHEQUE', 'DEPOSITO SANTANDER', 'DEPOSITO ITAU',
  'DEPOSITO ITAÚ', 'CRÉDITO DE COMPRA', 'CREDITO DE COMPRA',
  'CRÉDITO DE COMPRA', 'TRANSFERENCIA ITAU', 'TRANSFERÊNCIA ITAU',
  'DEPOSITO', 'TRANSFERENCIA', 'TRANSFERÊNCIA',
];

// =============================================
// PARSER INTELIGENTE
// =============================================

function parseMethod(nome) {
  var n = nome.trim().toUpperCase();

  if (/^1\s*\+\s*\d+\s*(BOLETO|BOL|CHEQUE)/.test(n) ||
      /^1\s*\+\s*\d+\s*BOLETOS/.test(n) ||
      /^ENTRADA\s*\+/.test(n) || /^DINHEIRO\s*\+/.test(n) || /DIN\s*\+/.test(n)) {
    return parseComposto(n);
  }

  for (var i = 0; i < BANDEIRAS.length; i++) {
    var b = BANDEIRAS[i];
    if (n.indexOf(b) === 0 || n.indexOf(b + ' ') === 0) return parseCartao(n, b);
  }

  if (n.indexOf('BOLETO') === 0 || n.indexOf('BOL ') === 0 || n.indexOf('BOL.') === 0) return parseBoleto(n);
  if (n.indexOf('CHEQUE') === 0 || n.indexOf('CHEQ') === 0) return { tipo: 'manual', forma: nome, manual_tipo: 'cheque' };
  if (n.indexOf('PIX') === 0) return { tipo: 'pix' };

  for (var j = 0; j < MANUAIS.length; j++) {
    if (n.indexOf(MANUAIS[j]) === 0) return { tipo: 'manual', forma: nome, manual_tipo: MANUAIS[j] };
  }

  if (n.indexOf('BOLETO') >= 0) return parseBoleto(n);
  if (n.indexOf('CHEQUE') >= 0) return { tipo: 'manual', forma: nome, manual_tipo: 'cheque' };
  return { tipo: 'manual', forma: nome, manual_tipo: 'desconhecido' };
}

function parseCartao(n, bandeira) {
  var debito = n.indexOf('DÉBITO') >= 0 || n.indexOf('DEBITO') >= 0 || n.indexOf('DEB') >= 0;
  var parcelas = 1;
  var match = n.match(/(\d+)\s*(VEZES|X|VEZ)/);
  if (match) { parcelas = parseInt(match[1]); }
  return { tipo: 'cartao', bandeira: bandeira, parcelas: parcelas, debito: debito };
}

function parseBoleto(n) {
  var slashMatch = n.match(/(\d+(?:\s*\/\s*\d+)+)/);
  if (slashMatch) {
    var dias = slashMatch[1].split('/').map(function(d) { return parseInt(d.trim()); });
    return { tipo: 'boleto_parcelado', dias: dias };
  }
  var xMatch = n.match(/(\d+)\s*X/);
  if (xMatch) {
    var num = parseInt(xMatch[1]);
    var dias = [];
    for (var i = 0; i < num; i++) dias.push(30 * (i + 1));
    return { tipo: 'boleto_parcelado', dias: dias };
  }
  var dMatch = n.match(/(\d+)\s*D/);
  if (dMatch) return { tipo: 'boleto', dias: [parseInt(dMatch[1])] };
  return { tipo: 'boleto', dias: [30] };
}

function parseComposto(n) {
  var boletoMatch = n.match(/(\d+)\s*BOLETO/);
  if (boletoMatch) return { tipo: 'composto', entrada_tipo: 'pix', restante_tipo: 'boleto', dias_restante: [parseInt(boletoMatch[1])] };
  var boletosMatch = n.match(/(\d+)\s*BOLETOS/);
  if (boletosMatch) {
    var num = parseInt(boletosMatch[1]);
    var dias = [];
    for (var i = 0; i < num; i++) dias.push(30 * (i + 1));
    return { tipo: 'composto', entrada_tipo: 'pix', restante_tipo: 'boleto_parcelado', dias_restante: dias };
  }
  return { tipo: 'composto', entrada_tipo: 'pix', restante_tipo: 'manual' };
}

// =============================================
// PROCESSADOR PRINCIPAL v5.0
// =============================================

var MID_URL = process.env.MID_URL || config.midUrl || 'https://itau-odoo.onrender.com';

async function processarPagamento(formaPagamento, dados) {
  if (!formaPagamento) throw { status: 400, message: 'forma_pagamento obrigatoria' };

  var parsed = parseMethod(formaPagamento);
  logger.info('[v5.0] Processando: "' + formaPagamento + '" -> tipo: ' + parsed.tipo +
    ' | Mock: ' + (config.mockMode ? 'SIM' : 'NAO'));

  if (config.mockMode) {
    return mockService.gerarResposta(formaPagamento, parsed, dados);
  }

  var resultado = {
    forma_pagamento: formaPagamento,
    tipo: parsed.tipo,
    mock: false,
    valor_total: dados.fatura.valor_nominal,
    pagamentos: [],
    situacao: 'emitido',
  };

  switch (parsed.tipo) {
    case 'pix':     return await _pix(parsed, dados, resultado);
    case 'boleto':  return await _boleto(parsed, dados, resultado);
    case 'boleto_parcelado': return await _boletoParcelado(parsed, dados, resultado);
    case 'cartao':  return await _cartao(parsed, dados, resultado);
    case 'composto': return await _composto(parsed, dados, resultado);
    case 'manual':  return await _manual(parsed, dados, resultado);
    default:        return await _manual(parsed, dados, resultado);
  }
}

// =============================================
// PROCESSADORES POR TIPO (API REAL)
// =============================================

async function _pix(parsed, dados, resultado) {
  var pixDados = {
    valor: dados.fatura.valor_nominal,
    chave: dados.fatura.pix_chave || config.itau.pixChave,
    devedor: dados.pagador,
    expiracao: dados.fatura.expiracao || 3600,
    solicitacaoPagador: dados.fatura.name || dados.fatura.seu_numero || '',
  };
  var pix = await pixService.criarCobrancaPix(pixDados);
  resultado.pagamentos.push({
    parcela: 1, tipo: 'pix',
    txid: pix.txid, pix_copia_cola: pix.pixCopiaECola,
    valor: dados.fatura.valor_nominal,
  });
  return resultado;
}

async function _boleto(parsed, dados, resultado) {
  var dias = parsed.dias || [30];
  var vencimento = dayjs().add(dias[0], 'day').format('YYYY-MM-DD');
  if (dados.fatura.data_vencimento) vencimento = dados.fatura.data_vencimento;

  var bd = Object.assign({}, dados, {
    fatura: Object.assign({}, dados.fatura, { data_vencimento: vencimento }),
  });
  var boleto = await boletoService.emitirBoleto(bd);

  var pg = {
    parcela: 1, tipo: 'boleto',
    nosso_numero: boleto.nosso_numero,
    codigo_barras: boleto.codigo_barras,
    linha_digitavel: boleto.linha_digitavel,
    valor: dados.fatura.valor_nominal,
    vencimento: vencimento,
  };
  var bId = boleto.codigo_barras || boleto.nosso_numero;
  if (bId) pg.url_pdf = MID_URL + '/boleto/' + bId + '/pdf';
  resultado.pagamentos.push(pg);
  return resultado;
}

async function _boletoParcelado(parsed, dados, resultado) {
  var dias = parsed.dias || [30];
  var n = dias.length;
  var vt = dados.fatura.valor_nominal;
  var vp = Math.floor((vt / n) * 100) / 100;
  var vu = Math.round((vt - vp * (n - 1)) * 100) / 100;
  resultado.parcelas = n;

  for (var i = 0; i < n; i++) {
    var valor = (i === n - 1) ? vu : vp;
    var venc = dayjs().add(dias[i], 'day').format('YYYY-MM-DD');
    var bd = Object.assign({}, dados, {
      fatura: Object.assign({}, dados.fatura, {
        valor_nominal: valor, data_vencimento: venc,
        nosso_numero: (dados.fatura.nosso_numero || '') + String(i + 1).padStart(2, '0'),
        seu_numero: (dados.fatura.seu_numero || dados.fatura.name || '') + '/' + (i + 1) + '/' + n,
        instrucao1: 'Parcela ' + (i + 1) + ' de ' + n,
      }),
    });
    try {
      var boleto = await boletoService.emitirBoleto(bd);
      var pg = {
        parcela: i + 1, total_parcelas: n, tipo: 'boleto',
        nosso_numero: boleto.nosso_numero,
        codigo_barras: boleto.codigo_barras,
        linha_digitavel: boleto.linha_digitavel,
        valor: valor, vencimento: venc, dias: dias[i],
      };
      var bId = boleto.codigo_barras || boleto.nosso_numero;
      if (bId) pg.url_pdf = MID_URL + '/boleto/' + bId + '/pdf';
      resultado.pagamentos.push(pg);
    } catch (err) {
      resultado.pagamentos.push({ parcela: i + 1, total_parcelas: n, tipo: 'boleto', erro: err.message, valor: valor, vencimento: venc });
      resultado.situacao = 'parcial';
    }
  }
  return resultado;
}

async function _cartao(parsed, dados, resultado) {
  // v5: Cartao ainda requer configuracao da Rede (futuro)
  // Por enquanto, retorna aviso que precisa configurar
  resultado.situacao = 'nao_configurado';
  resultado.pagamentos.push({
    parcela: 1,
    tipo: parsed.debito ? 'cartao_debito' : 'cartao_credito',
    bandeira: parsed.bandeira,
    valor: dados.fatura.valor_nominal,
    parcelas: parsed.parcelas,
    debito: !!parsed.debito,
    observacao: 'Cartao requer configuracao da Rede Itau (REDE_CLIENT_ID + REDE_CLIENT_SECRET)',
  });
  return resultado;
}

async function _composto(parsed, dados, resultado) {
  var vt = dados.fatura.valor_nominal;
  var pctEntrada = dados.pct_entrada || 0.3;
  var ve = dados.valor_entrada || Math.round(vt * pctEntrada * 100) / 100;
  var vr = Math.round((vt - ve) * 100) / 100;
  resultado.valor_entrada = ve;
  resultado.valor_restante = vr;

  // Entrada via PIX
  try {
    var pixDados = {
      valor: ve,
      chave: config.itau.pixChave,
      devedor: dados.pagador,
      expiracao: 3600,
      solicitacaoPagador: (dados.fatura.name || '') + ' - Entrada',
    };
    var pix = await pixService.criarCobrancaPix(pixDados);
    resultado.pagamentos.push({
      parcela: 'entrada', tipo: 'pix',
      txid: pix.txid, pix_copia_cola: pix.pixCopiaECola,
      valor: ve,
    });
  } catch (err) {
    resultado.pagamentos.push({ parcela: 'entrada', tipo: 'pix', erro: err.message, valor: ve });
    resultado.situacao = 'parcial';
  }

  // Restante
  if (parsed.restante_tipo === 'boleto' || parsed.restante_tipo === 'boleto_parcelado') {
    var dias = parsed.dias_restante || [30];
    var n = dias.length;
    var vpr = Math.floor((vr / n) * 100) / 100;
    var vur = Math.round((vr - vpr * (n - 1)) * 100) / 100;
    resultado.parcelas_restante = n;
    for (var i = 0; i < n; i++) {
      var valor = (i === n - 1) ? vur : vpr;
      var venc = dayjs().add(dias[i], 'day').format('YYYY-MM-DD');
      var bd = Object.assign({}, dados, {
        fatura: Object.assign({}, dados.fatura, {
          valor_nominal: valor, data_vencimento: venc,
          nosso_numero: (dados.fatura.nosso_numero || '') + 'R' + String(i + 1).padStart(2, '0'),
          seu_numero: (dados.fatura.seu_numero || dados.fatura.name || '') + ' - Restante ' + (i + 1) + '/' + n,
          instrucao1: 'Entrada de ' + ve.toFixed(2) + ' via PIX. Restante: ' + vr.toFixed(2),
        }),
      });
      try {
        var boleto = await boletoService.emitirBoleto(bd);
        var pg = {
          parcela: 'restante_' + (i + 1), total_parcelas: n, tipo: 'boleto',
          nosso_numero: boleto.nosso_numero,
          codigo_barras: boleto.codigo_barras,
          linha_digitavel: boleto.linha_digitavel,
          valor: valor, vencimento: venc,
        };
        var bId = boleto.codigo_barras || boleto.nosso_numero;
        if (bId) pg.url_pdf = MID_URL + '/boleto/' + bId + '/pdf';
        resultado.pagamentos.push(pg);
      } catch (err) {
        resultado.pagamentos.push({ parcela: 'restante_' + (i + 1), tipo: 'boleto', erro: err.message, valor: valor, vencimento: venc });
        resultado.situacao = 'parcial';
      }
    }
  } else {
    resultado.pagamentos.push({
      parcela: 'restante', tipo: 'manual', forma: parsed.restante_tipo || 'manual',
      valor: vr, observacao: 'Registrar manualmente no Odoo',
    });
  }

  return resultado;
}

async function _manual(parsed, dados, resultado) {
  resultado.situacao = 'manual';
  resultado.pagamentos.push({
    parcela: 1, tipo: 'manual',
    forma: parsed.forma || parsed.manual_tipo || 'Desconhecido',
    valor: dados.fatura.valor_nominal,
    observacao: 'Pagamento em ' + (parsed.forma || 'manual') + ' - registrar manualmente no Odoo',
  });
  return resultado;
}

// =============================================
// HELPERS
// =============================================

function listarMetodos() {
  return {
    info: 'O middleware aceita qualquer metodo de pagamento. Envie a forma_pagamento e o sistema processa automaticamente.',
    categorias: {
      cartao: 'Cartao de Credito/Debito (VISA, MASTER, ELO, AMEX, HIPERCARD) -> Link de Pagamento Itau',
      boleto: 'Boleto a Vista ou Parcelado (ex: BOLETO 30D, BOLETO 30/60/90) -> API Boletos Itau',
      pix: 'PIX -> API PIX Itau',
      composto: 'Entrada + Restante (ex: 1 + 30 BOLETO) -> PIX + API Boletos',
      manual: 'Dinheiro, Cheque, Deposito, Credito de Compra -> Sem API',
    },
    exemplos: [
      'BOLETO 30D', 'BOLETO 30/60/90', 'BOLETO 28/42/56', 'BOLETO 8X',
      'VISA CREDITO', 'VISA 3 VEZES', 'VISA DÉBITO',
      'MASTER CREDITO', 'MASTER 2 VEZES',
      'ELO CREDITO', 'ELO 3 VEZES',
      'DINHEIRO', 'CHEQUE', 'DEPOSITO ITAÚ',
      'CRÉDITO DE COMPRA', '1 + 30 BOLETO', 'PIX',
    ],
  };
}

module.exports = {
  processarPagamento: processarPagamento,
  parseMethod: parseMethod,
  listarMetodos: listarMetodos,
};
