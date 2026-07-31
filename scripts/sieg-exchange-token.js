/**
 * SIEG OAuth — PASSO 2: Trocar token temporario por definitivo
 */
const https = require('https');

const CLIENT_ID = 'odoo_e7d5d98da53c';
const SECRET_KEY = 'fJ54xuGwObUaQtOTIbO1qdxSYC6laIH8W01UzuQ2tkw';
const TEMP_TOKEN = 'CNcYnUgRBl-rOBujHQ5sZGmtvsaCC8kRjgVucbUN3Nk';
const STATE = 'odoo-ajl-001';
const REDIRECT_URI = 'https://exemplo.com.br/callback';

var body = JSON.stringify({
  AccessToken: TEMP_TOKEN,
  State: STATE,
  RedirectUri: REDIRECT_URI,
});

var options = {
  hostname: 'api.sieg.com',
  port: 443,
  path: '/api/v1/oauth/generate-token',
  method: 'POST',
  headers: {
    'X-Client-Id': CLIENT_ID,
    'X-Secret-Key': SECRET_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
  timeout: 15000,
};

console.log('=== SIEG OAuth — Trocando token temporario por definitivo ===');
console.log('Temp token:', TEMP_TOKEN.substring(0, 20) + '...');
console.log('State:', STATE);
console.log('---');

var req = https.request(options, function(res) {
  var data = '';
  res.on('data', function(c) { data += c; });
  res.on('end', function() {
    console.log('HTTP Status:', res.statusCode);
    console.log('Response:');
    try {
      var parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
      
      if (parsed.IsSuccess) {
        console.log('---');
        console.log('SUCESSO! Token OAuth definitivo obtido!');
        console.log('Data:', JSON.stringify(parsed.Data, null, 2));
        
        // Tentar extrair o token de Data
        var d = parsed.Data || {};
        var token = d.AccessToken || d.accessToken || d.Token || d.token || (typeof d === 'string' ? d : null);
        if (token) {
          console.log('');
          console.log('=== TOKEN DEFINITIVO (X-OAuth-Token) ===');
          console.log(token);
          console.log('======================================');
          console.log('Tamanho:', token.length, 'chars');
          console.log('');
          console.log('Validade: 30 dias');
          console.log('Salvar como env var: SIEG_OAUTH_TOKEN=' + token);
        }
      } else {
        console.log('FALHA:', parsed.ErrorMessage || 'erro desconhecido');
      }
    } catch (e) {
      console.log(data);
    }
  });
});

req.on('error', function(e) {
  console.error('ERRO:', e.message);
});
req.on('timeout', function() {
  console.error('TIMEOUT');
  req.destroy();
});

req.write(body);
req.end();
