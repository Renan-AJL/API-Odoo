/**
 * test-sieg-auth.js — Testa TODAS as estrategias de auth SIEG
 * 
 * DESCOBERTA: O swagger mostra api_key no topo (padrao SIEG)
 * O endpoint create-jwt tem parameters:[] e consumes:[]
 * Isso significa que a auth e via HEADER, nao body!
 * 
 * Uso: SIEG_CLIENT_ID=xxx SIEG_CLIENT_SECRET=yyy node scripts/test-sieg-auth.js
 */
const axios = require('axios');

var CLIENT_ID = process.env.SIEG_CLIENT_ID || '';
var CLIENT_SECRET = process.env.SIEG_CLIENT_SECRET || '';
var JWT_URL = 'https://api.sieg.com/api/v1/create-jwt';
var SEND_XML_URL = 'https://api.sieg.com/api/v1/send-xml';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('ERRO: Defina SIEG_CLIENT_ID e SIEG_CLIENT_SECRET');
  process.exit(1);
}

console.log('ClientId: ' + CLIENT_ID.substring(0, 8) + '...' + CLIENT_ID.slice(-4));
console.log('Secret:  ***' + CLIENT_SECRET.slice(-4));
console.log('');

var strategies = [
  // === HEADER-BASED (mais provavel dado o swagger) ===
  {
    name: '1. api_key header = ClientId',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, null, {
        headers: { 'api_key': CLIENT_ID },
        timeout: 15000,
      });
    }
  },
  {
    name: '2. api_key header = SecretKey',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, null, {
        headers: { 'api_key': CLIENT_SECRET },
        timeout: 15000,
      });
    }
  },
  {
    name: '3. X-Api-Key header = ClientId',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, null, {
        headers: { 'X-Api-Key': CLIENT_ID },
        timeout: 15000,
      });
    }
  },
  {
    name: '4. ApiKey header = ClientId',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, null, {
        headers: { 'ApiKey': CLIENT_ID },
        timeout: 15000,
      });
    }
  },
  // === BASIC AUTH ===
  {
    name: '5. Basic Auth (id:secret)',
    url: JWT_URL,
    fn: function() {
      var creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
      return axios.post(JWT_URL, null, {
        headers: { 'Authorization': 'Basic ' + creds },
        timeout: 15000,
      });
    }
  },
  // === QUERY PARAMS ===
  {
    name: '6. Query api_key=ClientId',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, null, {
        params: { api_key: CLIENT_ID },
        timeout: 15000,
      });
    }
  },
  {
    name: '7. Query ClientId+SecretKey',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, null, {
        params: { ClientId: CLIENT_ID, SecretKey: CLIENT_SECRET },
        timeout: 15000,
      });
    }
  },
  // === JSON BODY ===
  {
    name: '8. JSON PascalCase',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, { ClientId: CLIENT_ID, SecretKey: CLIENT_SECRET }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
    }
  },
  // === FORM ENCODED ===
  {
    name: '9. Form-encoded',
    url: JWT_URL,
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
  // === SEM AUTH (ver erro puro) ===
  {
    name: '10. Sem auth (ver erro)',
    url: JWT_URL,
    fn: function() {
      return axios.post(JWT_URL, null, { timeout: 15000 });
    }
  },
];

function extractToken(data) {
  if (!data) return null;
  if (typeof data === 'string' && data.length > 20) return data;
  return data.token || data.jwt || data.access_token || data.accessToken || data.Token || data.Jwt || null;
}

async function runTests() {
  var results = [];

  for (var i = 0; i < strategies.length; i++) {
    var s = strategies[i];
    process.stdout.write(s.name + '... ');
    try {
      var resp = await s.fn();
      var data = resp.data;
      var token = extractToken(data);
      
      if (token) {
        console.log('TOKEN ENCONTRADO!');
        console.log('  Token: ' + String(token).substring(0, 60) + '...');
        console.log('  Resposta:', JSON.stringify(data).substring(0, 300));
        results.push({ name: s.name, ok: true, token: String(token).substring(0, 80), data: data });
      } else {
        console.log('200 mas sem token');
        console.log('  Resposta:', JSON.stringify(data).substring(0, 200));
        results.push({ name: s.name, ok: false, status: 200, data: data });
      }
    } catch (err) {
      var errMsg = err.response ? err.response.data : err.message;
      var status = err.response ? err.response.status : 'N/A';
      var errStr = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
      console.log('FALHOU (' + status + '): ' + errStr.substring(0, 150));
      results.push({ name: s.name, ok: false, status: status, error: errStr });
    }
  }

  // === TESTE DIRETO: send-xml com api_key (pular JWT?) ===
  console.log('');
  console.log('=== TESTE: send-xml DIRETO com api_key ===');
  var xmlTest = '<nfe><infNFe versao="4.00"><ide><cUF>41</cUF><cNF>123</cNF></ide></infNFe></nfe>';
  var xmlB64 = Buffer.from(xmlTest).toString('base64');
  
  var directTests = [
    { name: 'send-xml + api_key=ClientId', headers: { 'api_key': CLIENT_ID } },
    { name: 'send-xml + X-Api-Key=ClientId', headers: { 'X-Api-Key': CLIENT_ID } },
    { name: 'send-xml + Bearer ClientId', headers: { 'Authorization': 'Bearer ' + CLIENT_ID } },
    { name: 'send-xml + Bearer Secret', headers: { 'Authorization': 'Bearer ' + CLIENT_SECRET } },
  ];
  
  for (var j = 0; j < directTests.length; j++) {
    var dt = directTests[j];
    process.stdout.write(dt.name + '... ');
    try {
      var r = await axios.post(SEND_XML_URL, { Xml: xmlB64 }, {
        headers: Object.assign({ 'Content-Type': 'application/json' }, dt.headers),
        timeout: 15000,
      });
      console.log('RESPOSTA:', JSON.stringify(r.data).substring(0, 200));
      results.push({ name: dt.name, ok: true, data: r.data });
    } catch (err2) {
      var eMsg = err2.response ? (typeof err2.response.data === 'string' ? err2.response.data : JSON.stringify(err2.response.data)) : err2.message;
      console.log('FALHOU (' + (err2.response?.status || 'N/A') + '): ' + eMsg.substring(0, 150));
      results.push({ name: dt.name, ok: false, error: eMsg });
    }
  }

  console.log('');
  console.log('=== RESUMO ===');
  var winners = results.filter(function(r) { return r.ok; });
  if (winners.length) {
    console.log('SUCESSO em ' + winners.length + ' estrategia(s):');
    winners.forEach(function(w) { console.log('  -> ' + w.name); });
  } else {
    console.log('Nenhuma estrategia funcionou.');
    console.log('');
    console.log('Diagnostico:');
    console.log('  - Verifique se as credenciais estao corretas no painel SIEG');
    console.log('  - Verifique se o IP do Render esta liberado no SIEG');
    console.log('  - Verifique se o "Sistema Externo" esta ativo no painel SIEG');
    console.log('  - Pode ser necessario contatar o suporte SIEG para o api_key correto');
  }
}

runTests().catch(function(err) {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
