/**
 * routes/admin.js — Painel Admin AJL (v5 — aba Odoo completa)
 */
'use strict';
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const config  = require('../config');
const xmlrpc  = require('xmlrpc');

// ── Cache ZIP em memória (chave -> xmlString, TTL 30min) ─────────
var _zipCache = {}; // { chave: { xml: string, ts: number } }
var ZIP_CACHE_TTL = 30 * 60 * 1000;
function cacheSet(chave, xml) { _zipCache[chave] = { xml, ts: Date.now() }; }
function cacheGet(chave) {
  var e = _zipCache[chave];
  if (!e) return null;
  if (Date.now() - e.ts > ZIP_CACHE_TTL) { delete _zipCache[chave]; return null; }
  return e.xml;
}
setInterval(function() {
  var now = Date.now();
  Object.keys(_zipCache).forEach(function(k) { if (now - _zipCache[k].ts > ZIP_CACHE_TTL) delete _zipCache[k]; });
}, 10 * 60 * 1000);

// ── Auth ──────────────────────────────────────────────────────────
const ADMIN_USER   = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'ajl2025';
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || process.env.API_SECRET_KEY || 'ajl-admin-secret';
const COOKIE_NAME  = 'ajl_admin_token';
const COOKIE_TTL   = 8 * 60 * 60 * 1000;

function parseCookies(req) {
  var list = {};
  var header = req.headers && req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(function(c) {
    var idx = c.indexOf('=');
    if (idx < 0) return;
    var k = c.slice(0, idx).trim();
    var v = c.slice(idx + 1).trim();
    if (v[0] === '"') v = v.slice(1, -1);
    list[k] = decodeURIComponent(v);
  });
  return list;
}

function makeToken(user) {
  var exp     = Date.now() + COOKIE_TTL;
  var payload = user + ':' + exp;
  var sig     = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return payload + ':' + sig;
}

function validateToken(token) {
  if (!token) return false;
  var idx = token.lastIndexOf(':');
  if (idx < 0) return false;
  var sig     = token.slice(idx + 1);
  var payload = token.slice(0, idx);
  var parts   = payload.split(':');
  if (parts.length < 2) return false;
  var exp     = parseInt(parts[parts.length - 1]);
  if (isNaN(exp) || Date.now() > exp) return false;
  var expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return sig === expected;
}

function auth(req, res, next) {
  var cookies = parseCookies(req);
  if (validateToken(cookies[COOKIE_NAME])) return next();
  var ah = req.headers['authorization'] || '';
  if (ah.startsWith('Bearer ') && validateToken(ah.slice(7))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Não autenticado' });
  res.redirect('/admin/login');
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout ' + ms + 'ms')), ms))]);
}

function odooClient(url) {
  var base = (url || '').replace(/\/+$/, '');
  var host = base.replace(/^https?:\/\//, '');
  var secure = base.startsWith('https');
  var fn = secure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: fn({ host, path: '/xmlrpc/2/common', port: secure ? 443 : 80 }),
    models: fn({ host, path: '/xmlrpc/2/object', port: secure ? 443 : 80 }),
  };
}

function odooAuth(c, db, user, pass) {
  return withTimeout(new Promise((res, rej) => {
    c.common.methodCall('authenticate', [db, user, pass, {}], (err, uid) => {
      if (err || !uid) rej(new Error('Auth falhou: ' + (err && (err.faultString || err.message) || 'uid nulo')));
      else res(uid);
    });
  }), 15000);
}

function odooKw(c, db, uid, pass, model, method, args, kwargs) {
  var params = [db, uid, pass, model, method, args || []];
  if (kwargs) params.push(kwargs);
  return withTimeout(new Promise((res, rej) => {
    c.models.methodCall('execute_kw', params, (err, r) => {
      if (err) rej(new Error(err.faultString || err.message)); else res(r);
    });
  }), 20000);
}

// ── Login ─────────────────────────────────────────────────────────
router.get('/login', (req, res) => res.send(loginHtml(req.query.erro ? 'Usuário ou senha inválidos.' : '')));

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.usuario === ADMIN_USER && req.body.senha === ADMIN_PASS) {
    var token = makeToken(req.body.usuario);
    var secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',
      COOKIE_NAME + '=' + encodeURIComponent(token) +
      '; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(COOKIE_TTL / 1000) +
      (secure ? '; Secure' : ''));
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?erro=1');
});

router.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/admin; HttpOnly; Max-Age=0');
  res.redirect('/admin/login');
});

router.get('/', auth, (req, res) => res.send(dashHtml()));

// ════════════════════════════════════════════════════════════════
// APIs — SIEG
// ════════════════════════════════════════════════════════════════

router.get('/api/sieg/emitidas', auth, async (req, res) => {
  try {
    var cfg = config.odoo;
    if (!cfg.url) return res.json({ erro: 'ODOO_URL não configurada', registros: [] });
    var { dataInicio, dataFim, status: st, busca } = req.query;
    var c   = odooClient(cfg.url);
    var uid = await odooAuth(c, cfg.db, cfg.user, cfg.password);
    var ekw = (m, mt, a, k) => odooKw(c, cfg.db, uid, cfg.password, m, mt, a, k);
    var domain = [['move_type', '=', 'out_invoice'], ['x_studio_nfe_chave', '!=', false]];
    if (st && st !== 'todos') domain.push(['x_studio_nfe_status', '=', st]);
    if (dataInicio) domain.push(['invoice_date', '>=', dataInicio]);
    if (dataFim)    domain.push(['invoice_date', '<=', dataFim]);
    if (busca)      domain.push(['name', 'ilike', busca]);
    var ids = await ekw('account.move', 'search', [domain], { order: 'invoice_date desc', limit: 200 });
    var registros = [];
    if (ids.length) {
      var rows = await ekw('account.move', 'read', [ids, [
        'name', 'partner_id', 'invoice_date', 'amount_total',
        'x_studio_nfe_status', 'x_studio_nfe_chave', 'x_studio_nfe_protocolo',
      ]]);
      registros = rows.map(r => ({
        id: r.id,
        numero: r.name,
        cliente: Array.isArray(r.partner_id) ? r.partner_id[1] : String(r.partner_id || ''),
        data: r.invoice_date,
        valor: r.amount_total,
        status: r.x_studio_nfe_status,
        chave: r.x_studio_nfe_chave,
        protocolo: r.x_studio_nfe_protocolo,
      }));
    }
    res.json({ total: registros.length, registros });
  } catch(e) {
    console.error('[ADMIN] sieg/emitidas erro:', e.message);
    res.json({ erro: e.message, registros: [] });
  }
});

// NF-e recebidas
router.get('/api/sieg/recebidas', auth, async (req, res) => {
  try {
    var axios = require('axios');
    var { getAuthHeaders } = require('../services/sieg-auth');
    var headers = await withTimeout(getAuthHeaders(), 15000);
    var { dataInicio, dataFim, cnpjEmitente, cnpjDestinatario, pagina, tipoXml, nomeEmitente, nomeDestinatario } = req.query;

    var skip = ((parseInt(pagina) || 1) - 1) * 50;
    var body = {
      TipoXml: parseInt(tipoXml) || 1,
      Take: 50,
      Skip: skip,
    };
    if (dataInicio)       body.DataEmissaoInicio = dataInicio + 'T00:00:00Z';
    if (dataFim)          body.DataEmissaoFim    = dataFim   + 'T23:59:59Z';
    if (cnpjEmitente)     body.CNPJemit          = cnpjEmitente.replace(/\D/g, '');
    if (cnpjDestinatario) body.CNPJdest          = cnpjDestinatario.replace(/\D/g, '');

    console.log('[ADMIN] sieg/recebidas body:', JSON.stringify(body));

    var resp = await withTimeout(axios.post('https://api.sieg.com/api/v1/baixar-xmls', body, {
      headers, timeout: 25000, responseType: 'arraybuffer',
    }), 30000);

    var respBuffer = resp.data;
    console.log('[ADMIN] sieg/recebidas HTTP', resp.status, 'bytes:', respBuffer && respBuffer.length);

    if (!Buffer.isBuffer(respBuffer) && !respBuffer) {
      return res.json({ erro: 'Resposta vazia da SIEG', registros: [] });
    }

    var AdmZip = require('adm-zip');
    var zip = new AdmZip(respBuffer);
    var entries = zip.getEntries();
    console.log('[ADMIN] ZIP entries:', entries.length);

    var registros = [];
    var chavesVistas = {};
    for (var entry of entries) {
      if (entry.isDirectory) continue;
      try {
        var xmlStr = zip.readAsText(entry);
        var xml = xmlStr
          .replace(/\s+xmlns(?::[^=]+)?="[^"]*"/g, '')
          .replace(/<([A-Za-z]+):[A-Za-z]/g, function(m,p){ return '<'; })
          .replace(/<\/([A-Za-z]+):[A-Za-z]/g, function(m,p){ return '</'; });

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

        var chaveM = xml.match(/Id="(?:NFe|CTe|MDFe)?(\d{44})"/i)
                  || xml.match(/<chNFe>(\d{44})</)
                  || xml.match(/<chCTe>(\d{44})</);
        var chave = chaveM ? chaveM[1] : '';

        if (chave && chavesVistas[chave]) continue;
        if (chave) chavesVistas[chave] = true;
        if (chave) cacheSet(chave, xmlStr);

        var emitNome = xb('emit','xFant') || xb('emit','xNome') || '';
        var emitCNPJ = xb('emit','CNPJ')  || xb('emit','CPF')   || '';
        var destNome = xb('dest','xNome') || '';
        var destCNPJ = xb('dest','CNPJ')  || xb('dest','CPF')   || '';
        var dhEmi    = xt('dhEmi') || xt('dEmi') || '';
        var vNF      = parseFloat(xt('vNF') || xt('vCT') || xt('vTPrest') || '0') || 0;
        var nNF      = xt('nNF') || xt('nCT') || xt('nMDF') || '';
        var serie    = xt('serie') || '';

        registros.push({
          chave, numero: nNF, serie,
          emitente: emitNome, cnpjEmitente: emitCNPJ,
          destinatario: destNome, cnpjDestinatario: destCNPJ,
          dataEmissao: dhEmi.slice(0, 10), valor: vNF,
        });
        if (registros.length <= 2) {
          console.log('[ADMIN] XML parse sample — emit:', emitNome, 'dest:', destNome, 'nNF:', nNF, 'vNF:', vNF, 'chave:', chave.slice(0,10));
        }
      } catch(ezip) {
        console.warn('[ADMIN] Erro ao parsear entry', entry.entryName, ezip.message);
      }
    }

    if (nomeEmitente) {
      var ne = nomeEmitente.toUpperCase();
      registros = registros.filter(function(r) { return (r.emitente || '').toUpperCase().indexOf(ne) !== -1; });
    }
    if (nomeDestinatario) {
      var nd = nomeDestinatario.toUpperCase();
      registros = registros.filter(function(r) { return (r.destinatario || '').toUpperCase().indexOf(nd) !== -1; });
    }
    res.json({ total: registros.length, registros, pagina: parseInt(pagina) || 1 });
  } catch(e) {
    console.error('[ADMIN] sieg/recebidas erro:', e.message);
    res.json({ erro: 'SIEG: ' + e.message, registros: [] });
  }
});

// Download XML individual
router.get('/api/sieg/xml/:chave', auth, async (req, res) => {
  try {
    var chave = req.params.chave;
    var cached = cacheGet(chave);
    if (cached) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="NFe_' + chave + '.xml"');
      return res.send(cached);
    }
    var axios  = require('axios');
    var AdmZip = require('adm-zip');
    var { getAuthHeaders } = require('../services/sieg-auth');
    var headers = await withTimeout(getAuthHeaders(), 15000);
    var tipoXml = parseInt(req.query.tipoXml) || 1;
    var aamm = chave.slice(2, 6);
    var ano  = '20' + aamm.slice(0, 2);
    var mes  = aamm.slice(2, 4);
    var di   = ano + '-' + mes + '-01';
    var dfDate = new Date(parseInt(ano), parseInt(mes), 0);
    var df   = ano + '-' + mes + '-' + String(dfDate.getDate()).padStart(2,'0');
    console.log('[ADMIN] xml/chave fallback SIEG — chave:', chave.slice(0,10)+'...', 'período:', di, '-', df);
    var body = { TipoXml: tipoXml, Take: 500, Skip: 0,
      DataEmissaoInicio: di + 'T00:00:00Z', DataEmissaoFim: df + 'T23:59:59Z',
    };
    var resp = await withTimeout(axios.post('https://api.sieg.com/api/v1/baixar-xmls', body, {
      headers, timeout: 30000, responseType: 'arraybuffer',
    }), 35000);
    var zip     = new AdmZip(resp.data);
    var entries = zip.getEntries();
    var found   = null;
    for (var entry of entries) {
      if (entry.isDirectory) continue;
      var xmlStr = zip.readAsText(entry);
      var km = xmlStr.match(/Id="(?:NFe|CTe|MDFe)?(\d{44})"/i);
      if (km) cacheSet(km[1], xmlStr);
      if (xmlStr.indexOf(chave) !== -1) found = xmlStr;
    }
    if (!found) return res.status(404).json({ erro: 'XML não encontrado no cofre SIEG para esta chave' });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="NFe_' + chave + '.xml"');
    res.send(found);
  } catch(e) {
    console.error('[ADMIN] xml/chave erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Download PDF — gera DANFE local via danfe-pdf.js
router.get('/api/sieg/pdf/:chave', auth, async (req, res) => {
  try {
    var chave   = req.params.chave;
    var tipoXml = parseInt(req.query.tipoXml) || 1;
    var xmlStr = cacheGet(chave);
    if (!xmlStr) {
      var axios  = require('axios');
      var AdmZip = require('adm-zip');
      var { getAuthHeaders } = require('../services/sieg-auth');
      var headers = await withTimeout(getAuthHeaders(), 15000);
      var aamm = chave.slice(2, 6);
      var ano  = '20' + aamm.slice(0, 2);
      var mes  = aamm.slice(2, 4);
      var di   = ano + '-' + mes + '-01';
      var dfD  = new Date(parseInt(ano), parseInt(mes), 0);
      var df   = ano + '-' + mes + '-' + String(dfD.getDate()).padStart(2,'0');
      console.log('[ADMIN] pdf fallback SIEG — chave:', chave.slice(0,10)+'...', 'período:', di, '-', df);
      var zResp = await withTimeout(axios.post('https://api.sieg.com/api/v1/baixar-xmls', {
        TipoXml: tipoXml, Take: 500, Skip: 0,
        DataEmissaoInicio: di + 'T00:00:00Z', DataEmissaoFim: df + 'T23:59:59Z',
      }, { headers, timeout: 30000, responseType: 'arraybuffer' }), 35000);
      var zip = new AdmZip(zResp.data);
      for (var entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        var xs = zip.readAsText(entry);
        var km = xs.match(/Id="(?:NFe|CTe|MDFe)?(\d{44})"/i);
        if (km) cacheSet(km[1], xs);
        if (xs.indexOf(chave) !== -1) xmlStr = xs;
      }
    }
    if (!xmlStr) {
      return res.status(404).json({
        erro: 'XML não encontrado no cofre SIEG — não é possível gerar o DANFE.',
        dica: 'Recarregue a listagem antes de baixar o PDF (popula o cache do XML).',
        chave,
      });
    }
    var { gerarDanfePdf } = require('../services/danfe-pdf');
    var pdfBuf = await gerarDanfePdf(xmlStr);
    console.log('[ADMIN] pdf DANFE local OK —', pdfBuf.length, 'bytes, chave:', chave.slice(0,10)+'...');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="NFe_' + chave + '.pdf"');
    res.send(pdfBuf);
  } catch(e) {
    console.error('[ADMIN] pdf/chave erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Download ZIP direto da SIEG
router.get('/api/sieg/download-zip', auth, async (req, res) => {
  try {
    var axios = require('axios');
    var { getAuthHeaders } = require('../services/sieg-auth');
    var headers = await withTimeout(getAuthHeaders(), 15000);
    var { dataInicio, dataFim, tipoXml } = req.query;
    var hoje = new Date();
    var tresAtras = new Date(hoje); tresAtras.setDate(hoje.getDate() - 3);
    var di = dataInicio || tresAtras.toISOString().slice(0,10);
    var df = dataFim    || hoje.toISOString().slice(0,10);
    var body = {
      TipoXml: parseInt(tipoXml) || 1,
      Take: 200, Skip: 0,
      DataEmissaoInicio: di + 'T00:00:00Z',
      DataEmissaoFim:    df + 'T23:59:59Z',
    };
    var resp = await withTimeout(axios.post('https://api.sieg.com/api/v1/baixar-xmls', body, {
      headers, timeout: 30000, responseType: 'arraybuffer',
    }), 35000);
    var tipoLabel = { 1:'recebidas', 2:'emitidas-cofre', 3:'cte', 4:'nfse', 6:'nfce' };
    var nome = 'sieg-nfe-' + (tipoLabel[parseInt(tipoXml)||1] || 'docs') + '-' + di + '-a-' + df + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + nome + '"');
    res.send(Buffer.from(resp.data));
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// APIs — ODOO
// ════════════════════════════════════════════════════════════════

// Dashboard Odoo — KPIs
router.get('/api/odoo/dashboard', auth, async (req, res) => {
  try {
    var cfg = config.odoo;
    if (!cfg.url) return res.json({ erro: 'ODOO_URL não configurada' });
    var c   = odooClient(cfg.url);
    var uid = await odooAuth(c, cfg.db, cfg.user, cfg.password);
    var ekw = (m, mt, a, k) => odooKw(c, cfg.db, uid, cfg.password, m, mt, a, k);

    var hoje = new Date().toISOString().slice(0, 10);
    var mesInicio = hoje.slice(0, 7) + '-01';
    var anoInicio = hoje.slice(0, 4) + '-01-01';

    // Paralelo: NF-e emitidas + Faturas abertas + Vencidas
    var [
      nfeCount, nfeValor,
      faturasAbertas, faturasVencidas,
      faturasRecebidas, topClientes,
    ] = await Promise.all([
      // Total NF-e do mês
      ekw('account.move', 'search_count', [[
        ['move_type','=','out_invoice'],
        ['x_studio_nfe_chave','!=',false],
        ['invoice_date','>=',mesInicio],
        ['invoice_date','<=',hoje],
      ]], null),
      // Valor NF-e do mês
      ekw('account.move', 'read_group', [[
        ['move_type','=','out_invoice'],
        ['x_studio_nfe_chave','!=',false],
        ['invoice_date','>=',mesInicio],
        ['invoice_date','<=',hoje],
      ]], { fields: ['amount_total:sum'], groupby: [] }),
      // Faturas abertas
      ekw('account.move', 'search_read', [[
        ['move_type','=','out_invoice'],
        ['payment_state','in',['not_paid','partial']],
        ['state','=','posted'],
      ]], { fields: ['name','partner_id','amount_residual','invoice_date_due'], limit: 5, order: 'invoice_date_due asc' }),
      // Faturas vencidas (data_due < hoje e não pagas)
      ekw('account.move', 'search_count', [[
        ['move_type','=','out_invoice'],
        ['payment_state','in',['not_paid','partial']],
        ['state','=','posted'],
        ['invoice_date_due','<',hoje],
      ]], null),
      // Valor recebido no mês
      ekw('account.move', 'read_group', [[
        ['move_type','=','out_invoice'],
        ['payment_state','in',['paid','in_payment']],
        ['invoice_date','>=',mesInicio],
        ['invoice_date','<=',hoje],
      ]], { fields: ['amount_total:sum'], groupby: [] }),
      // Top 5 clientes do ano (por valor)
      ekw('account.move', 'read_group', [[
        ['move_type','=','out_invoice'],
        ['state','=','posted'],
        ['invoice_date','>=',anoInicio],
        ['invoice_date','<=',hoje],
      ]], { fields: ['partner_id','amount_total:sum'], groupby: ['partner_id'], orderby: 'amount_total desc', limit: 5 }),
    ]);

    var valorMes    = (nfeValor[0] && nfeValor[0].amount_total) || 0;
    var valorReceb  = (faturasRecebidas[0] && faturasRecebidas[0].amount_total) || 0;
    var abertas     = faturasAbertas.map(f => ({
      id: f.id,
      numero: f.name,
      cliente: Array.isArray(f.partner_id) ? f.partner_id[1] : String(f.partner_id||''),
      vencimento: f.invoice_date_due,
      saldo: f.amount_residual,
    }));
    var top = topClientes.map(g => ({
      cliente: Array.isArray(g.partner_id) ? g.partner_id[1] : String(g.partner_id||''),
      total: g.amount_total || 0,
    }));

    res.json({
      nfeMes: nfeCount,
      valorNfeMes: valorMes,
      valorRecebidoMes: valorReceb,
      faturasVencidas,
      faturasAbertasTop: abertas,
      topClientes: top,
    });
  } catch(e) {
    console.error('[ADMIN] odoo/dashboard erro:', e.message);
    res.json({ erro: e.message });
  }
});

// Faturas Odoo — listagem
router.get('/api/odoo/faturas', auth, async (req, res) => {
  try {
    var cfg = config.odoo;
    if (!cfg.url) return res.json({ erro: 'ODOO_URL não configurada', registros: [] });
    var { dataInicio, dataFim, status: st, busca, tipo } = req.query;
    var c   = odooClient(cfg.url);
    var uid = await odooAuth(c, cfg.db, cfg.user, cfg.password);
    var ekw = (m, mt, a, k) => odooKw(c, cfg.db, uid, cfg.password, m, mt, a, k);

    var moveType = tipo === 'entrada' ? 'in_invoice' : 'out_invoice';
    var domain = [['move_type','=', moveType], ['state','=','posted']];
    if (st && st !== 'todos') domain.push(['payment_state','=', st]);
    if (dataInicio) domain.push(['invoice_date','>=', dataInicio]);
    if (dataFim)    domain.push(['invoice_date','<=', dataFim]);
    if (busca)      domain.push(['name','ilike', busca]);

    var ids = await ekw('account.move', 'search', [domain], { order: 'invoice_date desc', limit: 200 });
    var registros = [];
    if (ids.length) {
      var rows = await ekw('account.move', 'read', [ids, [
        'name','partner_id','invoice_date','invoice_date_due',
        'amount_total','amount_residual','payment_state','ref',
      ]]);
      registros = rows.map(r => ({
        id: r.id,
        numero: r.name,
        ref: r.ref || '',
        parceiro: Array.isArray(r.partner_id) ? r.partner_id[1] : String(r.partner_id||''),
        dataEmissao: r.invoice_date,
        dataVencimento: r.invoice_date_due,
        total: r.amount_total,
        saldo: r.amount_residual,
        statusPagamento: r.payment_state,
      }));
    }
    res.json({ total: registros.length, registros });
  } catch(e) {
    console.error('[ADMIN] odoo/faturas erro:', e.message);
    res.json({ erro: e.message, registros: [] });
  }
});

router.get('/api/status', auth, (req, res) => {
  var sieg = { tpAmb: process.env.SIEG_TP_AMB === '1' ? 'Produção' : 'Homologação' };
  res.json({
    ok: true,
    uptime_s: Math.floor(process.uptime()),
    ambiente: sieg.tpAmb,
    timestamp: new Date().toISOString(),
  });
});

// ════════════════════════════════════════════════════════════════
// HTML
// ════════════════════════════════════════════════════════════════
function loginHtml(erro) {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AJL Admin — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#1a1a2e,#0f3460);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);padding:48px 40px;width:100%;max-width:400px}
h1{font-size:26px;font-weight:700;color:#1a1a2e;text-align:center;margin-bottom:6px}
h1 span{color:#e84545}
.sub{text-align:center;color:#666;font-size:13px;margin-bottom:32px}
label{display:block;font-size:12px;font-weight:600;color:#444;margin-bottom:6px;text-transform:uppercase}
input{width:100%;padding:12px 14px;border:2px solid #e5e5e5;border-radius:8px;font-size:15px;outline:none;transition:border .2s;margin-bottom:18px}
input:focus{border-color:#0f3460}
button{width:100%;padding:14px;background:#0f3460;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
button:hover{background:#1a4a8a}
.erro{background:#fff0f0;color:#c00;border:1px solid #fcc;border-radius:8px;padding:12px;font-size:13px;margin-bottom:18px;text-align:center}
</style></head><body>
<div class="card">
  <h1>AJL <span>Admin</span></h1>
  <div class="sub">Painel de Controle</div>
  ${erro ? `<div class="erro">⚠️ ${erro}</div>` : ''}
  <form method="POST" action="/admin/login">
    <label>Usuário</label><input name="usuario" type="text" required autocomplete="username">
    <label>Senha</label><input name="senha" type="password" required autocomplete="current-password">
    <button type="submit">Entrar</button>
  </form>
</div></body></html>`;
}

function dashHtml() {
  return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AJL Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--bd:#30363d;--tx:#c9d1d9;--tx2:#8b949e;--ac:#58a6ff;--gr:#3fb950;--rd:#f85149;--yw:#d29922;--pu:#bc8cff}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--tx);min-height:100vh}
.topbar{background:var(--bg2);border-bottom:1px solid var(--bd);padding:0 24px;display:flex;align-items:center;height:56px;position:sticky;top:0;z-index:100;gap:16px}
.topbar h1{font-size:18px;font-weight:700;color:#fff}.topbar h1 span{color:#f85149}
.tag{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600}
.tag-prod{background:#1f3a1f;color:#3fb950;border:1px solid #238636}
.tag-hom{background:#3a2e1f;color:#d29922;border:1px solid #bb8009}
.ml{margin-left:auto}.topbar a{color:var(--tx2);font-size:13px;text-decoration:none}
.topbar a:hover{color:var(--tx)}
.tabs{background:var(--bg2);border-bottom:1px solid var(--bd);padding:0 20px;display:flex;overflow-x:auto}
.tab{padding:14px 18px;font-size:13px;font-weight:500;color:var(--tx2);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;user-select:none}
.tab:hover{color:var(--tx)}.tab.on{color:var(--ac);border-bottom-color:var(--ac)}
.subtabs{display:flex;gap:0;margin-bottom:20px;background:var(--bg3);border-radius:8px;padding:4px;width:fit-content}
.stab{padding:7px 18px;border-radius:6px;font-size:13px;font-weight:500;color:var(--tx2);cursor:pointer;transition:all .15s;user-select:none}
.stab:hover{color:var(--tx)}.stab.on{background:var(--bg2);color:var(--ac);box-shadow:0 1px 4px rgba(0,0,0,.3)}
.main{padding:24px;max-width:1400px;margin:0 auto}
.pane{display:none}.pane.on{display:block}
.panel{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;overflow:hidden;margin-bottom:20px}
.ph{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ph h3{font-size:14px;font-weight:600;color:#fff;flex:1}
.pb{padding:20px}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.fg{display:flex;flex-direction:column;gap:4px}
.fg label{font-size:11px;color:var(--tx2);text-transform:uppercase;letter-spacing:.4px}
.fg input,.fg select{background:var(--bg3);border:1px solid var(--bd);color:var(--tx);padding:7px 12px;border-radius:6px;font-size:13px;outline:none;min-width:110px}
.fg input:focus,.fg select:focus{border-color:var(--ac)}
.btn{padding:7px 14px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500}
.btn-p{background:var(--ac);color:#fff}.btn-p:hover{background:#79b8ff}
.btn-o{background:transparent;color:var(--tx2);border:1px solid var(--bd)}.btn-o:hover{border-color:var(--tx);color:var(--tx)}
.btn-xl{background:#1e3a1e;color:#3fb950;border:1px solid #238636;padding:7px 14px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer}.btn-xl:hover{background:#1a5c1a}
.bgroup{display:flex;gap:6px;flex-wrap:wrap}
.tw{overflow-x:auto;margin-top:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--tx2);border-bottom:1px solid var(--bd);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--bd);color:var(--tx);vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:rgba(255,255,255,.02)}
.b{display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.3px}
.b-ok{background:#1a3a1a;color:#3fb950;border:1px solid #238636}
.b-warn{background:#3a2e1f;color:#d29922;border:1px solid #bb8009}
.b-err{background:#3a1a1a;color:#f85149;border:1px solid #b91c1c}
.b-can{background:#1f1a3a;color:#bc8cff;border:1px solid #6e40c9}
.b-gray{background:#21262d;color:#8b949e;border:1px solid #30363d}
.sum{font-size:13px;color:var(--tx2);margin-top:12px;padding:10px 12px;background:var(--bg3);border-radius:6px;border:1px solid var(--bd)}
.loading,.empty{text-align:center;padding:48px;color:var(--tx2);font-size:14px}
.spin{display:inline-block;width:18px;height:18px;border:2px solid var(--bd);border-top-color:var(--ac);border-radius:50%;animation:sp .7s linear infinite;margin-right:8px;vertical-align:middle}
@keyframes sp{to{transform:rotate(360deg)}}
.err-box{background:#1a0a0a;border:1px solid #5a2020;border-radius:8px;padding:16px;color:#f85149;font-size:13px;margin-top:12px}
.row-menu{position:relative;display:inline-block}
.row-dropdown{display:none;position:absolute;right:0;top:100%;background:var(--bg2);border:1px solid var(--bd);border-radius:8px;min-width:150px;z-index:50;box-shadow:0 4px 20px rgba(0,0,0,.4);overflow:hidden}
.row-dropdown a{display:block;padding:10px 14px;font-size:13px;color:var(--tx);text-decoration:none;white-space:nowrap}
.row-dropdown a:hover{background:var(--bg3)}
.row-dropdown.open{display:block}
input[type=checkbox]{width:15px;height:15px;accent-color:var(--ac);cursor:pointer;vertical-align:middle}
th.chk,td.chk{width:32px;padding-left:10px}
td.dt-dl{font-size:11px;color:var(--tx2);white-space:nowrap}
.mais-opcoes{font-size:12px;color:var(--ac);cursor:pointer;user-select:none;white-space:nowrap}
.mais-opcoes:hover{text-decoration:underline}
.extra-filters{display:none;flex-wrap:wrap;gap:10px;margin-top:8px;padding-top:8px;border-top:1px solid var(--bd)}
.extra-filters.open{display:flex}
.sel-bar{display:none;align-items:center;gap:10px;padding:9px 12px;background:var(--bg3);border:1px solid var(--bd);border-radius:8px;margin-top:10px;font-size:13px}
.sel-bar.on{display:flex}
/* KPIs */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:20px}
.kpi{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;padding:20px 24px}
.kpi-label{font-size:11px;color:var(--tx2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.kpi-val{font-size:28px;font-weight:700;color:#fff;line-height:1}
.kpi-sub{font-size:12px;color:var(--tx2);margin-top:6px}
.kpi.green .kpi-val{color:var(--gr)}
.kpi.yellow .kpi-val{color:var(--yw)}
.kpi.red .kpi-val{color:var(--rd)}
.kpi.blue .kpi-val{color:var(--ac)}
/* Top clientes bar */
.top-bar{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.top-bar-name{font-size:13px;color:var(--tx);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top-bar-fill{height:8px;border-radius:4px;background:var(--ac);min-width:4px;transition:width .4s}
.top-bar-val{font-size:12px;color:var(--tx2);white-space:nowrap;min-width:80px;text-align:right}
@media(max-width:600px){.main{padding:12px}.filters{flex-direction:column}.fg{width:100%}}
</style>
</head><body>

<div class="topbar">
  <h1>AJL <span>Admin</span></h1>
  <span id="env-tag" class="tag tag-hom">...</span>
  <span id="up" style="font-size:12px;color:var(--tx2)"></span>
  <div class="ml"></div>
  <a href="/admin/logout">Sair</a>
</div>

<div class="tabs">
  <div class="tab on" onclick="tab('sieg',this)">📄 SIEG</div>
  <div class="tab" onclick="tab('odoo',this)">📊 Odoo</div>
  <div class="tab" onclick="tab('itau',this)">🏦 Itaú</div>
  <div class="tab" onclick="tab('te',this)">🚚 TudoEntregue</div>
  <div class="tab" onclick="tab('status',this)">⚙️ Status</div>
</div>

<div class="main">

<!-- ══ SIEG ══════════════════════════════════════════════════════ -->
<div id="p-sieg" class="pane on">
  <div class="subtabs">
    <div class="stab on" onclick="stabSieg('rec',this)">📥 NF-e Recebidas</div>
  </div>

  <!-- Recebidas — filtros no estilo SIEG -->
  <div id="sp-rec">
    <div class="panel">
      <div class="ph"><h3>Consulta SIEG — NF-e / Documentos Fiscais</h3>
        <button class="btn btn-o" onclick="loadRec()">↻</button>
        <button class="btn btn-xl" onclick="exportarExcelRec()" title="Exportar para Excel/CSV">📊 Exportar Excel</button>
        <button class="btn btn-o" id="btn-zip" onclick="downloadZip()" title="Baixar ZIP com os XMLs">⬇ ZIP</button>
      </div>
      <div class="pb">
        <div class="filters">
          <div class="fg"><label>Tipo do Arquivo</label>
            <select id="r-tipo">
              <option value="1">NF-e Recebidas (entradas)</option>
              <option value="2">NF-e Emitidas (cofre SIEG)</option>
              <option value="3">CT-e</option>
              <option value="4">NFS-e</option>
              <option value="6">NFC-e</option>
            </select>
          </div>
          <div class="fg"><label>Data Emissão (Inicial)</label><input type="date" id="r-di"></div>
          <div class="fg"><label>Data Emissão (Final)</label><input type="date" id="r-df"></div>
          <div class="fg"><label>CNPJ Dest.</label><input type="text" id="r-cnpj-dest" placeholder="00000000000000" style="min-width:150px"></div>
          <div class="fg"><label>CNPJ Emit.</label><input type="text" id="r-cnpj" placeholder="00000000000000" style="min-width:150px"></div>
          <div class="fg" style="align-self:flex-end">
            <a class="mais-opcoes" id="mais-link" onclick="toggleMaisOpcoes()">Mais Opções ▾</a>
          </div>
          <div class="fg"><label>&nbsp;</label>
            <div class="bgroup">
              <button class="btn btn-o" onclick="preset('r',0)">Hoje</button>
              <button class="btn btn-o" onclick="preset('r',7)">7d</button>
              <button class="btn btn-o" onclick="preset('r',30)">30d</button>
              <button class="btn btn-o" onclick="preset('r',365)">Ano</button>
              <button class="btn btn-p" onclick="loadRec()">🔍 Pesquisar</button>
            </div>
          </div>
        </div>
        <!-- Mais Opções (oculto por padrão) -->
        <div class="extra-filters" id="extra-filters">
          <div class="fg"><label>Nome Emitente</label><input type="text" id="r-emit" placeholder="Ex: Maximus, Ferragens..." style="min-width:180px"></div>
          <div class="fg"><label>Nome Destinatário</label><input type="text" id="r-dest-nome" placeholder="Ex: AJL, Comercio..." style="min-width:180px"></div>
        </div>
        <div id="r-info" style="font-size:12px;color:var(--tx2);margin-top:10px">
          Padrão: últimos 3 dias. Use os filtros ou botões para ampliar o período.
        </div>
        <div id="r-sum"></div>
        <div id="r-tbl"><div class="loading"><span class="spin"></span>Aguardando...</div></div>
      </div>
    </div>
  </div>
</div>

<!-- ══ ODOO ══════════════════════════════════════════════════════ -->
<div id="p-odoo" class="pane">
  <div class="subtabs">
    <div class="stab on" onclick="stabOdoo('dash',this)">🏠 Dashboard</div>
    <div class="stab" onclick="stabOdoo('emit',this)">📤 NF-e Emitidas</div>
    <div class="stab" onclick="stabOdoo('fat',this)">🧾 Faturas</div>
  </div>

  <!-- Dashboard -->
  <div id="op-dash">
    <div id="kpi-area"><div class="loading"><span class="spin"></span>Carregando dashboard...</div></div>
  </div>

  <!-- NF-e Emitidas -->
  <div id="op-emit" style="display:none">
    <div class="panel">
      <div class="ph">
        <h3>NF-e Emitidas pela AJL</h3>
        <button class="btn btn-o" onclick="loadEmit()">↻</button>
        <button class="btn btn-xl" onclick="exportarExcelEmit()" title="Exportar para Excel/CSV">📊 Exportar Excel</button>
      </div>
      <div class="pb">
        <div class="filters">
          <div class="fg"><label>De</label><input type="date" id="e-di"></div>
          <div class="fg"><label>Até</label><input type="date" id="e-df"></div>
          <div class="fg"><label>Status NF-e</label>
            <select id="e-st">
              <option value="todos">Todos</option>
              <option value="autorizada">Autorizada</option>
              <option value="cancelada">Cancelada</option>
              <option value="pendente">Pendente</option>
              <option value="erro">Erro</option>
            </select>
          </div>
          <div class="fg"><label>Busca (nº fatura)</label><input type="text" id="e-bq" placeholder="INV/2025/..."></div>
          <div class="fg"><label>&nbsp;</label>
            <div class="bgroup">
              <button class="btn btn-o" onclick="preset('e',0)">Hoje</button>
              <button class="btn btn-o" onclick="preset('e',7)">7d</button>
              <button class="btn btn-o" onclick="preset('e',30)">30d</button>
              <button class="btn btn-o" onclick="preset('e',365)">Ano</button>
              <button class="btn btn-p" onclick="loadEmit()">🔍 Pesquisar</button>
            </div>
          </div>
        </div>
        <div id="e-sum"></div>
        <div id="e-tbl"><div class="loading"><span class="spin"></span>Aguardando...</div></div>
      </div>
    </div>
  </div>

  <!-- Faturas -->
  <div id="op-fat" style="display:none">
    <div class="panel">
      <div class="ph">
        <h3>Faturas / Contas a Receber</h3>
        <button class="btn btn-o" onclick="loadFat()">↻</button>
        <button class="btn btn-xl" onclick="exportarExcelFat()" title="Exportar para Excel/CSV">📊 Exportar Excel</button>
      </div>
      <div class="pb">
        <div class="filters">
          <div class="fg"><label>Tipo</label>
            <select id="f-tipo">
              <option value="saida">Saída (Clientes)</option>
              <option value="entrada">Entrada (Fornecedores)</option>
            </select>
          </div>
          <div class="fg"><label>De</label><input type="date" id="f-di"></div>
          <div class="fg"><label>Até</label><input type="date" id="f-df"></div>
          <div class="fg"><label>Status Pag.</label>
            <select id="f-st">
              <option value="todos">Todos</option>
              <option value="not_paid">Não pago</option>
              <option value="partial">Parcial</option>
              <option value="paid">Pago</option>
              <option value="in_payment">Em pagamento</option>
            </select>
          </div>
          <div class="fg"><label>Busca</label><input type="text" id="f-bq" placeholder="INV/2025/..."></div>
          <div class="fg"><label>&nbsp;</label>
            <div class="bgroup">
              <button class="btn btn-o" onclick="preset('f',0)">Hoje</button>
              <button class="btn btn-o" onclick="preset('f',7)">7d</button>
              <button class="btn btn-o" onclick="preset('f',30)">30d</button>
              <button class="btn btn-o" onclick="preset('f',365)">Ano</button>
              <button class="btn btn-p" onclick="loadFat()">🔍 Pesquisar</button>
            </div>
          </div>
        </div>
        <div id="f-sum"></div>
        <div id="f-tbl"><div class="loading"><span class="spin"></span>Aguardando...</div></div>
      </div>
    </div>
  </div>
</div>

<!-- ══ ITAÚ ══════════════════════════════════════════════════════ -->
<div id="p-itau" class="pane">
  <div class="panel"><div class="pb"><div class="empty">Em breve — Itaú</div></div></div>
</div>

<!-- ══ TE ════════════════════════════════════════════════════════ -->
<div id="p-te" class="pane">
  <div class="panel"><div class="pb"><div class="empty">Em breve — TudoEntregue</div></div></div>
</div>

<!-- ══ STATUS ════════════════════════════════════════════════════ -->
<div id="p-status" class="pane">
  <div class="panel">
    <div class="ph"><h3>⚙️ Status do Servidor</h3><button class="btn btn-o" onclick="loadStatus()">↻</button></div>
    <div class="pb"><div id="st-body"><div class="loading"><span class="spin"></span>Carregando...</div></div></div>
  </div>
</div>

</div><!-- /main -->

<script>
function today(){ return new Date().toISOString().slice(0,10); }
function daysAgo(n){ var d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function fmtDate(s){ if(!s) return '—'; return new Date(s+'T12:00:00').toLocaleDateString('pt-BR'); }
function fmtVal(v){ if(v===null||v===undefined||v==='') return '—'; return 'R$ '+parseFloat(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtChave(c){ if(!c||c.length<12) return c||'—'; return c.slice(0,6)+'…'+c.slice(-6); }

function badge(s){
  var map={
    autorizada:'ok',autorizado:'ok',paid:'ok',in_payment:'ok',
    cancelada:'can',cancelado:'can',
    pendente:'warn',partial:'warn',processando:'warn',cancelando:'warn',
    not_paid:'err',erro:'err',error:'err'
  };
  var label={
    paid:'Pago',in_payment:'Em pag.',not_paid:'Não pago',partial:'Parcial',
    autorizada:'Autorizada',cancelada:'Cancelada',pendente:'Pendente',erro:'Erro'
  };
  var cls=map[(s||'').toLowerCase()]||'gray';
  return '<span class="b b-'+cls+'">'+(label[s]||s||'—')+'</span>';
}

async function get(url){
  try{
    var ctrl=new AbortController();
    var t=setTimeout(()=>ctrl.abort(),35000);
    var r=await fetch(url,{credentials:'include',signal:ctrl.signal});
    clearTimeout(t);
    return await r.json();
  }catch(e){
    return {erro: e.name==='AbortError'?'Timeout — servidor demorou demais':e.message};
  }
}

function preset(pfx, days){
  var di=document.getElementById(pfx+'-di'), df=document.getElementById(pfx+'-df');
  if(!di||!df) return;
  df.value=today();
  di.value=days===0?today():daysAgo(days);
}

var loaded={};
function tab(name, el){
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.getElementById('p-'+name).classList.add('on');
  el.classList.add('on');
  if(!loaded[name]){
    loaded[name]=true;
    if(name==='sieg') loadRec();
    if(name==='odoo') loadDash();
    if(name==='status') loadStatus();
  }
}

// ── Sub-tabs SIEG ────────────────────────────────────────────────
function stabSieg(name, el){
  document.querySelectorAll('#p-sieg .stab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('sp-rec').style.display = name==='rec'?'':'none';
}

// ── Sub-tabs Odoo ────────────────────────────────────────────────
function stabOdoo(name, el){
  document.querySelectorAll('#p-odoo .stab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('op-dash').style.display = name==='dash'?'':'none';
  document.getElementById('op-emit').style.display = name==='emit'?'':'none';
  document.getElementById('op-fat').style.display  = name==='fat' ?'':'none';
  if(name==='emit' && !loaded['emit']){ loaded['emit']=true; loadEmit(); }
  if(name==='fat'  && !loaded['fat'] ){ loaded['fat'] =true; loadFat();  }
}

// ── Status ───────────────────────────────────────────────────────
async function loadStatus(){
  var d=await get('/admin/api/status');
  document.getElementById('env-tag').textContent=d.ambiente||'?';
  document.getElementById('env-tag').className='tag '+(d.ambiente==='Produção'?'tag-prod':'tag-hom');
  var h=Math.floor((d.uptime_s||0)/3600), m=Math.floor(((d.uptime_s||0)%3600)/60);
  document.getElementById('up').textContent='Uptime '+h+'h '+m+'m';
  if(d.erro){document.getElementById('st-body').innerHTML='<div class="err-box">'+d.erro+'</div>';return;}
  document.getElementById('st-body').innerHTML=
    '<table><tr><th>Chave</th><th>Valor</th></tr>'+
    '<tr><td>Ambiente</td><td>'+badge(d.ambiente)+'</td></tr>'+
    '<tr><td>Uptime</td><td>'+h+'h '+m+'m</td></tr>'+
    '<tr><td>Timestamp</td><td>'+new Date(d.timestamp).toLocaleString('pt-BR')+'</td></tr>'+
    '</table>';
}

// ── Dashboard Odoo ───────────────────────────────────────────────
async function loadDash(){
  document.getElementById('kpi-area').innerHTML='<div class="loading"><span class="spin"></span>Carregando dashboard...</div>';
  var d=await get('/admin/api/odoo/dashboard');
  if(d.erro){
    document.getElementById('kpi-area').innerHTML='<div class="err-box">❌ '+d.erro+'</div>';
    return;
  }
  var mes=new Date().toLocaleString('pt-BR',{month:'long',year:'numeric'});
  var html='';

  // KPIs
  html+='<div class="kpi-grid">';
  html+='<div class="kpi blue"><div class="kpi-label">NF-e Emitidas (mês)</div><div class="kpi-val">'+d.nfeMes+'</div><div class="kpi-sub">'+mes+'</div></div>';
  html+='<div class="kpi green"><div class="kpi-label">Valor NF-e (mês)</div><div class="kpi-val">'+fmtVal(d.valorNfeMes)+'</div><div class="kpi-sub">'+mes+'</div></div>';
  html+='<div class="kpi green"><div class="kpi-label">Recebido (mês)</div><div class="kpi-val">'+fmtVal(d.valorRecebidoMes)+'</div><div class="kpi-sub">Faturas pagas em '+mes+'</div></div>';
  html+='<div class="kpi '+(d.faturasVencidas>0?'red':'gray')+'"><div class="kpi-label">Faturas Vencidas</div><div class="kpi-val">'+d.faturasVencidas+'</div><div class="kpi-sub">Aguardando pagamento</div></div>';
  html+='</div>';

  // Linha: Próximas a vencer + Top clientes
  html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;flex-wrap:wrap">';

  // Próximas a vencer
  html+='<div class="panel"><div class="ph"><h3>⚠️ Próximas a Vencer / Em Aberto</h3></div><div class="pb">';
  if(!d.faturasAbertasTop || !d.faturasAbertasTop.length){
    html+='<div class="empty" style="padding:24px">Nenhuma fatura em aberto.</div>';
  } else {
    html+='<div class="tw"><table><thead><tr><th>Fatura</th><th>Cliente</th><th>Vencimento</th><th>Saldo</th></tr></thead><tbody>';
    d.faturasAbertasTop.forEach(function(f){
      var hoje=new Date().toISOString().slice(0,10);
      var venc=f.vencimento||'';
      var atrasada=venc && venc<hoje;
      html+='<tr>';
      html+='<td style="font-family:monospace;font-size:12px">'+f.numero+'</td>';
      html+='<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+f.cliente+'">'+f.cliente+'</td>';
      html+='<td style="'+(atrasada?'color:var(--rd);font-weight:600':'')+'">'+fmtDate(venc)+(atrasada?' ⚠️':'')+'</td>';
      html+='<td style="font-weight:600">'+fmtVal(f.saldo)+'</td>';
      html+='</tr>';
    });
    html+='</tbody></table></div>';
  }
  html+='</div></div>';

  // Top clientes
  html+='<div class="panel"><div class="ph"><h3>🏆 Top Clientes (ano)</h3></div><div class="pb">';
  if(!d.topClientes || !d.topClientes.length){
    html+='<div class="empty" style="padding:24px">Sem dados.</div>';
  } else {
    var maxVal=d.topClientes[0].total||1;
    d.topClientes.forEach(function(tc){
      var pct=Math.max(4,Math.round((tc.total/maxVal)*100));
      html+='<div class="top-bar">';
      html+='<div class="top-bar-name" title="'+tc.cliente+'">'+tc.cliente+'</div>';
      html+='<div style="flex:2;display:flex;align-items:center"><div class="top-bar-fill" style="width:'+pct+'%"></div></div>';
      html+='<div class="top-bar-val">'+fmtVal(tc.total)+'</div>';
      html+='</div>';
    });
  }
  html+='</div></div>';
  html+='</div>';

  document.getElementById('kpi-area').innerHTML=html;
}

// ── NF-e Emitidas ────────────────────────────────────────────────
async function loadEmit(){
  document.getElementById('e-tbl').innerHTML='<div class="loading"><span class="spin"></span>Buscando no Odoo...</div>';
  document.getElementById('e-sum').innerHTML='';
  var di=document.getElementById('e-di').value;
  var df=document.getElementById('e-df').value;
  var st=document.getElementById('e-st').value;
  var bq=document.getElementById('e-bq').value;
  var url='/admin/api/sieg/emitidas?status='+encodeURIComponent(st||'todos');
  if(di) url+='&dataInicio='+di;
  if(df) url+='&dataFim='+df;
  if(bq) url+='&busca='+encodeURIComponent(bq);
  var d=await get(url);
  if(d.erro){ document.getElementById('e-tbl').innerHTML='<div class="err-box">❌ '+d.erro+'</div>'; return; }
  var reg=d.registros||[];
  if(!reg.length){ document.getElementById('e-tbl').innerHTML='<div class="empty">Nenhuma NF-e encontrada.</div>'; return; }
  var tot=reg.reduce((a,r)=>a+(parseFloat(r.valor)||0),0);
  document.getElementById('e-sum').innerHTML='<div class="sum">'+reg.length+' nota(s) &nbsp;·&nbsp; Total: <b>'+fmtVal(tot)+'</b></div>';
  var html='<div class="tw"><table id="emit-table"><thead><tr><th>#</th><th>Fatura</th><th>Cliente</th><th>Data</th><th>Valor</th><th>Status NF-e</th><th>Protocolo</th><th>Chave</th></tr></thead><tbody>';
  reg.forEach((r,i)=>{
    html+='<tr>';
    html+='<td style="color:var(--tx2);font-size:12px">'+(i+1)+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+r.numero+'</td>';
    html+='<td>'+r.cliente+'</td>';
    html+='<td>'+fmtDate(r.data)+'</td>';
    html+='<td style="font-weight:600">'+fmtVal(r.valor)+'</td>';
    html+='<td>'+badge(r.status)+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--tx2)">'+(r.protocolo||'—')+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--tx2)" title="'+r.chave+'">'+fmtChave(r.chave)+'</td>';
    html+='</tr>';
  });
  html+='</tbody></table></div>';
  document.getElementById('e-tbl').innerHTML=html;
}

// ── Faturas Odoo ─────────────────────────────────────────────────
async function loadFat(){
  document.getElementById('f-tbl').innerHTML='<div class="loading"><span class="spin"></span>Buscando faturas no Odoo...</div>';
  document.getElementById('f-sum').innerHTML='';
  var di=document.getElementById('f-di').value;
  var df=document.getElementById('f-df').value;
  var st=document.getElementById('f-st').value;
  var bq=document.getElementById('f-bq').value;
  var tipo=document.getElementById('f-tipo').value;
  var url='/admin/api/odoo/faturas?tipo='+tipo+'&status='+encodeURIComponent(st||'todos');
  if(di) url+='&dataInicio='+di;
  if(df) url+='&dataFim='+df;
  if(bq) url+='&busca='+encodeURIComponent(bq);
  var d=await get(url);
  if(d.erro){ document.getElementById('f-tbl').innerHTML='<div class="err-box">❌ '+d.erro+'</div>'; return; }
  var reg=d.registros||[];
  if(!reg.length){ document.getElementById('f-tbl').innerHTML='<div class="empty">Nenhuma fatura encontrada.</div>'; return; }
  var totTotal=reg.reduce((a,r)=>a+(parseFloat(r.total)||0),0);
  var totSaldo=reg.reduce((a,r)=>a+(parseFloat(r.saldo)||0),0);
  document.getElementById('f-sum').innerHTML='<div class="sum">'+reg.length+' fatura(s) &nbsp;·&nbsp; Total: <b>'+fmtVal(totTotal)+'</b> &nbsp;·&nbsp; Em aberto: <b>'+fmtVal(totSaldo)+'</b></div>';
  var html='<div class="tw"><table id="fat-table"><thead><tr><th>#</th><th>Fatura</th><th>Ref.</th><th>Parceiro</th><th>Emissão</th><th>Vencimento</th><th>Total</th><th>Saldo</th><th>Status Pag.</th></tr></thead><tbody>';
  var hoje=new Date().toISOString().slice(0,10);
  reg.forEach((r,i)=>{
    var atrasada=r.saldo>0 && r.dataVencimento && r.dataVencimento<hoje;
    html+='<tr>';
    html+='<td style="color:var(--tx2);font-size:12px">'+(i+1)+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+r.numero+'</td>';
    html+='<td style="font-size:12px;color:var(--tx2)">'+(r.ref||'—')+'</td>';
    html+='<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+r.parceiro+'">'+r.parceiro+'</td>';
    html+='<td>'+fmtDate(r.dataEmissao)+'</td>';
    html+='<td style="'+(atrasada?'color:var(--rd);font-weight:600':'')+'">'+fmtDate(r.dataVencimento)+(atrasada?' ⚠️':'')+'</td>';
    html+='<td style="font-weight:600">'+fmtVal(r.total)+'</td>';
    html+='<td style="'+(r.saldo>0?'color:var(--yw)':'color:var(--gr)')+'">'+fmtVal(r.saldo)+'</td>';
    html+='<td>'+badge(r.statusPagamento)+'</td>';
    html+='</tr>';
  });
  html+='</tbody></table></div>';
  document.getElementById('f-tbl').innerHTML=html;
}

// ── SIEG Recebidas ───────────────────────────────────────────────
function downloadZip(){
  var di=document.getElementById('r-di').value;
  var df=document.getElementById('r-df').value;
  var tipo=document.getElementById('r-tipo').value;
  var url='/admin/api/sieg/download-zip?tipoXml='+tipo;
  if(di) url+='&dataInicio='+di;
  if(df) url+='&dataFim='+df;
  var a=document.createElement('a');
  a.href=url; a.download=''; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

async function loadRec(){
  document.getElementById('r-tbl').innerHTML='<div class="loading"><span class="spin"></span>Consultando SIEG...</div>';
  document.getElementById('r-sum').innerHTML='';
  var di=document.getElementById('r-di').value;
  var df=document.getElementById('r-df').value;
  var tipo=document.getElementById('r-tipo').value;
  var cnpj=(document.getElementById('r-cnpj')||{}).value||'';
  var cnpjDest=(document.getElementById('r-cnpj-dest')||{}).value||'';
  var emitNome=(document.getElementById('r-emit')||{}).value||'';
  var destNome=(document.getElementById('r-dest-nome')||{}).value||'';
  var url='/admin/api/sieg/recebidas?tipoXml='+tipo;
  if(di) url+='&dataInicio='+di;
  if(df) url+='&dataFim='+df;
  if(cnpj.replace(/\D/g,'')) url+='&cnpjEmitente='+encodeURIComponent(cnpj.replace(/\D/g,''));
  if(cnpjDest.replace(/\D/g,'')) url+='&cnpjDestinatario='+encodeURIComponent(cnpjDest.replace(/\D/g,''));
  if(emitNome.trim()) url+='&nomeEmitente='+encodeURIComponent(emitNome.trim());
  if(destNome.trim()) url+='&nomeDestinatario='+encodeURIComponent(destNome.trim());

  var d=await get(url);
  if(d.erro){ document.getElementById('r-tbl').innerHTML='<div class="err-box">⚠️ '+d.erro+'</div>'; return; }
  var reg=d.registros||[];
  if(!reg.length){ document.getElementById('r-tbl').innerHTML='<div class="empty">Nenhuma NF-e encontrada.</div>'; return; }

  var tot=reg.reduce((a,r)=>a+(parseFloat(r.valor)||0),0);
  document.getElementById('r-sum').innerHTML='<div class="sum">'+reg.length+' nota(s) &nbsp;·&nbsp; Total: <b>'+fmtVal(tot)+'</b></div>';

  var tipoAtual=tipo;
  var dtDl=new Date().toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

  var html='<div class="sel-bar" id="sel-bar">'
    +'<span id="sel-count">0 selecionado(s)</span>'
    +'<button class="btn btn-o" style="font-size:12px" onclick="dlSelecionados()">⬇ XML Selecionados</button>'
    +'<button class="btn btn-o" style="font-size:12px" onclick="deselectAll()">✕ Limpar</button>'
    +'</div>';

  html+='<div class="tw"><table id="r-table"><thead><tr>'
    +'<th class="chk"><input type="checkbox" id="chk-all" onclick="toggleAll(this)" title="Selecionar todos"></th>'
    +'<th>Tipo</th><th>Nº</th><th>Rz. Emit.</th><th>CNPJ Emit.</th>'
    +'<th>Data de Emi.</th><th>CNPJ Dest.</th><th>Destinatário</th>'
    +'<th>Valor</th><th>Dt. do Download</th><th>Chave</th><th>+Detalhes</th>'
    +'</tr></thead><tbody>';

  reg.forEach(function(r){
    var xmlUrl='/admin/api/sieg/xml/'+(r.chave||'')+'?tipoXml='+tipoAtual;
    var pdfUrl='/admin/api/sieg/pdf/'+(r.chave||'')+'?tipoXml='+tipoAtual;
    var ce=(r.chave||'').replace(/"/g,'');
    html+='<tr>';
    html+='<td class="chk"><input type="checkbox" class="row-chk" data-chave="'+ce+'" data-tipo="'+tipoAtual+'" onchange="updateSelBar()"></td>';
    html+='<td><span class="b b-ok" style="font-size:10px">'+(r.tipo||'NF-e')+'</span></td>';
    html+='<td style="font-family:monospace;font-weight:600">'+(r.numero||'—')+'</td>';
    html+='<td style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(r.emitente||'')+'">'+(r.emitente||'—')+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+(r.cnpjEmitente||'—')+'</td>';
    html+='<td>'+fmtDate(r.dataEmissao)+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+(r.cnpjDestinatario||'—')+'</td>';
    html+='<td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(r.destinatario||'')+'">'+(r.destinatario||'—')+'</td>';
    html+='<td style="font-weight:600">'+fmtVal(r.valor)+'</td>';
    html+='<td class="dt-dl">'+dtDl+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--tx2)" title="'+(r.chave||'')+'">'+fmtChave(r.chave)+'</td>';
    html+='<td>';
    if(r.chave){
      html+='<div class="row-menu">'
        +'<button class="btn btn-o" style="padding:4px 10px;font-size:12px" onclick="toggleMenu(this)">⋯</button>'
        +'<div class="row-dropdown">'
        +'<a href="#" class="dl-link" data-url="'+xmlUrl+'" data-file="NFe_'+ce+'.xml">⬇ Baixar XML</a>'
        +'<a href="#" class="dl-link" data-url="'+pdfUrl+'" data-file="NFe_'+ce+'.pdf">⬇ Baixar PDF</a>'
        +'</div></div>';
    } else { html+='—'; }
    html+='</td></tr>';
  });
  html+='</tbody></table></div>';
  document.getElementById('r-tbl').innerHTML=html;
  updateSelBar();
}

// ── Download via fetch ────────────────────────────────────────────
async function downloadFile(url, filename){
  try {
    var r = await fetch(url, { credentials: 'include' });
    if(!r.ok){ var e=await r.json().catch(()=>({erro:'Erro '+r.status})); alert('Erro: '+(e.erro||r.status)); return; }
    var blob = await r.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
  } catch(e){ alert('Erro ao baixar: '+e.message); }
}

// ── Mais Opções ───────────────────────────────────────────────────
function toggleMaisOpcoes(){
  var ef=document.getElementById('extra-filters');
  var ml=document.getElementById('mais-link');
  if(!ef) return;
  var open=ef.classList.toggle('open');
  if(ml) ml.textContent=open?'Menos Opções ▴':'Mais Opções ▾';
}

// ── Seleção de linhas ─────────────────────────────────────────────
function updateSelBar(){
  var chks=document.querySelectorAll('.row-chk:checked');
  var bar=document.getElementById('sel-bar');
  var cnt=document.getElementById('sel-count');
  if(cnt) cnt.textContent=chks.length+' selecionado(s)';
  if(bar) bar.classList.toggle('on', chks.length>0);
}
function toggleAll(chkAll){
  document.querySelectorAll('.row-chk').forEach(function(c){c.checked=chkAll.checked;});
  updateSelBar();
}
function deselectAll(){
  document.querySelectorAll('.row-chk').forEach(function(c){c.checked=false;});
  var a=document.getElementById('chk-all'); if(a) a.checked=false;
  updateSelBar();
}
async function dlSelecionados(){
  var chks=Array.from(document.querySelectorAll('.row-chk:checked'));
  if(!chks.length){alert('Nenhuma nota selecionada.');return;}
  for(var c of chks){
    var chave=c.dataset.chave, tipo=c.dataset.tipo||'1';
    await downloadFile('/admin/api/sieg/xml/'+chave+'?tipoXml='+tipo,'NFe_'+chave+'.xml');
    await new Promise(function(r){setTimeout(r,400);});
  }
}

// ── Exportar Excel (CSV UTF-8) ────────────────────────────────────
function exportarCsv(tableId, filename){
  var tbl=document.getElementById(tableId);
  if(!tbl){alert('Faça uma consulta primeiro.');return;}
  var rows=tbl.querySelectorAll('tr'), csv=[];
  rows.forEach(function(row){
    var cells=row.querySelectorAll('th,td'), line=[];
    cells.forEach(function(cell,idx){
      // pula checkbox (idx=0) e coluna +Detalhes (última) quando existir
      if(cell.querySelector('input[type=checkbox]')) return;
      if(cell.querySelector('.row-menu')) return;
      line.push('"'+cell.innerText.replace(/"/g,'""').replace(/\n/g,' ')+'"');
    });
    if(line.length) csv.push(line.join(';'));
  });
  var blob=new Blob(['\uFEFF'+csv.join('\n')],{type:'text/csv;charset=utf-8;'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);document.body.removeChild(a);},1000);
}
function exportarExcelRec(){ exportarCsv('r-table','sieg-recebidas-'+today()+'.csv'); }
function exportarExcelEmit(){ exportarCsv('emit-table','odoo-emitidas-'+today()+'.csv'); }
function exportarExcelFat(){ exportarCsv('fat-table','odoo-faturas-'+today()+'.csv'); }

// ── Menu dropdown por linha ───────────────────────────────────────
function toggleMenu(btn){
  var dd=btn.nextElementSibling;
  var isOpen=dd.classList.contains('open');
  document.querySelectorAll('.row-dropdown.open').forEach(function(el){el.classList.remove('open');});
  if(!isOpen) dd.classList.add('open');
}
document.addEventListener('click',function(e){
  var dlLink = e.target.closest('.dl-link');
  if(dlLink){
    e.preventDefault();
    downloadFile(dlLink.dataset.url, dlLink.dataset.file);
    document.querySelectorAll('.row-dropdown.open').forEach(function(el){el.classList.remove('open');});
    return;
  }
  if(!e.target.closest('.row-menu')) document.querySelectorAll('.row-dropdown.open').forEach(function(el){el.classList.remove('open');});
});

// ── Init ──────────────────────────────────────────────────────────
preset('e',30);
preset('r',3);
preset('f',30);
loadStatus();
loadRec();
</script>
</body></html>`;
}

module.exports = router;
