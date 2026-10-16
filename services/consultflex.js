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

  // Scores (SCORES with OCORRENCIAS array)
  var scores = cred.SCORES || cred.SCORE || {};
  if (scores && (scores.OCORRENCIAS || scores.VALOR || scores.PONTUACAO)) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Score / Pontuação</th></tr>';
    if (scores.OCORRENCIAS && scores.OCORRENCIAS.length > 0) {
      html += '<tr style="background:#f2f2f2"><th style="padding:4px">Score</th><th style="padding:4px">Faixa</th><th style="padding:4px">Descrição</th><th style="padding:4px">Data</th></tr>';
      for (var si = 0; si < scores.OCORRENCIAS.length; si++) {
        var sc = scores.OCORRENCIAS[si];
        html += '<tr><td style="padding:4px;font-weight:bold">' + (sc.PONTUACAO || sc.VALOR || sc.SCORE || '-') + '</td><td style="padding:4px">' + (sc.FAIXA || sc.CLASSIFICACAO || '-') + '</td><td style="padding:4px">' + (sc.DESCRICAO || '-') + '</td><td style="padding:4px">' + (sc.DATA_CONSULTA || '-') + '</td></tr>';
      }
    } else {
      html += tr('Score', scores.VALOR || scores.PONTUACAO || '-');
    }
    html += '</table>';
  }

  // Relatório SCR (Sistema de Crédito)
  var scr = cred.RELATORIO_SCR || {};
  if (scr && scr.STATUS_RETORNO && scr.STATUS_RETORNO.CODIGO === '1') {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#548235;color:white"><th colspan="4" style="padding:6px">Relatório SCR (Bacen)</th></tr>';
    html += tr('Documento', (scr.TIPO_DOCUMENTO || '') + ' ' + (scr.DOCUMENTO || '-'));
    html += tr('Nome/Razão Social', scr.NOME_RAZAO_SOCIAL || '-');
    html += tr('Coobrigação Assumida', scr.COOBRIGACAO_ASSUMIDA || '-');
    html += tr('Coobrigação Recebida', scr.COOBRIGACAO_RECEBIDA || '-');
    html += tr('Data Base', scr.DATABASE_CONSULTADA || '-');
    html += tr('Início Relacionamento', scr.DATA_INICIO_RELACIONAMENTO || '-');
    html += tr('Valor Repasse', scr.VALOR_REPASSE || '-');
    html += tr('Valor Trans. Judiciais', scr.VALOR_TRANSACOES_JUDICIAIS || '-');
    html += tr('Valor Trans. Divergentes', scr.VALOR_TRANSACOES_DIVERGENTES || '-');
    html += tr('Qtd Instituições', scr.QUANTIDADE_INSTITUICOES || '-');
    html += '</table>';
  }

  // Relatório Jurídico Empresarial
  var rje = cred.RELATORIO_JURIDICO_EMPRESARIAL || {};
  if (rje && rje.STATUS_RETORNO && rje.STATUS_RETORNO.CODIGO === '1') {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#C00000;color:white"><th colspan="4" style="padding:6px">Relatório Jurídico Empresarial</th></tr>';
    if (rje.RESUMO) html += tr('Resumo', rje.RESUMO || '-');
    if (rje.ACOES) html += tr('Ações', rje.ACOES || '-');
    if (rje.ACOES_ARQUIVADAS) html += tr('Ações Arquivadas', rje.ACOES_ARQUIVADAS || '-');
    html += '</table>';
  }

  // Ações Cíveis (ACOES_CIVEIS)
  var ac = cred.ACOES_CIVEIS || {};
  if (ac && ac.QUANTIDADE_OCORRENCIA && ac.QUANTIDADE_OCORRENCIA !== '0' && ac.QUANTIDADE_OCORRENCIA !== 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#C00000;color:white"><th colspan="4" style="padding:6px">Ações Cíveis</th></tr>';
    html += tr('Quantidade', ac.QUANTIDADE_OCORRENCIA || '-');
    html += tr('Valor Total', ac.VALOR_TOTAL || '-');
    if (ac.VALOR_PRIMEIRO) html += tr('Primeiro Valor', ac.VALOR_PRIMEIRO || '-');
    if (ac.VALOR_ULTIMO) html += tr('Último Valor', ac.VALOR_ULTIMO || '-');
    if (ac.DATA_PRIMEIRO) html += tr('Primeira Data', ac.DATA_PRIMEIRO || '-');
    if (ac.DATA_ULTIMO) html += tr('Última Data', ac.DATA_ULTIMO || '-');
    html += '</table>';
  }

  // Ações Trabalhistas
  var at = cred.ACOES_TRABALHISTAS || {};
  if (at && at.STATUS_RETORNO && at.QUANTIDADE_OCORRENCIAS && at.QUANTIDADE_OCORRENCIAS !== '0' && at.QUANTIDADE_OCORRENCIAS !== 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#C00000;color:white"><th colspan="4" style="padding:6px">Ações Trabalhistas</th></tr>';
    html += tr('Quantidade', at.QUANTIDADE_OCORRENCIAS || '-');
    html += tr('Valor Total', at.VALOR_TOTAL || '-');
    html += tr('Emitiu Certidão Negativa', at.EMITIU_CERTIDAO_NEGATIVA || '-');
    if (at.MENSAGEM) html += tr('Mensagem', at.MENSAGEM || '-');
    html += '</table>';
  }

  // Cheques sem fundos Bacen
  var chBacen = cred.CH_SEM_FUNDOS_BACEN || {};
  if (chBacen && chBacen.QUANTIDADE_OCORRENCIA && chBacen.QUANTIDADE_OCORRENCIA !== '0' && chBacen.QUANTIDADE_OCORRENCIA !== 0) {
    html += '<div style="background:#f8d7da;padding:8px;border-radius:4px;margin-bottom:8px"><b>⚠ Cheques sem fundo (Bacen):</b> ' + chBacen.QUANTIDADE_OCORRENCIA + '</div>';
  }

  // Cheques sem fundos Varejo
  var chVar = cred.CH_SEM_FUNDOS_VAREJO || {};
  if (chVar && chVar.QUANTIDADE_OCORRENCIA && chVar.QUANTIDADE_OCORRENCIA !== '0' && chVar.QUANTIDADE_OCORRENCIA !== 0) {
    html += '<div style="background:#f8d7da;padding:8px;border-radius:4px;margin-bottom:8px"><b>⚠ Cheques sem fundo (Varejo):</b> ' + chVar.QUANTIDADE_OCORRENCIA + '</div>';
  }

  // Recheque
  var reqq = cred.RECHEQUE || {};
  if (reqq && reqq.QUANTIDADE_OCORRENCIAS && reqq.QUANTIDADE_OCORRENCIAS !== '0' && reqq.QUANTIDADE_OCORRENCIAS !== 0) {
    html += '<div style="background:#fff3cd;padding:8px;border-radius:4px;margin-bottom:8px"><b>⚠ Recheque:</b> ' + reqq.QUANTIDADE_OCORRENCIAS + ' ocorrência(s)</div>';
  }

  // Participação em Empresas (PARTICIPACAO_EM_EMPRESAS)
  var partEmp = cred.PARTICIPACAO_EM_EMPRESAS || cred.PARTICIPACOES || {};
  if (partEmp && partEmp.QUANTIDADE_OCORRENCIAS && partEmp.QUANTIDADE_OCORRENCIAS !== '0' && partEmp.QUANTIDADE_OCORRENCIAS !== 0) {
    html += '<div style="background:#d4edda;padding:8px;border-radius:4px;margin-bottom:8px"><b>Participação em Empresas:</b> ' + partEmp.QUANTIDADE_OCORRENCIAS + ' empresa(s)</div>';
    if (partEmp.OCORRENCIAS && partEmp.OCORRENCIAS.length > 0) {
      html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">';
      html += '<tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Participações (' + partEmp.QUANTIDADE_OCORRENCIAS + ')</th></tr>';
      for (var pi = 0; pi < partEmp.OCORRENCIAS.length; pi++) {
        var pe = partEmp.OCORRENCIAS[pi];
        html += '<tr><td style="padding:4px">' + (pe.NOME || pe.RAZAO_SOCIAL || '-') + '</td><td style="padding:4px">' + (pe.CNPJ || pe.CPF_CNPJ || '-') + '</td><td style="padding:4px">' + (pe.PERCENTUAL_PARTICIPACAO || '-') + '%</td><td style="padding:4px">' + (pe.CARGO || '-') + '</td></tr>';
      }
      html += '</table>';
    }
  }

  // Histórico de Consultas
  var hist = cred.HIST_CONSULTAS || {};
  if (hist && hist.QUANTIDADE_OCORRENCIAS && hist.QUANTIDADE_OCORRENCIAS !== '0' && hist.QUANTIDADE_OCORRENCIAS !== 0) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Histórico de Consultas</th></tr>';
    html += tr('Quantidade', hist.QUANTIDADE_OCORRENCIAS || '-');
    if (hist.DATA_INICIAL) html += tr('Período', (hist.DATA_INICIAL || '-') + ' a ' + (hist.DATA_FINAL || '-'));
    if (hist.QUANTIDADES) html += tr('Quantidades', JSON.stringify(hist.QUANTIDADES));
    if (hist.SEGMENTOS) html += tr('Segmentos', JSON.stringify(hist.SEGMENTOS));
    html += '</table>';
  }

  // Informações da Empresa (PJ)
  var infoEmp = cred.INFORMACOES_DA_EMPRESA || {};
  if (infoEmp && infoEmp.RAZAO_SOCIAL) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Informações da Empresa</th></tr>';
    html += tr('Razão Social', infoEmp.RAZAO_SOCIAL || '-');
    if (infoEmp.NOME_FANTASIA) html += tr('Nome Fantasia', infoEmp.NOME_FANTASIA || '-');
    html += tr('Situação', infoEmp.SITUACAO || '-');
    if (infoEmp.DATA_SITUACAO) html += tr('Data Situação', infoEmp.DATA_SITUACAO || '-');
    if (infoEmp.INSCRICAO_ESTADUAL) html += tr('Inscrição Estadual', infoEmp.INSCRICAO_ESTADUAL || '-');
    if (infoEmp.SITUACAO_SINTEGRA) html += tr('Situação Sintegra', infoEmp.SITUACAO_SINTEGRA || '-');
    html += '</table>';
  }

  // Capital Social (from QUADRO_SOCIETARIO)
  var qsCap = cred.QUADRO_SOCIETARIO || {};
  if (qsCap && qsCap.CAPITAL_SOCIAL) {
    html += '<div style="background:#d4edda;padding:8px;border-radius:4px;margin-bottom:8px"><b>Capital Social:</b> R$ ' + qsCap.CAPITAL_SOCIAL + '</div>';
  }

  // Emails
  var emails = cred.EMAILS || {};
  if (emails && emails.INFOEMAILS) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">E-mails</th></tr>';
    html += tr('E-mails', JSON.stringify(emails.INFOEMAILS).substring(0, 500));
    html += '</table>';
  }

  // Passagens Comerciais
  var pass = cred.PASSAGENS_COMERCIAIS || {};
  if (pass && pass.QUANTIDADE_OCORRENCIA && pass.QUANTIDADE_OCORRENCIA !== '0' && pass.QUANTIDADE_OCORRENCIA !== 0) {
    html += '<div style="background:#fff3cd;padding:8px;border-radius:4px;margin-bottom:8px"><b>Passagens Comerciais:</b> ' + pass.QUANTIDADE_OCORRENCIA + '</div>';
  }

  // Pagamento Atrasado
  var pagAtr = cred.PAGAMENTO_ATRASADO || {};
  if (pagAtr && pagAtr.STATUS_RETORNO && pagAtr.STATUS_RETORNO.CODIGO === '1') {
    html += '<div style="background:#fff3cd;padding:8px;border-radius:4px;margin-bottom:8px"><b>⚠ Pagamento Atrasado: Informação disponível</b></div>';
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
