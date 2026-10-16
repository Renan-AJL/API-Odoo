// ============================================
// UTIL: NORMALIZACAO DO DEVEDOR PIX (BACEN)
// ============================================
// BACEN exige que cob.devedor contenha EXATAMENTE:
//   - cpf (11 digitos) OU cnpj (14 digitos), nunca ambos, nunca null
//   - nome (string nao-vazia)
// Se nao ha documento valido, devedor deve ser OMITIDO do payload.
//
// Erro comum: { cpf: 'null', cnpj: 'null', nome: '...' }
// Causa: Odoo envia vat/cnpj_cpf vazio ou 'null' → middleware
//        repassa sem limpar → Itau/BACEN rejeita 400.

var logger = require('./logger');

/**
 * Strip non-digits from a CPF/CNPJ string.
 * Returns empty string if input is falsy or 'null' string.
 */
function stripDoc(val) {
  if (val === null || val === undefined || val === false) return '';
  var s = String(val).trim();
  if (s === '' || s.toLowerCase() === 'null' || s.toLowerCase() === 'none') return '';
  return s.replace(/\D/g, '');
}

/**
 * Validate CPF check digits (Receita Federal algorithm).
 * @param {string} cpf - 11-digit string
 * @returns {boolean}
 */
function validateCpf(cpf) {
  if (!cpf || cpf.length !== 11) return false;
  // Reject obvious fakes: all same digit
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  var sum = 0;
  for (var i = 0; i < 9; i++) sum += parseInt(cpf.charAt(i)) * (10 - i);
  var rem = 11 - (sum % 11);
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== parseInt(cpf.charAt(9))) return false;
  sum = 0;
  for (var j = 0; j < 10; j++) sum += parseInt(cpf.charAt(j)) * (11 - j);
  rem = 11 - (sum % 11);
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== parseInt(cpf.charAt(10))) return false;
  return true;
}

/**
 * Validate CNPJ check digits (Receita Federal algorithm).
 * @param {string} cnpj - 14-digit string
 * @returns {boolean}
 */
function validateCnpj(cnpj) {
  if (!cnpj || cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  var weights1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  var weights2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  var sum = 0;
  for (var i = 0; i < 12; i++) sum += parseInt(cnpj.charAt(i)) * weights1[i];
  var rem = sum % 11;
  var dv1 = rem < 2 ? 0 : 11 - rem;
  if (dv1 !== parseInt(cnpj.charAt(12))) return false;
  sum = 0;
  for (var j = 0; j < 13; j++) sum += parseInt(cnpj.charAt(j)) * weights2[j];
  rem = sum % 11;
  var dv2 = rem < 2 ? 0 : 11 - rem;
  if (dv2 !== parseInt(cnpj.charAt(13))) return false;
  return true;
}

/**
 * Normalize and build the devedor object for PIX payload.
 *
 * @param {Object} devedor - Raw devedor from caller. May contain:
 *   - nome: string
 *   - cpf: string (raw, formatted, or empty)
 *   - cnpj: string (raw, formatted, or empty)
 * OR
 *   - cpf_cnpj: single field with either CPF or CNPJ
 *
 * @returns {Object|undefined} Clean devedor with exactly one of cpf/cnpj,
 *          or undefined if no valid document found (BACEN allows omitting devedor
 *          for some cobrança types, but presence without doc is invalid).
 */
function normalizeDevedor(devedor) {
  if (!devedor || typeof devedor !== 'object') return undefined;

  var nome = (devedor.nome || '').trim();
  if (!nome) {
    logger.warn('[PIX-DEV] Devedor sem nome, omitindo do payload');
    return undefined;
  }

  // Try to get document from cpf/cnpj or cpf_cnpj field
  var rawCpf = devedor.cpf || '';
  var rawCnpj = devedor.cnpj || '';
  var rawDoc = devedor.cpf_cnpj || '';

  var cpfDigits = stripDoc(rawCpf);
  var cnpjDigits = stripDoc(rawCnpj);
  var docDigits = stripDoc(rawDoc);

  // If cpf_cnpj was provided but cpf/cnpj weren't, classify by length
  if (docDigits && !cpfDigits && !cnpjDigits) {
    if (docDigits.length <= 11) {
      cpfDigits = docDigits;
    } else {
      cnpjDigits = docDigits;
    }
  }

  // If both cpf and cnpj were provided, keep whichever is valid
  // If only digits from one source, classify by length
  if (cpfDigits && !cnpjDigits && cpfDigits.length > 11) {
    // Was classified as CPF but has >11 digits → it's actually CNPJ
    cnpjDigits = cpfDigits;
    cpfDigits = '';
  }
  if (cnpjDigits && !cpfDigits && cnpjDigits.length <= 11) {
    // Was classified as CNPJ but has <=11 digits → it's actually CPF
    cpfDigits = cnpjDigits;
    cnpjDigits = '';
  }

  var result = { nome: nome };

  if (cpfDigits) {
    // Pad CPF to 11 digits if needed (leading zeros stripped by Odoo)
    if (cpfDigits.length < 11) {
      cpfDigits = cpfDigits.padStart(11, '0');
    }
    if (cpfDigits.length === 11) {
      var valid = validateCpf(cpfDigits);
      if (valid) {
        result.cpf = cpfDigits;
        logger.info('[PIX-DEV] Devedor CPF valido: ' + cpfDigits.substring(0, 3) + '***' + cpfDigits.substring(9));
      } else {
        logger.warn('[PIX-DEV] CPF invalido (check digit): ' + cpfDigits.substring(0, 3) + '***' + cpfDigits.substring(9) + ' — enviando sem validacao');
        // Still send it — Odoo may have the correct doc, let Itaú validate
        result.cpf = cpfDigits;
      }
    } else {
      logger.warn('[PIX-DEV] CPF com ' + cpfDigits.length + ' digitos (esperado 11), classificando como CNPJ');
      cnpjDigits = cpfDigits;
      delete result.cpf;
    }
  }

  if (cnpjDigits && !result.cpf) {
    // Pad CNPJ to 14 digits if needed
    if (cnpjDigits.length < 14) {
      cnpjDigits = cnpjDigits.padStart(14, '0');
    }
    if (cnpjDigits.length === 14) {
      var validCnpj = validateCnpj(cnpjDigits);
      if (validCnpj) {
        result.cnpj = cnpjDigits;
        logger.info('[PIX-DEV] Devedor CNPJ valido: ' + cnpjDigits.substring(0, 2) + '***' + cnpjDigits.substring(12));
      } else {
        logger.warn('[PIX-DEV] CNPJ invalido (check digit): ' + cnpjDigits.substring(0, 2) + '***' + cnpjDigits.substring(12) + ' — enviando sem validacao');
        result.cnpj = cnpjDigits;
      }
    } else {
      logger.warn('[PIX-DEV] CNPJ com ' + cnpjDigits.length + ' digitos (esperado 14) — enviado como esta');
      result.cnpj = cnpjDigits;
    }
  }

  // Must have at least cpf OR cnpj for BACEN
  if (!result.cpf && !result.cnpj) {
    logger.warn('[PIX-DEV] Devedor sem CPF/CNPJ valido, omitindo do payload. nome=' + nome);
    return undefined;
  }

  return result;
}

/**
 * Convenience: build devedor from a single cpfCnpj string and nome.
 * Used by routes that receive pagador_cpf as a flat field.
 *
 * @param {string} nome - Debtor name
 * @param {string} cpfCnpj - CPF or CNPJ (raw, formatted, or empty)
 * @returns {Object|undefined}
 */
function buildDevedorFromDoc(nome, cpfCnpj) {
  return normalizeDevedor({
    nome: nome,
    cpf_cnpj: cpfCnpj,
  });
}

module.exports = {
  normalizeDevedor,
  buildDevedorFromDoc,
  stripDoc,
  validateCpf,
  validateCnpj,
};
