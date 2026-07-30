/**
 * services/sieg-odoo-emit.js v2.0.0
 * =============================================
 * Processa emissoes pendentes de NF-e/NFS-e via polling Odoo XML-RPC.
 * 
 * CAMPOS USADOS (existentes no Odoo do cliente):
 *   account.move:
 *     x_studio_nfe_status     (Selection: vazio, pendente, processando, autorizada, erro)
 *     x_studio_nfe_chave      (Char)
 *     x_studio_nfe_protocolo  (Char)
 *     x_studio_nfse_numero    (Char)
 *     x_studio_nfse_status    (Selection: vazio, pendente, processando, autorizada, erro)
 *   res.company:
 *     x_studio_sieg_ultimo_nfe  (Integer)
 *     x_studio_sieg_ultimo_nfse (Integer)
 *     x_studio_sieg_serie_nfe   (Char, default 100)
 *     x_studio_sieg_serie_nfse  (Char, default 1)
 *   product.product:
 *     x_studio_c_trib_nac       (Char) — Codigo tributo nacional (NFS-e)
 *     x_studio_c_nbs            (Char) — Codigo NBS (NFS-e)
 *     x_studio_aliquota_iss    (Char) — Aliquota ISS (NFS-e)
 *     x_studio_ibge_code       (Char) — Codigo IBGE municipio
 *
 * Chatter: apos emissao, XML + PDF (DANFE/DANFSE) aparecem como anexos.
 */

var xmlrpc = require('xmlrpc');
var { emitirNota } = require('./sieg-api');
var config = require('../config');

// ============================================================
// XML-RPC Helpers
// ============================================================
function createClient(url) {
  var base = url.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  return {
    common: xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 }),
    models: xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 }),
  };
}

function authenticate(client, db, login, password) {
  return new Promise(function(resolve, reject) {
    client.common.methodCall('authenticate', [db, login, password, {}], function(err, uid) {
      if (err) reject(new Error('Auth Odoo falhou: ' + (err.message || JSON.stringify(err))));
      else if (uid === false || uid === null) reject(new Error('Credenciais Odoo invalidas'));
      else resolve(uid);
    });
  });
}

function executeKw(client, db, uid, password, model, method, args, kwargs) {
  return new Promise(function(resolve, reject) {
    var params = [db, uid, password, model, method, args || []];
    if (kwargs) params.push(kwargs);
    client.models.methodCall('execute_kw', params, function(err, result) {
      if (err) reject(new Error(model + '.' + method + ': ' + (err.message || JSON.stringify(err))));
      else resolve(result);
    });
  });
}

// ============================================================
// Main: Process Pending Emissions
// ============================================================
async function processPendingEmissions() {
  var odoo = config.odoo;
  if (!odoo || !odoo.enabled || !odoo.url) {
    console.log('[SIEG-EMIT] Odoo nao configurado');
    return { processed: 0, reason: 'odoo_not_configured' };
  }

  var client = createClient(odoo.url);
  var uid = await authenticate(client, odoo.db, odoo.user, odoo.password);
  var db = odoo.db;
  var pwd = odoo.password;

  console.log('[SIEG-EMIT] Buscando faturas pendentes...');

  // Buscar NF-e pendentes
  var nfeIds = await executeKw(client, db, uid, pwd, 'account.move', 'search', [[
    ['move_type', '=', 'out_invoice'],
    ['x_studio_nfe_status', '=', 'pendente'],
  ]], { order: 'id asc', limit: 5 });

  // Buscar NFS-e pendentes
  var nfseIds = await executeKw(client, db, uid, pwd, 'account.move', 'search', [[
    ['move_type', '=', 'out_invoice'],
    ['x_studio_nfse_status', '=', 'pendente'],
  ]], { order: 'id asc', limit: 5 });

  var allPending = [];
  for (var i = 0; i < nfeIds.length; i++) {
    allPending.push({ id: nfeIds[i], tipo: 'nfe' });
  }
  for (var j = 0; j < nfseIds.length; j++) {
    allPending.push({ id: nfseIds[j], tipo: 'nfse' });
  }

  if (!allPending.length) {
    console.log('[SIEG-EMIT] Nenhuma fatura pendente');
    return { processed: 0 };
  }

  console.log('[SIEG-EMIT] ' + allPending.length + ' fatura(s) pendente(s)');
  var results = [];

  for (var k = 0; k < allPending.length; k++) {
    var item = allPending[k];
    try {
      var r = await processOne(client, db, uid, pwd, item.id, item.tipo);
      results.push(r);
    } catch (err) {
      console.error('[SIEG-EMIT] ERRO fatura ' + item.id + ':', err.message);
      await safeUpdateError(client, db, uid, pwd, item.id, item.tipo, err.message);
      results.push({ move_id: item.id, sucesso: false, tipo: item.tipo, erro: err.message });
    }
  }

  var ok = results.filter(function(r) { return r.sucesso; }).length;
  console.log('[SIEG-EMIT] Concluido: ' + ok + '/' + results.length + ' sucesso');
  return { processed: results.length, sucesso: ok, detalhes: results };
}

// ============================================================
// Process Single Invoice
// ============================================================
async function processOne(client, db, uid, pwd, moveId, tipo) {
  console.log('[SIEG-EMIT] --- Fatura ID: ' + moveId + ' | Tipo: ' + tipo + ' ---');

  // 1. Read account.move
  var moves = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], [
    'name', 'partner_id', 'company_id', 'invoice_date', 'date',
    'amount_total', 'amount_untaxed', 'narration', 'invoice_line_ids',
    'x_studio_nfe_status', 'x_studio_nfse_status', 'payment_state',
  ]]);
  if (!moves || !moves.length) throw new Error('Fatura ' + moveId + ' nao encontrada');
  var move = moves[0];
  console.log('[SIEG-EMIT] Fatura: ' + move.name + ' | R$ ' + (move.amount_total || 0));

  // 2. Read company
  var companyId = tupId(move.company_id);
  var company = await readCompany(client, db, uid, pwd, companyId);

  // 3. Read partner
  var partnerId = tupId(move.partner_id);
  if (!partnerId) throw new Error('Fatura sem parceiro');
  var partner = await readPartner(client, db, uid, pwd, partnerId);

  // 4. Read invoice lines + product data
  // IMPORTANT: Odoo XML-RPC returns One2many as [id, name] tuples — extract plain IDs
  var lineIdsRaw = move.invoice_line_ids || [];
  var lineIds = lineIdsRaw.map(function(v) { return Array.isArray(v) ? v[0] : v; }).filter(function(v) { return typeof v === 'number' && v > 0; });
  console.log('[SIEG-EMIT] Linhas da fatura: ' + lineIdsRaw.length + ' raw, ' + lineIds.length + ' IDs extraidos');

  if (!lineIds.length) throw new Error('Fatura sem linhas (invoice_line_ids vazio ou invalido)');

  // Try reading with standard fields first
  var rawLines = [];
  try {
    rawLines = await executeKw(client, db, uid, pwd, 'account.move.line', 'read', [lineIds, [
      'display_type', 'product_id', 'name', 'quantity', 'price_unit',
      'price_subtotal', 'tax_ids', 'discount',
    ]]);
  } catch (lineErr) {
    // If price_subtotal or discount fails, try minimal field set
    console.warn('[SIEG-EMIT] Campo invalido em account.move.line, tentando campo minimos:', lineErr.message.substring(0, 120));
    try {
      rawLines = await executeKw(client, db, uid, pwd, 'account.move.line', 'read', [lineIds, [
        'display_type', 'product_id', 'name', 'quantity', 'price_unit', 'tax_ids',
      ]]);
    } catch (e2) {
      throw new Error('Nao foi possivel ler linhas da fatura: ' + e2.message.substring(0, 200));
    }
  }

  console.log('[SIEG-EMIT] rawLines retornadas: ' + (rawLines ? rawLines.length : 0));
  if (rawLines) {
    for (var dl = 0; dl < Math.min(rawLines.length, 3); dl++) {
      var rl = rawLines[dl];
      console.log('[SIEG-EMIT]   Line ' + rl.id + ': display_type=' + JSON.stringify(rl.display_type) + ' product=' + JSON.stringify(rl.product_id) + ' name=' + (rl.name || '').substring(0, 40));
    }
  }

  // Filter: keep only lines that are NOT section/note/payment headers
  var invoiceLines = (rawLines || []).filter(function(l) {
    return l.display_type !== 'line_section' && l.display_type !== 'line_note' && l.display_type !== 'line_payment';
  });
  console.log('[SIEG-EMIT] invoiceLines apos filtro: ' + invoiceLines.length);
  if (!invoiceLines.length) throw new Error('Fatura sem linhas de produto/servico (todas tinham display_type)');

  // 5. Get next NF number from company
  var serie, numField, nextNum;
  if (tipo === 'nfe') {
    serie = String(company.x_studio_sieg_serie_nfe || '100');
    numField = 'x_studio_sieg_ultimo_nfe';
  } else {
    serie = String(company.x_studio_sieg_serie_nfse || '1');
    numField = 'x_studio_sieg_ultimo_nfse';
  }
  nextNum = (parseInt(company[numField]) || 0) + 1;
  console.log('[SIEG-EMIT] Serie: ' + serie + ' | nNF: ' + nextNum);

  // 6. Build line data with taxes + product x_studio_ fields
  var linesData = [];
  for (var i = 0; i < invoiceLines.length; i++) {
    var ld = await buildLineData(client, db, uid, pwd, invoiceLines[i]);
    linesData.push(ld);
  }

  // 7. Build emission payload
  var emitData = {
    company: company,
    partner: partner,
    order: {
      name: move.name,
      number: String(nextNum),
      date_order: move.invoice_date || move.date,
      amount_total: move.amount_total,
      note: move.narration || '',
    },
    lines: linesData,
    config: {
      serie: serie,
      tpAmb: process.env.SIEG_TP_AMB || config.sieg.tpAmb || '2',
      natOp: 'Venda de Mercadoria',
      mod: tipo === 'nfe' ? '55' : '01',
    },
    tipo: tipo,
  };

  // NFS-e: build service block from product x_studio_ fields
  if (tipo === 'nfse') {
    emitData.service = buildServiceBlock(linesData, move);
  }

  // 8. Set status to 'processando'
  var processVals = {};
  if (tipo === 'nfe') processVals.x_studio_nfe_status = 'processando';
  else processVals.x_studio_nfse_status = 'processando';
  await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], processVals]);

  // 9. Call SIEG API
  console.log('[SIEG-EMIT] Enviando ao SIEG...');
  var resultado = await emitirNota(emitData);
  console.log('[SIEG-EMIT] SIEG retornou - sucesso: ' + resultado.sucesso);

  // 10. Parse result
  var info = parseResult(resultado, tipo);
  var xmlRetornoText = '';
  var rawXmlAuth = resultado.resposta && (resultado.resposta.Xml || resultado.resposta.xml || resultado.resposta.xmlBase64);
  if (rawXmlAuth) {
    xmlRetornoText = (typeof rawXmlAuth === 'string' && rawXmlAuth.length > 200)
      ? rawXmlAuth
      : Buffer.from(rawXmlAuth, 'base64').toString('utf-8');
  }

  // 11. Update account.move with results
  var updateVals = {};
  if (info.sucesso) {
    if (tipo === 'nfe') {
      updateVals.x_studio_nfe_status = 'autorizada';
      updateVals.x_studio_nfe_chave = info.chave;
      updateVals.x_studio_nfe_protocolo = info.protocolo;
    } else {
      updateVals.x_studio_nfse_status = 'autorizada';
      updateVals.x_studio_nfse_numero = String(nextNum);
    }

    // Increment NF number (only on authorization)
    try {
      var companyUpdate = {};
      companyUpdate[numField] = nextNum;
      await executeKw(client, db, uid, pwd, 'res.company', 'write', [[companyId], companyUpdate]);
      console.log('[SIEG-EMIT] Sequencia ' + numField + ' = ' + nextNum);
    } catch (seqErr) {
      console.error('[SIEG-EMIT] Erro ao atualizar sequencia:', seqErr.message);
    }
  } else {
    if (tipo === 'nfe') {
      updateVals.x_studio_nfe_status = info.cStat + ' - ' + info.motivo;
    } else {
      updateVals.x_studio_nfse_status = info.motivo;
    }
  }

  await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], updateVals]);
  console.log('[SIEG-EMIT] Fatura atualizada');

  // 12. Post XML + PDF to Chatter
  await postChatterResult(client, db, uid, pwd, moveId, move.name, tipo, info, resultado, xmlRetornoText);

  return {
    move_id: moveId, sucesso: info.sucesso, tipo: tipo,
    chave: info.chave, numero: nextNum, serie: serie,
  };
}

// ============================================================
// Post XML + PDF to Odoo Chatter
// ============================================================
async function postChatterResult(client, db, uid, pwd, moveId, moveName, tipo, info, resultado, xmlRetornoText) {
  var attachIds = [];
  var safeName = (moveName || 'Fatura').replace(/[^a-zA-Z0-9\-_]/g, '_');
  var nfLabel = tipo === 'nfe' ? 'NF-e' : 'NFS-e';
  var xmlContent = xmlRetornoText || resultado.xmlEnviado || '';
  var pdfBase64 = resultado.pdfBase64 || '';

  // Attach XML
  if (xmlContent) {
    try {
      var xmlB64 = Buffer.from(xmlContent, 'utf-8').toString('base64');
      var xmlAttach = await executeKw(client, db, uid, pwd, 'ir.attachment', 'create', [{
        name: nfLabel + '_' + safeName + '.xml',
        datas: xmlB64,
        res_model: 'account.move',
        res_id: moveId,
        mimetype: 'application/xml',
      }]);
      attachIds.push(xmlAttach);
      console.log('[SIEG-EMIT] XML anexado (ID: ' + xmlAttach + ')');
    } catch (e) { console.error('[SIEG-EMIT] Erro anexar XML:', e.message); }
  }

  // Attach PDF (DANFE / DANFSE)
  if (pdfBase64) {
    try {
      var pdfLabel = tipo === 'nfe' ? 'DANFE' : 'DANFSE';
      var pdfAttach = await executeKw(client, db, uid, pwd, 'ir.attachment', 'create', [{
        name: pdfLabel + '_' + safeName + '.pdf',
        datas: pdfBase64,
        res_model: 'account.move',
        res_id: moveId,
        mimetype: 'application/pdf',
      }]);
      attachIds.push(pdfAttach);
      console.log('[SIEG-EMIT] PDF anexado (ID: ' + pdfAttach + ')');
    } catch (e) { console.error('[SIEG-EMIT] Erro anexar PDF:', e.message); }
  }

  // Post chatter message
  var body = '';
  if (info.sucesso) {
    body = '<b>' + nfLabel + ' Emitida com Sucesso!</b><br/>';
    if (tipo === 'nfe') {
      body += 'Chave: ' + info.chave + '<br/>';
      body += 'Protocolo: ' + info.protocolo + '<br/>';
    } else {
      body += 'Numero: ' + info.numero + '<br/>';
    }
    body += 'Status: ' + info.cStat + ' - ' + info.motivo;
    body += '<br/><br/><i>Arquivos anexados: XML e ' + (tipo === 'nfe' ? 'DANFE' : 'DANFSE') + ' (PDF)</i>';
  } else {
    body = '<b>Erro na Emissao de ' + nfLabel + '</b><br/>';
    body += 'Status: ' + info.cStat + ' - ' + info.motivo;
  }

  try {
    var msgVals = {
      model: 'account.move',
      res_id: moveId,
      body: body,
      message_type: 'comment',
    };
    if (attachIds.length > 0) {
      msgVals.attachment_ids = [[6, 0, attachIds]];
    }
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [msgVals]);
    console.log('[SIEG-EMIT] Mensagem postada no chatter');
  } catch (e) { console.error('[SIEG-EMIT] Erro postar chatter:', e.message); }
}

// Safe Read: only standard Odoo fields (no l10n_br dependency)
var PARTNER_SAFE = ['name','street','street2','city','state_id','zip','phone','email','is_company','vat','country_id','city_id'];

// BR-specific fields to try ONE BY ONE (never in batch to avoid partial rejection)
var PARTNER_BR_INDIVIDUAL = ['inscr_est','legal_name','number','district','l10n_br_city_id'];

async function safeReadPartner(client, db, uid, pwd, pid) {
  // Step 1: Read only standard fields (guaranteed to work)
  var r;
  try {
    r = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[pid], PARTNER_SAFE]);
  } catch (e) {
    console.error('[SIEG-EMIT] Erro ao ler parceiro ' + pid + ':', e.message.substring(0, 150));
    return {};
  }
  if (!r || !r.length) return {};
  var partner = r[0];

  // Map vat -> cnpj_cpf for downstream compatibility
  partner.cnpj_cpf = partner.vat || '';

  // Step 2: Try each BR field individually (silent fail per field)
  for (var i = 0; i < PARTNER_BR_INDIVIDUAL.length; i++) {
    var field = PARTNER_BR_INDIVIDUAL[i];
    try {
      var br = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[pid], [field]]);
      if (br && br[0] && br[0][field] !== undefined && br[0][field] !== false) {
        partner[field] = br[0][field];
      }
    } catch (e) {
      // Field does not exist in this Odoo instance — skip silently
    }
  }

  return partner;
}

// ============================================================
// Read Company
// ============================================================
async function readCompany(client, db, uid, pwd, companyId) {
  var recs = await executeKw(client, db, uid, pwd, 'res.company', 'read', [[companyId], [
    'name', 'partner_id', 'street', 'city', 'state_id', 'zip', 'phone', 'email', 'vat',
    'x_studio_sieg_ultimo_nfe', 'x_studio_sieg_ultimo_nfse',
    'x_studio_sieg_serie_nfe', 'x_studio_sieg_serie_nfse',
  ]]);
  if (!recs || !recs.length) throw new Error('Empresa ' + companyId + ' nao encontrada');
  var c = recs[0];

  var pId = tupId(c.partner_id);
  var p = {};
  if (pId) {
    p = await safeReadPartner(client, db, uid, pwd, pId);
  }

  var stateCode = '', stateIbge = '';
  var stateId = tupId(c.state_id || p.state_id);
  if (stateId) {
    // Read code first (standard field)
    try {
      var sts = await executeKw(client, db, uid, pwd, 'res.country.state', 'read', [[stateId], ['code']]);
      if (sts && sts[0]) stateCode = sts[0].code || '';
    } catch (e) {}
    // Try ibge_code separately (l10n_br field, may not exist)
    try {
      var sts2 = await executeKw(client, db, uid, pwd, 'res.country.state', 'read', [[stateId], ['ibge_code']]);
      if (sts2 && sts2[0]) stateIbge = sts2[0].ibge_code || '';
    } catch (e) {}
  }

  var cityIbge = '';
  var cityRef = p.l10n_br_city_id || p.city_id;
  if (cityRef && Array.isArray(cityRef)) cityIbge = await readCityIbge(client, db, uid, pwd, cityRef[0]);

  return {
    cnpj_cpf: (p.cnpj_cpf || p.vat || c.vat || '22603750000190').replace(/[^0-9]/g, ''),
    legal_name: p.legal_name || c.name || 'AJL FERRO E ACO LTDA',
    name: c.name || 'AJL',
    inscr_est: p.inscr_est || '9069585890',
    street: c.street || p.street || '',
    number: p.number || 'S/N',
    street2: p.street2 || p.district || '',
    city: c.city || p.city || 'Curitiba',
    state: stateCode || 'PR',
    zip: (c.zip || p.zip || '').replace(/[^0-9]/g, ''),
    city_ibge_code: cityIbge || '4106902',
    state_ibge: stateIbge || '41',
    crt: '1',
    phone: c.phone || p.phone || '',
    email: c.email || p.email || '',
    x_studio_sieg_ultimo_nfe: c.x_studio_sieg_ultimo_nfe || 0,
    x_studio_sieg_ultimo_nfse: c.x_studio_sieg_ultimo_nfse || 0,
    x_studio_sieg_serie_nfe: c.x_studio_sieg_serie_nfe || '100',
    x_studio_sieg_serie_nfse: c.x_studio_sieg_serie_nfse || '1',
  };
}

// ============================================================
// Read Partner
// ============================================================
async function readPartner(client, db, uid, pwd, partnerId) {
  var p = await safeReadPartner(client, db, uid, pwd, partnerId);
  if (!p.name) throw new Error('Parceiro ' + partnerId + ' nao encontrado');

  var stateCode = '';
  var stId = tupId(p.state_id);
  if (stId) {
    try {
      var sts = await executeKw(client, db, uid, pwd, 'res.country.state', 'read', [[stId], ['code']]);
      if (sts && sts[0]) stateCode = sts[0].code || '';
    } catch (e) {}
  }

  var cityIbge = '';
  var cityRef = p.l10n_br_city_id || p.city_id;
  if (cityRef && Array.isArray(cityRef)) cityIbge = await readCityIbge(client, db, uid, pwd, cityRef[0]);

  return {
    cnpj_cpf: (p.cnpj_cpf || p.vat || '').replace(/[^0-9]/g, ''),
    legal_name: p.legal_name || p.name || '',
    xNome: p.name || '',
    inscr_est: p.inscr_est || '',
    street: p.street || '',
    number: p.number || 'S/N',
    street2: p.street2 || p.district || '',
    city: p.city || '',
    state: stateCode,
    zip: (p.zip || '').replace(/[^0-9]/g, ''),
    city_ibge_code: cityIbge,
    phone: p.phone || '',
    email: p.email || '',
    is_consumer: !p.is_company,
    district: p.district || p.street2 || '',
  };
}

// ============================================================
// Build Line Data (with product x_studio_ fields for NFS-e)
// ============================================================
async function buildLineData(client, db, uid, pwd, line) {
  var productId = tupId(line.product_id);
  var productName = Array.isArray(line.product_id) ? line.product_id[1] : (line.name || 'Item');
  var defaultCode = '', barcode = '', ncm = '', detailedType = 'product', uomName = 'UN';
  var prodStudio = {}; // x_studio_ fields from product

  if (productId) {
    // Read safe product fields first (no l10n_br fields that may not exist in SaaS)
    var PRODUCT_SAFE = ['default_code', 'barcode', 'name', 'uom_id',
      'x_studio_c_trib_nac', 'x_studio_c_nbs', 'x_studio_aliquota_iss', 'x_studio_ibge_code'];
    var pr = null;
    try {
      var prods = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], PRODUCT_SAFE]);
      if (prods && prods[0]) {
        pr = prods[0];
        defaultCode = pr.default_code || '';
        barcode = pr.barcode || '';
        productName = pr.name || productName;

        // Try detailed_type separately (may not exist in Odoo 19 SaaS)
        try {
          var dt = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['detailed_type']]);
          if (dt && dt[0] && dt[0].detailed_type) detailedType = dt[0].detailed_type;
        } catch (dtErr) {
          // detailed_type not available — use type field instead
          try {
            var tp = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['type']]);
            if (tp && tp[0]) detailedType = tp[0].type === 'service' ? 'service' : 'product';
          } catch (tpErr) {}
        }

        // Try ncm_id separately (l10n_br field, may not exist in SaaS)
        try {
          var ncmData = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['ncm_id']]);
          if (ncmData && ncmData[0] && ncmData[0].ncm_id && Array.isArray(ncmData[0].ncm_id)) {
            try {
              var ncmRec = await executeKw(client, db, uid, pwd, 'l10n_br_fiscal.ncm', 'read', [[ncmData[0].ncm_id[0]], ['code']]);
              if (ncmRec && ncmRec[0]) ncm = ncmRec[0].code || '';
            } catch (e) {
              console.log('[SIEG-EMIT] l10n_br_fiscal.ncm nao disponivel, usando default_code como NCM');
            }
          }
        } catch (ncmErr) {
          // ncm_id field not available in this instance
        }

        // UoM
        if (pr.uom_id && Array.isArray(pr.uom_id)) uomName = pr.uom_id[1] || 'UN';

        // x_studio_ fields from product (for NFS-e)
        prodStudio = {
          c_trib_nac: pr.x_studio_c_trib_nac || '',
          c_nbs: pr.x_studio_c_nbs || '',
          aliquota_iss: pr.x_studio_aliquota_iss || '',
          ibge_code: pr.x_studio_ibge_code || '',
        };
      }
    } catch (e) { console.warn('[SIEG-EMIT] Erro ao ler produto ' + productId + ':', e.message); }
  }

  // Tax extraction
  var tax = await extractTaxes(client, db, uid, pwd, line);

  return {
    cProd: defaultCode, barcode: barcode,
    product_name: productName, xProd: productName,
    ncm: ncm, cfop: '5102', uom: uomName,
    qty: line.quantity || 0, price_unit: line.price_unit || 0,
    price_subtotal: line.price_subtotal || (line.quantity * line.price_unit),
    detailed_type: detailedType,
    csosn: tax.csosn || '103', orig: '0',
    cst_icms: tax.cst_icms || '',
    vbc_icms: String(tax.vbc || 0), vicms: String(tax.vicms || 0), picms: String(tax.picms || 0),
    cst_pis: tax.cst_pis || '99',
    vbc_pis: String(tax.vbc_pis || 0), ppis: String(tax.ppis || 0), vpis: String(tax.vpis || 0),
    cst_cofins: tax.cst_cofins || '99',
    vbc_cofins: String(tax.vbc_cofins || 0), pcofins: String(tax.pcofins || 0), vcofins: String(tax.vcofins || 0),
    // NFS-e fields from product
    x_studio_c_trib_nac: prodStudio.c_trib_nac,
    x_studio_c_nbs: prodStudio.c_nbs,
    x_studio_aliquota_iss: prodStudio.aliquota_iss,
    x_studio_ibge_code: prodStudio.ibge_code,
  };
}

// ============================================================
// Build Service Block for NFS-e (reads from product x_studio_ fields)
// ============================================================
function buildServiceBlock(linesData, move) {
  // Use first service line's x_studio_ fields
  var cTribNac = '';
  var cNBS = '999999999';
  var pAliq = '2.00';
  var cIntContrib = '';
  var xDescServ = move.narration || 'Servico prestado conforme contrato';

  for (var i = 0; i < linesData.length; i++) {
    var l = linesData[i];
    if (l.x_studio_c_trib_nac) cTribNac = l.x_studio_c_trib_nac;
    if (l.x_studio_c_nbs) cNBS = l.x_studio_c_nbs;
    if (l.x_studio_aliquota_iss) pAliq = String(l.x_studio_aliquota_iss);
    if (l.x_studio_ibge_code) cIntContrib = l.x_studio_ibge_code;
  }

  if (!cTribNac) cTribNac = '140101';

  return {
    cTribNac: cTribNac,
    xDescServ: xDescServ,
    cNBS: cNBS,
    cIntContrib: cIntContrib,
    valor: move.amount_total,
    pAliq: pAliq,
    tpRetISSQN: '1',
    pTotTribFed: '13.45',
    pTotTribEst: '0.00',
    pTotTribMun: '3.29',
  };
}

// ============================================================
// Tax Extraction
// ============================================================
async function extractTaxes(client, db, uid, pwd, line) {
  var result = {
    csosn: '103', cst_icms: '', vbc: 0, vicms: 0, picms: 0,
    cst_pis: '99', vbc_pis: 0, ppis: 0, vpis: 0,
    cst_cofins: '99', vbc_cofins: 0, pcofins: 0, vcofins: 0,
  };

  var taxIds = (line.tax_ids || []).map(function(t) { return Array.isArray(t) ? t[0] : t; }).filter(Boolean);
  if (!taxIds.length) return result;

  try {
    var taxes = await executeKw(client, db, uid, pwd, 'account.tax', 'read', [taxIds, [
      'name', 'amount', 'amount_type', 'description',
    ]]);
    if (!taxes || !taxes.length) return result;

    var base = parseFloat(line.price_subtotal) || 0;
    var totalIcms = 0, totalPis = 0, totalCofins = 0;

    for (var i = 0; i < taxes.length; i++) {
      var tax = taxes[i];
      var n = ((tax.name || tax.description || '').toUpperCase());
      var amt = parseFloat(tax.amount) || 0;
      if (n.indexOf('ICMS') >= 0 || n.indexOf('CSOSN') >= 0) {
        totalIcms += amt;
        var m = n.match(/(10[0-9]|20[0-9]|300|400|500|900)/);
        if (m) result.csosn = m[1];
      } else if (n.indexOf('PIS') >= 0) { totalPis += amt; }
      else if (n.indexOf('COFINS') >= 0) { totalCofins += amt; }
    }

    result.picms = totalIcms; result.vbc = base; result.vicms = base * (totalIcms / 100);
    result.ppis = totalPis; result.vbc_pis = base; result.vpis = base * (totalPis / 100);
    result.pcofins = totalCofins; result.vbc_cofins = base; result.vcofins = base * (totalCofins / 100);
  } catch (e) { console.warn('[SIEG-EMIT] Erro ao extrair impostos:', e.message); }

  return result;
}

// ============================================================
// Helpers
// ============================================================
function parseResult(resultado, tipo) {
  var resp = resultado.resposta || {};
  var chave = '', protocolo = '', cStat = '', motivo = '', numero = '', sucesso = false;

  if (tipo === 'nfe') {
    chave = resp.chNFe || resp.chave || resp.ChaveXml || '';
    protocolo = resp.nProt || resp.protocolo || '';
    cStat = String(resp.cStat || resp.status || '');
    motivo = resp.xMotivo || resp.motivo || 'Processado';
    sucesso = (cStat === '100' || cStat === '104' || cStat === '150');
  } else {
    chave = resp.Chave || resp.chave || '';
    protocolo = resp.Protocolo || resp.protocolo || '';
    numero = resp.NumeroNfse || resp.nDFSe || resp.numero || '';
    cStat = String(resp.CodigoVerificacao || resp.codigo || '');
    motivo = resp.Motivo || resp.motivo || (resultado.sucesso ? 'Autorizada' : 'Erro na emissao');
    sucesso = resultado.sucesso;
  }

  return { sucesso: sucesso, chave: chave, protocolo: protocolo, cStat: cStat, motivo: motivo, numero: numero };
}

async function readCityIbge(client, db, uid, pwd, cityId) {
 try {
    var c = await executeKw(client, db, uid, pwd, 'res.city', 'read', [[cityId], ['ibge_code']]);
    if (c && c[0] && c[0].ibge_code) return String(c[0].ibge_code);
  } catch (e) {}
  try {
    var c2 = await executeKw(client, db, uid, pwd, 'l10n_br.city', 'read', [[cityId], ['ibge_code']]);
    if (c2 && c2[0] && c2[0].ibge_code) return String(c2[0].ibge_code);
  } catch (e2) {}
  return '';
}

function tupId(val) {
  if (Array.isArray(val)) return val[0] || 0;
  if (typeof val === 'number') return val;
  return parseInt(val) || 0;
}

async function safeUpdateError(client, db, uid, pwd, moveId, tipo, errMsg) {
  try {
    var vals = {};
    if (tipo === 'nfe') vals.x_studio_nfe_status = 'erro: ' + errMsg.substring(0, 200);
    else vals.x_studio_nfse_status = 'erro: ' + errMsg.substring(0, 200);
    await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], vals]);
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
      model: 'account.move', res_id: moveId,
      body: '<b>Erro na Emissao de ' + (tipo === 'nfe' ? 'NF-e' : 'NFS-e') + '</b><br/>' + errMsg.substring(0, 500),
    }]);
  } catch (e) { console.error('[SIEG-EMIT] Falha ao registrar erro:', e.message); }
}

module.exports = { processPendingEmissions };
