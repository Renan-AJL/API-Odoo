/**
 * Teste JWT SIEG com credenciais reais
 * Documentacao: POST https://api.sieg.com/api/v1/create-jwt
 * Headers: X-Client-Id + X-Secret-Key
 */
const https = require('https');

const CLIENT_ID = 'odoo_e7d5d98da53c';
const SECRET_KEY = 'fJ54xuGwObUaQtOTIbO1qdxSYC6laIH8W01UzuQ2tkw';

const postData = '';

const options = {
  hostname: 'api.sieg.com',
  port: 443,
  path: '/api/v1/create-jwt',
  method: 'POST',
  headers: {
    'X-Client-Id': CLIENT_ID,
    'X-Secret-Key': SECRET_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Content-Length': '0',
  },
  timeout: 15000,
};

console.log('=== TESTE JWT SIEG ===');
console.log('Endpoint: https://api.sieg.com/api/v1/create-jwt');
console.log('Client ID: ***' + CLIENT_ID.slice(-4));
console.log('Secret Key: ***' + SECRET_KEY.slice(-4));
console.log('Headers: X-Client-Id, X-Secret-Key, Content-Type, Accept');
console.log('---');

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log('HTTP Status:', res.statusCode);
    console.log('Response Headers:', JSON.stringify(res.headers, null, 2));
    console.log('---');
    console.log('Response Body:');
    try {
      const parsed = JSON.parse(body);
      console.log(JSON.stringify(parsed, null, 2));
      if (parsed.Token || parsed.token) {
        console.log('---');
        console.log('SUCESSO! JWT obtido:');
        const token = parsed.Token || parsed.token;
        console.log('Token (primeiros 80 chars):', token.substring(0, 80) + '...');
        console.log('Token length:', token.length);
      }
    } catch (e) {
      console.log(body);
    }
  });
});

req.on('error', (e) => {
  console.error('ERRO:', e.message);
  console.error('Code:', e.code);
});

req.on('timeout', () => {
  console.error('TIMEOUT - sem resposta em 15s');
  req.destroy();
});

req.write(postData);
req.end();
