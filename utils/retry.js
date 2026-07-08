/**
 * retry.js - Exponential backoff retry utility
 */
const logger = require('./logger');

async function retry(fn, opts) {
  opts = opts || {};
  var maxRetries = opts.maxRetries || 3;
  var baseDelay = opts.baseDelay || 1000;
  var label = opts.label || 'retry';

  for (var i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) throw err;
      var delay = baseDelay * Math.pow(2, i);
      logger.warn(label + ' tentativa ' + (i + 1) + '/' + (maxRetries + 1) + ' falhou: ' + err.message + ' - retry em ' + delay + 'ms');
      await new Promise(function(resolve) { setTimeout(resolve, delay); });
    }
  }
}

module.exports = { retry: retry };