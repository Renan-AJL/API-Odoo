/**
 * Uso: node scripts/pfx-to-env.js /caminho/do/certificado.pfx
 * 
 * Imprime o valor para a variavel de ambiente NFE_CERT_PFX_BASE64
 * e pede a senha NFE_CERT_SENHA.
 *
 * No Render, va em Settings > Environment e adicione:
 *   NFE_CERT_PFX_BASE64 = <valor impresso>
 *   NFE_CERT_SENHA    = <senha do certificado>
 */
var fs = require('fs');
var path = require('path');
var readline = require('readline');

var pfxPath = process.argv[2];
if (!pfxPath) {
  console.log('Uso: node scripts/pfx-to-env.js <caminho-do-certificado.pfx>');
  console.log('');
  console.log('Este script converte um arquivo .pfx para base64 e exibe');
  console.log('o valor para a variavel de ambiente NFE_CERT_PFX_BASE64.');
  console.log('');
  console.log('No Render (Dashboard > Environment):');
  console.log('  1. NFE_CERT_PFX_BASE64 = <cole o valor abaixo>');
  console.log('  2. NFE_CERT_SENHA    = <senha do certificado>');
  console.log('');
  console.log('Apos definir, faca um novo deploy para o servidor carregar.');
  process.exit(1);
}

var resolved = path.resolve(pfxPath);
if (!fs.existsSync(resolved)) {
  console.error('Arquivo nao encontrado: ' + resolved);
  process.exit(1);
}

var buf = fs.readFileSync(resolved);
var b64 = buf.toString('base64');
var sizeKb = (buf.length / 1024).toFixed(1);

console.log('=== Certificado A1 para Variaveis de Ambiente ===');
console.log('Arquivo: ' + resolved + ' (' + sizeKb + ' KB)');
console.log('');
console.log('Variavel NFE_CERT_PFX_BASE64 (copie tudo abaixo):');
console.log('');
console.log(b64);
console.log('');
console.log('Tamanho em caracteres: ' + b64.length);
console.log('');
console.log('Variavel NFE_CERT_SENHA: <sua senha>');
console.log('');
console.log('=== Instrucoes Render ===');
console.log('1. Acesse https://dashboard.render.com');
console.log('2. Selecione o servico API-Odoo');
console.log('3. Vá em Environment');
console.log('4. Adicione:');
console.log('   Key:   NFE_CERT_PFX_BASE64');
console.log('   Value: <cole o base64 acima>');
console.log('5. Adicione:');
console.log('   Key:   NFE_CERT_SENHA');
console.log('   Value: <senha do certificado>');
console.log('6. Clique em Save Changes e aguarde o redeploy');
console.log('');
console.log('Apos o redeploy, teste:');
console.log('  curl -H "x-api-key: SUA_KEY" https://seu-app.onrender.com/api/v1/nfe/certificado');
