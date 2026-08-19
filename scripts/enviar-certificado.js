#!/usr/bin/env node
/**
 * scripts/enviar-certificado.js — envia o certificado A1 para a API
 *
 * Uso:
 *   node scripts/enviar-certificado.js ./certificado.pfx "SENHA" \
 *        https://sua-api.onrender.com SUA_API_KEY
 *
 * O arquivo nunca eh gravado em log: apenas convertido em base64 e enviado
 * por HTTPS para o endpoint protegido POST /api/v1/nfe/certificado.
 */
var fs = require('fs');
var https = require('https');
var http = require('http');
var url = require('url');

var arquivo = process.argv[2];
var senha = process.argv[3];
var base = process.argv[4] || process.env.API_BASE;
var apiKey = process.argv[5] || process.env.API_KEY;

if (!arquivo || !senha || !base || !apiKey) {
  console.error('Uso: node scripts/enviar-certificado.js <arquivo.pfx> <senha> <url-da-api> <api-key>');
  process.exit(1);
}

var pfx = fs.readFileSync(arquivo).toString('base64');
var payload = JSON.stringify({ pfxBase64: pfx, senha: senha });
var u = url.parse(base.replace(/\/+$/, '') + '/api/v1/nfe/certificado');
var mod = u.protocol === 'https:' ? https : http;

var req = mod.request({
  method: 'POST',
  hostname: u.hostname,
  port: u.port,
  path: u.path,
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'x-api-key': apiKey,
  },
}, function (res) {
  var body = '';
  res.on('data', function (c) { body += c; });
  res.on('end', function () {
    console.log('HTTP ' + res.statusCode);
    console.log(body);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});
req.on('error', function (e) { console.error('Erro: ' + e.message); process.exit(1); });
req.write(payload);
req.end();
