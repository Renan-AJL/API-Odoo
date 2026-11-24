/**
 * routes/nf-entrada.js — Trazer PDF da NF de ENTRADA p/ o botao "Trazer .pdf" do Odoo
 * (AJL 24/11/2026 — App Compras / entrada de NF)
 *
 * Fluxo: server action no Odoo (account.move, sem imports — safe_eval bloqueia)
 * dispara um server action state='webhook' -> POST aqui com os campos da fatura
 * -> busca a NF no cofre SIEG pelo Numero do documento (nNF) -> gera o DANFE
 * localmente do XML (services/danfe-pdf) -> anexa via XML-RPC (ir.attachment raw)
 * e publica no chatter (mail.message) -> a resposta volta rapida (<2s) e o
 * trabalho pesado roda em background (padrao do webhook: fire-and-forget).
 *
 * Rotas (auth X-Api-Key ou ?api_key=):
 *   POST /api/v1/nf-entrada/trazer-pdf  — { id } da fatura (payload do webhook)
 *   POST /api/v1/nf-entrada/ping        — grava ir.logging com o body (diagnostico)
 *
 * Idempotente: se a fatura ja tem qualquer PDF anexado, nao duplica (so anota).
 * Erros ficam visiveis: nota no chatter da fatura + ir.logging na middleware.
 */
'use strict';
const express = require('express');
const router = express.Router();
const config = require('../config');
const axios = require('axios');
const AdmZip = require('adm-zip');
const xmlrpc = require('xmlrpc');
const { getAuthHeaders } = require('../services/sieg-auth');
const { gerarDanfePdf } = require('../services/danfe-pdf');

// ── Auth (mesma chave da middleware — header X-Api-Key ou query api_key) ──
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key || '';
  if (key !== config.middlewareApiKey) {
    return res.status(401).json({ success: false, error: 'API Key invalida' });
  }
  next();
}
router.use(apiKeyAuth);

// ── Helpers XML-RPC (mesmo padrao de odoo-admin.js) ─────────────────────
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout ' + ms + 'ms')), ms))]);
}
function createClient(url) {
  var base = url.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  var isSecure = base.startsWith('https');
  var createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host: host, path: '/xmlrpc/2/common', port: isSecure ? 443 : 80 }),
    models: createFn({ host: host, path: '/xmlrpc/2/object', port: isSecure ? 443 : 80 }),
  };
}
function authenticate(client, db, login, password) {
  return new Promise(function (resolve, reject) {
    client.common.methodCall('authenticate', [db, login, password, {}], function (err, uid) {
      if (err) reject(new Error('Auth falhou: ' + (err.message || JSON.stringify(err))));
      else if (!uid) reject(new Error('Credenciais invalidas'));
      else resolve(uid);
    });
  });
}
function executeKw(client, db, uid, password, model, method, args, kwargs) {
  return new Promise(function (resolve, reject) {
    var params = [db, uid, password, model, method, args || []];
    if (kwargs) params.push(kwargs);
    client.models.methodCall('execute_kw', params, function (err, result) {
      if (err) reject(new Error(model + '.' + method + ': ' + (err.faultString || err.message || JSON.stringify(err))));
      else resolve(result);
    });
  });
}

// ── Odoo: log tecnico (ir.logging) — diagnostico fica visivel p/ o admin ──
async function odooLog(ekw, cfg, level, message) {
  try {
    await ekw('ir.logging', 'create', [{
      name: 'nf-entrada (middleware)',
      type: 'server',
      dbname: cfg.db,
      level: level,
      message: String(message).slice(0, 900),
      path: '/api/v1/nf-entrada',
      func: 'trazer-pdf',
      line: 0,
    }]);
  } catch (e) {
    console.error('[NF-ENTRADA] ir.logging falhou:', e.message);
  }
}

// ── Odoo: nota no chatter (house style: mail.message.create, HTML real) ──
async function chatterNote(ekw, moveId, corpoHtml, attachmentIds) {
  var msgVals = { model: 'account.move', res_id: moveId, body: corpoHtml, message_type: 'comment' };
  if (attachmentIds && attachmentIds.length) msgVals.attachment_ids = [[6, 0, attachmentIds]];
  await ekw('mail.message', 'create', [msgVals]);
}

// ── Parse do XML da NF (mesma tecnica do admin.js recebidas) ─────────────
function parseNfeXml(xmlStr) {
  var xml = xmlStr
    .replace(/\s+xmlns(?::[^=]+)?="[^"]*"/g, '')
    .replace(/<([A-Za-z]+):[A-Za-z]/g, function (m, p) { return '<'; })
    .replace(/<\/([A-Za-z]+):[A-Za-z]/g, function (m, p) { return '</'; });
  function xt(tag) {
    var re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\/' + tag + '>', 'i');
    var m = xml.match(re);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  }
  function xb(parent, tag) {
    var rp = new RegExp('<' + parent + '(?:\\s[^>]*)?>([\\s\\S]*?)<\/' + parent + '>', 'i');
    var mp = xml.match(rp);
    if (!mp) return '';
    var re2 = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\/' + tag + '>', 'i');
    var m2 = mp[1].match(re2);
    return m2 ? m2[1].replace(/<[^>]+>/g, '').trim() : '';
  }
  var chaveM = xml.match(/Id="(?:NFe|CTe|MDFe)?(\d{44})"/i) || xml.match(/<chNFe>(\d{44})</);
  return {
    xml: xmlStr,
    chave: chaveM ? chaveM[1] : '',
    nNF: xt('nNF'),
    serie: xt('serie'),
    emitente: xb('emit', 'xFant') || xb('emit', 'xNome') || '',
    cnpjEmitente: xb('emit', 'CNPJ') || xb('emit', 'CPF') || '',
    // AJL 24/11 (v1.2.43): campos do espelho sieg_compras (painel de entradas)
    destinatario: xb('dest', 'xNome') || '',
    cnpjDestinatario: xb('dest', 'CNPJ') || xb('dest', 'CPF') || '',
    cStat: xt('cStat'),
    nProt: xt('nProt'),
    xMotivo: xt('xMotivo'),
    vNF: parseFloat(xt('vNF') || '0') || 0,
    dhEmi: (xt('dhEmi') || xt('dEmi') || '').slice(0, 10),
  };
}

function ultimoDia(mesYYYYMM) {
  var y = parseInt(mesYYYYMM.slice(0, 4));
  var m = parseInt(mesYYYYMM.slice(5, 7));
  var d = new Date(Date.UTC(y, m, 0));
  return mesYYYYMM + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// ── Chamada SIEG com retry (429 rate-limit e timeout de rede) ───────────
// AJL 24/11 (v1.2.41): o cofre SIEG vem devolvendo 429/timeout em rajadas
// (o painel usa a mesma conta) — 2 retries com backoff e erro explicativo.
// AJL 24/11 (v1.2.42): baixar-xmls as vezes responde 404 — a rota /sieg/cofre
// ja trata isso como variante de "sem resultado" (v1.2.20); aqui vira valor
// sentinela (__empty404) em vez de excecao. Demais HTTP != 200/404/429 ->
// erro com o corpo (antes so dizia "status code X" sem contexto).
async function siegBaixarXmls(body, headers) {
  var delays = [0, 5000, 10000];
  var lastErr = null;
  for (var i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(function (r) { setTimeout(r, delays[i]); });
    var resp;
    try {
      resp = await withTimeout(axios.post('https://api.sieg.com/api/v1/baixar-xmls', body, {
        headers: headers, timeout: 15000, responseType: 'arraybuffer',
        validateStatus: function () { return true; },
      }), 20000);
    } catch (e) {
      lastErr = e;
      var msg = String((e && e.message) || '');
      if (msg.indexOf('timeout') < 0 && msg.indexOf('Timeout') < 0) throw e;
      console.log('[NF-ENTRADA] SIEG timeout — retry ' + (i + 1));
      continue;
    }
    var status = resp.status;
    if (status === 200) return resp;
    if (status === 404) {
      console.log('[NF-ENTRADA] SIEG 404 para', JSON.stringify(body).slice(0, 140), '— tratado como sem resultado');
      return { __empty404: true };
    }
    if (status === 429) {
      lastErr = new Error('SIEG HTTP 429 (rate limit)');
      console.log('[NF-ENTRADA] SIEG 429 — retry ' + (i + 1));
      continue;
    }
    var txt = '';
    try {
      txt = Buffer.isBuffer(resp.data) ? resp.data.toString('utf-8').slice(0, 200) : String(resp.data).slice(0, 200);
    } catch (eTxt) { /* corpo ilegivel */ }
    throw new Error('SIEG HTTP ' + status + ': ' + txt);
  }
  throw new Error('SIEG instavel (limite de uso/tempo esgotado apos retries) — aguarde ~1 minuto e clique Trazer .pdf de novo');
}

// ── Busca no cofre SIEG: paginada (Take<=50 — limite SIEG v1.2.20) ───────
// AJL 24/11 (v1.2.42): a NF 181163 do ACSO nao era achada — com filtro
// CNPJdest ou sem filtro a 1a pagina de out/2026 ja traz 50 docs (AJL recebe
// centenas de NFs/mes) e a nota fica fora das 150 primeiras. Estrategia nova:
// 1o filtro CNPJemit do FORNECEDOR (vat do partner — ACSO=35 docs em out/26,
// achou na 1a pagina), depois CNPJdest da empresa, depois sem filtro; mes da
// fatura antes do anterior; ate 6 paginas (300 docs) por tentativa.
async function buscarNfNoSieg(numero, meses, cnpjDest, cnpjEmit) {
  var tentativasCfg = [];
  if (cnpjEmit) tentativasCfg.push({ label: 'emit', campo: 'CNPJemit', cnpj: cnpjEmit });
  if (cnpjDest) tentativasCfg.push({ label: 'dest', campo: 'CNPJdest', cnpj: cnpjDest });
  tentativasCfg.push({ label: 'semfiltro', campo: '', cnpj: '' });
  var candidatos = [];
  var tentativas = [];
  for (var mi = 0; mi < meses.length && !candidatos.length; mi++) {
    var mes = meses[mi];
    for (var ti = 0; ti < tentativasCfg.length && !candidatos.length; ti++) {
      var tc = tentativasCfg[ti];
      for (var pg = 0; pg < 6 && !candidatos.length; pg++) {
        var body = {
          TipoXml: 1, Take: 50, Skip: pg * 50,
          DataEmissaoInicio: mes + '-01T00:00:00Z',
          DataEmissaoFim: ultimoDia(mes) + 'T23:59:59Z',
        };
        if (tc.campo) body[tc.campo] = tc.cnpj;
        tentativas.push(mes + '/' + tc.label + '/p' + (pg + 1));
        console.log('[NF-ENTRADA] SIEG busca:', JSON.stringify(body));
        var headers = await withTimeout(getAuthHeaders(), 15000);
        var resp = await siegBaixarXmls(body, headers);
        if (!resp || resp.__empty404) break; // sem resultado nessa tentativa
        var zip = new AdmZip(resp.data);
        var entries = zip.getEntries();
        console.log('[NF-ENTRADA] SIEG zip entries:', entries.length);
        for (var ei = 0; ei < entries.length; ei++) {
          if (entries[ei].isDirectory) continue;
          var cand;
          try {
            cand = parseNfeXml(zip.readAsText(entries[ei]));
          } catch (eParse) { continue; }
          if (!cand.nNF) continue;
          if (parseInt(cand.nNF, 10) !== parseInt(numero, 10)) continue;
          if (!candidatos.some(function (c) { return c.chave === cand.chave; })) candidatos.push(cand);
        }
        if (entries.length < 50) break; // paginacao esgotou
      }
    }
  }
  return { candidatos: candidatos, tentativas: tentativas };
}

// ── Trabalho principal (background) ──────────────────────────────────────
async function trazerPdfParaMove(moveId) {
  var cfg = config.odoo;
  if (!cfg.url) throw new Error('ODOO_URL nao configurada na middleware');
  var c = createClient(cfg.url);
  var uid = await authenticate(c, cfg.db, cfg.user, cfg.password);
  var ekw = function (m, mt, a, k) { return executeKw(c, cfg.db, uid, cfg.password, m, mt, a, k); };

  var moves = await ekw('account.move', 'read', [[moveId], [
    'name', 'ref', 'l10n_latam_document_number', 'amount_total', 'invoice_date',
    'company_id', 'partner_id', 'move_type',
  ]]);
  var move = moves[0];
  if (!move) throw new Error('Fatura id=' + moveId + ' nao encontrada no Odoo');
  if (['in_invoice', 'in_refund', 'in_receipt'].indexOf(move.move_type) < 0) {
    throw new Error('Fatura ' + move.name + ' nao e uma ENTRADA (move_type=' + move.move_type + ')');
  }

  var numeroRaw = move.l10n_latam_document_number || move.ref || move.name || '';
  var numero = String(numeroRaw).replace(/\D/g, '');
  if (!numero) {
    throw new Error('Fatura ' + move.name + ' sem Numero do documento — preencha antes de trazer o PDF');
  }

  // idempotencia: qualquer PDF ja anexado -> nao duplica
  var jaPdfs = await ekw('ir.attachment', 'search', [[
    ['res_model', '=', 'account.move'], ['res_id', '=', moveId],
    ['mimetype', '=', 'application/pdf'],
  ]]);
  if (jaPdfs.length) {
    await odooLog(ekw, cfg, 'INFO', 'move ' + moveId + ' (NF ' + numero + '): ja tem PDF anexado — nada a fazer');
    return { status: 'ja_anexado', move_id: moveId, numero: numero };
  }

  // meses alvo: data da fatura e anterior; senao corrente e anterior
  var meses = [];
  function pushMes(d) {
    var s = d.toISOString().slice(0, 7);
    if (meses.indexOf(s) < 0) meses.push(s);
  }
  if (move.invoice_date) {
    var d1 = new Date(move.invoice_date + 'T12:00:00Z');
    pushMes(d1);
    pushMes(new Date(Date.UTC(d1.getUTCFullYear(), d1.getUTCMonth() - 1, 1)));
  } else {
    var agora = new Date();
    pushMes(agora);
    pushMes(new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1)));
  }

  var cnpjDest = '';
  if (move.company_id && move.company_id[0]) {
    var comps = await ekw('res.company', 'read', [[move.company_id[0]], ['vat']]);
    cnpjDest = (comps[0].vat || '').replace(/\D/g, '');
  }

  // AJL 24/11 (v1.2.42): CNPJ do FORNECEDOR (vat do partner) — filtro mais
  // seletivo; sem ele a NF some entre as centenas de entradas do mes.
  var cnpjEmit = '';
  if (move.partner_id && move.partner_id[0]) {
    var parts = await ekw('res.partner', 'read', [[move.partner_id[0]], ['vat']]);
    cnpjEmit = (parts[0].vat || '').replace(/\D/g, '');
  }

  var busca = await buscarNfNoSieg(numero, meses, cnpjDest, cnpjEmit);
  var candidatos = busca.candidatos;

  if (!candidatos.length) {
    throw new Error('NF ' + numero + ' nao encontrada no cofre SIEG (meses: ' + meses.join(', ')
      + '; tentativas: ' + busca.tentativas.join(', ') + '). Verifique se a nota foi manifestada.');
  }

  // desambigua por valor da fatura
  var escolhida = candidatos.length === 1 ? candidatos[0]
    : (candidatos.find(function (c) { return Math.abs(c.vNF - move.amount_total) < 0.02; }) || null);
  if (!escolhida) {
    var lista = candidatos.map(function (c) {
      return c.emitente + ' — R$ ' + c.vNF.toFixed(2) + ' (' + c.dhEmi + ', serie ' + (c.serie || '1') + ')';
    }).join(' | ');
    throw new Error('NF ' + numero + ' tem ' + candidatos.length + ' notas no cofre e o valor da fatura (R$ '
      + move.amount_total.toFixed(2) + ') nao casou: ' + lista);
  }

  // DANFE local a partir do XML
  var pdfBuf = await gerarDanfePdf(escolhida.xml);
  if (!pdfBuf || !pdfBuf.length) throw new Error('DANFE gerado vazio para a NF ' + numero);

  // anexo + chatter
  var att = await ekw('ir.attachment', 'create', [{
    name: 'DANFE_NF_' + numero + '.pdf',
    raw: pdfBuf.toString('base64'),
    res_model: 'account.move',
    res_id: moveId,
    mimetype: 'application/pdf',
  }]);
  var corpo = '<p><b>DANFE da NF de entrada ' + numero + '</b> anexado pelo painel de NFs (SIEG).</p>'
    + '<p>Emitente: ' + (escolhida.emitente || '—') + ' | Valor: R$ ' + escolhida.vNF.toFixed(2)
    + ' | Emissão: ' + (escolhida.dhEmi || '—') + '</p>';
  await chatterNote(ekw, moveId, corpo, [att]);
  await odooLog(ekw, cfg, 'INFO', 'move ' + moveId + ' (NF ' + numero + '): DANFE anexado, chave ' + escolhida.chave);
  console.log('[NF-ENTRADA] OK move', moveId, 'NF', numero, 'chave', escolhida.chave.slice(0, 10) + '...', pdfBuf.length, 'bytes');
  return { status: 'anexado', move_id: moveId, numero: numero, chave: escolhida.chave, bytes: pdfBuf.length };
}

// nota de erro visivel no chatter (sem anexo)
async function notaErro(moveId, mensagem) {
  var cfg = config.odoo;
  var c = createClient(cfg.url);
  var uid = await authenticate(c, cfg.db, cfg.user, cfg.password);
  var ekw = function (m, mt, a, k) { return executeKw(c, cfg.db, uid, cfg.password, m, mt, a, k); };
  var corpo = '<p><b>Trazer .pdf — falhou:</b> ' + String(mensagem).replace(/</g, '&lt;').slice(0, 500) + '</p>';
  await chatterNote(ekw, moveId, corpo, []);
  await odooLog(ekw, cfg, 'ERROR', 'move ' + moveId + ': ' + mensagem);
}

// ── Extrai o id da fatura de qualquer formato de payload ────────────────
function extrairMoveId(body) {
  if (!body) return 0;
  if (typeof body.id === 'number' || typeof body.id === 'string') return parseInt(body.id) || 0;
  if (body.move_id) return parseInt(body.move_id) || 0;
  if (Array.isArray(body) && body[0]) return parseInt(body[0].id) || 0;
  if (body.records && body.records[0]) return parseInt(body.records[0].id) || 0;
  return 0;
}

// fallback: payload sem id -> resolve a fatura pelo numero do documento
function extrairNumero(body) {
  if (!body) return '';
  var cand = body.l10n_latam_document_number || body.ref || body.name || '';
  if (Array.isArray(body) && body[0]) {
    cand = body[0].l10n_latam_document_number || body[0].ref || body[0].name || cand;
  }
  if (body.records && body.records[0]) {
    cand = body.records[0].l10n_latam_document_number || body.records[0].ref || body.records[0].name || cand;
  }
  return String(cand || '').trim();
}

async function resolverMovePorNumero(numeroRaw) {
  var cfg = config.odoo;
  if (!numeroRaw) return 0;
  var c = createClient(cfg.url);
  var uid = await authenticate(c, cfg.db, cfg.user, cfg.password);
  var dom = ['&',
    ['move_type', 'in', ['in_invoice', 'in_refund', 'in_receipt']],
    '|', '|',
    ['ref', '=', numeroRaw],
    ['name', '=', numeroRaw],
    ['l10n_latam_document_number', '=', numeroRaw],
  ];
  var ids = await executeKw(c, cfg.db, uid, cfg.password, 'account.move', 'search', [dom],
    { limit: 5, order: 'create_date desc' });
  return (ids && ids.length === 1) ? ids[0] : 0;
}

// ═════════════════════════════════════════════════════════════════════════
// POST /trazer-pdf — webhook do Odoo (responde <2s, trabalho em background)
// ═════════════════════════════════════════════════════════════════════════
router.post('/trazer-pdf', async function (req, res) {
  var moveId = extrairMoveId(req.body);
  if (!moveId) {
    var numeroBody = extrairNumero(req.body);
    if (numeroBody) {
      try {
        moveId = await withTimeout(resolverMovePorNumero(numeroBody), 20000);
        console.log('[NF-ENTRADA] resolveu por numero', numeroBody, '-> move', moveId);
      } catch (eRes) {
        console.error('[NF-ENTRADA] resolucao por numero falhou:', eRes.message);
      }
    }
  }
  if (!moveId) {
    return res.status(400).json({ success: false, error: 'id da fatura ausente no payload do webhook' });
  }
  res.json({ success: true, status: 'recebido', move_id: moveId });
  trazerPdfParaMove(moveId).then(function (r) {
    console.log('[NF-ENTRADA] resultado:', JSON.stringify(r));
  }).catch(function (e) {
    console.error('[NF-ENTRADA] erro move', moveId, ':', e.message);
    notaErro(moveId, e.message).catch(function (e2) {
      console.error('[NF-ENTRADA] nota de erro tambem falhou:', e2.message);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /ping — prova de entrega do webhook (grava ir.logging no Odoo)
// ═════════════════════════════════════════════════════════════════════════
router.post('/ping', async function (req, res) {
  var bodyStr = JSON.stringify(req.body || {}).slice(0, 700);
  res.json({ success: true, status: 'pong' });
  try {
    var cfg = config.odoo;
    var c = createClient(cfg.url);
    var uid = await authenticate(c, cfg.db, cfg.user, cfg.password);
    var ekw = function (m, mt, a, k) { return executeKw(c, cfg.db, uid, cfg.password, m, mt, a, k); };
    await odooLog(ekw, cfg, 'INFO', 'PING webhook recebido: ' + bodyStr);
    console.log('[NF-ENTRADA] ping registrado no ir.logging');
  } catch (e) {
    console.error('[NF-ENTRADA] ping falhou:', e.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SIEG COMPRAS — espelho das NFs de ENTRADA no Odoo (modelo x_sieg_compras)
// AJL 24/11 (v1.2.43): demanda do Compras. O cron roda AQUI (node) de 1 em 1
// hora porque server action do Odoo nao faz HTTP (safe_eval bloqueia import/
// urllib — provado 24/11). Varre o cofre SIEG desde 01/10/2026, compara com
// as chaves ja salvas em x_sieg_compras e cria as linhas novas — cada uma com
// o XML fiscal e o DANFE (PDF) anexados (ir.attachment res_model
// =x_sieg_compras). Depois, quando o admin de compras preenche o Numero do
// documento na entrada de NF, a automation do Odoo ('AJL · Compras: XML+PDF
// do cofre sieg_compras') copia os dois anexos para a fatura e o fluxo atual
// (automacao 160/1697 'Entrada de NF via XML') processa o XML como sempre.
// Endpoints manuais: POST /sieg-compras-sync (forca 1 ciclo, p/ backfill) e
// GET /sieg-compras-status (ultimo resumo / ciclo em andamento).
// ═══════════════════════════════════════════════════════════════════════════
var SYNC_INICIO = '2026-10';   // mes inicial do espelho (pedido do Compras)
var SYNC_LIMITE_CICLO = 120;   // max de NFs novas por ciclo (Render free)
var syncState = { rodando: false, ultima: null, ciclos: 0, iniciadoEm: null };

function mesesDesde(inicioYYYYMM) {
  var out = [];
  var agora = new Date();
  var y = parseInt(inicioYYYYMM.slice(0, 4));
  var m = parseInt(inicioYYYYMM.slice(5, 7));
  while (y < agora.getUTCFullYear() || (y === agora.getUTCFullYear() && m <= agora.getUTCMonth() + 1)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function odooConnect() {
  var cfg = config.odoo;
  if (!cfg.url) throw new Error('ODOO_URL nao configurada na middleware');
  var c = createClient(cfg.url);
  var uid = await authenticate(c, cfg.db, cfg.user, cfg.password);
  return {
    cfg: cfg,
    ekw: function (model, method, args, kwargs) {
      return executeKw(c, cfg.db, uid, cfg.password, model, method, args, kwargs);
    },
  };
}

// Busca TODOS os XMLs do cofre nos meses informados (sem filtro de numero) —
// espelho sieg_compras. Paginada Take 50 (limite SIEG) ate zip vazio/404,
// max 20 paginas por mes (1000 docs). Reusa siegBaixarXmls (404/429/timeout).
async function buscarCofreCompleto(meses) {
  var docs = [];
  var vistos = {};
  var headers = await withTimeout(getAuthHeaders(), 15000);
  for (var mi = 0; mi < meses.length; mi++) {
    var mes = meses[mi];
    for (var pg = 0; pg < 20; pg++) {
      var body = {
        TipoXml: 1, Take: 50, Skip: pg * 50,
        DataEmissaoInicio: mes + '-01T00:00:00Z',
        DataEmissaoFim: ultimoDia(mes) + 'T23:59:59Z',
      };
      var resp = await siegBaixarXmls(body, headers);
      if (!resp || resp.__empty404) break;
      var zip = new AdmZip(resp.data);
      var entries = zip.getEntries();
      console.log('[SIEG-COMPRAS] cofre', mes, 'p' + (pg + 1) + ':', entries.length, 'docs');
      for (var ei = 0; ei < entries.length; ei++) {
        if (entries[ei].isDirectory) continue;
        var xmlStr = '';
        try { xmlStr = zip.readAsText(entries[ei]); } catch (eZip) { continue; }
        var reg;
        try { reg = parseNfeXml(xmlStr); } catch (eParse) { continue; }
        if (!reg.chave || vistos[reg.chave]) continue;
        vistos[reg.chave] = true;
        docs.push(reg);
      }
      if (entries.length < 50) break;
    }
  }
  return docs;
}

// Um ciclo de sincronizacao: cofre -> x_sieg_compras + anexos XML/DANFE.
async function sincronizarSiegCompras(limiteNovas) {
  var t0 = Date.now();
  var o = await odooConnect();
  // chaves ja sincronizadas (paginado, teto 20k linhas)
  var existentes = {};
  var offset = 0;
  while (true) {
    var lote = await o.ekw('x_sieg_compras', 'search_read', [[], ['x_chave']], { limit: 1000, offset: offset });
    for (var i = 0; i < lote.length; i++) existentes[lote[i].x_chave] = true;
    offset += lote.length;
    if (lote.length < 1000 || offset > 20000) break;
  }
  var meses = mesesDesde(SYNC_INICIO);
  var docs = await buscarCofreCompleto(meses);
  var novas = [];
  for (var di = 0; di < docs.length; di++) if (!existentes[docs[di].chave]) novas.push(docs[di]);
  var alvo = novas.slice(0, limiteNovas || SYNC_LIMITE_CICLO);
  var criadas = 0, comPdf = 0, erros = [];
  var agoraStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (var ni = 0; ni < alvo.length; ni++) {
    var reg = alvo[ni];
    try {
      var pdfB64 = '';
      try {
        var pdfBuf = await gerarDanfePdf(reg.xml);
        if (pdfBuf && pdfBuf.length) { pdfB64 = pdfBuf.toString('base64'); comPdf++; }
      } catch (eDanfe) {
        console.error('[SIEG-COMPRAS] DANFE falhou NF', reg.nNF, eDanfe.message);
      }
      var dhEmiTs = String(reg.dhEmi || '');
      var vals = {
        x_name: 'NF ' + (reg.nNF || '?') + (reg.serie ? ' s. ' + reg.serie : '') + ' — ' + (reg.emitente || '?'),
        x_chave: reg.chave,
        x_numero: reg.nNF || '',
        x_serie: reg.serie || '',
        x_emitente: reg.emitente || '',
        x_cnpj_emitente: reg.cnpjEmitente || '',
        x_destinatario: reg.destinatario || '',
        x_cnpj_destinatario: reg.cnpjDestinatario || '',
        x_data_emissao: dhEmiTs.length >= 19 ? dhEmiTs.replace('T', ' ').slice(0, 19) : false,
        x_valor: reg.vNF || 0,
        x_cstat: reg.cStat || '',
        x_nprot: reg.nProt || '',
        x_motivo: (reg.xMotivo || '').slice(0, 100),
        x_pdf_disponivel: !!pdfB64,
        x_sync_data: agoraStr,
      };
      var rid = await o.ekw('x_sieg_compras', 'create', [vals]);
      await o.ekw('ir.attachment', 'create', [{
        name: reg.chave + '.xml',
        raw: Buffer.from(reg.xml, 'utf-8').toString('base64'),
        res_model: 'x_sieg_compras', res_id: rid, mimetype: 'application/xml',
      }]);
      if (pdfB64) {
        await o.ekw('ir.attachment', 'create', [{
          name: 'DANFE_NF_' + (reg.nNF || reg.chave.slice(-8)) + '.pdf',
          raw: pdfB64,
          res_model: 'x_sieg_compras', res_id: rid, mimetype: 'application/pdf',
        }]);
      }
      criadas++;
    } catch (eRec) {
      erros.push('NF ' + (reg.nNF || reg.chave) + ': ' + String(eRec.message).slice(0, 120));
      console.error('[SIEG-COMPRAS] erro NF', reg.nNF, eRec.message);
    }
  }
  var resumo = {
    meses: meses.join(','), docsNoCofre: docs.length, novasPendentes: novas.length,
    criadas: criadas, comPdf: comPdf, restantes: Math.max(0, novas.length - criadas),
    erros: erros.slice(0, 5), nErros: erros.length,
    duracaoSeg: Math.round((Date.now() - t0) / 1000),
  };
  try {
    await odooLog(o.ekw, o.cfg, erros.length ? 'WARNING' : 'INFO',
      'sieg_compras sync (' + (limiteNovas || SYNC_LIMITE_CICLO) + '): ' + JSON.stringify(resumo));
  } catch (eLog) { /* log nao trava o ciclo */ }
  return resumo;
}

function cicloSiegCompras(origem, limiteNovas) {
  if (syncState.rodando) return false;
  syncState.rodando = true;
  syncState.iniciadoEm = new Date().toISOString();
  console.log('[SIEG-COMPRAS] ciclo iniciado (' + origem + ')');
  sincronizarSiegCompras(limiteNovas || SYNC_LIMITE_CICLO).then(function (r) {
    syncState.ultima = r;
    syncState.ciclos++;
    console.log('[SIEG-COMPRAS] ciclo OK:', JSON.stringify(r));
  }).catch(function (e) {
    syncState.ultima = { erro: e.message };
    console.error('[SIEG-COMPRAS] ciclo FALHOU:', e.message);
  }).then(function () { syncState.rodando = false; });
  return true;
}

// endpoints manuais (backfill + acompanhamento — mesma apiKeyAuth do router)
router.post('/sieg-compras-sync', function (req, res) {
  var limite = parseInt(req.body && req.body.limite, 10) || SYNC_LIMITE_CICLO;
  var disparou = cicloSiegCompras('manual', limite);
  res.json({ ok: disparou, limite: limite, status: syncState });
});
router.get('/sieg-compras-status', function (req, res) {
  res.json(syncState);
});

// cron de 1 em 1 hora (+ 1a rodada ~4 min apos o start do servico).
// Kill switch: env SIEG_COMPRAS_SYNC=off (se precisar desligar sem redeploy de codigo).
if ((config.odoo && config.odoo.url) && process.env.SIEG_COMPRAS_SYNC !== 'off') {
  setTimeout(function () { cicloSiegCompras('startup'); }, 4 * 60 * 1000);
  setInterval(function () { cicloSiegCompras('cron-1h'); }, 60 * 60 * 1000);
  console.log('[SIEG-COMPRAS] cron ativo: ciclo de 1h desde ' + SYNC_INICIO + ' (limite ' + SYNC_LIMITE_CICLO + ' NFs/ciclo)');
}

module.exports = router;
