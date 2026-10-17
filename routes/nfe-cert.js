/**
 * routes/nfe-cert.js — Certificado A1 e emissao propria na SEFAZ
 *
 * POST   /api/v1/nfe/certificado         — upload do .pfx (base64 + senha)
 * GET    /api/v1/nfe/certificado         — status do certificado carregado
 * DELETE /api/v1/nfe/certificado         — remove o certificado
 * GET    /api/v1/nfe/sefaz/status        — status do servico da SEFAZ (testa mTLS)
 * POST   /api/v1/nfe/danfe               — gera o DANFE PDF localmente a partir do XML
 */
var express = require('express');
var router = express.Router();
var { apiKeyAuth } = require('../middleware/auth');
var { salvarCertificado, statusCertificado, removerCertificado } = require('../services/nfe-cert');
var { statusServico } = require('../services/sefaz-client');
var { gerarDanfePdf } = require('../services/danfe-pdf');

// Upload do certificado A1 (protegido por API key)
router.post('/certificado', apiKeyAuth, express.json({ limit: '10mb' }), function (req, res) {
  try {
    var body = req.body || {};
    var b64 = body.pfxBase64 || body.pfx_base64 || body.certificado || body.arquivo;
    var senha = body.senha || body.password || body.pfxSenha;
    if (!b64) return res.status(400).json({ erro: 'Envie o arquivo .pfx em base64 no campo "pfxBase64".' });
    if (!senha) return res.status(400).json({ erro: 'Campo "senha" obrigatorio.' });

    var buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
    var info = salvarCertificado(buf, senha);
    res.json({ sucesso: true, mensagem: 'Certificado A1 armazenado com sucesso.', certificado: info });
  } catch (err) {
    console.error('[NFE-CERT] Erro no upload: ' + err.message);
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

router.get('/certificado', apiKeyAuth, function (req, res) {
  res.json(statusCertificado());
});

router.delete('/certificado', apiKeyAuth, function (req, res) {
  removerCertificado();
  res.json({ sucesso: true, mensagem: 'Certificado removido.' });
});

// Testa conexao mTLS com a SEFAZ usando o certificado carregado
router.get('/sefaz/status', apiKeyAuth, async function (req, res) {
  try {
    res.json(await statusServico());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Gera o DANFE PDF localmente (sem SIEG)
router.post('/danfe', apiKeyAuth, express.json({ limit: '10mb' }), async function (req, res) {
  try {
    var xml = req.body && (req.body.xml || (req.body.xmlBase64 ? Buffer.from(req.body.xmlBase64, 'base64').toString('utf8') : ''));
    if (!xml) return res.status(400).json({ erro: 'Informe "xml" (nfeProc autorizado) ou "xmlBase64".' });
    var pdf = await gerarDanfePdf(xml);
    if (req.query.base64 === '1') return res.json({ sucesso: true, pdfBase64: pdf.toString('base64') });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="danfe.pdf"');
    res.send(pdf);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// Painel HTML simples para enviar o certificado sem usar terminal
router.get('/painel', function (req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PAINEL_HTML);
});

var PAINEL_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Certificado A1 - NF-e | Middleware AJL</title>
<style>
 :root{color-scheme:light}
 body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f8;margin:0;padding:24px;color:#1c2430}
 .card{max-width:620px;margin:0 auto 18px;background:#fff;border:1px solid #dde3ea;border-radius:12px;padding:22px}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:0 0 14px}
 p.sub{color:#5b6875;margin:0 0 18px;font-size:14px}
 label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
 input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd4de;border-radius:8px;font-size:14px}
 button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#12508f;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 button.sec{background:#5b6875;margin-top:10px}
 button:disabled{opacity:.6;cursor:progress}
 pre{background:#0f172a;color:#d7e3f4;padding:14px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
 .ok{color:#0a7a41;font-weight:600}.err{color:#b3261e;font-weight:600}
</style></head><body>
<div class="card">
  <h1>Certificado Digital A1 - NF-e</h1>
  <p class="sub">Envie o arquivo <b>.pfx</b> da AJL e a senha. O arquivo vai direto para o servidor por HTTPS e a senha fica criptografada em disco.</p>
  <label>API Key (a mesma que o Odoo usa)</label>
  <input id="key" type="password" placeholder="x-api-key" autocomplete="off">
  <label>Arquivo do certificado (.pfx ou .p12)</label>
  <input id="pfx" type="file" accept=".pfx,.p12">
  <label>Senha do certificado</label>
  <input id="senha" type="password" placeholder="senha do .pfx" autocomplete="off">
  <button id="btnEnviar">Enviar certificado</button>
  <button id="btnStatus" class="sec">Ver certificado atual</button>
  <button id="btnSefaz" class="sec">Testar conexao com a SEFAZ</button>
</div>
<div class="card"><h2>Resultado</h2><pre id="out">Aguardando...</pre></div>
<script>
 var out=document.getElementById('out');
 function key(){var k=document.getElementById('key').value.trim();if(!k){show('Informe a API Key.',true);}return k;}
 function show(t,erro){out.textContent=typeof t==='string'?t:JSON.stringify(t,null,2);out.className=erro?'err':'';}
 async function call(m,p,body){
   var r=await fetch(p,{method:m,headers:{'x-api-key':key(),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
   var j=await r.json().catch(function(){return{erro:'resposta invalida'}});
   show('HTTP '+r.status+'\\n'+JSON.stringify(j,null,2), !r.ok); return j;
 }
 document.getElementById('btnStatus').onclick=function(){if(key())call('GET','/api/v1/nfe/certificado');};
 document.getElementById('btnSefaz').onclick=function(){if(key()){show('Consultando a SEFAZ...');call('GET','/api/v1/nfe/sefaz/status');}};
 document.getElementById('btnEnviar').onclick=function(){
   var f=document.getElementById('pfx').files[0], s=document.getElementById('senha').value;
   if(!key())return; if(!f)return show('Selecione o arquivo .pfx.',true); if(!s)return show('Informe a senha.',true);
   var b=this; b.disabled=true; show('Enviando...');
   var fr=new FileReader();
   fr.onload=function(){
     var b64=String(fr.result).split(',')[1];
     call('POST','/api/v1/nfe/certificado',{pfxBase64:b64,senha:s}).finally(function(){b.disabled=false;});
   };
   fr.readAsDataURL(f);
 };
</script></body></html>`;

module.exports = router;
