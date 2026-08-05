/**
 * services/nfe-cancelar-odoo.js — Cancelamento de NF-e integrado ao Odoo
 * ==========================================================================
 * 1. Lê a fatura no Odoo para obter chave + protocolo de autorização
 * 2. Envia o evento de cancelamento à SEFAZ PR
 * 3. Atualiza o status da fatura no Odoo para "cancelada"
 * 4. Reverte a fatura para rascunho (button_draft) e cancela (button_cancel)
 * 5. Posta mensagem no chatter com resultado
 */
'use strict';
var xmlrpc  = require('xmlrpc');
var config  = require('../config');
var { cancelarNFe } = require('./nfe-cancelamento');

// ── XML-RPC helpers (mesmo padrão do sieg-odoo-emit.js) ──────────────────────
function createClient(url) {
  var base = url.replace(/\/+$/, '');
  var host = base.replace('https://', '').replace('http://', '');
  var port = base.startsWith('https') ? 443 : 80;
  var isSecure = base.startsWith('https');
  var fn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: fn({ host, path: '/xmlrpc/2/common', port }),
    models: fn({ host, path: '/xmlrpc/2/object', port }),
  };
}

function authenticate(client, db, login, password) {
  return new Promise(function(resolve, reject) {
    client.common.methodCall('authenticate', [db, login, password, {}], function(err, uid) {
      if (err) return reject(new Error('Auth Odoo: ' + (err.message || err)));
      if (!uid) return reject(new Error('Credenciais Odoo inválidas'));
      resolve(uid);
    });
  });
}

function executeKw(client, db, uid, password, model, method, args, kwargs) {
  return new Promise(function(resolve, reject) {
    var params = [db, uid, password, model, method, args || []];
    if (kwargs) params.push(kwargs);
    client.models.methodCall('execute_kw', params, function(err, result) {
      if (err) return reject(new Error(model + '.' + method + ': ' + (err.faultString || err.message || err)));
      resolve(result);
    });
  });
}

// ── Principal ────────────────────────────────────────────────────────────────
async function cancelarNFeOdoo({ moveId, justificativa }) {
  var odooUrl = config.odoo.url;
  var db      = config.odoo.db;
  var login   = config.odoo.login;
  var pwd     = config.odoo.password;

  var client = createClient(odooUrl);
  var uid    = await authenticate(client, db, login, pwd);

  // 1. Ler a fatura
  var moves = await executeKw(client, db, uid, pwd, 'account.move', 'read',
    [[Number(moveId)], ['name', 'state', 'x_studio_nfe_chave', 'x_studio_nfe_protocolo',
                        'x_studio_nfe_status', 'company_id']]);
  if (!moves || !moves.length) throw new Error('Fatura não encontrada: move_id=' + moveId);
  var move = moves[0];

  var chave     = (move.x_studio_nfe_chave || '').replace(/\D/g, '');
  var protocolo = String(move.x_studio_nfe_protocolo || '').trim();
  var status    = move.x_studio_nfe_status || '';

  console.log('[NFE-CANCEL] Fatura ' + move.name + ' | chave=' + chave.slice(0,15) + '... | protocolo=' + protocolo + ' | status=' + status);

  if (!chave || chave.length !== 44) throw new Error('Chave de acesso inválida ou ausente na fatura (' + chave.length + ' dígitos). A nota precisa estar autorizada.');
  if (!protocolo)                    throw new Error('Protocolo de autorização ausente. A nota precisa estar autorizada (cStat 100).');
  if (status !== 'autorizada')       throw new Error('Fatura não está autorizada (status atual: "' + status + '"). Só é possível cancelar notas autorizadas.');

  // 2. CNPJ do emitente (via company)
  var companyId = Array.isArray(move.company_id) ? move.company_id[0] : move.company_id;
  var companies = await executeKw(client, db, uid, pwd, 'res.company', 'read',
    [[companyId], ['vat']]);
  var cnpj = (companies && companies[0] && companies[0].vat || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ do emitente não encontrado na empresa do Odoo');

  // 3. Enviar cancelamento à SEFAZ
  var resultado = await cancelarNFe({ chave, protocolo, cnpj, justificativa });

  // 4. Atualizar status no Odoo independente do resultado
  var statusNovo = resultado.sucesso ? 'cancelada' : 'erro';
  var msgSefaz   = resultado.cStat + ' - ' + resultado.xMotivo;

  await executeKw(client, db, uid, pwd, 'account.move', 'write',
    [[Number(moveId)], {
      x_studio_nfe_status: statusNovo,
      x_studio_nfe_protocolo: resultado.nProt || move.x_studio_nfe_protocolo,
    }]);

  // 5. Reverter fatura para rascunho + cancelar (apenas se SEFAZ confirmou)
  if (resultado.sucesso) {
    try {
      // Odoo 17+/18+: button_draft reverte a fatura para rascunho
      await executeKw(client, db, uid, pwd, 'account.move', 'button_draft', [[Number(moveId)]]);
      await executeKw(client, db, uid, pwd, 'account.move', 'button_cancel', [[Number(moveId)]]);
      console.log('[NFE-CANCEL] Fatura ' + move.name + ' revertida para rascunho e cancelada no Odoo');
    } catch (e) {
      // Pode falhar se a fatura já foi paga — apenas logar
      console.warn('[NFE-CANCEL] Nao foi possivel reverter a fatura no Odoo: ' + e.message);
    }
  }

  // 6. Postar mensagem no chatter
  var msgCorpo = resultado.sucesso
    ? '<p>✅ <strong>NF-e Cancelada na SEFAZ</strong><br/>'
      + 'Protocolo: ' + (resultado.nProt || protocolo) + '<br/>'
      + 'Data: ' + (resultado.dhRecbto || '') + '<br/>'
      + 'Justificativa: ' + justificativa + '</p>'
    : '<p>❌ <strong>Cancelamento rejeitado pela SEFAZ</strong><br/>'
      + 'Status: ' + msgSefaz + '<br/>'
      + 'Justificativa enviada: ' + justificativa + '</p>';

  try {
    await executeKw(client, db, uid, pwd, 'mail.message', 'create', [{
      model: 'account.move',
      res_id: Number(moveId),
      message_type: 'comment',
      body: msgCorpo,
      subtype_id: 1,
    }]);
  } catch (e) {
    console.warn('[NFE-CANCEL] Nao foi possivel postar no chatter: ' + e.message);
  }

  console.log('[NFE-CANCEL] Concluido: sucesso=' + resultado.sucesso + ' cStat=' + resultado.cStat);
  return {
    sucesso: resultado.sucesso,
    cStat: resultado.cStat,
    xMotivo: resultado.xMotivo,
    nProt: resultado.nProt,
    dhRecbto: resultado.dhRecbto,
    fatura: move.name,
    odoo_status: statusNovo,
  };
}

module.exports = { cancelarNFeOdoo };
