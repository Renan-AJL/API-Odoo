/**
 * routes/admin.js — Painel Administrativo AJL
 * Autenticação via cookie HttpOnly com token HMAC-SHA256
 * Login: ADMIN_USER / ADMIN_PASSWORD (variáveis de ambiente)
 */
'use strict';
const express   = require('express');
const crypto    = require('crypto');
const router    = express.Router();
const config    = require('../config');

// ── Odoo XML-RPC helpers (com timeout de 15s) ────────────────────
const xmlrpc = require('xmlrpc');

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ' + ms + 'ms')), ms)),
  ]);
}

function odooClient(url) {
  var base = (url || '').replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  var isSecure = base.startsWith('https');
  var fn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: fn({ host, path: '/xmlrpc/2/common', port: isSecure ? 443 : 80 }),
    models: fn({ host, path: '/xmlrpc/2/object', port: isSecure ? 443 : 80 }),
  };
}

function odooAuth(client, db, user, password) {
  return withTimeout(new Promise((resolve, reject) => {
    client.common.methodCall('authenticate', [db, user, password, {}], (err, uid) => {
      if (err || !uid) reject(new Error('Auth Odoo falhou: ' + (err && (err.faultString || err.message) || 'uid nulo')));
      else resolve(uid);
    });
  }), 15000);
}

function odooKw(client, db, uid, password, model, method, args, kwargs) {
  var params = [db, uid, password, model, method, args || []];
  if (kwargs) params.push(kwargs);
  return withTimeout(new Promise((resolve, reject) => {
    client.models.methodCall('execute_kw', params, (err, r) => {
      if (err) reject(new Error(err.faultString || err.message));
      else resolve(r);
    });
  }), 20000);
}

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'ajl2025';
const TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || process.env.API_SECRET_KEY || 'ajl-admin-secret';
const COOKIE_NAME  = 'ajl_admin_token';
const COOKIE_TTL   = 8 * 60 * 60 * 1000; // 8h

function makeToken(user) {
  var exp = Date.now() + COOKIE_TTL;
  var payload = user + ':' + exp;
  var sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return payload + ':' + sig;
}

function validateToken(token) {
  if (!token) return false;
  var parts = token.split(':');
  if (parts.length !== 3) return false;
  var [user, exp, sig] = parts;
  if (Date.now() > parseInt(exp)) return false;
  var payload = user + ':' + exp;
  var expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return sig === expected;
}

function authMiddleware(req, res, next) {
  var token = req.cookies && req.cookies[COOKIE_NAME];
  if (validateToken(token)) return next();
  res.redirect('/admin/login');
}

// ── Login GET ──────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  var err = req.query.erro ? 'Usuário ou senha inválidos.' : '';
  res.send(loginHtml(err));
});

// ── Login POST ─────────────────────────────────────────────────────────────
router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  var { usuario, senha } = req.body;
  if (usuario === ADMIN_USER && senha === ADMIN_PASS) {
    var token = makeToken(usuario);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_TTL,
      secure: process.env.NODE_ENV === 'production',
    });
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?erro=1');
});

// ── Logout ────────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.redirect('/admin/login');
});

// ── Dashboard principal ───────────────────────────────────────────────────
router.get('/', authMiddleware, (req, res) => {
  res.send(dashboardHtml());
});

// ── API de status geral ───────────────────────────────────────────────────
router.get('/api/status', authMiddleware, async (req, res) => {
  var status = { timestamp: new Date().toISOString(), servicos: {} };

  // Render/Node uptime
  status.uptime_s = Math.floor(process.uptime());

  // Odoo
  try {
    var cfg = config.odoo;
    status.servicos.odoo = {
      configurado: !!(cfg.url && cfg.db && cfg.user),
      url: cfg.url || null,
      db: cfg.db || null,
    };
  } catch(e) { status.servicos.odoo = { erro: e.message }; }

  // SIEG
  try {
    var { getTokenState } = require('../services/sieg-auth');
    var ts = getTokenState();
    status.servicos.sieg = {
      configurado: !!(process.env.SIEG_CLIENT_ID),
      token_valido: ts.valid,
      expira: ts.expiresAt || null,
      tpAmb: process.env.SIEG_TP_AMB === '1' ? 'Produção' : 'Homologação',
    };
  } catch(e) { status.servicos.sieg = { erro: e.message }; }

  // Itaú
  status.servicos.itau = {
    configurado: !!(process.env.ITAU_CLIENT_ID && process.env.ITAU_CLIENT_SECRET),
    pix_chave: process.env.ITAU_PIX_CHAVE ? '✓ configurada' : '✗ ausente',
  };

  // TudoEntregue
  status.servicos.tudoentregue = {
    configurado: !!(process.env.TE_APP_KEY),
    base_url: process.env.TE_BASE_URL || 'https://app.tudoentregue.com.br',
  };

  // Certificado NF-e
  try {
    var { carregarCertificado } = require('../services/nfe-cert');
    var cert = carregarCertificado();
    status.servicos.certificado_nfe = {
      carregado: !!cert,
      titular: cert && cert.info ? cert.info.titular : null,
      cnpj: cert && cert.info ? cert.info.cnpj : null,
      validade: cert && cert.info ? cert.info.validoAte : null,
      expirado: cert && cert.info ? cert.info.expirado : null,
    };
  } catch(e) { status.servicos.certificado_nfe = { erro: e.message }; }

  res.json(status);
});

// ── API SIEG: NF-e emitidas (Odoo) ───────────────────────────────────────
router.get('/api/sieg/emitidas', authMiddleware, async (req, res) => {
  try {
    var cfg = config.odoo;
    if (!cfg.url) return res.json({ erro: 'Odoo não configurado', registros: [] });
    var { dataInicio, dataFim, status: filtroStatus, busca } = req.query;
    var client = odooClient(cfg.url);
    var uid = await odooAuth(client, cfg.db, cfg.user, cfg.password);
    var ekw = (model, method, args, kwargs) => odooKw(client, cfg.db, uid, cfg.password, model, method, args, kwargs);

    // Montar domain
    var domain = [
      ['move_type', '=', 'out_invoice'],
      ['x_studio_nfe_chave', '!=', false],
    ];
    if (filtroStatus && filtroStatus !== 'todos') domain.push(['x_studio_nfe_status', '=', filtroStatus]);
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
        cliente: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
        data: r.invoice_date,
        valor: r.amount_total,
        status: r.x_studio_nfe_status,
        chave: r.x_studio_nfe_chave,
        protocolo: r.x_studio_nfe_protocolo,
      }));
    }
    res.json({ total: registros.length, registros });
  } catch(e) {
    res.json({ erro: e.message, registros: [] });
  }
});

// ── API SIEG: NF-e recebidas (cofre SIEG) ─────────────────────────────────
router.get('/api/sieg/recebidas', authMiddleware, async (req, res) => {
  try {
    var axios = require('axios');
    var { getAuthHeaders } = require('../services/sieg-auth');

    var headers = await getAuthHeaders();
    var { dataInicio, dataFim, cnpjEmitente, pagina } = req.query;

    var params = {
      Take: 50,
      Skip: ((parseInt(pagina) || 1) - 1) * 50,
      TipoDocumento: 'NFe',
    };
    if (dataInicio) params.DataEmissaoInicio = dataInicio;
    if (dataFim)    params.DataEmissaoFim    = dataFim;
    if (cnpjEmitente) params.CnpjEmitente    = cnpjEmitente.replace(/\D/g, '');

    var resp = await axios.get('https://api.sieg.com/v1/xml-documents', {
      headers, params, timeout: 30000,
    });

    var data = resp.data;
    var items = data.items || data.Items || data.xmlDocuments || data.XmlDocuments || data || [];
    if (!Array.isArray(items)) items = [];

    var registros = items.map(x => ({
      id: x.id || x.Id,
      chave: x.chaveAcesso || x.ChaveAcesso || x.accessKey || '',
      numero: x.numeroDocumento || x.NumeroDocumento || x.nNF || '',
      emitente: x.razaoSocialEmitente || x.RazaoSocialEmitente || x.cnpjEmitente || '',
      cnpjEmitente: x.cnpjEmitente || x.CnpjEmitente || '',
      dataEmissao: x.dataEmissao || x.DataEmissao || '',
      valor: x.valorTotal || x.ValorTotal || 0,
      status: x.situacao || x.Situacao || '',
    }));

    res.json({ total: registros.length, registros });
  } catch(e) {
    res.json({ erro: 'SIEG: ' + e.message, registros: [] });
  }
});

// ── API Odoo: resumo faturas ──────────────────────────────────────────────
router.get('/api/odoo/resumo', authMiddleware, async (req, res) => {
  try {
    var cfg = config.odoo;
    if (!cfg.url) return res.json({ erro: 'Odoo não configurado' });
    var client = odooClient(cfg.url);
    var uid = await odooAuth(client, cfg.db, cfg.user, cfg.password);
    var ekw = (model, method, args, kwargs) => odooKw(client, cfg.db, uid, cfg.password, model, method, args, kwargs);

    // Contar por status NF-e
    var statusList = ['pendente', 'processando', 'autorizada', 'cancelada', 'erro'];
    var contagem = {};
    for (var s of statusList) {
      var ids = await ekw('account.move', 'search', [[
        ['move_type', '=', 'out_invoice'],
        ['x_studio_nfe_status', '=', s],
      ]], { limit: 1000 });
      contagem[s] = ids.length;
    }

    // Últimas 10 faturas
    var recentes = await ekw('account.move', 'search_read', [[
      ['move_type', '=', 'out_invoice'],
    ]], {
      fields: ['name', 'partner_id', 'invoice_date', 'amount_total', 'state', 'x_studio_nfe_status'],
      order: 'id desc', limit: 10,
    });

    res.json({
      nfe_contagem: contagem,
      faturas_recentes: recentes.map(r => ({
        id: r.id,
        numero: r.name,
        cliente: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
        data: r.invoice_date,
        valor: r.amount_total,
        estado: r.state,
        nfe_status: r.x_studio_nfe_status,
      })),
    });
  } catch(e) {
    res.json({ erro: e.message });
  }
});

// ── API Itaú: cobranças PIX recentes ─────────────────────────────────────
router.get('/api/itau/pix', authMiddleware, async (req, res) => {
  try {
    var axios = require('axios');
    var { getAccessToken } = require('../services/itau-auth');

    var token = await getAccessToken();
    var pixBase = process.env.ITAU_PIX_URL || 'https://secure.api.itau/pix_recebimentos/';

    var { dataInicio, dataFim } = req.query;
    var hoje = new Date().toISOString().slice(0, 10);
    var params = {
      inicio: dataInicio || (hoje + 'T00:00:00Z'),
      fim:    dataFim    || (hoje + 'T23:59:59Z'),
    };

    var resp = await axios.get(pixBase + 'v2/cobv', {
      headers: { Authorization: 'Bearer ' + token },
      params, timeout: 20000,
    });

    var data = resp.data;
    var cobranças = data.cobs || data.cobvs || data.items || [];
    res.json({ total: cobranças.length, cobrancas: cobranças });
  } catch(e) {
    res.json({ erro: 'Itaú PIX: ' + e.message, cobrancas: [] });
  }
});

// ── API TudoEntregue: pedidos recentes ───────────────────────────────────
router.get('/api/te/pedidos', authMiddleware, async (req, res) => {
  try {
    var axios = require('axios');
    var teBase = (process.env.TE_BASE_URL || 'https://app.tudoentregue.com.br').replace(/\/$/, '');
    var appKey = process.env.TE_APP_KEY || '';
    var reqKey = process.env.TE_REQUESTER_KEY || '';

    var { dataInicio, dataFim, status: filtroStatus } = req.query;
    var hoje = new Date().toISOString().slice(0, 10);

    var params = {
      app_key: appKey,
      requester_key: reqKey,
      data_inicio: dataInicio || hoje,
      data_fim: dataFim || hoje,
    };
    if (filtroStatus) params.status = filtroStatus;

    var resp = await axios.get(teBase + '/api/v1/orders', {
      params, timeout: 20000,
    });

    var pedidos = resp.data.orders || resp.data.data || resp.data || [];
    if (!Array.isArray(pedidos)) pedidos = [];
    res.json({ total: pedidos.length, pedidos });
  } catch(e) {
    res.json({ erro: 'TudoEntregue: ' + e.message, pedidos: [] });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// HTML DO PAINEL
// ════════════════════════════════════════════════════════════════════════════

function loginHtml(erro) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AJL — Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);padding:48px 40px;width:100%;max-width:400px}
.logo{text-align:center;margin-bottom:32px}
.logo h1{font-size:28px;font-weight:700;color:#1a1a2e;letter-spacing:-1px}
.logo p{font-size:13px;color:#666;margin-top:4px}
.logo span{color:#e84545;font-weight:700}
label{display:block;font-size:12px;font-weight:600;color:#444;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
input{width:100%;padding:12px 14px;border:2px solid #e5e5e5;border-radius:8px;font-size:15px;outline:none;transition:border .2s}
input:focus{border-color:#0f3460}
.field{margin-bottom:20px}
button{width:100%;padding:14px;background:#0f3460;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background .2s}
button:hover{background:#1a4a8a}
.erro{background:#fff0f0;color:#c00;border:1px solid #fcc;border-radius:8px;padding:12px;font-size:13px;margin-bottom:20px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>AJL <span>Admin</span></h1>
    <p>Painel de Controle — APIs Integradas</p>
  </div>
  ${erro ? `<div class="erro">⚠️ ${erro}</div>` : ''}
  <form method="POST" action="/admin/login">
    <div class="field"><label>Usuário</label><input name="usuario" type="text" placeholder="admin" autocomplete="username" required></div>
    <div class="field"><label>Senha</label><input name="senha" type="password" placeholder="••••••••" autocomplete="current-password" required></div>
    <button type="submit">Entrar</button>
  </form>
</div>
</body></html>`;
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AJL Admin — Painel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--border:#30363d;
  --text:#c9d1d9;--text2:#8b949e;--accent:#58a6ff;--green:#3fb950;
  --red:#f85149;--yellow:#d29922;--orange:#e3b341;--purple:#bc8cff;
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}

/* ── Topbar ─────────────────────────────────────────────────────── */
.topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;height:56px;position:sticky;top:0;z-index:100}
.topbar h1{font-size:18px;font-weight:700;color:#fff;letter-spacing:-.5px}
.topbar h1 span{color:#f85149}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:16px}
.topbar-right a{color:var(--text2);font-size:13px;text-decoration:none}
.topbar-right a:hover{color:var(--text)}
.badge-env{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600}
.badge-prod{background:#1f3a1f;color:#3fb950;border:1px solid #238636}
.badge-hom{background:#3a2e1f;color:#d29922;border:1px solid #bb8009}

/* ── Tabs ────────────────────────────────────────────────────────── */
.tabs{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;display:flex;gap:0;overflow-x:auto}
.tab{padding:14px 20px;font-size:13px;font-weight:500;color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:all .15s;user-select:none}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab-icon{margin-right:6px}

/* ── Main ────────────────────────────────────────────────────────── */
.main{padding:24px;max-width:1400px;margin:0 auto}

/* ── Cards ───────────────────────────────────────────────────────── */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px}
.card-title{font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.card-value{font-size:28px;font-weight:700;color:#fff}
.card-sub{font-size:12px;color:var(--text2);margin-top:4px}
.card-green .card-value{color:var(--green)}
.card-red .card-value{color:var(--red)}
.card-yellow .card-value{color:var(--yellow)}
.card-blue .card-value{color:var(--accent)}

/* ── Panel ───────────────────────────────────────────────────────── */
.panel{background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:24px}
.panel-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.panel-header h3{font-size:14px;font-weight:600;color:#fff;flex:1}
.panel-body{padding:20px}

/* ── Filters ────────────────────────────────────────────────────── */
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.filter-group{display:flex;flex-direction:column;gap:4px}
.filter-group label{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.4px}
.filter-group input,.filter-group select{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:7px 12px;border-radius:6px;font-size:13px;outline:none;min-width:120px}
.filter-group input:focus,.filter-group select:focus{border-color:var(--accent)}
.btn{padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#79b8ff}
.btn-sm{padding:5px 12px;font-size:12px}
.btn-outline{background:transparent;color:var(--text2);border:1px solid var(--border)}
.btn-outline:hover{border-color:var(--text);color:var(--text)}

/* ── Table ───────────────────────────────────────────────────────── */
.table-wrap{overflow-x:auto;margin-top:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:11px 14px;border-bottom:1px solid var(--border);color:var(--text);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}

/* ── Status badges ───────────────────────────────────────────────── */
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.4px}
.badge-autorizada,.badge-ok,.badge-ativa{background:#1a3a1a;color:#3fb950;border:1px solid #238636}
.badge-pendente,.badge-processando{background:#3a2e1f;color:#d29922;border:1px solid #bb8009}
.badge-cancelada,.badge-cancelado{background:#1f1a3a;color:#bc8cff;border:1px solid #6e40c9}
.badge-erro,.badge-error{background:#3a1a1a;color:#f85149;border:1px solid #b91c1c}
.badge-cancelando{background:#2a1f3a;color:#e3b341;border:1px solid #9a7c0b}

/* ── Status grid ──────────────────────────────────────────────────── */
.status-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-top:8px}
.status-item{background:var(--bg3);border-radius:8px;padding:14px;text-align:center;border:1px solid var(--border)}
.status-item .sval{font-size:24px;font-weight:700;color:#fff;display:block}
.status-item .slabel{font-size:11px;color:var(--text2);margin-top:4px;text-transform:uppercase;letter-spacing:.4px}

/* ── Loading / Empty ─────────────────────────────────────────────── */
.loading{text-align:center;padding:40px;color:var(--text2);font-size:14px}
.empty{text-align:center;padding:40px;color:var(--text2);font-size:14px}
.spin{display:inline-block;width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;margin-right:8px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Tabs content ────────────────────────────────────────────────── */
.tab-content{display:none}.tab-content.active{display:block}

/* ── Service card ────────────────────────────────────────────────── */
.service-row{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)}
.service-row:last-child{border-bottom:none}
.service-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.dot-ok{background:#3fb950} .dot-warn{background:#d29922} .dot-err{background:#f85149}
.service-name{font-size:14px;font-weight:500;color:#fff;min-width:160px}
.service-info{font-size:12px;color:var(--text2);flex:1}

/* ── Responsive ──────────────────────────────────────────────────── */
@media(max-width:600px){.main{padding:12px}.filters{flex-direction:column}.filter-group{width:100%}.cards{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>

<!-- Topbar -->
<div class="topbar">
  <h1>AJL <span>Admin</span></h1>
  <div class="topbar-right">
    <span id="env-badge" class="badge-env" style="background:#21262d;color:#8b949e;border:1px solid #30363d">carregando...</span>
    <span id="uptime-label" style="font-size:12px;color:#8b949e"></span>
    <a href="/admin/logout">Sair</a>
  </div>
</div>

<!-- Tabs -->
<div class="tabs">
  <div class="tab active" onclick="switchTab('dashboard')" id="tab-dashboard"><span class="tab-icon">🏠</span>Dashboard</div>
  <div class="tab" onclick="switchTab('sieg-emitidas')" id="tab-sieg-emitidas"><span class="tab-icon">📤</span>NF-e Emitidas</div>
  <div class="tab" onclick="switchTab('sieg-recebidas')" id="tab-sieg-recebidas"><span class="tab-icon">📥</span>NF-e Recebidas</div>
  <div class="tab" onclick="switchTab('odoo')" id="tab-odoo"><span class="tab-icon">📊</span>Odoo</div>
  <div class="tab" onclick="switchTab('itau')" id="tab-itau"><span class="tab-icon">🏦</span>Itaú PIX</div>
  <div class="tab" onclick="switchTab('te')" id="tab-te"><span class="tab-icon">🚚</span>TudoEntregue</div>
  <div class="tab" onclick="switchTab('apis')" id="tab-apis"><span class="tab-icon">⚙️</span>APIs Status</div>
</div>

<div class="main">

<!-- ═══════ DASHBOARD ═══════ -->
<div id="tab-dashboard" class="tab-content active">
  <div id="dashboard-cards" class="cards"><div class="card"><div class="loading"><span class="spin"></span>Carregando...</div></div></div>
  <div class="panel">
    <div class="panel-header"><h3>📋 Faturas Recentes (Odoo)</h3><button class="btn btn-outline btn-sm" onclick="loadDashboard()">↻ Atualizar</button></div>
    <div class="panel-body">
      <div id="faturas-recentes-table" class="loading"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
</div>

<!-- ═══════ NF-e EMITIDAS ═══════ -->
<div id="tab-sieg-emitidas" class="tab-content">
  <div class="panel">
    <div class="panel-header">
      <h3>📤 NF-e Emitidas pela AJL (via Odoo)</h3>
      <button class="btn btn-outline btn-sm" onclick="loadEmitidas()">↻ Atualizar</button>
    </div>
    <div class="panel-body">
      <div class="filters">
        <div class="filter-group"><label>Data início</label><input type="date" id="emit-di" onchange="setPreset('')"></div>
        <div class="filter-group"><label>Data fim</label><input type="date" id="emit-df" onchange="setPreset('')"></div>
        <div class="filter-group"><label>Status</label>
          <select id="emit-status">
            <option value="todos">Todos</option>
            <option value="autorizada">Autorizada</option>
            <option value="cancelada">Cancelada</option>
            <option value="pendente">Pendente</option>
            <option value="erro">Erro</option>
          </select>
        </div>
        <div class="filter-group"><label>Busca (nº fatura)</label><input type="text" id="emit-busca" placeholder="NFe 000..."></div>
        <div class="filter-group"><label>&nbsp;</label>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" onclick="setPreset('hoje')">Hoje</button>
            <button class="btn btn-outline btn-sm" onclick="setPreset('semana')">Semana</button>
            <button class="btn btn-outline btn-sm" onclick="setPreset('mes')">Mês</button>
            <button class="btn btn-outline btn-sm" onclick="setPreset('ano')">Ano</button>
            <button class="btn btn-primary btn-sm" onclick="loadEmitidas()">Filtrar</button>
          </div>
        </div>
      </div>
      <div id="emit-summary" style="margin-top:16px;font-size:13px;color:var(--text2)"></div>
      <div id="emit-table" class="loading"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
</div>

<!-- ═══════ NF-e RECEBIDAS ═══════ -->
<div id="tab-sieg-recebidas" class="tab-content">
  <div class="panel">
    <div class="panel-header">
      <h3>📥 NF-e Recebidas pela AJL (cofre SIEG)</h3>
      <button class="btn btn-outline btn-sm" onclick="loadRecebidas()">↻ Atualizar</button>
    </div>
    <div class="panel-body">
      <div class="filters">
        <div class="filter-group"><label>Data início</label><input type="date" id="rec-di" onchange="setPresetRec('')"></div>
        <div class="filter-group"><label>Data fim</label><input type="date" id="rec-df" onchange="setPresetRec('')"></div>
        <div class="filter-group"><label>CNPJ Emitente</label><input type="text" id="rec-cnpj" placeholder="00.000.000/0001-00"></div>
        <div class="filter-group"><label>&nbsp;</label>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" onclick="setPresetRec('hoje')">Hoje</button>
            <button class="btn btn-outline btn-sm" onclick="setPresetRec('semana')">Semana</button>
            <button class="btn btn-outline btn-sm" onclick="setPresetRec('mes')">Mês</button>
            <button class="btn btn-outline btn-sm" onclick="setPresetRec('ano')">Ano</button>
            <button class="btn btn-primary btn-sm" onclick="loadRecebidas()">Filtrar</button>
          </div>
        </div>
      </div>
      <div id="rec-summary" style="margin-top:16px;font-size:13px;color:var(--text2)"></div>
      <div id="rec-table" class="loading"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
</div>

<!-- ═══════ ODOO ═══════ -->
<div id="tab-odoo" class="tab-content">
  <div class="panel">
    <div class="panel-header"><h3>📊 Odoo — Status NF-e</h3><button class="btn btn-outline btn-sm" onclick="loadOdoo()">↻ Atualizar</button></div>
    <div class="panel-body">
      <div id="odoo-status-grid" class="loading"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-header"><h3>📋 Últimas Faturas</h3></div>
    <div class="panel-body">
      <div id="odoo-faturas" class="loading"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
</div>

<!-- ═══════ ITAÚ ═══════ -->
<div id="tab-itau" class="tab-content">
  <div class="panel">
    <div class="panel-header">
      <h3>🏦 Itaú — Cobranças PIX</h3>
      <button class="btn btn-outline btn-sm" onclick="loadItau()">↻ Atualizar</button>
    </div>
    <div class="panel-body">
      <div class="filters">
        <div class="filter-group"><label>Data início</label><input type="date" id="itau-di"></div>
        <div class="filter-group"><label>Data fim</label><input type="date" id="itau-df"></div>
        <div class="filter-group"><label>&nbsp;</label><button class="btn btn-primary btn-sm" onclick="loadItau()">Filtrar</button></div>
      </div>
      <div id="itau-result" class="loading" style="margin-top:20px"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
</div>

<!-- ═══════ TUDO ENTREGUE ═══════ -->
<div id="tab-te" class="tab-content">
  <div class="panel">
    <div class="panel-header">
      <h3>🚚 TudoEntregue — Pedidos</h3>
      <button class="btn btn-outline btn-sm" onclick="loadTE()">↻ Atualizar</button>
    </div>
    <div class="panel-body">
      <div class="filters">
        <div class="filter-group"><label>Data início</label><input type="date" id="te-di"></div>
        <div class="filter-group"><label>Data fim</label><input type="date" id="te-df"></div>
        <div class="filter-group"><label>&nbsp;</label><button class="btn btn-primary btn-sm" onclick="loadTE()">Filtrar</button></div>
      </div>
      <div id="te-result" class="loading" style="margin-top:20px"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
</div>

<!-- ═══════ APIs STATUS ═══════ -->
<div id="tab-apis" class="tab-content">
  <div class="panel">
    <div class="panel-header"><h3>⚙️ Status das Integrações</h3><button class="btn btn-outline btn-sm" onclick="loadApiStatus()">↻ Atualizar</button></div>
    <div class="panel-body">
      <div id="api-status-list" class="loading"><span class="spin"></span>Carregando...</div>
    </div>
  </div>
</div>

</div><!-- /main -->

<script>
// ════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════
function today()  { return new Date().toISOString().slice(0,10); }
function weekAgo(){ var d=new Date(); d.setDate(d.getDate()-7); return d.toISOString().slice(0,10); }
function monthAgo(){ var d=new Date(); d.setMonth(d.getMonth()-1); return d.toISOString().slice(0,10); }
function yearAgo(){ var d=new Date(); d.setFullYear(d.getFullYear()-1); return d.toISOString().slice(0,10); }

function fmtDate(s){ if(!s) return '—'; var d=new Date(s+'T12:00:00'); return d.toLocaleDateString('pt-BR'); }
function fmtVal(v){ if(!v && v!==0) return '—'; return 'R$ '+parseFloat(v).toLocaleString('pt-BR',{minimumFractionDigits:2}); }
function fmtChave(c){ if(!c) return '—'; return c.slice(0,6)+'...'+c.slice(-6); }

function badge(s){
  var map={autorizada:'autorizada',cancelada:'cancelada',cancelando:'cancelando',pendente:'pendente',processando:'pendente',erro:'erro',ok:'ok',error:'error'};
  var cls=map[s]||'';
  return '<span class="badge badge-'+cls+'">'+(s||'—')+'</span>';
}

async function api(url){
  try {
    var ctrl=new AbortController();
    var tid=setTimeout(()=>ctrl.abort(),25000);
    var r=await fetch(url,{signal:ctrl.signal});
    clearTimeout(tid);
    var txt=await r.text();
    try{ return JSON.parse(txt); }
    catch(e){ return {erro:'Resposta inválida do servidor: '+txt.slice(0,100)}; }
  } catch(e) {
    return {erro: e.name==='AbortError' ? 'Timeout — servidor demorou demais' : e.message};
  }
}

// ════════════════════════════════════════════════
// TABS
// ════════════════════════════════════════════════
var tabLoaded={};
function switchTab(name){
  document.querySelectorAll('.tab-content').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el=>el.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  document.getElementById('tab-'+name.replace('-emitidas','').replace('-recebidas','')+'-'+name.split('-').slice(-1)[0]) && 0;

  var tabEl = document.querySelector('[onclick="switchTab(\''+name+'\')"]');
  if(tabEl) tabEl.classList.add('active');

  if(!tabLoaded[name]){
    tabLoaded[name]=true;
    if(name==='dashboard') loadDashboard();
    else if(name==='sieg-emitidas'){ setPreset('mes'); loadEmitidas(); }
    else if(name==='sieg-recebidas'){ setPresetRec('mes'); loadRecebidas(); }
    else if(name==='odoo') loadOdoo();
    else if(name==='itau'){ document.getElementById('itau-di').value=today(); document.getElementById('itau-df').value=today(); loadItau(); }
    else if(name==='te'){ document.getElementById('te-di').value=weekAgo(); document.getElementById('te-df').value=today(); loadTE(); }
    else if(name==='apis') loadApiStatus();
  }
}

// ════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════
async function loadDashboard(){
  document.getElementById('dashboard-cards').innerHTML='<div class="card" style="grid-column:1/-1"><div class="loading"><span class="spin"></span>Conectando...</div></div>';
  document.getElementById('faturas-recentes-table').innerHTML='<div class="loading"><span class="spin"></span>Carregando...</div>';
  var [status, resumo] = await Promise.all([
    api('/admin/api/status'),
    api('/admin/api/odoo/resumo'),
  ]);

  // Tratar erro
  if(status.erro){ document.getElementById('dashboard-cards').innerHTML='<div class="card card-red" style="grid-column:1/-1"><div class="card-title">Erro ao carregar status</div><div class="card-value" style="font-size:14px">'+status.erro+'</div></div>'; }
  if(resumo.erro){ document.getElementById('faturas-recentes-table').innerHTML='<div class="empty">❌ Odoo: '+resumo.erro+'</div>'; }

  // Env badge
  var sieg=status.servicos&&status.servicos.sieg||{};
  document.getElementById('env-badge').textContent=sieg.tpAmb||'—';
  document.getElementById('env-badge').className='badge-env '+(sieg.tpAmb==='Produção'?'badge-prod':'badge-hom');
  var h=Math.floor(status.uptime_s/3600),m=Math.floor((status.uptime_s%3600)/60);
  document.getElementById('uptime-label').textContent='Uptime: '+h+'h '+m+'m';

  // Cards
  var cnt=resumo.nfe_contagem||{};
  var cardsHtml='';
  var cardData=[
    {title:'Autorizadas',val:cnt.autorizada||0,cls:'card-green'},
    {title:'Pendentes',val:cnt.pendente||0,cls:'card-yellow'},
    {title:'Com Erro',val:cnt.erro||0,cls:'card-red'},
    {title:'Canceladas',val:cnt.cancelada||0,cls:''},
  ];
  for(var c of cardData){
    cardsHtml+='<div class="card '+c.cls+'"><div class="card-title">'+c.title+'</div><div class="card-value">'+c.val+'</div><div class="card-sub">NF-e</div></div>';
  }

  var svcs=status.servicos||{};
  var svcList=[
    {n:'Odoo',s:svcs.odoo},
    {n:'SIEG',s:svcs.sieg},
    {n:'Itaú',s:svcs.itau},
    {n:'TudoEntregue',s:svcs.tudoentregue},
    {n:'Certificado NF-e',s:svcs.certificado_nfe},
  ];
  for(var sv of svcList){
    var ok=sv.s&&sv.s.configurado&&!sv.s.erro;
    var cls=ok?'card-blue':'card-red';
    cardsHtml+='<div class="card '+cls+'"><div class="card-title">'+sv.n+'</div><div class="card-value" style="font-size:16px">'+(ok?'✅ Online':'⚠️ Config')+'</div></div>';
  }
  document.getElementById('dashboard-cards').innerHTML=cardsHtml;

  // Tabela faturas recentes
  var fat=resumo.faturas_recentes||[];
  if(!fat.length){
    document.getElementById('faturas-recentes-table').innerHTML='<div class="empty">Nenhuma fatura encontrada.</div>';
  } else {
    var html='<div class="table-wrap"><table><thead><tr><th>Número</th><th>Cliente</th><th>Data</th><th>Valor</th><th>Estado</th><th>NF-e Status</th></tr></thead><tbody>';
    for(var f of fat){
      html+='<tr><td style="font-family:monospace;font-size:12px">'+f.numero+'</td><td>'+f.cliente+'</td><td>'+fmtDate(f.data)+'</td><td>'+fmtVal(f.valor)+'</td><td><span class="badge badge-ok">'+f.estado+'</span></td><td>'+badge(f.nfe_status)+'</td></tr>';
    }
    html+='</tbody></table></div>';
    document.getElementById('faturas-recentes-table').innerHTML=html;
  }
}

// ════════════════════════════════════════════════
// NF-e EMITIDAS — Filtros rápidos
// ════════════════════════════════════════════════
function setPreset(p){
  var di=document.getElementById('emit-di'),df=document.getElementById('emit-df');
  var t=today();
  if(p==='hoje'){ di.value=t; df.value=t; }
  else if(p==='semana'){ di.value=weekAgo(); df.value=t; }
  else if(p==='mes'){ di.value=monthAgo(); df.value=t; }
  else if(p==='ano'){ di.value=yearAgo(); df.value=t; }
}

async function loadEmitidas(){
  document.getElementById('emit-table').innerHTML='<div class="loading"><span class="spin"></span>Buscando no Odoo...</div>';
  document.getElementById('emit-summary').textContent='';
  var di=document.getElementById('emit-di').value;
  var df=document.getElementById('emit-df').value;
  var st=document.getElementById('emit-status').value;
  var bq=document.getElementById('emit-busca').value;
  var url='/admin/api/sieg/emitidas?status='+encodeURIComponent(st)+(di?'&dataInicio='+di:'')+(df?'&dataFim='+df:'')+(bq?'&busca='+encodeURIComponent(bq):'');
  var data=await api(url);

  if(data.erro){ document.getElementById('emit-table').innerHTML='<div class="empty">❌ '+data.erro+'</div>'; return; }
  var reg=data.registros||[];
  if(!reg.length){ document.getElementById('emit-table').innerHTML='<div class="empty">Nenhuma NF-e encontrada para os filtros.</div>'; return; }

  var total=reg.reduce((a,r)=>a+(parseFloat(r.valor)||0),0);
  document.getElementById('emit-summary').textContent=reg.length+' nota(s) • Total: '+fmtVal(total);

  var html='<div class="table-wrap"><table><thead><tr><th>#</th><th>Nº Fatura</th><th>Cliente</th><th>Data</th><th>Valor</th><th>Status</th><th>Chave</th><th>Protocolo</th></tr></thead><tbody>';
  var i=1;
  for(var r of reg){
    html+='<tr><td style="color:var(--text2)">'+i+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+r.numero+'</td>';
    html+='<td>'+r.cliente+'</td>';
    html+='<td>'+fmtDate(r.data)+'</td>';
    html+='<td>'+fmtVal(r.valor)+'</td>';
    html+='<td>'+badge(r.status)+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--text2)">'+fmtChave(r.chave)+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--text2)">'+( r.protocolo||'—' )+'</td>';
    html+='</tr>';
    i++;
  }
  html+='</tbody></table></div>';
  document.getElementById('emit-table').innerHTML=html;
}

// ════════════════════════════════════════════════
// NF-e RECEBIDAS
// ════════════════════════════════════════════════
function setPresetRec(p){
  var di=document.getElementById('rec-di'),df=document.getElementById('rec-df');
  var t=today();
  if(p==='hoje'){ di.value=t; df.value=t; }
  else if(p==='semana'){ di.value=weekAgo(); df.value=t; }
  else if(p==='mes'){ di.value=monthAgo(); df.value=t; }
  else if(p==='ano'){ di.value=yearAgo(); df.value=t; }
}

async function loadRecebidas(){
  document.getElementById('rec-table').innerHTML='<div class="loading"><span class="spin"></span>Consultando SIEG...</div>';
  document.getElementById('rec-summary').textContent='';
  var di=document.getElementById('rec-di').value;
  var df=document.getElementById('rec-df').value;
  var cnpj=document.getElementById('rec-cnpj').value;
  var url='/admin/api/sieg/recebidas?'+(di?'dataInicio='+di:'')+(df?'&dataFim='+df:'')+(cnpj?'&cnpjEmitente='+encodeURIComponent(cnpj):'');
  var data=await api(url);

  if(data.erro){ document.getElementById('rec-table').innerHTML='<div class="empty">⚠️ '+data.erro+'</div>'; return; }
  var reg=data.registros||[];
  if(!reg.length){ document.getElementById('rec-table').innerHTML='<div class="empty">Nenhuma NF-e recebida encontrada.</div>'; return; }

  var total=reg.reduce((a,r)=>a+(parseFloat(r.valor)||0),0);
  document.getElementById('rec-summary').textContent=reg.length+' nota(s) • Total: '+fmtVal(total);

  var html='<div class="table-wrap"><table><thead><tr><th>#</th><th>Emitente</th><th>CNPJ Emitente</th><th>Nº Doc</th><th>Data Emissão</th><th>Valor</th><th>Situação</th><th>Chave</th></tr></thead><tbody>';
  var i=1;
  for(var r of reg){
    html+='<tr><td style="color:var(--text2)">'+i+'</td>';
    html+='<td>'+r.emitente+'</td>';
    html+='<td style="font-family:monospace;font-size:12px">'+( r.cnpjEmitente||'—' )+'</td>';
    html+='<td style="font-family:monospace">'+( r.numero||'—' )+'</td>';
    html+='<td>'+fmtDate(r.dataEmissao)+'</td>';
    html+='<td>'+fmtVal(r.valor)+'</td>';
    html+='<td>'+badge(r.status)+'</td>';
    html+='<td style="font-family:monospace;font-size:11px;color:var(--text2)">'+fmtChave(r.chave)+'</td>';
    html+='</tr>';
    i++;
  }
  html+='</tbody></table></div>';
  document.getElementById('rec-table').innerHTML=html;
}

// ════════════════════════════════════════════════
// ODOO
// ════════════════════════════════════════════════
async function loadOdoo(){
  document.getElementById('odoo-status-grid').innerHTML='<div class="loading"><span class="spin"></span>Conectando ao Odoo...</div>';
  document.getElementById('odoo-faturas').innerHTML='<div class="loading"><span class="spin"></span>Carregando...</div>';
  var data=await api('/admin/api/odoo/resumo');
  if(data.erro){
    document.getElementById('odoo-status-grid').innerHTML='<div class="empty">❌ '+data.erro+'</div>';
    return;
  }
  var cnt=data.nfe_contagem||{};
  var grid='<div class="status-grid">';
  var items=[
    {k:'autorizada',l:'Autorizadas',color:'#3fb950'},
    {k:'pendente',l:'Pendentes',color:'#d29922'},
    {k:'processando',l:'Processando',color:'#58a6ff'},
    {k:'cancelada',l:'Canceladas',color:'#bc8cff'},
    {k:'erro',l:'Com Erro',color:'#f85149'},
  ];
  for(var it of items){
    grid+='<div class="status-item"><span class="sval" style="color:'+it.color+'">'+(cnt[it.k]||0)+'</span><span class="slabel">'+it.l+'</span></div>';
  }
  grid+='</div>';
  document.getElementById('odoo-status-grid').innerHTML=grid;

  var fat=data.faturas_recentes||[];
  if(!fat.length){ document.getElementById('odoo-faturas').innerHTML='<div class="empty">Sem faturas.</div>'; return; }
  var html='<div class="table-wrap"><table><thead><tr><th>Número</th><th>Cliente</th><th>Data</th><th>Valor</th><th>Estado</th><th>NF-e</th></tr></thead><tbody>';
  for(var f of fat){
    html+='<tr><td style="font-family:monospace;font-size:12px">'+f.numero+'</td><td>'+f.cliente+'</td><td>'+fmtDate(f.data)+'</td><td>'+fmtVal(f.valor)+'</td><td>'+f.estado+'</td><td>'+badge(f.nfe_status)+'</td></tr>';
  }
  html+='</tbody></table></div>';
  document.getElementById('odoo-faturas').innerHTML=html;
}

// ════════════════════════════════════════════════
// ITAÚ
// ════════════════════════════════════════════════
async function loadItau(){
  document.getElementById('itau-result').innerHTML='<div class="loading"><span class="spin"></span>Consultando Itaú...</div>';
  var di=document.getElementById('itau-di').value;
  var df=document.getElementById('itau-df').value;
  var url='/admin/api/itau/pix?'+(di?'dataInicio='+di+'T00:00:00Z':'')+(df?'&dataFim='+df+'T23:59:59Z':'');
  var data=await api(url);
  if(data.erro){
    document.getElementById('itau-result').innerHTML='<div class="empty">⚠️ '+data.erro+'</div>';
    return;
  }
  var cobs=data.cobrancas||[];
  if(!cobs.length){ document.getElementById('itau-result').innerHTML='<div class="empty">Nenhuma cobrança PIX encontrada.</div>'; return; }
  var html='<div class="table-wrap"><table><thead><tr><th>TxId</th><th>Valor</th><th>Status</th><th>Criação</th><th>Devedor</th></tr></thead><tbody>';
  for(var c of cobs){
    html+='<tr>';
    html+='<td style="font-family:monospace;font-size:12px">'+(c.txid||c.txId||'—')+'</td>';
    html+='<td>'+fmtVal((c.valor&&c.valor.original)||c.valor||0)+'</td>';
    html+='<td>'+badge(c.status)+'</td>';
    html+='<td>'+fmtDate(c.calendario&&c.calendario.criacao||c.criacao||'')+'</td>';
    html+='<td>'+(c.devedor&&c.devedor.nome||c.devedor||'—')+'</td>';
    html+='</tr>';
  }
  html+='</tbody></table></div>';
  document.getElementById('itau-result').innerHTML=html;
}

// ════════════════════════════════════════════════
// TUDO ENTREGUE
// ════════════════════════════════════════════════
async function loadTE(){
  document.getElementById('te-result').innerHTML='<div class="loading"><span class="spin"></span>Consultando TudoEntregue...</div>';
  var di=document.getElementById('te-di').value;
  var df=document.getElementById('te-df').value;
  var url='/admin/api/te/pedidos?'+(di?'dataInicio='+di:'')+(df?'&dataFim='+df:'');
  var data=await api(url);
  if(data.erro){
    document.getElementById('te-result').innerHTML='<div class="empty">⚠️ '+data.erro+'</div>';
    return;
  }
  var pedidos=data.pedidos||[];
  if(!pedidos.length){ document.getElementById('te-result').innerHTML='<div class="empty">Nenhum pedido encontrado.</div>'; return; }
  var html='<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Cliente</th><th>Motorista</th><th>Data</th></tr></thead><tbody>';
  for(var p of pedidos){
    var id=p.id||p.orderId||p.order_id||'—';
    var st=p.status||p.state||'—';
    var cli=p.customer&&(p.customer.name||p.customer.nome)||p.destinatario||'—';
    var mot=p.driver&&(p.driver.name||p.driver.nome)||p.motorista||'—';
    var dt=fmtDate(p.created_at||p.createdAt||p.data||'');
    html+='<tr><td style="font-family:monospace;font-size:12px">'+id+'</td><td>'+badge(st)+'</td><td>'+cli+'</td><td>'+mot+'</td><td>'+dt+'</td></tr>';
  }
  html+='</tbody></table></div>';
  document.getElementById('te-result').innerHTML=html;
}

// ════════════════════════════════════════════════
// APIs STATUS
// ════════════════════════════════════════════════
async function loadApiStatus(){
  document.getElementById('api-status-list').innerHTML='<div class="loading"><span class="spin"></span>Verificando...</div>';
  var data=await api('/admin/api/status');
  var s=data.servicos||{};

  var rows=[
    {name:'Odoo (XML-RPC)',info:s.odoo},
    {name:'SIEG (NF-e / NFS-e)',info:s.sieg},
    {name:'Itaú (PIX / Boleto)',info:s.itau},
    {name:'TudoEntregue',info:s.tudoentregue},
    {name:'Certificado Digital A1',info:s.certificado_nfe},
  ];

  var html='';
  for(var row of rows){
    var info=row.info||{};
    var ok=info.configurado&&!info.erro;
    var dot=ok?'dot-ok':(info.erro?'dot-err':'dot-warn');
    var details=[];
    for(var k in info){
      if(k==='configurado') continue;
      if(info[k]!==null&&info[k]!==undefined&&info[k]!=='') details.push('<b>'+k+'</b>: '+info[k]);
    }
    html+='<div class="service-row">';
    html+='<div class="service-dot '+dot+'"></div>';
    html+='<div class="service-name">'+row.name+'</div>';
    html+='<div class="service-info">'+details.join(' &nbsp;·&nbsp; ')+'</div>';
    html+='</div>';
  }

  html+='<div style="margin-top:16px;font-size:12px;color:var(--text2)">Uptime: '+Math.floor(data.uptime_s/3600)+'h &nbsp;|&nbsp; Verificado em: '+new Date(data.timestamp).toLocaleString('pt-BR')+'</div>';
  document.getElementById('api-status-list').innerHTML=html;
}

// ════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════
loadDashboard();
</script>
</body></html>`;
}

module.exports = router;
