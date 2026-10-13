/**
 * utils/odoo-write-guard.js - Diff-guard + retry para writes no Odoo
 * ============================================================
 * Resolve SerializationFailure (SQLSTATE 40001) em colisoes de
 * escrita concorrente no Odoo, sem adicionar latencia perceptivel
 * ao caminho feliz.
 *
 * Prefixes de log (obrigatorios para auditoria no Render):
 *   [DIFF-GUARD] = write pulado por nao haver mudancas (INFO)
 *   [RETRY]      = cada retry (WARNING)
 *   [WB-ERROR]   = falha final apos esgotar retries (ERROR)
 */

var logger = require('./logger');

// ============================================================
// Normalizacao
// ============================================================

function normalizeCep(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

function normalizeCnpj(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

function normalizeString(val) {
  if (val == null || val === false) return '';
  return String(val).trim();
}

function extractMany2oneId(val) {
  if (!val) return 0;
  if (Array.isArray(val)) return val[0] || 0;
  return Number(val) || 0;
}

function fieldValuesEqual(fieldName, proposedVal, currentVal) {
  if (fieldName === 'state_id' || fieldName === 'country_id' || fieldName === 'city_id') {
    return extractMany2oneId(currentVal) === (Number(proposedVal) || 0);
  }
  if (fieldName === 'zip') {
    return normalizeCep(currentVal) === normalizeCep(proposedVal);
  }
  if (fieldName === 'vat') {
    return normalizeCnpj(currentVal) === normalizeCnpj(proposedVal);
  }
  if (typeof proposedVal === 'boolean') {
    return !!currentVal === proposedVal;
  }
  if (typeof proposedVal === 'number') {
    return Number(currentVal) === proposedVal;
  }
  return normalizeString(currentVal) === normalizeString(proposedVal);
}

// ============================================================
// Diff-guard
// ============================================================

async function diffGuard(odooExecFn, oc, host, uid, model, recordId, proposedValues) {
  var fieldNames = Object.keys(proposedValues);
  if (fieldNames.length === 0) {
    return { changedValues: {}, unchangedFields: [], allUnchanged: true };
  }

  var currentRecords;
  try {
    currentRecords = await odooExecFn(oc, host, uid, model, 'read', [[recordId], fieldNames]);
  } catch (readErr) {
    logger.error('[WB-ERROR] Erro ao ler ' + model + ' id=' + recordId + ': ' + readErr.message);
    throw readErr;
  }

  if (!currentRecords || currentRecords.length === 0) {
    var notFoundErr = new Error(model + ' id=' + recordId + ' nao encontrado no Odoo');
    notFoundErr.code = 'RECORD_NOT_FOUND';
    throw notFoundErr;
  }

  var currentData = currentRecords[0];
  var changedValues = {};
  var unchangedFields = [];

  for (var i = 0; i < fieldNames.length; i++) {
    var field = fieldNames[i];
    if (fieldValuesEqual(field, proposedValues[field], currentData[field])) {
      unchangedFields.push(field);
    } else {
      changedValues[field] = proposedValues[field];
    }
  }

  var allUnchanged = Object.keys(changedValues).length === 0;

  if (allUnchanged) {
    logger.info('[DIFF-GUARD] id=' + recordId + ' sem mudancas (' + fieldNames.join(', ') + ' identicos)');
  } else if (unchangedFields.length > 0) {
    logger.info('[DIFF-GUARD] id=' + recordId + ' ' + unchangedFields.length + ' campo(s) inalterado(s) removido(s): ' + unchangedFields.join(', '));
  }

  return { changedValues: changedValues, unchangedFields: unchangedFields, allUnchanged: allUnchanged };
}

// ============================================================
// Deteccao de erro retriable
// ============================================================

function isRetriableOdooError(err) {
  var msg = (err.message || '').toLowerCase();
  var errCode = err.code || '';

  if (errCode === 'RECORD_NOT_FOUND') return false;

  // Nao retriable: autenticacao
  if (msg.indexOf('autenticac') !== -1 && (msg.indexOf('invalid') !== -1 || msg.indexOf('falhou') !== -1 || msg.indexOf('failed') !== -1)) return false;
  if (msg.indexOf('access denied') !== -1 || msg.indexOf('accessdenied') !== -1) return false;
  if (msg.indexOf('permission') !== -1) return false;
  if (msg.indexOf('credenciais') !== -1 && msg.indexOf('invalid') !== -1) return false;

  // Nao retriable: validacao
  if (msg.indexOf('validation') !== -1) return false;
  if (msg.indexOf('missing required') !== -1) return false;
  if (msg.indexOf('required field') !== -1) return false;

  // Retriable: SerializationFailure
  if (msg.indexOf('40001') !== -1) return true;
  if (msg.indexOf('serializationfailure') !== -1) return true;
  if (msg.indexOf('could not serialize access') !== -1) return true;
  if (msg.indexOf('concurrent update') !== -1) return true;
  if (msg.indexOf('could not serialize') !== -1) return true;

  // Retriable: rede transitaria
  if (msg.indexOf('timeout') !== -1 || msg.indexOf('timed out') !== -1) return true;
  if (msg.indexOf('econnreset') !== -1 || msg.indexOf('connection reset') !== -1) return true;
  if (msg.indexOf('econnrefused') !== -1) return true;
  if (msg.indexOf('socket hang up') !== -1) return true;
  if (msg.indexOf('enotfound') !== -1) return true;
  if (msg.indexOf('5xx') !== -1) return true;
  if (msg.indexOf('internal server error') !== -1) return true;
  if (msg.indexOf('bad gateway') !== -1) return true;
  if (msg.indexOf('service unavailable') !== -1) return true;
  if (msg.indexOf('gateway timeout') !== -1) return true;
  if (err.faultCode === 500 || err.faultCode === 502 || err.faultCode === 503) return true;

  return false;
}

// ============================================================
// Retry com backoff + jitter
// ============================================================

async function retryWithJitter(fn, opts) {
  opts = opts || {};
  var maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
  var label = opts.label || 'odoo';
  var recordId = opts.recordId || '?';
  var shouldRetry = opts.shouldRetry || isRetriableOdooError;

  for (var i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) {
        logger.error('[WB-ERROR] id=' + recordId + ' esgotou ' + (maxRetries + 1) + ' tentativa(s): ' + err.message);
        throw err;
      }
      if (!shouldRetry(err)) {
        logger.error('[WB-ERROR] id=' + recordId + ' erro nao retriable: ' + err.message);
        throw err;
      }
      var baseDelay = 500 * Math.pow(3, i);
      var jitter = 1 + (Math.random() * 0.6 - 0.3);
      var delay = Math.round(baseDelay * jitter);
      logger.warn('[RETRY] tentativa ' + (i + 1) + '/' + (maxRetries + 1) + ' apos ' + err.message + ' no ' + label + ' id=' + recordId + ' - retry em ' + delay + 'ms');
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
    }
  }
}

// ============================================================
// Write com diff-guard + retry
// ============================================================

async function odooWriteGuarded(odooExecFn, oc, host, uid, model, recordId, values, opts) {
  opts = opts || {};
  var label = opts.label || (model + '.write[' + recordId + ']');

  if (!values || Object.keys(values).length === 0) {
    return { updated: false, campos_atualizados: [], motivo: 'sem_valores' };
  }

  var writeResult = { updated: false, campos_atualizados: [], motivo: 'sem_mudancas' };

  try {
    await retryWithJitter(
      async function() {
        var diff = await diffGuard(odooExecFn, oc, host, uid, model, recordId, values);
        if (diff.allUnchanged) {
          writeResult = { updated: false, campos_atualizados: [], motivo: 'sem_mudancas' };
          return;
        }
        var changedValues = diff.changedValues;
        var changedFields = Object.keys(changedValues);
        await odooExecFn(oc, host, uid, model, 'write', [[recordId], changedValues]);
        writeResult = { updated: true, campos_atualizados: changedFields, motivo: null };
        logger.info('[DIFF-GUARD] id=' + recordId + ' write OK: ' + changedFields.join(', '));
      },
      {
        label: label,
        maxRetries: 3,
        shouldRetry: isRetriableOdooError,
        recordId: recordId,
      }
    );
  } catch (finalErr) {
    if (finalErr.code === 'RECORD_NOT_FOUND') {
      return { updated: false, campos_atualizados: [], motivo: 'registro_nao_encontrado', erro: finalErr.message };
    }
    return { updated: false, campos_atualizados: [], motivo: 'erro_escrita', erro: finalErr.message };
  }

  return writeResult;
}

module.exports = {
  normalizeCep: normalizeCep,
  normalizeCnpj: normalizeCnpj,
  normalizeString: normalizeString,
  extractMany2oneId: extractMany2oneId,
  fieldValuesEqual: fieldValuesEqual,
  diffGuard: diffGuard,
  isRetriableOdooError: isRetriableOdooError,
  retryWithJitter: retryWithJitter,
  odooWriteGuarded: odooWriteGuarded,
};
