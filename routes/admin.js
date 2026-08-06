/**
 * routes/admin.js — Painel Admin AJL (v3 — sem dependência cookie-parser)
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
// Limpar entradas expiradas a cada 10 min
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
  // Aceita também via header Authorization para testes
  var ah = req.headers['authorization'] || '';
  if (ah.startsWith('Bearer ') && validateToken(ah.slice(7))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Não autenticado' });
  res.redirect('/admin/login');
}

// ── Odoo helpers ──────────────────────────────────────────────────
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

// ── Dashboard (HTML) ──────────────────────────────────────────────
router.get('/', auth, (req, res) => res.send(dashHtml()));

// ════════════════════════════════════════════════════════════════
// APIs — SIEG
// ════════════════════════════════════════════════════════════════

// NF-e emitidas — lidas do Odoo (têm chave autorizada)
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

// NF-e recebidas — POST /api/v1/baixar-xmls (TipoXml=1 = NF-e entrada)
// TipoXml: 1=NFe recebida, 2=NFe emitida cofre, 3=CTe, 4=NFSe, 5=CFe, 6=NFCe, 7=CTe OS, 8=CTe emitido, 10=MDFe, 99=todos, 100=NFe emitida SEFAZ
router.get('/api/sieg/recebidas', auth, async (req, res) => {
  try {
    var axios = require('axios');
    var { getAuthHeaders } = require('../services/sieg-auth');
    var headers = await withTimeout(getAuthHeaders(), 15000);
    var { dataInicio, dataFim, cnpjEmitente, cnpjDestinatario, pagina, tipoXml } = req.query;

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

    // A SIEG retorna um arquivo ZIP binário com os XMLs
    // Precisamos descompactar e extrair dados de cada XML
    var respBuffer = resp.data; // Buffer (axios com responseType: 'arraybuffer')
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

        // Remover prefixos de namespace (ex: <nfe:infNFe> -> <infNFe>)
        var xml = xmlStr
          .replace(/\s+xmlns(?::[^=]+)?="[^"]*"/g, '')
          .replace(/<([A-Za-z]+):[A-Za-z]/g, function(m,p){ return '<'; })
          .replace(/<\/([A-Za-z]+):[A-Za-z]/g, function(m,p){ return '</'; });

        // Extrai texto de uma tag
        function xt(tag) {
          var re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\/' + tag + '>', 'i');
          var m = xml.match(re);
          return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
        }
        // Extrai texto de uma tag dentro de um bloco pai
        function xb(parent, tag) {
          var rp = new RegExp('<' + parent + '(?:\\s[^>]*)?>([\\s\\S]*?)<\/' + parent + '>', 'i');
          var mp = xml.match(rp);
          if (!mp) return '';
          var re2 = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\/' + tag + '>', 'i');
          var m2 = mp[1].match(re2);
          return m2 ? m2[1].replace(/<[^>]+>/g, '').trim() : '';
        }

        // Chave de acesso — atributo Id ou tag chNFe/chCTe
        var chaveM = xml.match(/Id="(?:NFe|CTe|MDFe)?(\d{44})"/i)
                  || xml.match(/<chNFe>(\d{44})</)
                  || xml.match(/<chCTe>(\d{44})</);
        var chave = chaveM ? chaveM[1] : '';

        // Deduplicar por chave
        if (chave && chavesVistas[chave]) continue;
        if (chave) chavesVistas[chave] = true;
        // Popular cache para download individual
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
          chave,
          numero: nNF,
          serie,
          emitente: emitNome,
          cnpjEmitente: emitCNPJ,
          destinatario: destNome,
          cnpjDestinatario: destCNPJ,
          dataEmissao: dhEmi.slice(0, 10),
          valor: vNF,
        });
        if (registros.length <= 2) {
          console.log('[ADMIN] XML parse sample — emit:', emitNome, 'dest:', destNome, 'nNF:', nNF, 'vNF:', vNF, 'chave:', chave.slice(0,10));
        }
      } catch(ezip) {
        console.warn('[ADMIN] Erro ao parsear entry', entry.entryName, ezip.message);
      }
    }

    res.json({ total: registros.length, registros, pagina: parseInt(pagina) || 1 });
  } catch(e) {
    console.error('[ADMIN] sieg/recebidas erro:', e.message);
    res.json({ erro: 'SIEG: ' + e.message, registros: [] });
  }
});


// Download XML individual por chave — usa cache do ZIP já baixado
router.get('/api/sieg/xml/:chave', auth, async (req, res) => {
  try {
    var chave = req.params.chave;
    // 1. Tentar cache (populado quando a tabela foi consultada)
    var cached = cacheGet(chave);
    if (cached) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="NFe_' + chave + '.xml"');
      return res.send(cached);
    }
    // 2. Fallback: buscar o mês inteiro da chave na SIEG
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

    // Buscar sem filtro de CNPJ para garantir achar (tanto emitida quanto recebida)
    var body = { TipoXml: tipoXml, Take: 500, Skip: 0,
      DataEmissaoInicio: di + 'T00:00:00Z',
      DataEmissaoFim:    df + 'T23:59:59Z',
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
      // popular cache para todas as entradas encontradas
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

// Download PDF individual por chave — endpoint SIEG /api/v1/GetPdf
router.get('/api/sieg/pdf/:chave', auth, async (req, res) => {
  try {
    var axios  = require('axios');
    var { getAuthHeaders } = require('../services/sieg-auth');
    var headers = await withTimeout(getAuthHeaders(), 15000);
    var chave   = req.params.chave;
    // SIEG endpoint para PDF individual
    var resp = await withTimeout(axios.get('https://api.sieg.com/api/v1/GetPdf?chaveAcesso=' + chave, {
      headers, timeout: 30000, responseType: 'arraybuffer',
    }), 35000);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="NFe_' + chave + '.pdf"');
    res.send(Buffer.from(resp.data));
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
    var tresAtrás = new Date(hoje); tresAtrás.setDate(hoje.getDate() - 3);
    var di = dataInicio || tresAtrás.toISOString().slice(0,10);
    var df = dataFim    || hoje.toISOString().slice(0,10);

    var body = {
      TipoXml: parseInt(tipoXml) || 1,
      Take: 200,
      Skip: 0,
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

// Status geral (leve — sem Odoo)
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

/* tabs */
.tabs{background:var(--bg2);border-bottom:1px solid var(--bd);padding:0 20px;display:flex;overflow-x:auto}
.tab{padding:14px 18px;font-size:13px;font-weight:500;color:var(--tx2);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;user-select:none}
.tab:hover{color:var(--tx)}.tab.on{color:var(--ac);border-bottom-color:var(--ac)}

/* sub-tabs (dentro de SIEG) */
.subtabs{display:flex;gap:0;margin-bottom:20px;background:var(--bg3);border-radius:8px;padding:4px;width:fit-content}
.stab{padding:7px 18px;border-radius:6px;font-size:13px;font-weight:500;color:var(--tx2);cursor:pointer;transition:all .15s;user-select:none}
.stab:hover{color:var(--tx)}.stab.on{background:var(--bg2);color:var(--ac);box-shadow:0 1px 4px rgba(0,0,0,.3)}

/* main */
.main{padding:24px;max-width:1400px;margin:0 auto}
.pane{display:none}.pane.on{display:block}
.panel{background:var(--bg2);border:1px solid var(--bd);border-radius:12px;overflow:hidden;margin-bottom:20px}
.ph{padding:16px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ph h3{font-size:14px;font-weight:600;color:#fff;flex:1}
.pb{padding:20px}

/* filtros */
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.fg{display:flex;flex-direction:column;gap:4px}
.fg label{font-size:11px;color:var(--tx2);text-transform:uppercase;letter-spacing:.4px}
.fg input,.fg select{background:var(--bg3);border:1px solid var(--bd);color:var(--tx);padding:7px 12px;border-radius:6px;font-size:13px;outline:none;min-width:110px}
.fg input:focus,.fg select:focus{border-color:var(--ac)}
.btn{padding:7px 14px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500}
.btn-p{background:var(--ac);color:#fff}.btn-p:hover{background:#79b8ff}
.btn-o{background:transparent;color:var(--tx2);border:1px solid var(--bd)}.btn-o:hover{border-color:var(--tx);color:var(--tx)}
.bgroup{display:flex;gap:6px;flex-wrap:wrap}

/* table */
.tw{overflow-x:auto;margin-top:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--tx2);border-bottom:1px solid var(--bd);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--bd);color:var(--tx);vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:rgba(255,255,255,.02)}

/* badges */
.b{display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.3px}
.b-ok{background:#1a3a1a;color:#3fb950;border:1px solid #238636}
.b-warn{background:#3a2e1f;color:#d29922;border:1px solid #bb8009}
.b-err{background:#3a1a1a;color:#f85149;border:1px solid #b91c1c}
.b-can{background:#1f1a3a;color:#bc8cff;border:1px solid #6e40c9}
.b-gray{background:#21262d;color:#8b949e;border:1px solid #30363d}

/* misc */
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
    <div class="stab on" onclick="stab('emit',this)">📤 NF-e Emitidas</div>
    <div class="stab" onclick="stab('rec',this)">📥 NF-e Recebidas</div>
  </div>

  <!-- Emitidas -->
  <div id="sp-emit">
    <div class="panel">
      <div class="ph"><h3>NF-e Emitidas pela AJL</h3><button class="btn btn-o" onclick="loadEmit()">↻</button></div>
      <div class="pb">
        <div class="filters">
          <div class="fg"><label>De</label><input type="date" id="e-di"></div>
          <div class="fg"><label>Até</label><input type="date" id="e-df"></div>
          <div class="fg"><label>Status</label>
            <select id="e-st">
              <option value="todos">Todos</option>
              <option value="autorizada">Autorizada</option>
              <option value="cancelada">Cancelada</option>
              <option value="pendente">Pendente</option>
              <option value="erro">Erro</option>
            </select>
          </div>
          <div class="fg"><label>Busca</label><input type="text" id="e-bq" placeholder="NFe 000..."></div>
          <div class="fg"><label>&nbsp;</label>
            <div class="bgroup">
              <button class="btn btn-o" onclick="preset('e',0)">Hoje</button>
              <button class="btn btn-o" onclick="preset('e',7)">7d</button>
              <button class="btn btn-o" onclick="preset('e',30)">30d</button>
              <button class="btn btn-o" onclick="preset('e',365)">Ano</button>
              <button class="btn btn-p" onclick="loadEmit()">Filtrar</button>
            </div>
          </div>
        </div>
        <div id="e-sum"></div>
        <div id="e-tbl"><div class="loading"><span class="spin"></span>Aguardando...</div></div>
      </div>
    </div>
  </div>

  <!-- Recebidas -->
  <div id="sp-rec" style="display:none">
    <div class="panel">
      <div class="ph"><h3>Consulta SIEG — NF-e / Documentos Fiscais</h3>
        <button class="btn btn-o" onclick="loadRec()">↻</button>
        <button class="btn btn-o" id="btn-zip" onclick="downloadZip()" title="Baixar ZIP com os XMLs">⬇ ZIP</button>
      </div>
      <div class="pb">
        <div class="filters">
          <div class="fg"><label>De</label><input type="date" id="r-di"></div>
          <div class="fg"><label>Até</label><input type="date" id="r-df"></div>
          <div class="fg"><label>Tipo</label>
            <select id="r-tipo">
              <option value="1">NF-e Recebidas (entradas)</option>
              <option value="2">NF-e Emitidas (cofre SIEG)</option>
              <option value="3">CT-e</option>
              <option value="4">NFS-e</option>
              <option value="6">NFC-e</option>
            </select>
          </div>
          <div class="fg"><label>CNPJ Emitente</label><input type="text" id="r-cnpj" placeholder="00.000.000/0001-00" style="min-width:170px"></div>
          <div class="fg"><label>&nbsp;</label>
            <div class="bgroup">
              <button class="btn btn-o" onclick="preset('r',0)">Hoje</button>
              <button class="btn btn-o" onclick="preset('r',7)">7d</button>
              <button class="btn btn-o" onclick="preset('r',30)">30d</button>
              <button class="btn btn-o" onclick="preset('r',365)">Ano</button>
              <button class="btn btn-p" onclick="loadRec()">Filtrar</button>
            </div>
          </div>
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

<!-- ══ ODOO (placeholder) ════════════════════════════════════════ -->
<div id="p-odoo" class="pane">
  <div class="panel"><div class="pb"><div class="empty">Em breve — Odoo</div></div></div>
</div>

<!-- ══ ITAÚ (placeholder) ════════════════════════════════════════ -->
<div id="p-itau" class="pane">
  <div class="panel"><div class="pb"><div class="empty">Em breve — Itaú</div></div></div>
</div>

<!-- ══ TE (placeholder) ══════════════════════════════════════════ -->
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
// ── util ──────────────────────────────────────────────────────────
function today(){ return new Date().toISOString().slice(0,10); }
function daysAgo(n){ var d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function fmtDate(s){ if(!s) return '—'; return new Date(s+'T12:00:00').toLocaleDateString('pt-BR'); }
function fmtVal(v){ if(v===null||v===undefined||v==='') return '—'; return 'R$ '+parseFloat(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtChave(c){ if(!c||c.length<12) return c||'—'; return c.slice(0,6)+'…'+c.slice(-6); }

function badge(s){
  var map={autorizada:'ok',autorizado:'ok',cancelada:'can',cancelado:'can',cancelando:'warn',pendente:'warn',processando:'warn',erro:'err',error:'err'};
  var cls=map[(s||'').toLowerCase()]||'gray';
  return '<span class="b b-'+cls+'">'+(s||'—')+'</span>';
}

async function get(url){
  try{
    var ctrl=new AbortController();
    var t=setTimeout(()=>ctrl.abort(),28000);
    var r=await fetch(url,{credentials:'include',signal:ctrl.signal});
    clearTimeout(t);
    return await r.json();
  }catch(e){
    return {erro: e.name==='AbortError'?'Timeout — servidor demorou demais':e.message};
  }
}

function preset(pfx, days){
  var di=document.getElementById(pfx+'-di'), df=document.getElementById(pfx+'-df');
  df.value=today();
  di.value=days===0?today():daysAgo(days);
}

// ── Tab logic ──────────────────────────────────────────────────────
var loaded={};
function tab(name, el){
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.getElementById('p-'+name).classList.add('on');
  el.classList.add('on');
  if(!loaded[name]){
    loaded[name]=true;
    if(name==='sieg') loadEmit();
    if(name==='status') loadStatus();
  }
}

function stab(name, el){
  document.querySelectorAll('.stab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('sp-emit').style.display = name==='emit'?'':'none';
  document.getElementById('sp-rec').style.display  = name==='rec' ?'':'none';
  if(name==='rec' && !loaded['rec']){ loaded['rec']=true; loadRec(); }
}

// ── Status (topbar + aba) ────────────────────────────────────────
async function loadStatus(){
  var d=await get('/admin/api/status');
  // topbar
  document.getElementById('env-tag').textContent=d.ambiente||'?';
  document.getElementById('env-tag').className='tag '+(d.ambiente==='Produção'?'tag-prod':'tag-hom');
  var h=Math.floor((d.uptime_s||0)/3600), m=Math.floor(((d.uptime_s||0)%3600)/60);
  document.getElementById('up').textContent='Uptime '+h+'h '+m+'m';
  // aba
  if(d.erro){document.getElementById('st-body').innerHTML='<div class="err-box">'+d.erro+'</div>';return;}
  document.getElementById('st-body').innerHTML=
    '<table><tr><th>Chave</th><th>Valor</th></tr>'+
    '<tr><td>Ambiente</td><td>'+badge(d.ambiente)+'</td></tr>'+
    '<tr><td>Uptime</td><td>'+h+'h '+m+'m</td></tr>'+
    '<tr><td>Timestamp</td><td>'+new Date(d.timestamp).toLocaleString('pt-BR')+'</td></tr>'+
    '</table>';
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

  var html='<div class="tw"><table><thead><tr><th>#</th><th>Fatura</th><th>Cliente</th><th>Data</th><th>Valor</th><th>Status</th><th>Protocolo</th><th>Chave</th></tr></thead><tbody>';
  reg.forEach((r,i)=>{
    html+='<tr>';
    html+='<td style="color:var(--tx2);font-size:12px">'+(i+1)+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+r.numero+'</td>';
    html+='<td>'+r.cliente+'</td>';
    html+='<td>'+fmtDate(r.data)+'</td>';
    html+='<td>'+fmtVal(r.valor)+'</td>';
    html+='<td>'+badge(r.status)+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--tx2)">'+(r.protocolo||'—')+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--tx2)" title="'+r.chave+'">'+fmtChave(r.chave)+'</td>';
    html+='</tr>';
  });
  html+='</tbody></table></div>';
  document.getElementById('e-tbl').innerHTML=html;
}

// ── Download ZIP ─────────────────────────────────────────────────
function downloadZip(){
  var di=document.getElementById('r-di').value;
  var df=document.getElementById('r-df').value;
  var tipo=document.getElementById('r-tipo').value;
  var url='/admin/api/sieg/download-zip?tipoXml='+tipo;
  if(di) url+='&dataInicio='+di;
  if(df) url+='&dataFim='+df;
  // Criar link oculto e clicar para download
  var a=document.createElement('a');
  a.href=url; a.download=''; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── NF-e Recebidas ───────────────────────────────────────────────
async function loadRec(){
  document.getElementById('r-tbl').innerHTML='<div class="loading"><span class="spin"></span>Consultando SIEG...</div>';
  document.getElementById('r-sum').innerHTML='';
  var di=document.getElementById('r-di').value;
  var df=document.getElementById('r-df').value;
  var cnpj=document.getElementById('r-cnpj').value;
  var tipo=document.getElementById('r-tipo').value;
  var url='/admin/api/sieg/recebidas?tipoXml='+tipo;
  if(di) url+='&dataInicio='+di;
  if(df) url+='&dataFim='+df;
  if(cnpj) url+='&cnpjEmitente='+encodeURIComponent(cnpj);

  var d=await get(url);
  if(d.erro){ document.getElementById('r-tbl').innerHTML='<div class="err-box">⚠️ '+d.erro+'</div>'; return; }
  var reg=d.registros||[];
  if(!reg.length){ document.getElementById('r-tbl').innerHTML='<div class="empty">Nenhuma NF-e recebida encontrada.</div>'; return; }

  var tot=reg.reduce((a,r)=>a+(parseFloat(r.valor)||0),0);
  document.getElementById('r-sum').innerHTML='<div class="sum">'+reg.length+' nota(s) &nbsp;·&nbsp; Total: <b>'+fmtVal(tot)+'</b></div>';

  var tipoAtual=document.getElementById('r-tipo')?document.getElementById('r-tipo').value:'1';
  var html='<div class="tw"><table><thead><tr>'
    +'<th>Emitente</th><th>Tipo</th><th>Número</th><th>Data Emissão</th>'
    +'<th>CNPJ Destinatário</th><th>Destinatário</th><th>Valor</th><th>Chave</th><th>Ações</th>'
    +'</tr></thead><tbody>';
  reg.forEach((r,i)=>{
    var xmlUrl='/admin/api/sieg/xml/'+(r.chave||'')+'?tipoXml='+tipoAtual;
    html+='<tr>';
    html+='<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+r.emitente+'">'+(r.emitente||'—')+'</td>';
    html+='<td><span class="b b-ok" style="font-size:10px">NF-e</span></td>';
    html+='<td style="font-family:monospace;font-weight:600">'+(r.numero||'—')+'</td>';
    html+='<td>'+fmtDate(r.dataEmissao)+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+(r.cnpjDestinatario||r.cnpjEmitente||'—')+'</td>';
    html+='<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(r.destinatario||'')+'">'+(r.destinatario||'—')+'</td>';
    html+='<td style="font-weight:600">'+fmtVal(r.valor)+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--tx2)" title="'+(r.chave||'')+'">'+fmtChave(r.chave)+'</td>';
    html+='<td>';
    if(r.chave){
      html+='<div class="row-menu">'
        +'<button class="btn btn-o" style="padding:4px 10px;font-size:12px" onclick="toggleMenu(this)">⋯</button>'
        +'<div class="row-dropdown">'
        +'<a href="'+xmlUrl+'" download="NFe_'+r.chave+'.xml">⬇ Baixar XML</a>'
        +'<a href="/admin/api/sieg/pdf/'+r.chave+'" download="NFe_'+r.chave+'.pdf">⬇ Baixar PDF</a>'
        +'</div>'
        +'</div>';
    } else { html+='—'; }
    html+='</td>';
    html+='</tr>';
  });
  html+='</tbody></table></div>';
  document.getElementById('r-tbl').innerHTML=html;
}

// ── Menu dropdown por linha ──────────────────────────────────────
function toggleMenu(btn){
  var dd=btn.nextElementSibling;
  var isOpen=dd.classList.contains('open');
  // Fechar todos os menus abertos
  document.querySelectorAll('.row-dropdown.open').forEach(function(el){el.classList.remove('open');});
  if(!isOpen) dd.classList.add('open');
}
// Fechar ao clicar fora
document.addEventListener('click',function(e){
  if(!e.target.closest('.row-menu')) document.querySelectorAll('.row-dropdown.open').forEach(function(el){el.classList.remove('open');});
});

// ── Init ──────────────────────────────────────────────────────────
preset('e',3);
preset('r',3);
loadStatus();
</script>
</body></html>`;
}

module.exports = router;

// Diagnóstico SIEG — testa endpoints e retorna o que responde 2xx
// REMOVER APÓS IDENTIFICAR O ENDPOINT CORRETO
router.get('/api/sieg/diagnostico', auth, async (req, res) => {
  try {
    var axios  = require('axios');
    var { getAuthHeaders } = require('../services/sieg-auth');
    var headers = await withTimeout(getAuthHeaders(), 15000);
    var resultados = [];
    var candidatos = [
      'GET https://api.sieg.com/api/v1/GetXmls',
      'GET https://api.sieg.com/api/v1/xmls',
      'GET https://api.sieg.com/api/v1/xml-documents',
      'GET https://api.sieg.com/api/v1/documents',
      'GET https://api.sieg.com/api/v1/GetDocuments',
      'GET https://api.sieg.com/api/v1/nfe',
      'GET https://api.sieg.com/api/v1/GetNfe',
      'POST https://api.sieg.com/api/v1/GetXmls',
    ];
    for (var c of candidatos) {
      var parts = c.split(' ');
      var method = parts[0].toLowerCase();
      var url = parts[1];
      try {
        var r = await withTimeout(axios({ method, url, headers,
          params: method==='get' ? { Take: 1, TipoDocumento: 'NFe' } : undefined,
          data:   method==='post' ? { Take: 1, TipoDocumento: 'NFe' } : undefined,
          validateStatus: () => true, timeout: 8000 }), 10000);
        resultados.push({ endpoint: c, status: r.status, body: JSON.stringify(r.data).slice(0, 200) });
      } catch(e) {
        resultados.push({ endpoint: c, status: 'ERR', body: e.message });
      }
    }
    res.json(resultados);
  } catch(e) {
    res.json({ erro: e.message });
  }
});
