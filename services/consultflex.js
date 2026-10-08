/**
 * services/consultflex.js — ConsultFlex API Integration
 * ====================================================
 * Consulta crédito PJ/PF via ConsultFlex Webservice.
 * URL: https://api.consultflex.com.br/json/service.aspx
 *
 * Produtos (CodigoProduto):
 *   Básico:        1760 (PF) / 1761 (PJ)
 *   Crédito Total: 1762 (PF) / 1763 (PJ)
 *
 * Versao: 20180521
 */
var https = require('https');
var config = require('../config');

var API_URL = 'https://api.consultflex.com.br/json/service.aspx';
// Crédito Básico
var PRODUTO_BASICO_PJ = '1761';
var PRODUTO_BASICO_PF = '1760';
// Crédito Total
var PRODUTO_CREDITO_TOTAL_PJ = '1763';
var PRODUTO_CREDITO_TOTAL_PF = '1762';

var VERSAO = '20180521';

/**
 * Consulta CPF ou CNPJ na ConsultFlex
 * @param {Object} opts
 * @param {string} opts.cpfcnpj - CPF (11 digitos) ou CNPJ (14 digitos), somente números
 * @param {string} [opts.tipoPessoa] - 'J' (PJ/CNPJ) ou 'F' (PF/CPF). Auto-detectado se vazio.
 * @param {string} [opts.tipoOperacao] - 'basico' (padrão) ou 'credito_total'
 * @param {string} [opts.solicitante] - CNPJ do cliente final (opcional)
 * @returns {Promise<Object>} Resposta completa da ConsultFlex
 */
async function consultarCredito(opts) {
  var cpfcnpj = String(opts.cpfcnpj || '').replace(/\D/g, '');
  if (!cpfcnpj) throw new Error('CPF/CNPJ não informado');

  var tipoPessoa = opts.tipoPessoa || (cpfcnpj.length <= 11 ? 'F' : 'J');
  var tipoOperacao = opts.tipoOperacao || 'basico'; // 'basico' ou 'credito_total'
  var chaveAcesso = config.consultflex && config.consultflex.apiKey || process.env.CONSULTFLEX_API_KEY || '';
  if (!chaveAcesso) throw new Error('ConsultFlex API Key não configurada (CONSULTFLEX_API_KEY)');

  // Selecionar produto conforme tipo de operação e pessoa
  var codigoProduto;
  if (tipoOperacao === 'credito_total') {
    codigoProduto = tipoPessoa === 'F' ? PRODUTO_CREDITO_TOTAL_PF : PRODUTO_CREDITO_TOTAL_PJ;
  } else {
    codigoProduto = tipoPessoa === 'F' ? PRODUTO_BASICO_PF : PRODUTO_BASICO_PJ;
  }

  var payload = {
    CodigoProduto: codigoProduto,
    Versao: VERSAO,
    ChaveAcesso: chaveAcesso,
    Info: {},
    Parametros: {
      TipoPessoa: tipoPessoa,
      CPFCNPJ: cpfcnpj
    },
    WebHook: { UrlCallBack: '' }
  };

  if (opts.solicitante) {
    payload.Info.Solicitante = opts.solicitante;
  }

  console.log('[CONSULTFLEX] Consultando %s: %s (produto=%s, tipo=%s)', tipoPessoa === 'J' ? 'CNPJ' : 'CPF', cpfcnpj, codigoProduto, tipoOperacao);

  var result = await postJson(API_URL, payload);
  return result;
}

/**
 * Formata a resposta da ConsultFlex em HTML para exibição no Odoo
 * @param {Object} resp - Resposta JSON da ConsultFlex
 * @returns {string} HTML formatado
 */
function formatarRespostaHtml(resp) {
  if (!resp) return '<p style="color:red">Sem resposta da ConsultFlex</p>';

  var header = (resp.HEADER && resp.HEADER.INFORMACOES_RETORNO) || {};
  var status = (header.STATUS_RETORNO || {});
  var html = '';

  // Status header
  if (status.CODIGO === '1') {
    html += '<div style="background:#d4edda;padding:8px;border-radius:4px;margin-bottom:8px"><b>Consulta concluída com sucesso</b>';
    html += ' — ' + (header.DATA_HORA_CONSULTA || '') + '</div>';
  } else {
    html += '<div style="background:#f8d7da;padding:8px;border-radius:4px;margin-bottom:8px"><b>Erro:</b> ' + (status.DESCRICAO || 'Desconhecido') + '</div>';
    return html;
  }

  var cred = resp.CREDCADASTRAL || {};

  // Dados Receita Federal
  var rf = cred.DADOS_RECEITA_FEDERAL || {};
  if (rf && rf.NOME) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Dados Receita Federal</th></tr>';
    html += tr('Nome/Razão Social', rf.NOME || rf.RAZAO_SOCIAL || '-');
    html += tr('Situação', rf.SITUACAO_RECEITA || '-');
    html += tr('Data Nascimento/Fundação', rf.DATA_NASCIMENTO_FUNDACAO || '-');
    html += tr('Nome Mãe', rf.NOME_MAE || '-');
    html += tr('Atividade Principal', rf.ATIVIDADE_ECONOMICA_PRINCIPAL || '-');
    html += tr('Natureza Jurídica', rf.NATUREZA_JURIDICA || '-');
    html += '</table>';
  }

  // Endereço
  var end = cred.ENDERECO || {};
  if (end && end.ENDERECO) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Endereço</th></tr>';
    html += tr('Endereço', end.ENDERECO || '-');
    html += tr('Bairro', end.BAIRRO || '-');
    html += tr('Cidade/UF', (end.CIDADE || '-') + '/' + (end.UF || '-'));
    html += tr('CEP', end.CEP || '-');
    html += '</table>';
  }

  // Pendências Financeiras
  var pf = cred.PEND_FINANCEIRAS || {};
  if (pf && pf.OCORRENCIAS && pf.OCORRENCIAS.length > 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
    html += '<tr style="background:#C00000;color:white"><th colspan="4" style="padding:6px">Pendências Financeiras (' + pf.QUANTIDADE_OCORRENCIA + ')</th></tr>';
    html += '<tr style="background:#f2f2f2"><th style="padding:4px">Vencimento</th><th style="padding:4px">Credor</th><th style="padding:4px">Valor</th><th style="padding:4px">Modalidade</th></tr>';
    for (var i = 0; i < Math.min(pf.OCORRENCIAS.length, 20); i++) {
      var o = pf.OCORRENCIAS[i];
      html += '<tr><td style="padding:4px">' + (o.DATA_VENCIMENTO || '-') + '</td><td style="padding:4px">' + (o.CREDOR || '-') + '</td><td style="padding:4px">' + (o.MOEDA || '') + ' ' + (o.VALOR || '-') + '</td><td style="padding:4px">' + (o.MODALIDADE || '-') + '</td></tr>';
    }
    html += '</table>';
  }

  // Quadro Societário
  var qs = cred.QUADRO_SOCIETARIO || {};
  if (qs && qs.OCORRENCIAS && qs.OCORRENCIAS.length > 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
    html += '<tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Quadro Societário (' + qs.QUANTIDADE_OCORRENCIAS + ')</th></tr>';
    html += '<tr style="background:#f2f2f2"><th style="padding:4px">Nome</th><th style="padding:4px">CPF/CNPJ</th><th style="padding:4px">Participação</th><th style="padding:4px">Cargo</th></tr>';
    for (var i = 0; i < qs.OCORRENCIAS.length; i++) {
      var s = qs.OCORRENCIAS[i];
      html += '<tr><td style="padding:4px">' + (s.NOME || '-') + '</td><td style="padding:4px">' + (s.CPF_CNPJ || '-') + '</td><td style="padding:4px">' + (s.PERCENTUAL_PARTICIPACAO || '-') + '%</td><td style="padding:4px">' + (s.CARGO || '-') + '</td></tr>';
    }
    html += '</table>';
  }

  // Protestos
  var prot = cred.PROTESTO || {};
  if (prot && prot.OCORRENCIAS && prot.OCORRENCIAS.length > 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
    html += '<tr style="background:#C00000;color:white"><th colspan="3" style="padding:6px">Protestos</th></tr>';
    for (var i = 0; i < prot.OCORRENCIAS.length; i++) {
      var p = prot.OCORRENCIAS[i];
      html += '<tr><td style="padding:4px">' + (p.DATA_PROTESTO || '-') + '</td><td style="padding:4px">' + (p.VALOR || '-') + '</td><td style="padding:4px">' + (p.CARTORIO || '-') + '</td></tr>';
    }
    html += '</table>';
  }

  // Informações/Alertas/Restrições
  var info = cred.INFORMACOES_ALERTAS_RESTRICOES || {};
  if (info && info.OCORRENCIAS && info.OCORRENCIAS.length > 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
    html += '<tr style="background:#ED7D31;color:white"><th colspan="3" style="padding:6px">Informações / Alertas / Restrições (' + info.QUANTIDADE_OCORRENCIA + ')</th></tr>';
    for (var i = 0; i < info.OCORRENCIAS.length; i++) {
      var a = info.OCORRENCIAS[i];
      html += '<tr><td style="padding:4px"><b>' + (a.TITULO || '-') + '</b></td><td style="padding:4px">' + (a.DESCRICAO_TIPO_INFORMACAO || '-') + '</td><td style="padding:4px">' + (a.OBSERVACOES || '-') + '</td></tr>';
    }
    html += '</table>';
  }

  // Cheques sem fundos (CCF)
  var ccf = cred.CHEQUES_SEM_FUNDO || {};
  if (ccf && ccf.QUANTIDADE && ccf.QUANTIDADE !== '0') {
    html += '<div style="background:#f8d7da;padding:8px;border-radius:4px;margin-bottom:8px"><b>⚠ Cheques sem fundo:</b> ' + ccf.QUANTIDADE + '</div>';
  }

  // Contumácia
  var cont = cred.CONTUMACIA || {};
  if (cont && cont.QUANTIDADE_OCORRENCIA && cont.QUANTIDADE_OCORRENCIA !== '0') {
    html += '<div style="background:#fff3cd;padding:8px;border-radius:4px;margin-bottom:8px"><b>⚠ Contumácia:</b> ' + cont.QUANTIDADE_OCORRENCIA + ' ocorrência(s)</div>';
  }

  // ===== Campos extras do Crédito Total =====

  // Score / Pontuação
  var score = cred.SCORE || cred.PONTUACAO || {};
  if (score && (score.VALOR || score.PONTUACAO || score.SCORE)) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Score / Pontuação</th></tr>';
    html += tr('Score', score.VALOR || score.PONTUACAO || score.SCORE || '-');
    if (score.DESCRICAO || score.CLASSIFICACAO) html += tr('Classificação', score.DESCRICAO || score.CLASSIFICACAO || '-');
    if (score.FAIXA) html += tr('Faixa', score.FAIXA || '-');
    html += '</table>';
  }

  // Limite de Crédito
  var limite = cred.LIMITE_CREDITO || {};
  if (limite && (limite.VALOR || limite.LIMITE || limite.TOTAL)) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#548235;color:white"><th colspan="4" style="padding:6px">Limite de Crédito</th></tr>';
    html += tr('Valor', (limite.MOEDA || 'R$') + ' ' + (limite.VALOR || limite.LIMITE || limite.TOTAL || '-'));
    if (limite.FONTE) html += tr('Fonte', limite.FONTE || '-');
    if (limite.DATA_CONSULTA) html += tr('Data Consulta', limite.DATA_CONSULTA || '-');
    html += '</table>';
  }

  // Ações Judiciais
  var aj = cred.ACOES_JUDICIAIS || {};
  if (aj && aj.OCORRENCIAS && aj.OCORRENCIAS.length > 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
    html += '<tr style="background:#C00000;color:white"><th colspan="4" style="padding:6px">Ações Judiciais (' + (aj.QUANTIDADE_OCORRENCIA || aj.OCORRENCIAS.length) + ')</th></tr>';
    html += '<tr style="background:#f2f2f2"><th style="padding:4px">Data</th><th style="padding:4px">Comarca</th><th style="padding:4px">Valor</th><th style="padding:4px">Tipo</th></tr>';
    for (var i = 0; i < aj.OCORRENCIAS.length; i++) {
      var a = aj.OCORRENCIAS[i];
      html += '<tr><td style="padding:4px">' + (a.DATA_ACAO || '-') + '</td><td style="padding:4px">' + (a.COMARCA || '-') + '</td><td style="padding:4px">' + (a.VALOR || '-') + '</td><td style="padding:4px">' + (a.TIPO_ACAO || '-') + '</td></tr>';
    }
    html += '</table>';
  }

  // Participações em outras empresas
  var part = cred.PARTICIPACOES || {};
  if (part && part.OCORRENCIAS && part.OCORRENCIAS.length > 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
    html += '<tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Participações em Outras Empresas (' + (part.QUANTIDADE_OCORRENCIAS || part.OCORRENCIAS.length) + ')</th></tr>';
    html += '<tr style="background:#f2f2f2"><th style="padding:4px">Empresa</th><th style="padding:4px">CNPJ</th><th style="padding:4px">Participação</th><th style="padding:4px">Cargo</th></tr>';
    for (var i = 0; i < part.OCORRENCIAS.length; i++) {
      var p = part.OCORRENCIAS[i];
      html += '<tr><td style="padding:4px">' + (p.NOME || p.RAZAO_SOCIAL || '-') + '</td><td style="padding:4px">' + (p.CNPJ || '-') + '</td><td style="padding:4px">' + (p.PERCENTUAL_PARTICIPACAO || '-') + '%</td><td style="padding:4px">' + (p.CARGO || '-') + '</td></tr>';
    }
    html += '</table>';
  }

  // Recomendação / Parecer
  var rec = cred.RECOMENDACAO || cred.PARECER || {};
  if (rec && (rec.PARECER || rec.RECOMENDACAO || rec.CLASSIFICACAO)) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#548235;color:white"><th colspan="4" style="padding:6px">Recomendação / Parecer</th></tr>';
    html += tr('Parecer', rec.PARECER || rec.RECOMENDACAO || '-');
    if (rec.CLASSIFICACAO) html += tr('Classificação', rec.CLASSIFICACAO || '-');
    if (rec.JUSTIFICATIVA) html += tr('Justificativa', rec.JUSTIFICATIVA || '-');
    html += '</table>';
  }

  // Risk Rating (classificação de risco)
  var risk = cred.CLASSIFICACAO_RISCO || cred.RISK_RATING || {};
  if (risk && (risk.CLASSIFICACAO || risk.RATING || risk.NIVEL)) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#ED7D31;color:white"><th colspan="4" style="padding:6px">Classificação de Risco</th></tr>';
    html += tr('Classificação', risk.CLASSIFICACAO || risk.RATING || risk.NIVEL || '-');
    if (risk.PROBABILIDADE) html += tr('Probabilidade', risk.PROBABILIDADE || '-');
    html += '</table>';
  }

  return html;
}

function tr(label, value) {
  return '<tr><td style="padding:4px;width:30%;font-weight:bold">' + label + '</td><td style="padding:4px" colspan="3">' + value + '</td></tr>';
}

/**
 * POST JSON to URL
 */
function postJson(url, data) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(data);
    var parsed = new (require('url').URL)(url);
    var options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'AJL-Middleware/1.0 (ConsultFlex)',
      }
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('Invalid JSON from ConsultFlex: ' + raw.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { consultarCredito, formatarRespostaHtml };
