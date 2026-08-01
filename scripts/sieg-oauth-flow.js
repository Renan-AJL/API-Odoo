/**
 * SIEG OAuth 2.0 — Passo 1: Mostra URL de autorizacao
 * 
 * Apos rodar este script, abra a URL no navegador,
 * autorize o acesso, e cole a URL de redirect aqui.
 */
const CLIENT_ID = 'odoo_e7d5d98da53c';
const STATE = 'odoo-ajl-001';
const ACCESS_LEVEL = 'write';

var authUrl = 'https://app.sieg.com/AuthorizeAccess.aspx' +
  '?clientId=' + encodeURIComponent(CLIENT_ID) +
  '&state=' + encodeURIComponent(STATE) +
  '&accessLevel=' + encodeURIComponent(ACCESS_LEVEL);

console.log('');
console.log('=============================================================');
console.log('  SIEG OAuth 2.0 — PASSO 1: Autorizar acesso');
console.log('=============================================================');
console.log('');
console.log('Abra esta URL no navegador:');
console.log('');
console.log(authUrl);
console.log('');
console.log('Instrucoes:');
console.log('  1. Faca login com suas credenciais da plataforma SIEG');
console.log('  2. Clique em "Autorizar acesso"');
console.log('  3. A SIEG vai redirecionar para uma URL de callback');
console.log('  4. A pagina vai dar erro (404) — NORMAL!');
console.log('  5. COPIE a URL completa da barra de endereco');
console.log('  6. Me envie essa URL — vou trocar o token por voce');
console.log('');
console.log('State esperado: ' + STATE);
console.log('=============================================================');
