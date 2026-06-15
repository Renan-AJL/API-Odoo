// ============================================
// SERVICO MOCK v5.0 - RESPOSTAS SIMULADAS
// ============================================
// Gera respostas realistas para qualquer metodo
// sem depender do Sandbox Itau
// v5: url_pdf em vez de base64

var uuid = require('uuid');
var dayjs = require('dayjs');

var MID_URL = process.env.MID_URL || 'https://itau-odoo.onrender.com';

function gerarResposta(formaPagamento, parsed, dados) {
  var vt = (dados.fatura && dados.fatura.valor_nominal) || 0;
  var resultado = {
    forma_pagamento: formaPagamento,
    tipo: parsed.tipo,
    mock: true,
    valor_total: vt,
    pagamentos: [],
    situacao: 'emitido',
    aviso: 'RESPOSTA SIMULADA (MOCK MODE) - dados nao reais',
  };

  switch (parsed.tipo) {
    case 'pix':
      resultado.pagamentos.push(_pix(dados, vt, 1));
      break;
    case 'boleto':
      resultado.pagamentos.push(_boleto(dados, vt, (parsed.dias || [30])[0], 1, 1));
      break;
    case 'boleto_parcelado':
      var dias = parsed.dias || [30, 60, 90];
      var n = dias.length;
      var vp = Math.floor((vt / n) * 100) / 100;
      var vu = Math.round((vt - vp * (n - 1)) * 100) / 100;
      resultado.parcelas = n;
      for (var i = 0; i < n; i++) {
        resultado.pagamentos.push(_boleto(dados, (i === n - 1) ? vu : vp, dias[i], i + 1, n));
      }
      break;
    case 'cartao':
      resultado.bandeira = parsed.bandeira;
      resultado.parcelas = parsed.parcelas;
      resultado.pagamentos.push(_cartao(dados, vt, parsed));
      break;
    case 'composto':
      resultado.valor_entrada = dados.valor_entrada || Math.round(vt * 0.3 * 100) / 100;
      resultado.valor_restante = Math.round((vt - resultado.valor_entrada) * 100) / 100;
      resultado.pagamentos.push(_pix(dados, resultado.valor_entrada, 'entrada'));
      if (parsed.restante_tipo === 'boleto' || parsed.restante_tipo === 'boleto_parcelado') {
        var rdias = parsed.dias_restante || [30];
        var rn = rdias.length;
        var rvp = Math.floor((resultado.valor_restante / rn) * 100) / 100;
        var rvu = Math.round((resultado.valor_restante - rvp * (rn - 1)) * 100) / 100;
        resultado.parcelas_restante = rn;
        for (var j = 0; j < rn; j++) {
          resultado.pagamentos.push(_boleto(dados, (j === rn - 1) ? rvu : rvp, rdias[j], 'restante_' + (j + 1), rn));
        }
      } else if (parsed.restante_tipo === 'cartao') {
        resultado.pagamentos.push(_cartao(dados, resultado.valor_restante, { bandeira: 'VISA', parcelas: 1, debito: false }));
      } else {
        resultado.pagamentos.push({
          parcela: 'restante', tipo: 'manual', forma: 'manual',
          valor: resultado.valor_restante, observacao: 'Registrar manualmente',
        });
      }
      break;
    case 'manual':
    default:
      resultado.situacao = 'manual';
      resultado.pagamentos.push({
        parcela: 1, tipo: 'manual', forma: parsed.forma || formaPagamento,
        valor: vt, observacao: 'Pagamento em ' + (parsed.forma || 'manual') + ' - registrar no Odoo',
      });
      break;
  }

  return resultado;
}

function _pix(dados, valor, parcela) {
  var txid = 'txid_mock_' + uuid.v4().replace(/-/g, '').substring(0, 20);
  var ref = (dados.fatura && dados.fatura.name) || 'PIX';
  if (typeof parcela === 'string') ref = ref + ' - ' + parcela;
  return {
    parcela: parcela, tipo: 'pix', txid: txid,
    pix_copia_cola: '00020126580014br.gov.bcb.pix0136' + txid +
      '5204000053039865802BR5925AJL FERRO E ACO6009CURITIBA62070503***6304' +
      Math.floor(Math.random() * 9999),
    valor: valor,
    vencimento: dayjs().add(1, 'hour').toISOString(),
  };
}

function _boleto(dados, valor, dias, parcela, total) {
  var venc = dayjs().add(dias, 'day').format('YYYY-MM-DD');
  var ts = Date.now().toString();
  var plabel = 'Boleto';
  if (total > 1) plabel = 'Parcela ' + parcela + '/' + total;
  if (typeof parcela === 'string' && parcela.indexOf('restante') === 0) plabel = 'Boleto Restante';
  var nn = String(typeof parcela === 'number' ? parcela : 0).padStart(2, '0');
  var nnum = '000' + nn + ts.slice(-6);
  var cb = '34191' + nn + '9' + ts.slice(-5) + '0217519381000000' + valor.toFixed(2).replace('.', '');
  var ld = '34190' + nn + '5' + nnum.substring(0, 5) + ' 4' + nnum.substring(5) + ' ' +
    venc.replace(/-/g, '').substring(2) + ' 1' + ts.slice(-7) + ' ' + cb.slice(-14);
  return {
    parcela: parcela, total_parcelas: total, tipo: 'boleto',
    nosso_numero: nnum, codigo_barras: cb, linha_digitavel: ld,
    valor: valor, vencimento: venc, dias: dias,
    url_pdf: MID_URL + '/boleto/' + nnum + '/pdf',
  };
}

function _cartao(dados, valor, parsed) {
  return {
    parcela: 1,
    tipo: parsed.debito ? 'cartao_debito' : 'cartao_credito',
    bandeira: parsed.bandeira || 'VISA',
    id_link: 'link_mock_' + uuid.v4().replace(/-/g, '').substring(0, 15),
    url_link: 'https://shopline.itau.com.br/payment/mock/' + uuid.v4().replace(/-/g, ''),
    valor: valor, parcelas: parsed.parcelas || 1, debito: !!parsed.debito,
  };
}

module.exports = { gerarResposta: gerarResposta };
