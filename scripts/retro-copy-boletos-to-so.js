/**
 * scripts/retro-copy-boletos-to-so.js
 * ============================================
 * Script RETROATIVO: Copia boletos já emitidos (attachments nas invoices)
 * para os pedidos de venda (sale.order) vinculados.
 *
 * Uso: node scripts/retro-copy-boletos-to-so.js [--dry-run] [--invoice-id N]
 *
 * Flags:
 *   --dry-run       : Apenas lista o que seria copiado, sem executar
 *   --invoice-id N  : Processar apenas a fatura com ID N
 *   --limit N       : Processar no máximo N faturas (default: 100)
 */
var xmlrpc = require('xmlrpc');
var config = require('../config');

var odooConfig = config.odoo;
var DRY_RUN = process.argv.indexOf('--dry-run') >= 0;
var SINGLE_ID = 0;
var LIMIT = 100;

for (var i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--invoice-id' && process.argv[i + 1]) {
    SINGLE_ID = parseInt(process.argv[i + 1]) || 0;
  }
  if (process.argv[i] === '--limit' && process.argv[i + 1]) {
    LIMIT = parseInt(process.argv[i + 1]) || 100;
  }
}

if (!odooConfig || !odooConfig.enabled || !odooConfig.url) {
  console.error('Odoo não configurado. Verifique ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASSWORD.');
  process.exit(1);
}

function createClient(url) {
  var base = url.replace(/\/+$/, '');
  return {
    common: xmlrpc.createSecureClient({ host: base.replace('https://', ''), path: '/xmlrpc/2/common', port: 443 }),
    models: xmlrpc.createSecureClient({ host: base.replace('https://', ''), path: '/xmlrpc/2/object', port: 443 }),
  };
}

function rpc(client, db, uid, password, model, method, args, kwargs) {
  return new Promise(function(resolve, reject) {
    var params = [db, uid, password, model, method, args || []];
    if (kwargs) params.push(kwargs);
    client.models.methodCall('execute_kw', params, function(err, result) {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function main() {
  console.log('=== RETRO-COPY BOLETOS TO SALE ORDER ===');
  console.log('Dry run:', DRY_RUN);
  console.log('Single ID:', SINGLE_ID || 'todos');
  console.log('Limit:', LIMIT);

  var client = createClient(odooConfig.url);

  // Auth
  var uid = await new Promise(function(resolve, reject) {
    client.common.methodCall('authenticate', [odooConfig.db, odooConfig.user, odooConfig.password, {}], function(err, result) {
      if (err || !result) return reject(err || new Error('Auth failed'));
      resolve(result);
    });
  });
  console.log('Autenticado. UID:', uid);

  var db = odooConfig.db;
  var pw = odooConfig.password;

  // Buscar invoices com boletos emitidos
  var domain = [
    ['move_type', '=', 'out_invoice'],
    ['x_studio_itau_nosso_numero', '!=', false],
    ['x_studio_itau_nosso_numero', '!=', ''],
  ];
  if (SINGLE_ID > 0) {
    domain.push(['id', '=', SINGLE_ID]);
  }

  var invoiceIds = await rpc(client, db, uid, pw, 'account.move', 'search', [domain], { order: 'id desc', limit: LIMIT });
  console.log('Faturas com boletos emitidos:', invoiceIds.length);

  if (invoiceIds.length === 0) {
    console.log('Nenhuma fatura encontrada. Fim.');
    return;
  }

  // Ler dados das invoices
  var invoices = await rpc(client, db, uid, pw, 'account.move', 'read', [invoiceIds, ['name', 'invoice_origin', 'x_studio_itau_nosso_numero', 'x_studio_itau_situacao']]);

  var stats = { processed: 0, copied: 0, skipped: 0, no_so: 0, no_attachments: 0, errors: 0 };

  for (var inv of invoices) {
    console.log('\n--- Fatura', inv.name, '(ID:', inv.id, ') — NN:', inv.x_studio_itau_nosso_numero, '---');

    // Buscar sale order vinculado
    var soIds = await rpc(client, db, uid, pw, 'sale.order', 'search', [[['invoice_ids', 'in', [inv.id]]]], { limit: 5 });
    if (!soIds || soIds.length === 0) {
      // Fallback via invoice_origin
      if (inv.invoice_origin) {
        soIds = await rpc(client, db, uid, pw, 'sale.order', 'search', [[['name', 'ilike', inv.invoice_origin]]], { limit: 5 });
      }
    }

    if (!soIds || soIds.length === 0) {
      console.log('  ❌ Nenhum pedido de venda vinculado');
      stats.no_so++;
      continue;
    }

    var soId = soIds[0];
    var soData = await rpc(client, db, uid, pw, 'sale.order', 'read', [[soId], ['name']]);
    var soName = soData[0].name;
    console.log('  📋 Pedido:', soName, '(ID:', soId, ')');

    // Buscar attachments de boleto na invoice
    var attachIds = await rpc(client, db, uid, pw, 'ir.attachment', 'search', [[
      ['res_model', '=', 'account.move'],
      ['res_id', '=', inv.id],
      ['name', 'ilike', 'Boleto'],
      ['mimetype', '=', 'application/pdf'],
    ]]);

    if (!attachIds || attachIds.length === 0) {
      console.log('  ⚠️  Sem attachments de boleto na fatura');
      stats.no_attachments++;
      continue;
    }

    console.log('  📎 Attachments encontrados:', attachIds.length);

    // Verificar quais já existem no SO
    var soExisting = await rpc(client, db, uid, pw, 'ir.attachment', 'search', [[
      ['res_model', '=', 'sale.order'],
      ['res_id', '=', soId],
      ['name', 'ilike', 'Boleto'],
    ]]);
    var soExistingNames = [];
    if (soExisting && soExisting.length > 0) {
      var soExistingData = await rpc(client, db, uid, pw, 'ir.attachment', 'read', [soExisting, ['name']]);
      soExistingNames = soExistingData.map(function(a) { return a.name; });
    }
    console.log('  📎 Já no pedido:', soExistingNames.length);

    // Ler dados dos attachments
    var attachments = await rpc(client, db, uid, pw, 'ir.attachment', 'read', [attachIds, ['name', 'raw', 'mimetype']]);

    for (var att of attachments) {
      if (soExistingNames.indexOf(att.name) >= 0) {
        console.log('  ⏭️  Já existe:', att.name);
        stats.skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log('  🔄 [DRY-RUN] Copiaria:', att.name, '→', soName);
        stats.copied++;
        continue;
      }

      try {
        var newAttId = await rpc(client, db, uid, pw, 'ir.attachment', 'create', [{
          name: att.name,
          raw: att.raw,
          res_model: 'sale.order',
          res_id: soId,
          mimetype: att.mimetype || 'application/pdf',
        }]);

        await rpc(client, db, uid, pw, 'mail.message', 'create', [{
          model: 'sale.order',
          res_id: soId,
          body: '<b>Boleto</b> (cópia da fatura ' + inv.name + ')<br/>Arquivo: ' + att.name,
          message_type: 'comment',
          subtype_xmlid: 'mail.mt_note',
          attachment_ids: [[6, 0, [newAttId]]],
        }]);

        console.log('  ✅ Copiado:', att.name, '→', soName);
        stats.copied++;
      } catch (err) {
        console.error('  ❌ ERRO ao copiar', att.name + ':', err.message);
        stats.errors++;
      }
    }

    stats.processed++;
  }

  console.log('\n=== RESUMO ===');
  console.log('Faturas processadas:', stats.processed);
  console.log('Boletos copiados:', stats.copied);
  console.log('Boletos pulados (já existiam):', stats.skipped);
  console.log('Faturas sem pedido:', stats.no_so);
  console.log('Faturas sem attachments:', stats.no_attachments);
  console.log('Erros:', stats.errors);
  if (DRY_RUN) console.log('\n⚠️  MODO DRY-RUN — nada foi alterado');
}

main().then(function() {
  console.log('\nFim.');
  process.exit(0);
}).catch(function(err) {
  console.error('ERRO FATAL:', err);
  process.exit(1);
});
