/**
 * services/odoo-bank-statement.js - Cria extrato bancario no Odoo
 * ============================================================
 * Cria account.bank.statement + account.bank.statement.line
 * para conciliacao automatica de pagamentos e recebimentos
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');
var logger = require('../utils/logger');

// Config Odoo
var ODOO_URL = config.odoo.url;
var ODOO_DB = config.odoo.db;
var ODOO_USER = config.odoo.user;
var ODOO_PASS = config.odoo.password;

// Diario bancario padrao (configurado via env var)
var BANK_JOURNAL_ID = parseInt(process.env.ODOO_BANK_JOURNAL_ID, 10) || 0;

function getConn() {
  var client = xmlrpc.createSecureClient(ODOO_URL + '/xmlrpc/2/common');
  return client;
}

function getClient() {
  return xmlrpc.createSecureClient(ODOO_URL + '/xmlrpc/2/object');
}

async function authenticate() {
  var common = getConn();
  var uid = await new Promise(function(resolve, reject) {
    common.methodCall('authenticate', ODOO_DB, ODOO_USER, ODOO_PASS, {}, function(err, value) {
      if (err) return reject(err);
      resolve(value);
    });
  });
  if (!uid) throw new Error('Falha na autenticacao Odoo (uid=0)');
  return uid;
}

async function executeKw(model, method, args, kwargs) {
  var client = getClient();
  var uid = await authenticate();
  return new Promise(function(resolve, reject) {
    client.methodCall('execute_kw', ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs || {}, function(err, value) {
      if (err) return reject(new Error(model + '.' + method + ': ' + err.message));
      resolve(value);
    });
  });
}

/**
 * Busca o diario bancario configurado
 */
async function findBankJournal() {
  if (BANK_JOURNAL_ID) {
    var journals = await executeKw('account.journal', 'read', [[BANK_JOURNAL_ID]], {
      fields: ['id', 'name', 'code', 'bank_account_id'],
    });
    if (journals && journals[0]) return journals[0];
  }

  // Busca qualquer diario tipo banco
  var ids = await executeKw('account.journal', 'search', [['type', '=', 'bank']]);
  if (!ids || !ids.length) throw new Error('Nenhum diario bancario encontrado no Odoo');

  var journals = await executeKw('account.journal', 'read', [ids], {
    fields: ['id', 'name', 'code', 'bank_account_id', 'company_id'],
  });

  // Prefere diarios do Itau
  var itau = journals.find(function(j) { return j.name.toUpperCase().indexOf('ITAU') >= 0; });
  if (itau) {
    BANK_JOURNAL_ID = itau.id;
    return itau;
  }

  BANK_JOURNAL_ID = journals[0].id;
  return journals[0];
}

/**
 * Cria um extrato bancario no Odoo
 * @param {string} date - YYYY-MM-DD (data do extrato)
 * @param {Array} transacoes - [{ date, name, amount, ref }]
 * @returns {Object} { statementId, linesCreated, balance }
 */
async function criarExtrato(date, transacoes) {
  var journal = await findBankJournal();
  console.log('[BANK-STMT] Diario bancario: ' + journal.name + ' (id=' + journal.id + ')');

  // Cria o statement
  var statementVals = {
    journal_id: journal.id,
    date: date,
    line_ids: [],
  };

  // Cria as linhas
  var lines = [];
  var balance = 0;
  for (var i = 0; i < transacoes.length; i++) {
    var t = transacoes[i];
    var line = {
      date: t.date || date,
      name: (t.name || t.ref || 'Transacao sem descricao').substring(0, 200),
      amount: t.amount || 0,
      ref: t.ref || '',
    };
    lines.push([0, 0, line]);  // command 0 = CREATE
    balance += (t.amount || 0);
  }

  statementVals.line_ids = lines;

  console.log('[BANK-STMT] Criando extrato com ' + lines.length + ' linhas, saldo: R$ ' + balance.toFixed(2));

  var statementId = await executeKw('account.bank.statement', 'create', [statementVals]);
  console.log('[BANK-STMT] Extrato criado: id=' + statementId);

  // Valida o extrato para disparar a conciliacao automatica do Odoo
  try {
    await executeKw('account.bank.statement', 'button_validate_bank_statement', [[statementId]]);
    console.log('[BANK-STMT] Extrato validado (conciliacao automatica disparada)');
  } catch (err) {
    console.warn('[BANK-STMT] Validacao nao executada: ' + err.message);
  }

  return {
    statementId: statementId,
    journalName: journal.name,
    journalId: journal.id,
    linesCreated: lines.length,
    balance: balance,
  };
}

/**
 * Busca extratos existentes para uma data e diario
 */
async function findExistingStatement(journalId, date) {
  try {
    var ids = await executeKw('account.bank.statement', 'search', [
      ['journal_id', '=', journalId],
      ['date', '=', date],
    ]);
    return ids || [];
  } catch (err) {
    return [];
  }
}

module.exports = { criarExtrato, findBankJournal, findExistingStatement };
