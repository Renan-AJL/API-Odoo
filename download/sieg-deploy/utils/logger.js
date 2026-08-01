// ============================================
// LOGGER v5.0
// ============================================

const dayjs = require('dayjs');

function formatLog(level, message, meta) {
  var timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');
  var metaStr = meta ? ' | ' + JSON.stringify(meta) : '';
  return '[' + timestamp + '] [' + level + '] ' + message + metaStr;
}

var logger = {
  info: function(msg, meta) { console.log(formatLog('INFO ', msg, meta)); },
  warn: function(msg, meta) { console.warn(formatLog('WARN ', msg, meta)); },
  error: function(msg, meta) { console.error(formatLog('ERROR', msg, meta)); },
  debug: function(msg, meta) {
    if (process.env.NODE_ENV !== 'production') console.debug(formatLog('DEBUG', msg, meta));
  },
};

module.exports = logger;
