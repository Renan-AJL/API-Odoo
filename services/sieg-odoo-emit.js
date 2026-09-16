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
var { IeService } = require('./ie.service');
var _ieService = new IeService();

// ============================================================
// XML-RPC Helpers
// ============================================================
function createClient(url) {
  var base = url.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  var port = base.startsWith('https') ? 443 : 80;
  var isSecure = base.startsWith('https');
  var createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host: host, path: '/xmlrpc/2/common', port: port }),
    models: createFn({ host: host, path: '/xmlrpc/2/object', port: port }),
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

  // 1. Read account.move (sem invoice_line_ids — pode ser computed nao-stored no Odoo 19)
  var moves = await executeKw(client, db, uid, pwd, 'account.move', 'read', [[moveId], [
    'name', 'partner_id', 'company_id', 'invoice_date', 'date',
    'amount_total', 'narration',
    'x_studio_nfe_status', 'x_studio_nfse_status', 'payment_state',
  ]]);
  if (!moves || !moves.length) throw new Error('Fatura ' + moveId + ' nao encontrada');
  var move = moves[0];
  console.log('[SIEG-EMIT] Fatura: ' + move.name + ' | R$ ' + (move.amount_total || 0));

  // 2. Read company
  var companyId = tupId(move.company_id);
  var company = await readCompany(client, db, uid, pwd, companyId);
  console.log('[SIEG-EMIT] [EMITENTE] CNPJ=' + company.cnpj_cpf + ' IE=' + company.inscr_est + ' cMun=' + company.city_ibge_code + ' xMun=' + company.city + ' UF=' + company.state + ' xLgr=' + company.street + ' nro=' + company.number);

  // 3. Read partner
  var partnerId = tupId(move.partner_id);
  if (!partnerId) throw new Error('Fatura sem parceiro');
  var partner = await readPartner(client, db, uid, pwd, partnerId);
  console.log('[SIEG-EMIT] [DESTINATARIO] CNPJ=' + partner.cnpj_cpf + ' IE=' + (partner.inscr_est || '(vazio)') + ' xNome=' + partner.xNome + ' cMun=' + partner.city_ibge_code + ' xMun=' + partner.city + ' UF=' + partner.state + ' xLgr=' + partner.street + ' nro=' + partner.number);

  // 3b. Auto-lookup IE do destinatario se vazio (SEFAZ cStat 232 exige IE para CFOP 5xxx/6xxx)
  if (!partner.inscr_est || String(partner.inscr_est).trim() === '') {
    var partnerCnpj = (partner.cnpj_cpf || '').replace(/\D/g, '');
    var partnerUf = partner.state || '';
    if (partnerCnpj.length === 14) {
      console.log('[SIEG-EMIT] [DEST-IE] IE vazia no Odoo. Tentando auto-lookup CNPJ=' + partnerCnpj + ' UF=' + partnerUf);
      try {
        var ieResult = await _ieService.obterIE(partnerCnpj, null, partnerUf);
        if (ieResult.hasIE && ieResult.ie) {
          partner.inscr_est = ieResult.ie;
          console.log('[SIEG-EMIT] [DEST-IE] IE encontrada: ' + ieResult.ie + ' (UF=' + (ieResult.ieState || partnerUf) + ') via ' + ieResult.source);
          // Tentar salvar IE no Odoo para futuras emissoes
          try {
            await executeKw(client, db, uid, pwd, 'res.partner', 'write', [[partnerId], { inscr_est: ieResult.ie }]);
            console.log('[SIEG-EMIT] [DEST-IE] IE salva no parceiro Odoo (id=' + partnerId + ')');
          } catch (writeErr) {
            console.warn('[SIEG-EMIT] [DEST-IE] Nao conseguiu salvar IE no Odoo: ' + writeErr.message);
          }
        } else {
          console.warn('[SIEG-EMIT] [DEST-IE] IE nao encontrada em nenhuma fonte. Motivos: ' + JSON.stringify(ieResult.reasons || []));
          console.warn('[SIEG-EMIT] [DEST-IE] Emissao provavelmente sera rejeitada pela SEFAZ (cStat 232) se CFOP exigir IE.');
        }
      } catch (ieErr) {
        console.error('[SIEG-EMIT] [DEST-IE] Erro no auto-lookup de IE: ' + ieErr.message);
      }
    } else if (partnerCnpj.length === 11) {
      console.log('[SIEG-EMIT] [DEST-IE] Destinatario CPF (consumidor final) — IE nao necessaria');
    } else {
      console.warn('[SIEG-EMIT] [DEST-IE] CNPJ/CPF invalido (' + partnerCnpj.length + ' digitos) — sem auto-lookup de IE');
    }
  } else {
    console.log('[SIEG-EMIT] [DEST-IE] IE ja preenchida no Odoo: ' + partner.inscr_est);
  }

  // 4. Read invoice lines diretamente de account.move.line (evita computed field)
  var allLineIds = await executeKw(client, db, uid, pwd, 'account.move.line', 'search', [[
    ['move_id', '=', moveId],
  ]], { order: 'id asc' });
  console.log('[SIEG-EMIT] Linhas encontradas na fatura: ' + allLineIds.length);
  var rawLines = await executeKw(client, db, uid, pwd, 'account.move.line', 'read', [allLineIds, [
    'display_type', 'product_id', 'name', 'quantity', 'price_unit',
    'price_subtotal', 'tax_ids', 'discount',
  ]]);
  // Debug: log todas as linhas
  for (var li = 0; li < rawLines.length; li++) {
    var l = rawLines[li];
    var pName = 'N/A';
    if (l.product_id) pName = Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id);
    console.log('[SIEG-EMIT]   Line ' + li + ': display_type=' + JSON.stringify(l.display_type) + ' product=' + pName + ' qty=' + l.quantity + ' price=' + l.price_unit);
  }
  // Filtro principal: linhas com produto associado (mais confiavel que display_type)
  var invoiceLines = rawLines.filter(function(l) { return l.product_id; });
  // Fallback: se nenhuma tem product_id, tenta por display_type
  if (!invoiceLines.length) {
    invoiceLines = rawLines.filter(function(l) {
      var dt = l.display_type;
      return !dt || dt === 'product' || dt === 'service';
    });
  }
  if (!invoiceLines.length) throw new Error('Fatura sem linhas de produto/servico (total: ' + rawLines.length + ', com product: 0)');
  console.log('[SIEG-EMIT] Linhas de produto: ' + invoiceLines.length);

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
  // Nota: usar amount_untaxed (sem impostos) para NF-e com CSOSN 103
  // pois vNF deve ser igual a soma dos componentes (vProd + vICMS + ...)
  // e para CSOSN 103 o ICMS e 0, entao vNF = vProd
  var vProdSum = 0;
  for (var li = 0; li < linesData.length; li++) {
    vProdSum += parseFloat(linesData[li].price_subtotal) || 0;
  }

  // Pagamentos: NF-e 4.00 — vPag deve ser igual a vNF (total SEM IBS/CBS).
  // IBS/CBS sao tributos "por fora" e nao entram no bloco <pag>.
  // Se vPag > vNF sem vTroco declarado -> cStat 866.
  var pagamentos = [{
    tPag: '15', // PIX
    vPag: String(vProdSum.toFixed(2)),
  }];

  var emitData = {
    company: company,
    partner: partner,
    order: {
      name: move.name,
      number: String(nextNum),
      date_order: move.invoice_date || move.date,
      amount_total: vProdSum, // vNF (sem IBS/CBS) — o XML calcula vNFTot internamente
      note: move.narration || '',
    },
    lines: linesData,
    pagamentos: pagamentos,
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
  var resultado;
  try {
    resultado = await emitirNota(emitData);
  } catch (siegErr) {
    // Captura erros HTTP (ex: 409 com detalhes no body)
    var siegDetail = siegErr.response && siegErr.response.data;
    var errMsg = 'SIEG HTTP ' + (siegErr.response ? siegErr.response.status : 'erro') + ': ';
    if (siegDetail) {
      // Tentar extrair ErrorMessage do formato SIEG (PascalCase)
      var siegMsg = siegDetail.ErrorMessage || siegDetail.Message || siegDetail.message || '';
      if (siegMsg) {
        errMsg += siegMsg;
      } else {
        errMsg += typeof siegDetail === 'string' ? siegDetail : JSON.stringify(siegDetail).slice(0, 800);
      }
    } else {
      errMsg += siegErr.message;
    }
    console.error('[SIEG-EMIT] Erro SIEG:', errMsg);
    throw new Error(errMsg);
  }
  console.log('[SIEG-EMIT] SIEG retornou - sucesso: ' + resultado.sucesso + (resultado.httpStatus ? ' (HTTP ' + resultado.httpStatus + ')' : ''));

  // Se SIEG retornou erro (IsSuccess=false), extrair mensagem detalhada
  if (!resultado.sucesso && resultado.erro) {
    console.error('[SIEG-EMIT] SIEG rejeitou o XML: ' + resultado.erro);
  }

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
    // Falha: NUNCA gravar texto livre num campo Selection (o Odoo descarta e a
    // fatura some da fila). Grava um valor valido ('erro' ou 'pendente') e
    // mantem o motivo detalhado no chatter.
    var errStatus = statusOnError();
    if (tipo === 'nfe') {
      updateVals.x_studio_nfe_status = errStatus;
    } else {
      updateVals.x_studio_nfse_status = errStatus;
    }
    console.warn('[SIEG-EMIT] Emissao NAO autorizada -> status "' + errStatus
      + '" (motivo: ' + (info.cStat ? info.cStat + ' - ' : '') + (info.motivo || 'n/d') + ')');
  }

  await writeStatusSafe(client, db, uid, pwd, moveId, tipo, updateVals);
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
    try { p = await readPartnerSafe(client, db, uid, pwd, pId); } catch (e) {
      console.warn('[SIEG-EMIT] Erro ao ler partner da empresa:', e.message);
    }
  }

  var stateCode = '', stateIbge = '';
  var stateId = tupId(c.state_id || p.state_id);
  if (stateId) {
    try {
      var sts = await executeKw(client, db, uid, pwd, 'res.country.state', 'read', [[stateId], ['code', 'ibge_code']]);
      if (sts && sts[0]) { stateCode = sts[0].code || ''; stateIbge = sts[0].ibge_code || ''; }
    } catch (e) {}
  }

  var cityIbge = '';
  var cityRef = p.l10n_br_city_id || p.city_id;
  if (cityRef && Array.isArray(cityRef)) cityIbge = await readCityIbge(client, db, uid, pwd, cityRef[0]);

  return {
    cnpj_cpf: p.cnpj_cpf || c.vat || '22603750000190',
    legal_name: p.legal_name || c.name || 'AJL FERRO E ACO LTDA',
    name: c.name || 'AJL',
    inscr_est: p.inscr_est || '9069585890',
    street: c.street || p.street || '',
    number: p.number || 'S/N',
    street2: p.street2 || p.district || '',
    city: c.city || p.city || 'Curitiba',
    state: stateCode || 'PR',
    zip: c.zip || p.zip || '',
    city_ibge_code: cityIbge || '4106902',
    state_ibge: stateIbge || '41',
    crt: '3',
    phone: c.phone || p.phone || '',
    email: c.email || p.email || '',
    x_studio_sieg_ultimo_nfe: c.x_studio_sieg_ultimo_nfe || 0,
    x_studio_sieg_ultimo_nfse: c.x_studio_sieg_ultimo_nfse || 0,
    x_studio_sieg_serie_nfe: c.x_studio_sieg_serie_nfe || '100',
    x_studio_sieg_serie_nfse: c.x_studio_sieg_serie_nfse || '1',
  };
}

// ============================================================
// Read Partner (safe for Odoo 19 SaaS — l10n_br fields may not exist)
// ============================================================
var PARTNER_SAFE_FIELDS = [
  'name', 'vat', 'street', 'street2', 'city', 'state_id', 'zip',
  'phone', 'email', 'is_company', 'city_id', 'country_id',
];
var PARTNER_BR_FIELDS = ['cnpj_cpf', 'inscr_est', 'l10n_br_ie_code', 'legal_name', 'number', 'l10n_br_city_id', 'district'];

/**
 * Leitura segura de res.partner: campos core + l10n_br opcionais.
 * No Odoo 19 SaaS, campos como cnpj_cpf, inscr_est, legal_name, number,
 * l10n_br_city_id, district podem nao existir. Fazemos duas leituras:
 *   1. Campos core (sempre existem)
 *   2. Campos l10n_br (try/catch, ignora se falhar)
 *   3. Discovery: tenta encontrar campos x_studio_* para IE/CNPJ/razao social
 */

// Cache de campos IE descobertos no Odoo (para nao descobrir toda vez)
var _discoveredIeField = null;
var _discoveredCnpjField = null;
var _discoveredLegalNameField = null;
var _discoveredNumberField = null;

async function discoverPartnerFields(client, db, uid, pwd) {
  // Se ja descobrimos antes, reusa
  if (_discoveredIeField !== null) return;

  try {
    // fields_get() retorna metadados de todos os campos
    var allFields = await executeKw(client, db, uid, pwd, 'res.partner', 'fields_get', [[], ['string', 'type']]);
    var fieldNames = Object.keys(allFields);

    // Procurar campo IE
    var ieCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'inscr_est' || fl === 'l10n_br_ie' ||
             fl.indexOf('inscricao_estadual') >= 0 ||
             fl.indexOf('inscr_est') >= 0 ||
             (fl.indexOf('ie') >= 0 && fl.indexOf('x_studio') >= 0 && fl.indexOf('email') < 0 && fl.indexOf('field') < 0);
    });
    // Prioridade: inscr_est > l10n_br_ie > x_studio_*
    ieCandidates.sort(function(a, b) {
      if (a === 'inscr_est') return -1;
      if (b === 'inscr_est') return 1;
      if (a === 'l10n_br_ie') return -1;
      if (b === 'l10n_br_ie') return 1;
      return a.localeCompare(b);
    });
    _discoveredIeField = ieCandidates.length > 0 ? ieCandidates[0] : false;

    // Procurar campo CNPJ/CPF (alem de cnpj_cpf e vat)
    var cnpjCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'cnpj_cpf' || fl === 'l10n_br_cnpj_cpf' ||
             (fl.indexOf('cnpj') >= 0 && fl.indexOf('x_studio') >= 0);
    });
    _discoveredCnpjField = cnpjCandidates.length > 0 ? cnpjCandidates[0] : false;

    // Procurar campo razao social (alem de legal_name)
    var nameCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'legal_name' || fl === 'l10n_br_legal_name' ||
             (fl.indexOf('razao_social') >= 0 || fl.indexOf('legal_name') >= 0) && fl.indexOf('x_studio') >= 0;
    });
    _discoveredLegalNameField = nameCandidates.length > 0 ? nameCandidates[0] : false;

    // Procurar campo numero do endereco
    var numCandidates = fieldNames.filter(function(f) {
      var fl = f.toLowerCase();
      return fl === 'number' || fl === 'l10n_br_number' ||
             (fl.indexOf('numero') >= 0 && fl.indexOf('x_studio') >= 0);
    });
    _discoveredNumberField = numCandidates.length > 0 ? numCandidates[0] : false;

    console.log('[SIEG-EMIT] [DISCOVERY] Campos IE: ' + JSON.stringify(ieCandidates) + ' -> usando: ' + (_discoveredIeField || 'nenhum'));
    console.log('[SIEG-EMIT] [DISCOVERY] Campos CNPJ: ' + JSON.stringify(cnpjCandidates) + ' -> usando: ' + (_discoveredCnpjField || 'vat'));
    if (_discoveredLegalNameField) console.log('[SIEG-EMIT] [DISCOVERY] Razao social: ' + _discoveredLegalNameField);
    if (_discoveredNumberField && _discoveredNumberField !== 'number') console.log('[SIEG-EMIT] [DISCOVERY] Numero endereco: ' + _discoveredNumberField);
  } catch (e) {
    console.warn('[SIEG-EMIT] [DISCOVERY] Erro ao descobrir campos: ' + e.message);
    _discoveredIeField = false;
    _discoveredCnpjField = false;
    _discoveredLegalNameField = false;
    _discoveredNumberField = false;
  }
}

async function readPartnerSafe(client, db, uid, pwd, partnerId, extraFields) {
  var fields = PARTNER_SAFE_FIELDS.slice();
  if (extraFields) fields = fields.concat(extraFields);
  var recs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], fields]);
  if (!recs || !recs.length) throw new Error('Parceiro ' + partnerId + ' nao encontrado');
  var p = recs[0];
  // Try Brazilian fields separately
  try {
    var brRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], PARTNER_BR_FIELDS]);
    if (brRecs && brRecs[0]) {
      for (var k in brRecs[0]) { if (brRecs[0][k] !== undefined) p[k] = brRecs[0][k]; }
    }
  } catch (e) {
    console.log('[SIEG-EMIT] Campos l10n_br nao disponiveis, usando vat como CNPJ/CPF');
  }

  // Discovery: tenta encontrar campos IE/CNPJ/razao social via fields_get
  await discoverPartnerFields(client, db, uid, pwd);

  // Leitura direta da Inscricao Estadual do Odoo Brasil
  // Separada dos demais campos l10n_br para nao falhar se outro campo opcional nao existir.
  if (p.inscr_est === undefined || p.inscr_est === null || String(p.inscr_est).trim() === "") {
    try {
      var ieDirectRecs = await executeKw(client, db, uid, pwd, "res.partner", "read", [[partnerId], ["l10n_br_ie_code"]]);
      if (ieDirectRecs && ieDirectRecs[0] && ieDirectRecs[0].l10n_br_ie_code) {
        p.inscr_est = ieDirectRecs[0].l10n_br_ie_code;
        console.log("[SIEG-EMIT] [DEST-IE] IE lida diretamente de l10n_br_ie_code = " + p.inscr_est);
      }
    } catch (e) {
      console.warn("[SIEG-EMIT] [DEST-IE] Leitura direta de l10n_br_ie_code falhou: " + e.message);
    }
  }

  // Se inscr_est ainda vazio, tenta campo descoberto
  if ((!p.inscr_est || String(p.inscr_est).trim() === '') && _discoveredIeField && _discoveredIeField !== 'inscr_est') {
    try {
      var ieRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], [_discoveredIeField]]);
      if (ieRecs && ieRecs[0] && ieRecs[0][_discoveredIeField]) {
        p.inscr_est = ieRecs[0][_discoveredIeField];
        console.log('[SIEG-EMIT] [DEST-IE] IE lida do campo descoberto: ' + _discoveredIeField + ' = ' + p.inscr_est);
      }
    } catch (e) {
      console.warn('[SIEG-EMIT] [DEST-IE] Campo descoberto ' + _discoveredIeField + ' falhou: ' + e.message);
    }
  }

  // Se cnpj_cpf ainda vazio, tenta campo descoberto
  if ((!p.cnpj_cpf || String(p.cnpj_cpf).trim() === '') && _discoveredCnpjField) {
    try {
      var cnpjRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], [_discoveredCnpjField]]);
      if (cnpjRecs && cnpjRecs[0] && cnpjRecs[0][_discoveredCnpjField]) {
        p.cnpj_cpf = cnpjRecs[0][_discoveredCnpjField];
      }
    } catch (e) {}
  }

  // Se legal_name ainda vazio, tenta campo descoberto
  if ((!p.legal_name || String(p.legal_name).trim() === '') && _discoveredLegalNameField) {
    try {
      var nameRecs = await executeKw(client, db, uid, pwd, 'res.partner', 'read', [[partnerId], [_discoveredLegalNameField]]);
      if (nameRecs && nameRecs[0] && nameRecs[0][_discoveredLegalNameField]) {
        p.legal_name = nameRecs[0][_discoveredLegalNameField];
      }
    } catch (e) {}
  }

  return p;
}

async function readPartner(client, db, uid, pwd, partnerId) {
  var p = await readPartnerSafe(client, db, uid, pwd, partnerId);

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

  // Fallback 1: buscar res.city por nome + estado
  if (!cityIbge && p.city && stateCode) {
    cityIbge = await searchCityIbge(client, db, uid, pwd, p.city, stId);
  }
  // Fallback 2: tabela embutida de cidades principais
  if (!cityIbge && p.city && stateCode) {
    cityIbge = lookupIbgeFallback(p.city, stateCode);
  }
  if (!cityIbge) {
    console.warn('[SIEG-EMIT] cMun vazio para parceiro ' + partnerId + ' (' + (p.name || '?') + '): cidade=' + (p.city || '?') + ' UF=' + (stateCode || '?'));
  }

  return {
    cnpj_cpf: p.cnpj_cpf || p.vat || '',
    legal_name: p.legal_name || p.name || '',
    xNome: p.name || '',
    inscr_est: p.inscr_est || p.l10n_br_ie_code || p[_discoveredIeField] || '',
    street: p.street || '',
    number: p.number || 'S/N',
    street2: p.street2 || p.district || '',
    city: p.city || '',
    state: stateCode,
    zip: p.zip || '',
    city_ibge_code: cityIbge,
    phone: p.phone || '',
    email: p.email || '',
    is_consumer: !p.is_company,
    district: p.district || p.street2 || '',
  };
}

// ============================================================
// NCM Extraction Helper
// ============================================================
/**
 * Extrai codigo NCM (8 digitos) de um valor many2one do Odoo.
 * Aceita: [id, "7308.90.90"], [id, "7308.90.90 - Descricao"], string pura, numero
 */
function extractNcmFromRef(ref) {
  if (!ref) return '';
  var str = '';
  if (Array.isArray(ref)) {
    str = String(ref[1] || ref[0] || '');
  } else if (typeof ref === 'string') {
    str = ref;
  } else if (typeof ref === 'number') {
    return String(ref).length === 8 ? String(ref) : '';
  } else {
    str = String(ref);
  }
  // Tentar regex NNNN.NN.NN
  var m = str.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (m) return m[1] + m[2] + m[3];
  // Fallback: so digitos
  var digits = str.replace(/\D/g, '');
  return digits.length === 8 ? digits : '';
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
    try {
      // Campos core do produto (sempre existem) — SEM detailed_type (pode nao existir no SaaS)
      var prods = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], [
        'default_code', 'barcode', 'name', 'uom_id',
      ]]);
      if (prods && prods[0]) {
        var pr = prods[0];
        defaultCode = pr.default_code || '';
        barcode = pr.barcode || '';
        productName = pr.name || productName;
        if (pr.uom_id && Array.isArray(pr.uom_id)) uomName = pr.uom_id[1] || 'UN';
      }

      // Campo detailed_type (pode nao existir no Odoo 19 SaaS)
      try {
        var prodsDt = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['detailed_type']]);
        if (prodsDt && prodsDt[0] && prodsDt[0].detailed_type) detailedType = prodsDt[0].detailed_type;
      } catch (eDt) {
        console.log('[SIEG-EMIT] detailed_type nao disponivel, usando product');
      }

      // NCM do produto
      // Campo correto no Odoo 19 SaaS com l10n_br: l10n_br_ncm_code_id (many2one -> l10n_br.ncm.code)
      // Este campo esta em product.template (nao product.product)
      // Estrategia:
      //   T1: Ler product_tmpl_id + l10n_br_ncm_code_id do template
      //   T2: Tentar ncm_id em product.product (l10n_br_fiscal — pode nao existir)
      //   T3: fields_get para descobrir campo NCM alternativo

      // === T1: Ler l10n_br_ncm_code_id do product.template ===
      try {
        console.log('[SIEG-EMIT-NCM] [T1] Lendo product_tmpl_id + l10n_br_ncm_code_id...');
        var prodsTmpl = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['product_tmpl_id']]);
        if (prodsTmpl && prodsTmpl[0] && prodsTmpl[0].product_tmpl_id) {
          var tmplId = tupId(prodsTmpl[0].product_tmpl_id);
          console.log('[SIEG-EMIT-NCM] [T1] product_tmpl_id: ' + tmplId);
          var tmplNcm = await executeKw(client, db, uid, pwd, 'product.template', 'read', [[tmplId], ['l10n_br_ncm_code_id']]);
          console.log('[SIEG-EMIT-NCM] [T1] l10n_br_ncm_code_id bruto: ' + JSON.stringify(tmplNcm && tmplNcm[0] ? tmplNcm[0].l10n_br_ncm_code_id : 'N/A'));
          if (tmplNcm && tmplNcm[0] && tmplNcm[0].l10n_br_ncm_code_id) {
            ncm = extractNcmFromRef(tmplNcm[0].l10n_br_ncm_code_id);
            if (ncm) console.log('[SIEG-EMIT-NCM] [T1] *** NCM ENCONTRADO: ' + ncm + ' ***');
          } else {
            console.warn('[SIEG-EMIT-NCM] [T1] l10n_br_ncm_code_id vazio no template ' + tmplId);
          }
        } else {
          console.warn('[SIEG-EMIT-NCM] [T1] product_tmpl_id vazio para produto ' + productId);
        }
      } catch (eT1) {
        console.error('[SIEG-EMIT-NCM] [T1] FALHOU: ' + eT1.message);
      }

      // === T2: Tentar ncm_id em product.product (l10n_br_fiscal) ===
      if (!ncm) {
        try {
          console.log('[SIEG-EMIT-NCM] [T2] Tentando ncm_id em product.product...');
          var prodsNcm = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], ['ncm_id']]);
          if (prodsNcm && prodsNcm[0] && prodsNcm[0].ncm_id) {
            ncm = extractNcmFromRef(prodsNcm[0].ncm_id);
            if (ncm) console.log('[SIEG-EMIT-NCM] [T2] NCM via ncm_id: ' + ncm);
          }
        } catch (eT2) {
          console.log('[SIEG-EMIT-NCM] [T2] ncm_id nao disponivel: ' + eT2.message);
        }
      }

      // === T3: Descobrir campos NCM via fields_get ===
      if (!ncm) {
        try {
          console.log('[SIEG-EMIT-NCM] [T3] Buscando campos NCM via fields_get...');
          var fieldsInfo = await executeKw(client, db, uid, pwd, 'product.template', 'fields_get', [
            ['l10n_br_ncm_code_id', 'ncm_id', 'l10n_br_ncm_id', 'ncm_code_id'],
            ['type', 'relation', 'string']
          ]);
          console.log('[SIEG-EMIT-NCM] [T3] fields_get: ' + JSON.stringify(fieldsInfo));
          var fieldNames = Object.keys(fieldsInfo || {});
          for (var fi = 0; fi < fieldNames.length; fi++) {
            var fname = fieldNames[fi];
            if (fieldsInfo[fname].type === 'many2one') {
              try {
                var fv = await executeKw(client, db, uid, pwd, 'product.template', 'read', [[tmplId], [fname]]);
                if (fv && fv[0] && fv[0][fname]) {
                  var extracted = extractNcmFromRef(fv[0][fname]);
                  if (extracted) {
                    ncm = extracted;
                    console.log('[SIEG-EMIT-NCM] [T3] NCM via ' + fname + ': ' + ncm);
                    break;
                  }
                }
              } catch (ef3) {
                console.log('[SIEG-EMIT-NCM] [T3] ' + fname + ' falhou: ' + ef3.message);
              }
            }
          }
        } catch (eT3) {
          console.error('[SIEG-EMIT-NCM] [T3] FALHOU: ' + eT3.message);
        }
      }

      // x_studio fields documentados neste Odoo (NFS-e e customizacoes)
      try {
        var prods2 = await executeKw(client, db, uid, pwd, 'product.product', 'read', [[productId], [
          'x_studio_c_trib_nac', 'x_studio_c_nbs', 'x_studio_aliquota_iss', 'x_studio_ibge_code',
        ]]);
        if (prods2 && prods2[0]) {
          var pr2 = prods2[0];
          prodStudio = {
            c_trib_nac: pr2.x_studio_c_trib_nac || '',
            c_nbs: pr2.x_studio_c_nbs || '',
            aliquota_iss: pr2.x_studio_aliquota_iss || '',
            ibge_code: pr2.x_studio_ibge_code || '',
          };
        }
      } catch (e2) {
        console.log('[SIEG-EMIT] Campos x_studio do produto nao disponiveis: ' + e2.message);
      }
      // Fallback final: NCM do env var (se configurado)
      if (!ncm && process.env.SIEG_DEFAULT_NCM) {
        ncm = String(process.env.SIEG_DEFAULT_NCM).replace(/\D/g, '');
        console.log('[SIEG-EMIT-NCM] NCM via SIEG_DEFAULT_NCM env: ' + ncm);
      }
      // ALERTA se NCM ainda vazio
      if (!ncm) {
        console.error('[SIEG-EMIT-NCM] *** NCM VAZIO para produto ' + productId + ' (' + productName + ') — XML sera invalido ***');
      }
    } catch (e) { console.warn('[SIEG-EMIT] Erro ao ler produto ' + productId + ':', e.message); }
  }

  // Tax extraction
  var tax = await extractTaxes(client, db, uid, pwd, line);

  var lineData = {
    cProd: defaultCode, barcode: barcode,
    product_name: productName, xProd: productName,
    ncm: ncm, cfop: '5102', uom: uomName,
    qty: line.quantity || 0, price_unit: line.price_unit || 0,
    price_subtotal: line.price_subtotal || (line.quantity * line.price_unit),
    detailed_type: detailedType,
    // Tributação Lucro Real (padrão) — sobrescrito se Odoo tiver impostos configurados
    csosn: tax.csosn || '',
    cst_icms: tax.cst_icms || '00',
    mod_bc: tax.mod_bc || '3',
    orig: '0',
    vbc_icms: String(tax.vbc || 0),
    vicms: String(tax.vicms || 0),
    picms: String(tax.picms || 0),
    cst_pis: tax.cst_pis || '01',
    vbc_pis: String(tax.vbc_pis || 0),
    ppis: String(tax.ppis || 0),
    vpis: String(tax.vpis || 0),
    cst_cofins: tax.cst_cofins || '01',
    vbc_cofins: String(tax.vbc_cofins || 0),
    pcofins: String(tax.pcofins || 0),
    vcofins: String(tax.vcofins || 0),
    // NFS-e fields from product
    x_studio_c_trib_nac: prodStudio.c_trib_nac,
    x_studio_c_nbs: prodStudio.c_nbs,
    x_studio_aliquota_iss: prodStudio.aliquota_iss,
    x_studio_ibge_code: prodStudio.ibge_code,
  };

  // === LOG DETALHADO POR CAMPO (para debug de XML invalido) ===
  console.log('[SIEG-EMIT-LINE] === Dados da linha (product ' + productId + ') ===');
  console.log('[SIEG-EMIT-LINE]   cProd:      ' + JSON.stringify(lineData.cProd) + (lineData.cProd ? '' : ' *** VAZIO ***'));
  console.log('[SIEG-EMIT-LINE]   xProd:      ' + JSON.stringify(lineData.xProd));
  console.log('[SIEG-EMIT-LINE]   NCM:        ' + JSON.stringify(lineData.ncm) + (lineData.ncm ? '' : ' *** VAZIO ***'));
  console.log('[SIEG-EMIT-LINE]   CFOP:       ' + JSON.stringify(lineData.cfop));
  console.log('[SIEG-EMIT-LINE]   uCom:       ' + JSON.stringify(lineData.uom));
  console.log('[SIEG-EMIT-LINE]   qCom:       ' + lineData.qty);
  console.log('[SIEG-EMIT-LINE]   vUnCom:     ' + lineData.price_unit);
  console.log('[SIEG-EMIT-LINE]   vProd:      ' + lineData.price_subtotal);
  console.log('[SIEG-EMIT-LINE]   CSOSN:      ' + JSON.stringify(lineData.csosn));
  console.log('[SIEG-EMIT-LINE]   CST_ICMS:   ' + JSON.stringify(lineData.cst_icms));
  console.log('[SIEG-EMIT-LINE]   modBC:      ' + JSON.stringify(lineData.mod_bc));
  console.log('[SIEG-EMIT-LINE]   vBC_ICMS:   ' + lineData.vbc_icms);
  console.log('[SIEG-EMIT-LINE]   vICMS:      ' + lineData.vicms);
  console.log('[SIEG-EMIT-LINE]   pICMS:      ' + lineData.picms);
  console.log('[SIEG-EMIT-LINE]   CST_PIS:    ' + JSON.stringify(lineData.cst_pis));
  console.log('[SIEG-EMIT-LINE]   vBC_PIS:    ' + lineData.vbc_pis);
  console.log('[SIEG-EMIT-LINE]   pPIS:       ' + lineData.ppis);
  console.log('[SIEG-EMIT-LINE]   vPIS:       ' + lineData.vpis);
  console.log('[SIEG-EMIT-LINE]   CST_COFINS: ' + JSON.stringify(lineData.cst_cofins));
  console.log('[SIEG-EMIT-LINE]   vBC_COFINS: ' + lineData.vbc_cofins);
  console.log('[SIEG-EMIT-LINE]   pCOFINS:    ' + lineData.pcofins);
  console.log('[SIEG-EMIT-LINE]   vCOFINS:    ' + lineData.vcofins);

  return lineData;
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
  // Padrão: Lucro Real (CRT 3) — CST 00, ICMS 18% PR interno
  // PIS/COFINS não-cumulativo com base no valor do produto
  var base = parseFloat(line.price_subtotal) || 0;
  var result = {
    csosn: '',
    cst_icms: '00',
    mod_bc: '3',
    vbc: base,
    vicms: base * 0.18,
    picms: 18.00,
    cst_pis: '01',
    vbc_pis: base,
    ppis: 1.65,
    vpis: base * 0.0165,
    cst_cofins: '01',
    vbc_cofins: base,
    pcofins: 7.60,
    vcofins: base * 0.076,
  };

  var taxIds = (line.tax_ids || []).map(function(t) { return Array.isArray(t) ? t[0] : t; }).filter(Boolean);
  if (!taxIds.length) return result;

  try {
    var taxes = await executeKw(client, db, uid, pwd, 'account.tax', 'read', [taxIds, [
      'name', 'amount', 'amount_type', 'description',
    ]]);
    if (!taxes || !taxes.length) return result;

    var totalIcms = 0, totalPis = 0, totalCofins = 0;
    var foundCsosn = '';

    for (var i = 0; i < taxes.length; i++) {
      var tax = taxes[i];
      var n = ((tax.name || tax.description || '').toUpperCase());
      var amt = parseFloat(tax.amount) || 0;
      if (n.indexOf('ICMS') >= 0 || n.indexOf('CSOSN') >= 0) {
        totalIcms += amt;
        var m = n.match(/(10[0-9]|20[0-9]|300|400|500|900)/);
        if (m) foundCsosn = m[1];
      } else if (n.indexOf('PIS') >= 0) { totalPis += amt; }
      else if (n.indexOf('COFINS') >= 0) { totalCofins += amt; }
    }

    // Sobrescreve defaults apenas se o Odoo tiver impostos reais configurados (> 0)
    if (foundCsosn) {
      result.csosn = foundCsosn;
      result.cst_icms = '';
    }
    if (totalIcms > 0) {
      result.picms = totalIcms;
      result.vicms = base * (totalIcms / 100);
    }
    if (totalPis > 0) {
      result.ppis = totalPis;
      result.vpis = base * (totalPis / 100);
    }
    if (totalCofins > 0) {
      result.pcofins = totalCofins;
      result.vcofins = base * (totalCofins / 100);
    }
  } catch (e) { console.warn('[SIEG-EMIT] Erro ao extrair impostos:', e.message); }

  return result;
}

// ============================================================
// Helpers
// ============================================================
function parseResult(resultado, tipo) {
  var resp = resultado.resposta || {};
  var chave = '', protocolo = '', cStat = '', motivo = '', numero = '', sucesso = false;

  // Se SIEG retornou HTTP 4xx, usar ErrorMessage diretamente como motivo
  var siegErro = resultado.erro || '';
  if (resultado.httpStatus && resultado.httpStatus >= 400 && resultado.httpStatus < 500) {
    // Erro de validacao do XML — extrair mensagem do SIEG
    motivo = siegErro || 'Erro HTTP ' + resultado.httpStatus;
    if (tipo === 'nfe') {
      cStat = String(resultado.statusCode || resp.cStat || resp.status || '');
    }
    return { sucesso: false, chave: chave, protocolo: protocolo, cStat: cStat, motivo: motivo, numero: numero };
  }

  if (tipo === 'nfe') {
    chave = resp.chNFe || resp.chave || resp.ChaveXml || '';
    protocolo = resp.nProt || resp.protocolo || '';
    cStat = String(resp.cStat || resp.status || '');
    motivo = resp.xMotivo || resp.motivo || (siegErro || 'Processado');
    sucesso = (cStat === '100' || cStat === '104' || cStat === '150');
  } else {
    chave = resp.Chave || resp.chave || '';
    protocolo = resp.Protocolo || resp.protocolo || '';
    numero = resp.NumeroNfse || resp.nDFSe || resp.numero || '';
    cStat = String(resp.CodigoVerificacao || resp.codigo || '');
    motivo = resp.Motivo || resp.motivo || siegErro || (resultado.sucesso ? 'Autorizada' : 'Erro na emissao');
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

/**
 * Busca IBGE de cidade pelo nome e estado_id no Odoo
 */
async function searchCityIbge(client, db, uid, pwd, cityName, stateId) {
  if (!cityName || !stateId) return '';
  try {
    var domain = [['name', 'ilike', cityName]];
    if (stateId) domain.push(['state_id', '=', stateId]);
    var ids = await executeKw(client, db, uid, pwd, 'res.city', 'search', [domain], { limit: 5 });
    if (ids && ids.length > 0) {
      // Ler ibge_code de todos os resultados encontrados
      var cities = await executeKw(client, db, uid, pwd, 'res.city', 'read', [ids, ['name', 'ibge_code']]);
      if (cities) {
        for (var i = 0; i < cities.length; i++) {
          if (cities[i].ibge_code) {
            console.log('[SIEG-EMIT] IBGE encontrado por busca: ' + cities[i].name + ' = ' + cities[i].ibge_code);
            return String(cities[i].ibge_code);
          }
        }
      }
    }
  } catch (e) {
    console.log('[SIEG-EMIT] Busca res.city falhou: ' + e.message);
  }
  return '';
}

/**
 * Tabela de fallback para cidades principais do BR
 * Chave: 'CIDADE/UF' (normalizado) -> codigo IBGE 7 digitos
 */
var IBGE_FALLBACK = {
  'CURITIBA/PR': '4106902',
  'SAO PAULO/SP': '3550308',
  'RIO DE JANEIRO/RJ': '3304557',
  'BELO HORIZONTE/MG': '3106200',
  'PORTO ALEGRE/RS': '4314902',
  'SALVADOR/BA': '2927408',
  'BRASILIA/DF': '5300108',
  'FORTALEZA/CE': '2304400',
  'RECIFE/PE': '2611606',
  'CURITIBA/PR': '4106902',
  'GUARULHOS/SP': '3518800',
  'CAMPINAS/SP': '3509502',
  'SAO BERNARDO DO CAMPO/SP': '3548708',
  'SANTOS/SP': '3548500',
  'RIBEIRAO PRETO/SP': '3543402',
  'UBERLANDIA/MG': '3170206',
  'LONDRINA/PR': '4113700',
  'MARINGA/PR': '4115200',
  'PONTA GROSSA/PR': '4119905',
  'FOZ DO IGUACU/PR': '4108304',
  'CAMPO MOURAO/PR': '4104803',
  'CASCAVEL/PR': '4104808',
  'JOINVILLE/SC': '4209102',
  'FLORIANOPOLIS/SC': '4205407',
  'BALNEARIO CAMBORIU/SC': '4202008',
  'ITU/SP': '3523909',
  'JUNDIAI/SP': '3525904',
  'SOROCABA/SP': '3552205',
  'SAO JOSE DOS CAMPOS/SP': '3549904',
  'SANTO ANDRE/SP': '3548807',
  'SAO JOSE DO RIO PRETO/SP': '3549805',
  'MANAUS/AM': '1302603',
  'BELEM/PA': '1501402',
  'GOIANIA/GO': '5208707',
  'VITORIA/ES': '3205309',
  'VOLTA REDONDA/RJ': '3306305',
  'NILOPOLIS/RJ': '3303203',
  'MESQUITA/RJ': '3302858',
  'DUQUE DE CAXIAS/RJ': '3301702',
  'NOVA IGUACU/RJ': '3303500',
  'SAO GONCALO/RJ': '3304904',
  'MAUA/SP': '3529401',
  'DIADEMA/SP': '3513801',
  'OSASCO/SP': '3534401',
  'CARAPICUIBA/SP': '3509502',
  'MOGI DAS CRUZES/SP': '3530607',
  'SUZANO/SP': '3552503',
  'TABOAO DA SERRA/SP': '3552809',
};

function lookupIbgeFallback(cityName, stateCode) {
  if (!cityName || !stateCode) return '';
  var key = (cityName.toUpperCase().trim() + '/' + stateCode.toUpperCase().trim());
  var code = IBGE_FALLBACK[key];
  if (code) {
    console.log('[SIEG-EMIT] IBGE via tabela fallback: ' + key + ' = ' + code);
  }
  return code || '';
}

function tupId(val) {
  if (Array.isArray(val)) return val[0] || 0;
  if (typeof val === 'number') return val;
  return parseInt(val) || 0;
}

/**
 * Valor gravado no campo Selection quando a emissao falha.
 * NFE_STATUS_ON_ERROR=pendente -> a fatura volta para a fila e e retentada.
 * Padrao 'erro' -> exige reprocessamento manual.
 */
function statusOnError() {
  var v = String(process.env.NFE_STATUS_ON_ERROR || 'erro').trim().toLowerCase();
  return v === 'pendente' ? 'pendente' : 'erro';
}

/**
 * Grava o status com fallback: se o Odoo recusar o valor da Selection,
 * tenta 'pendente' para a fatura nunca ficar fora da fila silenciosamente.
 */
async function writeStatusSafe(client, db, uid, pwd, moveId, tipo, vals) {
  var field = tipo === 'nfe' ? 'x_studio_nfe_status' : 'x_studio_nfse_status';
  try {
    await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], vals]);
  } catch (e) {
    console.error('[SIEG-EMIT] Falha ao gravar status (' + vals[field] + '): ' + e.message);
    var fb = {};
    fb[field] = 'pendente';
    try {
      await executeKw(client, db, uid, pwd, 'account.move', 'write', [[moveId], fb]);
      console.warn('[SIEG-EMIT] Status revertido para "pendente" (retentativa possivel)');
    } catch (e2) { console.error('[SIEG-EMIT] Falha no fallback de status:', e2.message); }
  }
}

async function safeUpdateError(client, db, uid, pwd, moveId, tipo, errMsg) {
  try {
    var vals = {};
    var st = statusOnError();
    if (tipo === 'nfe') vals.x_studio_nfe_status = st;
    else vals.x_studio_nfse_status = st;
    await writeStatusSafe(client, db, uid, pwd, moveId, tipo, vals);
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
      model: 'account.move', res_id: moveId,
      body: '<b>Erro na Emissao de ' + (tipo === 'nfe' ? 'NF-e' : 'NFS-e') + '</b><br/>' + errMsg.substring(0, 500),
      message_type: 'comment',
    }]);
  } catch (e) { console.error('[SIEG-EMIT] Falha ao registrar erro:', e.message); }
}

// ============================================================
// Process Pending Cancellations (polling para status 'cancelando')
// ============================================================
/**
 * Busca faturas com x_studio_nfe_status = 'cancelando' e envia o
 * evento de cancelamento à SEFAZ PR, depois atualiza o Odoo.
 * Chamado pelo runSiegPoll no server.js junto com processPendingEmissions.
 */
async function processPendingCancellations() {
  var odoo = config.odoo;
  if (!odoo || !odoo.enabled || !odoo.url) {
    return { processed: 0, reason: 'odoo_not_configured' };
  }

  var client = createClient(odoo.url);
  var uid = await authenticate(client, odoo.db, odoo.user, odoo.password);
  var db = odoo.db;
  var pwd = odoo.password;

  var ids = await executeKw(client, db, uid, pwd, 'account.move', 'search', [[
    ['move_type', '=', 'out_invoice'],
    ['x_studio_nfe_status', '=', 'cancelando'],
  ]], { order: 'id asc', limit: 5 });

  if (!ids.length) return { processed: 0 };

  console.log('[SIEG-CANCEL-POLL] ' + ids.length + ' fatura(s) aguardando cancelamento');

  var { cancelarNFe } = require('./nfe-cancelamento');

  var results = [];
  for (var i = 0; i < ids.length; i++) {
    var moveId = ids[i];
    try {
      var r = await cancelOneInvoice(client, db, uid, pwd, moveId, cancelarNFe);
      results.push(r);
    } catch (err) {
      console.error('[SIEG-CANCEL-POLL] ERRO fatura ' + moveId + ':', err.message);
      try {
        await executeKw(client, db, uid, pwd, 'account.move', 'write',
          [[moveId], { x_studio_nfe_status: 'erro' }]);
        await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
          model: 'account.move', res_id: moveId,
          body: '<b>Erro no Cancelamento</b><br/>' + err.message.substring(0, 500),
          message_type: 'comment',
        }]);
      } catch (e2) { console.error('[SIEG-CANCEL-POLL] Falha ao gravar erro:', e2.message); }
      results.push({ move_id: moveId, sucesso: false, erro: err.message });
    }
  }

  var ok = results.filter(function(r) { return r.sucesso; }).length;
  console.log('[SIEG-CANCEL-POLL] Concluido: ' + ok + '/' + results.length + ' cancelada(s)');
  return { processed: results.length, sucesso: ok };
}

async function cancelOneInvoice(client, db, uid, pwd, moveId, cancelarNFe) {
  var moves = await executeKw(client, db, uid, pwd, 'account.move', 'read',
    [[moveId], ['name', 'x_studio_nfe_chave', 'x_studio_nfe_protocolo',
                'x_studio_nfe_status', 'company_id']]);
  if (!moves || !moves.length) throw new Error('Fatura ' + moveId + ' nao encontrada');
  var move = moves[0];

  var chave     = (move.x_studio_nfe_chave || '').replace(/\D/g, '');
  var protocolo = String(move.x_studio_nfe_protocolo || '').trim();
  var justificativa = 'Cancelamento solicitado pelo emitente via Odoo';
  if (justificativa.length < 15) justificativa = 'Cancelamento solicitado pelo emitente via Odoo';

  console.log('[SIEG-CANCEL-POLL] Fatura ' + move.name + ' | chave=' + chave.slice(0, 15) + '...');

  if (!chave || chave.length !== 44) throw new Error('Chave de acesso invalida (' + chave.length + ' digitos). Nota precisa estar autorizada.');
  if (!protocolo) throw new Error('Protocolo de autorizacao ausente na fatura ' + move.name);

  var companyId = Array.isArray(move.company_id) ? move.company_id[0] : move.company_id;
  var companies = await executeKw(client, db, uid, pwd, 'res.company', 'read', [[companyId], ['vat']]);
  var cnpj = ((companies && companies[0] && companies[0].vat) || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ do emitente nao encontrado na empresa');

  // Marcar como processando para nao processar duas vezes em paralelo
  await executeKw(client, db, uid, pwd, 'account.move', 'write',
    [[moveId], { x_studio_nfe_status: 'processando' }]);

  var resultado = await cancelarNFe({ chave, protocolo, cnpj, justificativa });

  var statusNovo = resultado.sucesso ? 'cancelada' : 'erro';
  await executeKw(client, db, uid, pwd, 'account.move', 'write',
    [[moveId], {
      x_studio_nfe_status: statusNovo,
      x_studio_nfe_protocolo: resultado.nProt || protocolo,
    }]);

  if (resultado.sucesso) {
    try {
      await executeKw(client, db, uid, pwd, 'account.move', 'button_draft', [[moveId]]);
      await executeKw(client, db, uid, pwd, 'account.move', 'button_cancel', [[moveId]]);
      console.log('[SIEG-CANCEL-POLL] Fatura ' + move.name + ' revertida no Odoo');
    } catch (e) {
      console.warn('[SIEG-CANCEL-POLL] Nao foi possivel reverter a fatura: ' + e.message);
    }
  }

  var msgCorpo = resultado.sucesso
    ? '<b>NF-e Cancelada na SEFAZ</b><br/>'
      + 'Protocolo: ' + (resultado.nProt || protocolo) + '<br/>'
      + 'Data: ' + (resultado.dhRecbto || '') + '<br/>'
      + 'Justificativa: ' + justificativa
    : '<b>Cancelamento rejeitado pela SEFAZ</b><br/>'
      + 'Status: ' + resultado.cStat + ' - ' + resultado.xMotivo + '<br/>'
      + 'Justificativa enviada: ' + justificativa;

  try {
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
      model: 'account.move', res_id: moveId,
      body: msgCorpo, message_type: 'comment',
    }]);
  } catch (e) { console.warn('[SIEG-CANCEL-POLL] Erro ao postar chatter:', e.message); }

  return { move_id: moveId, sucesso: resultado.sucesso, fatura: move.name, cStat: resultado.cStat };
}

module.exports = { processPendingEmissions, processPendingCancellations };
