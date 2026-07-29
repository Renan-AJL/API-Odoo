/**
 * Teste rápido da autenticação OAuth Rede/Itaú
 * Uso: REDE_PV=107719258 REDE_CHAVE_INTEGRACAO=21c857dc... node scripts/test-rede-auth.js
 */
var axios = require('axios');

var PV = process.env.REDE_PV || '107719258';
var CHAVE = process.env.REDE_CHAVE_INTEGRACAO || '21c857dc654c4c39894f432449b98625';
var BASE_URL = 'https://api.userede.com.br';

async function test() {
  console.log('=== Teste Rede/Itau OAuth ===');
  console.log('PV:', PV);
  console.log('Chave:', CHAVE.substring(0, 6) + '...');
  console.log('Ambiente: PRODUCAO');
  console.log('');

  var basicAuth = Buffer.from(PV + ':' + CHAVE).toString('base64');
  console.log('Basic Auth:', basicAuth.substring(0, 10) + '...');

  var params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  var tokenUrl = BASE_URL + '/redelabs/oauth2/token';
  console.log('Token URL:', tokenUrl);
  console.log('');

  try {
    var response = await axios.post(tokenUrl, params, {
      headers: {
        'Authorization': 'Basic ' + basicAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });

    var data = response.data;
    console.log('STATUS:', response.status);
    console.log('Token OK:', !!data.access_token);
    console.log('Expires in:', data.expires_in, 'segundos');
    console.log('Token prefix:', data.access_token ? data.access_token.substring(0, 20) + '...' : 'N/A');
    console.log('');
    console.log('=== SUCESSO - Credenciais validas! ===');
  } catch (error) {
    var status = error.response ? error.response.status : 0;
    var body = error.response ? JSON.stringify(error.response.data) : error.message;
    console.log('STATUS:', status);
    console.log('ERRO:', body);
    console.log('');
    console.log('=== FALHA - Verifique PV e Chave ===');
    process.exit(1);
  }
}

test();