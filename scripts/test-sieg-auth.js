/**
 * test-sieg-auth.js — Testa TODAS as estrategias de auth SIEG
 * Uso: SIEG_CLIENT_ID=xxx SIEG_CLIENT_SECRET=yyy node scripts/test-sieg-auth.js
 */
const axios = require('axios');

var CLIENT_ID = process.env.SIEG_CLIENT_ID || '';
var CLIENT_SECRET = process.env.SIEG_CLIENT_SECRET || '';
var JWT_URL = 'https://api.sieg.com/api/v1/create-jwt';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('ERRO: Defina SIEG_CLIENT_ID e SIEG_CLIENT_SECRET');
  console.log('Uso: SIEG_CLIENT_ID=xxx SIEG_CLIENT_SECRET=yyy node scripts/test-sieg-auth.js');
  process.exit(1);
}

console.log('ClientId: ' + CLIENT_ID.substring(0, 8) + '...' + CLIENT_ID.slice(-4));
console.log('Secret:  ***' + CLIENT_SECRET.slice(-4));
console.log('URL:     ' + JWT_URL);
console.log('');

var strategies = [
  {
    name: '1. Basic Auth header',
    fn: function() {
      var creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
      return axios.post(JWT_URL, null, {
        headers: { 'Authorization': 'Basic ' + creds },
        timeout: 15000,
      });
    }
  },
  {
    name: '2. Query Params PascalCase',
    fn: function() {
      return axios.get(JWT_URL, {
        params: { ClientId: CLIENT_ID, SecretKey: CLIENT_SECRET },
        timeout: 15000,
      });
    }
  },
  {
    name: '3. Query Params camelCase',
    fn: function() {
      return axios.get(JWT_URL, {
        params: { clientId: CLIENT_ID, secretKey: CLIENT_SECRET },
        timeout: 15000,
      });
    }
  },
  {
    name: '4. Form-Encoded PascalCase',
    fn: function() {
      var params = new URLSearchParams();
      params.append('ClientId', CLIENT_ID);
      params.append('SecretKey', CLIENT_SECRET);
      return axios.post(JWT_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
    }
  },
  {
    name: '5. Form-Encoded camelCase',
    fn: function() {
      var params = new URLSearchParams();
      params.append('clientId', CLIENT_ID);
      params.append('secretKey', CLIENT_SECRET);
      return axios.post(JWT_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
    }
  },
  {
    name: '6. JSON PascalCase (ClientId/SecretKey)',
    fn: function() {
      return axios.post(JWT_URL, {
        ClientId: CLIENT_ID,
        SecretKey: CLIENT_SECRET,
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    }
  },
  {
    name: '7. JSON camelCase (clientId/secretKey)',
    fn: function() {
      return axios.post(JWT_URL, {
        clientId: CLIENT_ID,
        secretKey: CLIENT_SECRET,
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    }
  },
  {
    name: '8. JSON snake_case (client_id/client_secret)',
    fn: function() {
      return axios.post(JWT_URL, {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    }
  },
  {
    name: '9. POST sem body + Basic Auth',
    fn: function() {
      var creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
      return axios.post(JWT_URL, {}, {
        headers: {
          'Authorization': 'Basic ' + creds,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    }
  },
  {
    name: '10. POST sem body sem auth (ver erro)',
    fn: function() {
      return axios.post(JWT_URL, null, { timeout: 15000 });
    }
  },
];

async function runTests() {
  var results = [];

  for (var i = 0; i < strategies.length; i++) {
    var s = strategies[i];
    process.stdout.write(s.name + '... ');
    try {
      var resp = await s.fn();
      var data = resp.data;
      var token = null;
      if (typeof data === 'string' && data.length > 20) {
        token = data;
      } else {
        token = data.token || data.jwt || data.access_token || data.accessToken || data.Token || data.Jwt || null;
      }
      
      if (token) {
        console.log('SUCESSO! Token: ' + String(token).substring(0, 50) + '...');
        console.log('  Resposta completa:', JSON.stringify(data).substring(0, 300));
        results.push({ name: s.name, ok: true, token: String(token).substring(0, 80), data: data });
        // Nao parar - testar todas para ter info completa
      } else {
        console.log('200 OK mas sem token reconhecido');
        console.log('  Resposta:', JSON.stringify(data).substring(0, 300));
        results.push({ name: s.name, ok: false, status: 200, data: data });
      }
    } catch (err) {
      var errMsg = err.response ? (err.response.data || err.response.status) : err.message;
      var status = err.response ? err.response.status : 'N/A';
      console.log('FALHOU (' + status + '): ' + (typeof errMsg === 'string' ? errMsg.substring(0, 150) : JSON.stringify(errMsg).substring(0, 150)));
      results.push({ name: s.name, ok: false, status: status, error: errMsg });
    }
  }

  console.log('');
  console.log('=== RESUMO ===');
  var winners = results.filter(function(r) { return r.ok; });
  if (winners.length) {
    console.log('VENCEDOR(ES): ' + winners.length);
    winners.forEach(function(w) { console.log('  -> ' + w.name); });
  } else {
    console.log('Nenhuma estrategia funcionou.');
    console.log('');
    console.log('Possiveis causas:');
    console.log('  1. Credenciais incorretas (verifique SIEG_CLIENT_ID e SIEG_CLIENT_SECRET)');
    console.log('  2. IP nao liberado no painel SIEG');
    console.log('  3. Endpoint diferente (verifique a versao da API SIEG)');
    console.log('  4. Necessario ativar "Sistema Externo" no painel SIEG antes');
  }
}

runTests().catch(function(err) {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
