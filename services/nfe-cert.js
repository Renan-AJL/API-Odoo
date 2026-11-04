/**
 * services/nfe-cert.js — Cofre do certificado digital A1 (.pfx/.p12) MULTI-EMITENTE
 * ==================================================================================
 * AJL 04/11/2026 (demanda Transferência entre Filiais): o cofre passa a guardar
 * UM certificado POR EMITENTE (CNPJ). Hoje temos:
 *   - Matriz Curitiba  : CNPJ 22603750000190 (AJL FERRO E ACO LTDA)
 *   - Filial Florianópolis: CNPJ 22603750000514 (AJL FERRO E ACO FILIAL FLORIANOPOLIS)
 *
 * O certificado eh enviado por endpoint protegido (routes/nfe-cert.js) ou,
 * como fallback da MATRIZ, lido das variaveis de ambiente
 * NFE_CERT_PFX_BASE64 / NFE_CERT_SENHA (compatibilidade com o fluxo antigo).
 *
 * Persistencia: grava em NFE_CERT_DIR (default /var/data, fallback os.tmpdir()).
 *   - Matriz (slot legado, sem CNPJ) : nfe-cert.pfx + nfe-cert.meta.json
 *   - Por emitente                   : nfe-cert-<CNPJ>.pfx + nfe-cert-<CNPJ>.meta.json
 * No Render, configure um Disk persistente em /var/data para nao precisar
 * reenviar o certificado a cada deploy.
 *
 * Logo do emitente (DANFE): logo-<CNPJ>.png|jpg|jpeg no mesmo diretorio.
 *
 * Nunca logamos a senha nem o conteudo do .pfx.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var forge = require('node-forge');
var openPfxWithOpenssl = require('./pfx-openssl').openPfxWithOpenssl;

var DIR = process.env.NFE_CERT_DIR || '/var/data';
var PFX_FILE = 'nfe-cert.pfx';          // slot legado (matriz)
var META_FILE = 'nfe-cert.meta.json';
var LOGO_EXTS = ['png', 'jpg', 'jpeg'];

var cache = null;   // slot legado (matriz) — { pfx, senha, privateKeyPem, certPem, chainPem, info }
var cachesPorCnpj = {}; // { '<cnpj>': { ...mesma estrutura } }

function ensureDir() {
  var dir = DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    dir = path.join(os.tmpdir(), 'nfe-cert');
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Chave simetrica derivada de um segredo do ambiente para proteger a senha em disco. */
function secretKey() {
  var base = process.env.NFE_CERT_KEK || process.env.API_KEY || process.env.SIEG_CLIENT_SECRET || 'ajl-nfe-local-kek';
  return crypto.createHash('sha256').update(String(base)).digest();
}

function encryptSenha(senha) {
  var iv = crypto.randomBytes(12);
  var c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  var enc = Buffer.concat([c.update(String(senha), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptSenha(blob) {
  var buf = Buffer.from(String(blob), 'base64');
  var iv = buf.slice(0, 12);
  var tag = buf.slice(12, 28);
  var d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.slice(28)), d.final()]).toString('utf8');
}

function onlyNum(s) { return String(s || '').replace(/\D/g, ''); }

function cnpjKey(cnpj) { return onlyNum(cnpj); }

function pfxPathFor(cnpj) {
  var dir = ensureDir();
  var k = cnpjKey(cnpj);
  return k ? path.join(dir, 'nfe-cert-' + k + '.pfx') : path.join(dir, PFX_FILE);
}
function metaPathFor(cnpj) {
  var dir = ensureDir();
  var k = cnpjKey(cnpj);
  return k ? path.join(dir, 'nfe-cert-' + k + '.meta.json') : path.join(dir, META_FILE);
}

/** Monta as infos publicas a partir do certificado do titular em PEM. */
function infoFromCertPem(certPem) {
  var leaf = forge.pki.certificateFromPem(certPem);
  var cn = '';
  try { cn = (leaf.subject.getField('CN') || {}).value || ''; } catch (e) { cn = ''; }
  var cnpj = onlyNum((cn.split(':')[1] || ''));
  if (cnpj.length !== 14) {
    var m = cn.match(/(\d{14})/);
    cnpj = m ? m[1] : '';
  }
  return {
    titular: cn.split(':')[0] || cn,
    cnpj: cnpj,
    emissor: (function () { try { return (leaf.issuer.getField('CN') || {}).value || ''; } catch (e) { return ''; } })(),
    validoDe: leaf.validity.notBefore.toISOString(),
    validoAte: leaf.validity.notAfter.toISOString(),
    diasRestantes: Math.floor((leaf.validity.notAfter.getTime() - Date.now()) / 86400000),
    expirado: leaf.validity.notAfter.getTime() < Date.now(),
    serial: leaf.serialNumber,
  };
}

/** Leitura via node-forge (PFX classicos: 3DES/RC2 com provider disponivel). */
function openPfxForge(pfxBuffer, senha) {
  var der = forge.util.createBuffer(pfxBuffer.toString('binary'));
  var asn1 = forge.asn1.fromDer(der);
  var p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(senha));

  var keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  if (!keyBags.length) {
    keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
  }
  if (!keyBags.length || !keyBags[0].key) throw new Error('Chave privada nao encontrada no certificado A1.');
  var privateKeyPem = forge.pki.privateKeyToPem(keyBags[0].key);

  var certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!certBags.length) throw new Error('Certificado nao encontrado no arquivo .pfx.');

  var leaf = null;
  var chainPem = [];
  for (var i = 0; i < certBags.length; i++) {
    var c = certBags[i].cert;
    if (!c) continue;
    chainPem.push(forge.pki.certificateToPem(c));
    var isCa = false;
    try {
      var bc = c.getExtension('basicConstraints');
      isCa = !!(bc && bc.cA);
    } catch (e) { isCa = false; }
    if (!isCa && !leaf) leaf = c;
  }
  if (!leaf) leaf = certBags[0].cert;
  var certPem = forge.pki.certificateToPem(leaf);

  return { privateKeyPem: privateKeyPem, certPem: certPem, chainPem: chainPem, info: infoFromCertPem(certPem) };
}

/**
 * Abre o PKCS#12, valida a senha e extrai chave privada + cadeia em PEM.
 * Tenta o node-forge e, quando o PFX usa algoritmos que ele nao suporta
 * (PBES2/AES-256 dos certificados ICP-Brasil recentes -> "Unsupported PKCS12
 * PFX data"), cai para o OpenSSL do sistema.
 */
function openPfx(pfxBuffer, senha) {
  if (!Buffer.isBuffer(pfxBuffer) || !pfxBuffer.length) throw new Error('Arquivo de certificado invalido.');
  var forgeErr = null;
  try {
    return openPfxForge(pfxBuffer, senha);
  } catch (e) {
    forgeErr = e;
    var msg = String((e && e.message) || e);
    if (/mac|password|senha/i.test(msg) && !/unsupported/i.test(msg)) {
      throw new Error('Senha do certificado incorreta ou arquivo .pfx invalido.');
    }
    console.warn('[NFE-CERT] node-forge nao leu o PFX (' + msg + '). Tentando via OpenSSL...');
  }

  var viaSsl;
  try {
    viaSsl = openPfxWithOpenssl(pfxBuffer, senha);
  } catch (e2) {
    throw new Error(String((e2 && e2.message) || e2) +
      ' (node-forge: ' + String((forgeErr && forgeErr.message) || forgeErr) + ')');
  }
  console.log('[NFE-CERT] PFX lido via OpenSSL' + (viaSsl.legacy ? ' (modo legacy)' : '') + '.');
  return {
    privateKeyPem: viaSsl.privateKeyPem,
    certPem: viaSsl.certPem,
    chainPem: viaSsl.chainPem,
    info: infoFromCertPem(viaSsl.certPem),
  };
}

/**
 * Salva o certificado (upload). Retorna as infos publicas do certificado.
 * @param {Buffer} pfxBuffer conteudo do .pfx
 * @param {string} senha senha do .pfx
 * @param {object} [opts] { emitente: CNPJ (14 digitos) — omitido/'' = slot legado (matriz) }
 */
function salvarCertificado(pfxBuffer, senha, opts) {
  if (!pfxBuffer || !pfxBuffer.length) throw new Error('Arquivo .pfx vazio.');
  if (!senha) throw new Error('Senha do certificado obrigatoria.');

  var aberto = openPfx(pfxBuffer, senha); // valida senha antes de persistir
  var emitCnpj = cnpjKey(opts && opts.emitente);
  var pfxPath = pfxPathFor(emitCnpj);
  var metaPath = metaPathFor(emitCnpj);

  fs.writeFileSync(pfxPath, pfxBuffer, { mode: 0o600 });
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      senha: encryptSenha(senha),
      info: aberto.info,
      emitente: emitCnpj || null,
      uploadEm: new Date().toISOString(),
    }),
    { mode: 0o600 }
  );

  var slot = {
    pfx: pfxBuffer,
    senha: String(senha),
    privateKeyPem: aberto.privateKeyPem,
    certPem: aberto.certPem,
    chainPem: aberto.chainPem,
    info: aberto.info,
  };
  if (emitCnpj) {
    cachesPorCnpj[emitCnpj] = slot;
    // Aviso importante: a SEFAZ valida o CNPJ do certificado contra o emitente da NF
    if (aberto.info.cnpj && aberto.info.cnpj !== emitCnpj) {
      console.warn('[NFE-CERT] ATENCAO: certificado tem CNPJ ' + aberto.info.cnpj +
        ' mas foi enviado para o emitente ' + emitCnpj + ' — a SEFAZ pode rejeitar (203/298).');
    }
  } else {
    cache = slot;
  }
  console.log('[NFE-CERT] Certificado A1 armazenado' + (emitCnpj ? ' p/ emitente ' + emitCnpj : ' (slot legado matriz)') +
    '. Titular: ' + aberto.info.titular +
    ' | CNPJ: ' + aberto.info.cnpj + ' | valido ate ' + aberto.info.validoAte);
  return aberto.info;
}

/** Carrega do cache/disco para UM emitente (CNPJ). Retorna null se nao houver. */
function carregarCertificadoPorCnpj(cnpj) {
  var k = cnpjKey(cnpj);
  if (!k) return null;
  if (cachesPorCnpj[k]) return cachesPorCnpj[k];

  try {
    var pfxPath = pfxPathFor(k);
    var metaPath = metaPathFor(k);
    if (fs.existsSync(pfxPath) && fs.existsSync(metaPath)) {
      var meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      var pfx = fs.readFileSync(pfxPath);
      var senha = decryptSenha(meta.senha);
      var aberto = openPfx(pfx, senha);
      cachesPorCnpj[k] = {
        pfx: pfx, senha: senha,
        privateKeyPem: aberto.privateKeyPem, certPem: aberto.certPem,
        chainPem: aberto.chainPem, info: aberto.info,
      };
      console.log('[NFE-CERT] Certificado carregado do disco p/ emitente ' + k + '. Titular: ' + aberto.info.titular);
      return cachesPorCnpj[k];
    }
  } catch (e) {
    console.error('[NFE-CERT] Falha ao ler certificado do emitente ' + k + ': ' + e.message);
  }
  return null;
}

/**
 * Carrega o certificado do cache, do disco ou das variaveis de ambiente.
 * Sem argumento = slot legado (matriz) — comportamento identico ao anterior.
 * Com CNPJ = cofre daquele emitente (null se nao configurado).
 */
function carregarCertificado(cnpj) {
  var k = cnpjKey(cnpj);
  if (k) return carregarCertificadoPorCnpj(k);

  if (cache) return cache;

  // 1) Variaveis de ambiente (PRIORIDADE — sobrevive a deploys/reinicios no Render)
  var b64 = process.env.NFE_CERT_PFX_BASE64;
  var envSenha = process.env.NFE_CERT_SENHA;
  if (b64 && envSenha) {
    try {
      console.log('[NFE-CERT] Carregando certificado das variaveis de ambiente (NFE_CERT_PFX_BASE64=' + b64.slice(0, 20) + '...)');
      var buf = Buffer.from(b64, 'base64');
      var ab = openPfx(buf, envSenha);
      cache = {
        pfx: buf, senha: envSenha,
        privateKeyPem: ab.privateKeyPem, certPem: ab.certPem,
        chainPem: ab.chainPem, info: ab.info,
      };
      console.log('[NFE-CERT] Certificado carregado via env vars. Titular: ' + ab.info.titular + ' | CNPJ: ' + ab.info.cnpj);
      return cache;
    } catch (e) {
      console.error('[NFE-CERT] Falha ao abrir certificado das env vars: ' + e.message);
    }
  }

  // 2) Disco (backup — pode ser perdido em reinicios no Render)
  try {
    var dir = ensureDir();
    var pfxPath = path.join(dir, PFX_FILE);
    var metaPath = path.join(dir, META_FILE);
    console.log('[NFE-CERT] Verificando disco: dir=' + dir + ' pfx=' + fs.existsSync(pfxPath) + ' meta=' + fs.existsSync(metaPath));
    if (fs.existsSync(pfxPath) && fs.existsSync(metaPath)) {
      var meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      var pfx = fs.readFileSync(pfxPath);
      var senha = decryptSenha(meta.senha);
      var aberto = openPfx(pfx, senha);
      cache = {
        pfx: pfx, senha: senha,
        privateKeyPem: aberto.privateKeyPem, certPem: aberto.certPem,
        chainPem: aberto.chainPem, info: aberto.info,
      };
      console.log('[NFE-CERT] Certificado carregado do disco. Titular: ' + aberto.info.titular);
      return cache;
    }
  } catch (e) {
    console.error('[NFE-CERT] Falha ao ler certificado do disco: ' + e.message);
  }

  console.warn('[NFE-CERT] Nenhum certificado encontrado. Defina NFE_CERT_PFX_BASE64 + NFE_CERT_SENHA nas env vars (recomendado) ou envie via POST /api/v1/nfe/certificado.');
  return null;
}

/**
 * Certificado do EMITENTE de uma NF-e, com fallback legado:
 * 1) cofre do CNPJ do emitente; 2) slot legado (matriz) — mantem compatibilidade
 * com deployments que so tem o certificado antigo (env vars / nfe-cert.pfx).
 */
function certificadoParaEmitente(cnpj, uf) {
  var k = cnpjKey(cnpj);
  var proprio = k ? carregarCertificadoPorCnpj(k) : null;
  if (proprio) return proprio;
  var legado = carregarCertificado(); // matriz/env
  if (legado) {
    var mesmoCnpj = legado.info && legado.info.cnpj === k;
    console.log('[NFE-CERT] Emitente ' + (k || '?') + ' sem cofre proprio — usando certificado ' +
      (mesmoCnpj ? 'correspondente' : 'LEGADO (' + (legado.info ? legado.info.cnpj : 's/ CNPJ') + ') — SEFAZ pode rejeitar se CNPJ divergir'));
    return legado;
  }
  return null;
}

function statusCertificado(cnpj) {
  var k = cnpjKey(cnpj);
  if (k) {
    var c2;
    try { c2 = carregarCertificadoPorCnpj(k); } catch (e2) {
      return { configurado: false, emitente: k, erro: e2.message };
    }
    if (!c2) return { configurado: false, emitente: k, mensagem: 'Nenhum certificado A1 carregado para o emitente ' + k + '.' };
    return Object.assign({ configurado: true, emitente: k }, c2.info);
  }
  var c;
  try { c = carregarCertificado(); } catch (e) {
    return { configurado: false, erro: e.message };
  }
  if (!c) return { configurado: false, mensagem: 'Nenhum certificado A1 carregado. Envie via POST /api/v1/nfe/certificado.' };
  return Object.assign({ configurado: true }, c.info);
}

/** Lista os emitentes com certificado no cofre (por CNPJ) + slot legado. */
function listarEmitentes() {
  var lista = [];
  var dir = ensureDir();
  try {
    var files = fs.readdirSync(dir);
    files.forEach(function (f) {
      var m = f.match(/^nfe-cert-(\d{14})\.pfx$/);
      if (!m) return;
      var st = statusCertificado(m[1]);
      st.emitente = m[1];
      lista.push(st);
    });
  } catch (e) { /* diretorio ainda nao existe */ }
  return lista;
}

function removerCertificado(cnpj) {
  var k = cnpjKey(cnpj);
  var dir = ensureDir();
  var files = k ? ['nfe-cert-' + k + '.pfx', 'nfe-cert-' + k + '.meta.json'] : [PFX_FILE, META_FILE];
  files.forEach(function (f) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ }
  });
  if (k) delete cachesPorCnpj[k]; else cache = null;
  return true;
}

// ============================================================
// LOGO do emitente (DANFE) — logo-<CNPJ>.png|jpg|jpeg
// ============================================================
function logoPathFor(cnpj) {
  var k = cnpjKey(cnpj) || 'default';
  var dir = ensureDir();
  for (var i = 0; i < LOGO_EXTS.length; i++) {
    var p = path.join(dir, 'logo-' + k + '.' + LOGO_EXTS[i]);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function salvarLogo(cnpj, buffer, nomeArquivo) {
  if (!buffer || !buffer.length) throw new Error('Arquivo de logo vazio.');
  var ext = String(nomeArquivo || '').toLowerCase().match(/\.(png|jpe?g)$/);
  ext = ext ? (ext[1] === 'jpeg' ? 'jpg' : ext[1]) : null;
  if (!ext) {
    // deduzir do conteudo
    var isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    var isJpg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    ext = isPng ? 'png' : (isJpg ? 'jpg' : null);
    if (!ext) throw new Error('Formato de logo nao suportado (use PNG ou JPG).');
  }
  var k = cnpjKey(cnpj) || 'default';
  var dir = ensureDir();
  // remove versoes antigas (outras extensoes)
  LOGO_EXTS.forEach(function (e2) {
    try { fs.unlinkSync(path.join(dir, 'logo-' + k + '.' + e2)); } catch (er) { /* ignore */ }
  });
  var dest = path.join(dir, 'logo-' + k + '.' + ext);
  fs.writeFileSync(dest, buffer);
  console.log('[NFE-CERT] Logo do emitente ' + k + ' armazenado (' + buffer.length + ' bytes): ' + dest);
  return { path: dest, bytes: buffer.length, formato: ext };
}

function removerLogo(cnpj) {
  var k = cnpjKey(cnpj) || 'default';
  var dir = ensureDir();
  LOGO_EXTS.forEach(function (e2) {
    try { fs.unlinkSync(path.join(dir, 'logo-' + k + '.' + e2)); } catch (er) { /* ignore */ }
  });
  return true;
}

module.exports = {
  salvarCertificado,
  carregarCertificado,
  carregarCertificadoPorCnpj,
  certificadoParaEmitente,
  statusCertificado,
  listarEmitentes,
  removerCertificado,
  logoPathFor,
  salvarLogo,
  removerLogo,
};
