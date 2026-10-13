/**
 * utils/odoo-write-guard.js - Diff-guard + retry para writes no Odoo
 * ============================================================
 * Resolve SerializationFailure (SQLSTATE 40001) em colisoes de
 * escrita concorrente no Odoo, sem adicionar latencia perceptivel
 * ao caminho feliz.
 *
 * Fluxo:
 *   1. Diff-guard: le valores atuais, filtra so campos que mudaram
 *   2. Se nenhum campo mudou: retorna { updated: false, motivo: 'sem_mudancas' }
 *   3. Se ha mudancas: escreve com retry + backoff + jitter
 *   4. Antes de cada retry: re-executa diff-guard (o outro lado pode ter gravado)
 *   5. Se erro nao retriable: falha imediatamente
 *   6. Se esgotou retries: falha com log ERROR
 */

var logger = require('./logger');

// ============================================================
// Normalizacao de valores para comparacao
// ============================================================

/**
 * Normaliza CEP: remove tudo que nao for digito
 * "84560-000" -> "84560000", "84560000" -> "84560000"
 */
function normalizeCep(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

/**
 * Normaliza CNPJ: remove tudo que nao for digito
 * "22.603.750/0001-90" -> "22603750000190"
 */
function normalizeCnpj(val) {
  if (!val) return '';
  return String(val).replace(/\D/g, '');
}

/**
 * Normaliza string: trim + null/undefined -> ''
 */
function normalizeString(val) {
  if (val == null || val === false) return '';
  return String(val).trim();
}

/**
 * Extrai ID de campo many2one do Odoo
 * Odoo retorna many2one como [id, name] ou false
 */
function extractMany2oneId(val) {
  if (!val) return 0;
  if (Array.isArray(val)) return val[0] || 0;
  return Number(val) || 0;
}

/**
 * Compara dois valores de campo considerando o tipo
 * Retorna true se sao iguais (nao mudou)
 */
function fieldValuesEqual(fieldName, proposedVal, currentVal) {
  // Campos many2one: comparar pelo ID
  if (fieldName === 'state_id' || fieldName === 'country_id' || fieldName === 'city_id') {
    var currentId = extractMany2oneId(currentVal);
    var proposedId = Number(proposedVal) || 0;
    return currentId === proposedId;
  }

  // CEP (zip): comparar normalizado (sem mascara)
  if (fieldName === 'zip') {
    return normalizeCep(currentVal) === normalizeCep(proposedVal);
  }

  // CNPJ (vat): comparar normalizado (sem mascara)
  if (fieldName === 'vat') {
    return normalizeCnpj(currentVal) === normalizeCnpj(proposedVal);
  }

  // Booleanos: comparacao direta
  if (typeof proposedVal === 'boolean') {
    return !!currentVal === proposedVal;
  }

  // Numeros: comparacao direta
  if (typeof proposedVal === 'number') {
    return Number(currentVal) === proposedVal;
  }

  // Campos string normais: comparar com trim
  return normalizeString(currentVal) === normalizeString(proposedVal);
}

// ============================================================
// Diff-guard: le valores atuais, retorna so campos que mudaram
// ============================================================

/**
 * Diff-guard: le o registro no Odoo e filtra so campos que realmente mudaram.
 *
 * @param {Function} odooExecFn - funcao async(oc, host, uid, model, method, args, kwargs)
 * @param {Object} oc - config Odoo
 * @param {string} host - Odoo host
 * @param {number} uid - Odoo UID
 * @param {string} model - modelo Odoo (ex: 'res.partner')
 * @param {number} recordId - ID do registro
 * @param {Object} proposedValues - campos e valores a escrever
 * @returns {Object} { changedValues, unchangedFields, allUnchanged }
 */
async function diffGuard(odooExecFn, oc, host, uid, model, recordId, proposedValues) {
  var fieldNames = Object.keys(proposedValues);

  if (fieldNames.length === 0) {
    return { changedValues: {}, unchangedFields: [], allUnchanged: true };
  }

  // Ler valores atuais do registro
  var currentRecords;
  try {
    currentRecords = await odooExecFn(oc, host, uid, model, 'read', [
      [recordId],
      fieldNames
    ]);
  } catch (readErr) {
    logger.error('[DIFF-GUARD] Erro ao ler ' + model + ' ID ' + recordId + ': ' + readErr.message);
    throw readErr;
  }

  if (!currentRecords || currentRecords.length === 0) {
    // Registro nao existe
    var notFoundErr = new Error(model + ' ID ' + recordId + ' nao encontrado no Odoo');
    notFoundErr.code = 'RECORD_NOT_FOUND';
    throw notFoundErr;
  }

  var currentData = currentRecords[0];
  var changedValues = {};
  var unchangedFields = [];

  for (var i = 0; i < fieldNames.length; i++) {
    var field = fieldNames[i];
    var proposed = proposedValues[field];
    var current = currentData[field];

    if (fieldValuesEqual(field, proposed, current)) {
      unchangedFields.push(field);
    } else {
      changedValues[field] = proposed;
    }
  }

  var allUnchanged = Object.keys(changedValues).length === 0;

  if (allUnchanged) {
    logger.info('[DIFF-GUARD] ' + model + ' ID ' + recordId + ': write ignorado (sem mudancas) - campos: ' + fieldNames.join(', '));
  } else if (unchangedFields.length > 0) {
    logger.info('[DIFF-GUARD] ' + model + ' ID ' + recordId + ': ' + unchangedFields.length + ' campo(s) inalterado(s) removido(s): ' + unchangedFields.join(', '));
  }

  return { changedValues: changedValues, unchangedFields: unchangedFields, allUnchanged: allUnchanged };
}

// ============================================================
// Deteccao de erro retriable
// ============================================================

/**
 * Verifica se um erro do Odoo e retriable (deve tentar novamente)
 *
 * Retriable:
 *   - SerializationFailure (SQLSTATE 40001)
 *   - "could not serialize access due to concurrent update"
 *   - Falhas de rede transitarias (timeout, connection reset, 5xx)
 *
 * Nao retriable:
 *   - Erro de autenticacao (credenciais invalidas)
 *   - Erro de validacao/permissao
 *   - Registro nao encontrado (RECORD_NOT_FOUND)
 */
function isRetriableOdooError(err) {
  var msg = (err.message || '').toLowerCase();
  var errCode = err.code || '';

  // Registro nao encontrado: nunca retratar
  if (errCode === 'RECORD_NOT_FOUND') return false;

  // Erro de autenticacao: nunca retratar
  if (msg.indexOf('autenticac') !== -1 && (msg.indexOf('invalid') !== -1 || msg.indexOf('falhou') !== -1 || msg.indexOf('failed') !== -1)) return false;
  if (msg.indexOf('access denied') !== -1 || msg.indexOf('accessdenied') !== -1) return false;
  if (msg.indexOf('permission') !== -1) return false;
  if (msg.indexOf('credenciais') !== -1 && msg.indexOf('invalid') !== -1) return false;

  // Erro de validacao: nunca retratar
  if (msg.indexOf('validation') !== -1) return false;
  if (msg.indexOf('missing required') !== -1) return false;
  if (msg.indexOf('required field') !== -1) return false;

  // SerializationFailure (SQLSTATE 40001) - RETRY
  if (msg.indexOf('40001') !== -1) return true;
  if (msg.indexOf('serializationfailure') !== -1) return true;
  if (msg.indexOf('could not serialize access') !== -1) return true;
  if (msg.indexOf('concurrent update') !== -1) return true;
  if (msg.indexOf('could not serialize') !== -1) return true;

  // Falhas de rede transitarias - RETRY
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

  // XML-RPC fault codes transitarios
  if (err.faultCode === 500 || err.faultCode === 502 || err.faultCode === 503) return true;

  // Default: nao retratar (erro desconhecido = provavelmente nao transitivo)
  return false;
}

// ============================================================
// Retry com backoff exponencial + jitter
// ============================================================

/**
 * Executa fn com retry em caso de erro retriable.
 * Politica: ate 3 tentativas extras, backoff ~0.5s -> ~1.5s -> ~4s (+-30% jitter)
 *
 * @param {Function} fn - funcao async a executar
 * @param {Object} opts
 * @param {string} opts.label - rotulo para logs
 * @param {number} opts.maxRetries - max retries (default: 3)
 * @param {Function} opts.shouldRetry - funcao(err) => boolean (default: isRetriableOdooError)
 * @returns {*} resultado de fn()
 */
async function retryWithJitter(fn, opts) {
  opts = opts || {};
  var maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
  var label = opts.label || 'odoo-retry';
  var shouldRetry = opts.shouldRetry || isRetriableOdooError;

  for (var i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      // Ultima tentativa ou erro nao retriable: falhar
      if (i === maxRetries) {
        logger.error('[' + label + '] Esgotou ' + (maxRetries + 1) + ' tentativa(s): ' + err.message);
        throw err;
      }

      if (!shouldRetry(err)) {
        logger.error('[' + label + '] Erro nao retriable (tentativa ' + (i + 1) + '): ' + err.message);
        throw err;
      }

      // Backoff exponencial com jitter: ~0.5s -> ~1.5s -> ~4s
      // base=500, factor=3: 500*3^0=500, 500*3^1=1500, 500*3^2=4500
      var baseDelay = 500 * Math.pow(3, i);
      var jitter = 1 + (Math.random() * 0.6 - 0.3); // +-30%
      var delay = Math.round(baseDelay * jitter);

      logger.warn('[' + label + '] Tentativa ' + (i + 1) + '/' + (maxRetries + 1) + ' falhou (retriable): ' + err.message + ' - retry em ' + delay + 'ms');

      await new Promise(function(resolve) { setTimeout(resolve, delay); });
    }
  }
}

// ============================================================
// Write com diff-guard + retry combinados
// ============================================================

/**
 * Escreve no Odoo com diff-guard + retry em colisao.
 *
 * Fluxo:
 *   1. Diff-guard: le valores atuais, filtra so campos que mudaram
 *   2. Se nenhum campo mudou: retorna { updated: false, motivo: 'sem_mudancas' }
 *   3. Se ha mudancas: escreve com retry
 *   4. Antes de cada retry: re-executa diff-guard automaticamente
 *      (o outro lado pode ter gravado o mesmo valor enquanto isso)
 *   5. Se erro nao retriable: falha imediatamente
 *   6. Se esgotou retries: falha com log ERROR
 *
 * @param {Function} odooExecFn - funcao async(oc, host, uid, model, method, args, kwargs)
 * @param {Object} oc - config Odoo
 * @param {string} host - Odoo host
 * @param {number} uid - Odoo UID
 * @param {string} model - modelo Odoo
 * @param {number} recordId - ID do registro
 * @param {Object} values - campos e valores a escrever
 * @param {Object} opts - opcoes adicionais
 * @returns {Object} { updated, campos_atualizados, motivo, erro }
 */
async function odooWriteGuarded(odooExecFn, oc, host, uid, model, recordId, values, opts) {
  opts = opts || {};
  var label = opts.label || (model + '.write[' + recordId + ']');

  if (!values || Object.keys(values).length === 0) {
    return { updated: false, campos_atualizados: [], motivo: 'sem_valores' };
  }

  // Resultado que sera preenchido pelo retry loop
  var writeResult = { updated: false, campos_atualizados: [], motivo: 'sem_mudancas' };

  try {
    await retryWithJitter(
      async function() {
        // Diff-guard antes de cada tentativa (inclui a primeira)
        var diff = await diffGuard(odooExecFn, oc, host, uid, model, recordId, values);

        if (diff.allUnchanged) {
          // Nenhum campo mudou - sucesso sem write
          writeResult = { updated: false, campos_atualizados: [], motivo: 'sem_mudancas' };
          return; // sucesso, sem write necessario
        }

        var changedValues = diff.changedValues;
        var changedFields = Object.keys(changedValues);

        // Executar write no Odoo
        await odooExecFn(oc, host, uid, model, 'write', [
          [recordId],
          changedValues
        ]);

        writeResult = { updated: true, campos_atualizados: changedFields, motivo: null };
        logger.info('[' + label + '] Write OK: ' + changedFields.join(', '));
      },
      {
        label: label,
        maxRetries: 3,
        shouldRetry: isRetriableOdooError,
      }
    );
  } catch (finalErr) {
    // Se o erro e RECORD_NOT_FOUND, tratar como sucesso:false imediato
    if (finalErr.code === 'RECORD_NOT_FOUND') {
      return { updated: false, campos_atualizados: [], motivo: 'registro_nao_encontrado', erro: finalErr.message };
    }
    // Erro real apos esgotar retries
    return { updated: false, campos_atualizados: [], motivo: 'erro_escrita', erro: finalErr.message };
  }

  return writeResult;
}

// ============================================================
// Exports
// ============================================================

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
