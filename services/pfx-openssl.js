/**
 * services/pfx-openssl.js — Fallback de leitura de PKCS#12 via OpenSSL CLI
 * ========================================================================
 * O node-forge nao suporta PFX gerados com PBES2/AES-256 (padrao das ACs
 * ICP-Brasil desde o OpenSSL 3) nem os antigos RC2-40 quando o runtime usa
 * OpenSSL 3 sem provider legacy. Nesses casos ele lanca:
 *   "Unsupported PKCS12 PFX data" / "Unsupported PKCS#12 ..."
 *
 * Aqui usamos o binario `openssl` (presente na imagem Docker) para extrair
 * chave privada e certificados em PEM. Tentamos primeiro o modo moderno e,
 * se falhar, com -legacy (algoritmos antigos).
 *
 * A senha NUNCA vai na linha de comando (usamos env:VAR) e o .pfx temporario
 * eh gravado com modo 0600 e apagado ao final.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var execFileSync = require('child_process').execFileSync;

function run(args, senha) {
  return execFileSync('openssl', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: Object.assign({}, process.env, { NFE_PFX_PW: String(senha) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function extract(pfxPath, senha, mode, legacy) {
  var args = ['pkcs12', '-in', pfxPath, '-passin', 'env:NFE_PFX_PW'];
  if (mode === 'key') args = args.concat(['-nocerts', '-nodes']);
  if (mode === 'leaf') args = args.concat(['-clcerts', '-nokeys']);
  if (mode === 'ca') args = args.concat(['-cacerts', '-nokeys']);
  if (legacy) args.push('-legacy');
  return run(args, senha);
}

function pemBlocks(text, tag) {
  var re = new RegExp('-----BEGIN ' + tag + '-----[\\s\\S]*?-----END ' + tag + '-----', 'g');
  return String(text || '').match(re) || [];
}

function normalizeKey(pem) {
  var b = pemBlocks(pem, 'PRIVATE KEY')[0]
    || pemBlocks(pem, 'RSA PRIVATE KEY')[0]
    || pemBlocks(pem, 'ENCRYPTED PRIVATE KEY')[0];
  return b ? b + '\n' : '';
}

/**
 * Extrai { privateKeyPem, certPem, chainPem[] } do PFX usando o OpenSSL CLI.
 * Lanca erro descritivo quando a senha esta incorreta.
 */
function openPfxWithOpenssl(pfxBuffer, senha) {
  var tmp = path.join(os.tmpdir(), 'nfe-' + crypto.randomBytes(8).toString('hex') + '.pfx');
  fs.writeFileSync(tmp, pfxBuffer, { mode: 0o600 });
  try {
    var lastErr = null;
    var modos = [false, true]; // moderno, depois -legacy
    for (var i = 0; i < modos.length; i++) {
      try {
        var keyPem = normalizeKey(extract(tmp, senha, 'key', modos[i]));
        var leafOut = extract(tmp, senha, 'leaf', modos[i]);
        var certPem = pemBlocks(leafOut, 'CERTIFICATE')[0];
        var chain = [];
        try { chain = pemBlocks(extract(tmp, senha, 'ca', modos[i]), 'CERTIFICATE'); } catch (e) { chain = []; }
        if (!certPem) {
          // alguns PFX trazem tudo como "cacert"; usa o primeiro disponivel
          certPem = chain[0];
        }
        if (!keyPem) throw new Error('Chave privada nao encontrada no arquivo .pfx.');
        if (!certPem) throw new Error('Certificado nao encontrado no arquivo .pfx.');
        var chainPem = [certPem].concat(chain.filter(function (c) { return c !== certPem; }));
        return { privateKeyPem: keyPem, certPem: certPem + '\n', chainPem: chainPem, legacy: modos[i] };
      } catch (e) {
        lastErr = e;
        var out = String((e && e.stderr) || (e && e.message) || '');
        if (/mac verify failure|invalid password|wrong password/i.test(out)) {
          throw new Error('Senha do certificado incorreta.');
        }
      }
    }
    var det = String((lastErr && lastErr.stderr) || (lastErr && lastErr.message) || 'desconhecido').trim();
    if (/ENOENT/.test(det)) {
      throw new Error('OpenSSL nao disponivel no servidor para ler este certificado.');
    }
    throw new Error('Falha ao abrir o certificado com OpenSSL: ' + det.split('\n').slice(-3).join(' '));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

function opensslDisponivel() {
  try { execFileSync('openssl', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] }); return true; }
  catch (e) { return false; }
}

module.exports = { openPfxWithOpenssl: openPfxWithOpenssl, opensslDisponivel: opensslDisponivel };
