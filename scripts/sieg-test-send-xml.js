/**
 * SIEG Teste Completo — Enviar XML com 3 headers
 * 
 * Credenciais:
 *   JWT: gerado via X-Client-Id + X-Secret-Key
 *   X-OAuth-Token: token definitivo OAuth (30 dias)
 *   X-API-Key: chave gerada no painel SIEG
 */
const https = require('https');

const CLIENT_ID = 'odoo_e7d5d98da53c';
const SECRET_KEY = 'fJ54xuGwObUaQtOTIbO1qdxSYC6laIH8W01UzuQ2tkw';
const OAUTH_TOKEN = 'wiSzba34AIO48pG2htsxvYYS5qijhOhUAr4cmLxtm9c';
const API_KEY = 'ufDBb_kHs01tRtiQJ3a054XttFDrKr7I6Dysx26phR0';

// Passo 1: Gerar JWT
function generateJwt() {
  return new Promise(function(resolve, reject) {
    var options = {
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
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (res.statusCode === 200 && data.length > 20) {
          // JWT vem como string pura
          var token = data.replace(/"/g, '');
          resolve(token);
        } else {
          reject(new Error('JWT falhou: ' + res.statusCode + ' - ' + data));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Passo 2: Enviar XML
function sendXml(jwt, endpointPath) {
  return new Promise(function(resolve, reject) {
    // XML de teste minimal (vai falhar validacao, mas testa autenticacao)
    var testXml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe versao="4.00">
    <ide>
      <cUF>41</cUF>
      <cNF>12345678</cNF>
      <natOp>Venda de Mercadoria</natOp>
      <mod>55</mod>
      <serie>100</serie>
      <nNF>1</nNF>
      <dhEmi>2026-08-01T10:00:00-03:00</dhEmi>
      <dhSaiEnt>2026-08-01T10:00:00-03:00</dhSaiEnt>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>4106902</cMunFG>
      <tpImp>1</tpImp>
      <tpEmis>1</tpEmis>
      <cDV>0</cDV>
      <tpAmb>2</tpAmb>
      <finNFe>1</finNFe>
      <indFinal>0</indFinal>
      <indPres>0</indPres>
      <procEmi>0</procEmi>
      <verProc>Odoo19-SIEG-1.0</verProc>
    </ide>
    <emit>
      <CNPJ>22603750000190</CNPJ>
      <xNome>AJL EMPRESA TESTE</xNome>
      <xFant>AJL</xFant>
      <enderEmit>
        <xLgr>Rua Teste</xLgr>
        <nro>123</nro>
        <xBairro>Centro</xBairro>
        <cMun>4106902</cMun>
        <xMun>Curitiba</xMun>
        <UF>PR</UF>
        <CEP>80000000</CEP>
        <cPais>1058</cPais>
        <xPais>Brasil</xPais>
      </enderEmit>
      <IE>9069585890</IE>
      <CRT>1</CRT>
    </emit>
    <dest>
      <CPF>12345678901</CPF>
      <xNome>CLIENTE TESTE</xNome>
      <enderDest>
        <xLgr>Rua Cliente</xLgr>
        <nro>456</nro>
        <xBairro>Bairro</xBairro>
        <cMun>4106902</cMun>
        <xMun>Curitiba</xMun>
        <UF>PR</UF>
        <CEP>80000000</CEP>
        <cPais>1058</cPais>
        <xPais>Brasil</xPais>
      </enderDest>
      <indIEDest>9</indIEDest>
    </dest>
    <det nItem="1">
      <prod>
        <cProd>001</cProd>
        <cEAN>SEM GTIN</cEAN>
        <xProd>Produto Teste</xProd>
        <NCM>00000000</NCM>
        <CFOP>5102</CFOP>
        <uCom>UN</uCom>
        <qCom>1.0000</qCom>
        <vUnCom>10.00</vUnCom>
        <vProd>10.00</vProd>
        <cEANTrib>SEM GTIN</cEANTrib>
        <uTrib>UN</uTrib>
        <qTrib>1.0000</qTrib>
        <vUnTrib>10.00</vUnTrib>
        <indTot>1</indTot>
      </prod>
      <imposto>
        <ICMS>
          <ICMSSN102>
            <orig>0</orig>
            <CSOSN>103</CSOSN>
          </ICMSSN102>
        </ICMS>
        <PIS>
          <PISNT>
            <CST>04</CST>
          </PISNT>
        </PIS>
        <COFINS>
          <COFINSNT>
            <CST>04</CST>
          </COFINSNT>
        </COFINS>
      </imposto>
    </det>
    <total>
      <ICMSTot>
        <vBC>0.00</vBC>
        <vICMS>0.00</vICMS>
        <vICMSDeson>0.00</vICMSDeson>
        <vFCPUFDest>0.00</vFCPUFDest>
        <vICMSUFDest>0.00</vICMSUFDest>
        <vFCP>0.00</vFCP>
        <vBCST>0.00</vBCST>
        <vST>0.00</vST>
        <vFCPST>0.00</vFCPST>
        <vFCPSTRet>0.00</vFCPSTRet>
        <vProd>10.00</vProd>
        <vFrete>0.00</vFrete>
        <vSeg>0.00</vSeg>
        <vDesc>0.00</vDesc>
        <vII>0.00</vII>
        <vIPI>0.00</vIPI>
        <vIPIDevol>0.00</vIPIDevol>
        <vPIS>0.00</vPIS>
        <vCOFINS>0.00</vCOFINS>
        <vOutro>0.00</vOutro>
        <vNF>10.00</vNF>
        <vTotTrib>0.00</vTotTrib>
      </ICMSTot>
    </total>
    <transp>
      <modFrete>9</modFrete>
    </transp>
  </infNFe>
</NFe>`;

    var xmlBase64 = Buffer.from(testXml, 'utf-8').toString('base64');
    var body = JSON.stringify({ Xml: xmlBase64 });

    var options = {
      hostname: 'api.sieg.com',
      port: 443,
      path: endpointPath,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + jwt,
        'X-OAuth-Token': OAUTH_TOKEN,
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    console.log('---');
    console.log('Enviando XML para: https://api.sieg.com' + endpointPath);
    console.log('Headers:');
    console.log('  Authorization: Bearer ' + jwt.substring(0, 30) + '...');
    console.log('  X-OAuth-Token: ' + OAUTH_TOKEN);
    console.log('  X-API-Key: ' + API_KEY);
    console.log('  XML Base64 length:', xmlBase64.length);
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
        } catch (e) {
          console.log(data);
        }
        resolve({ status: res.statusCode, data: data });
      });
    });
    req.on('error', function(e) { reject(e); });
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// === MAIN ===
async function main() {
  console.log('=== SIEG TESTE COMPLETO — Enviar XML ===');
  console.log('');

  // Passo 1: JWT
  console.log('PASSO 1: Gerando JWT...');
  var jwt;
  try {
    jwt = await generateJwt();
    console.log('JWT OK! (' + jwt.length + ' chars)');
  } catch (e) {
    console.error('FALHA JWT:', e.message);
    return;
  }

  // Passo 2: Tentar enviar XML
  // Tentar os paths mais provaveis
  var paths = [
    '/api/v1/send-xml',
    '/api/v1/enviar-xml',
    '/api/v1/external-system/send-xml',
  ];

  for (var i = 0; i < paths.length; i++) {
    console.log('');
    console.log('PASSO 2: Testando endpoint [' + (i+1) + '/' + paths.length + ']: ' + paths[i]);
    try {
      var result = await sendXml(jwt, paths[i]);
      if (result.status === 404) {
        console.log('-> 404: endpoint nao existe, tentando proximo...');
      } else if (result.status === 401) {
        console.log('-> 401: autenticacao falhou (mas endpoint existe!)');
        console.log('-> Este pode ser o endpoint correto — problema nos headers');
        break;
      } else {
        console.log('-> Status ' + result.status + ': endpoint respondeu!');
        break;
      }
    } catch (e) {
      console.error('-> Erro:', e.message);
    }
  }
}

main();
