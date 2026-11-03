/**
 * routes/nfe-cert.js — Certificado A1 e emissao propria na SEFAZ (MULTI-EMITENTE)
 * ================================================================================
 * AJL 04/11/2026 (demanda Transferência entre Filiais): o painel ganhou ABAS —
 *   aba "AJL Curitiba (Matriz)"        -> CNPJ 22603750000190
 *   aba "AJL Florianópolis (Filial)"   -> CNPJ 22603750000514
 * Cada aba guarda o SEU .pfx + senha + LOGO (usado no DANFE).
 *
 * Rotas:
 *   GET    /api/v1/nfe/painel                  — painel HTML (abas)
 *   POST   /api/v1/nfe/certificado             — upload do .pfx (base64 + senha [+ emitente])
 *   GET    /api/v1/nfe/certificado?emitente=   — status do certificado (por emitente ou legado)
 *   DELETE /api/v1/nfe/certificado?emitente=   — remove o certificado
 *   GET    /api/v1/nfe/emitentes               — status de TODOS os emitentes (painel)
 *   POST   /api/v1/nfe/logo                    — upload do logo { emitente, logoBase64, nomeArquivo }
 *   GET    /api/v1/nfe/logo?emitente=          — status do logo
 *   DELETE /api/v1/nfe/logo?emitente=          — remove o logo
 *   GET    /api/v1/nfe/sefaz/status?uf=        — status do servico da SEFAZ (testa mTLS)
 *   POST   /api/v1/nfe/danfe                   — gera o DANFE PDF localmente a partir do XML
 *   POST   /api/v1/nfe/consultar-chave         — consulta situacao de uma NF-e pela chave
 *   POST   /api/v1/nfe/cancelar-chave          — cancelamento direto por chave
 */
var express = require('express');
var router = express.Router();
var { apiKeyAuth } = require('../middleware/auth');
var config = require('../config');
var {
  salvarCertificado, statusCertificado, removerCertificado,
  listarEmitentes, salvarLogo, removerLogo, logoPathFor,
} = require('../services/nfe-cert');
var { statusServico, consultarChave } = require('../services/sefaz-client');
var { gerarDanfePdf } = require('../services/danfe-pdf');

var fs = require('fs');

/** Resolve o emitente informado (id 'matriz'/'florianopolis' ou CNPJ) -> CNPJ 14d ('' = matriz legado). */
function resolveEmitente(v) {
  var s = String(v || '').trim();
  if (!s) return { cnpj: '', nome: 'Matriz (padrão)' };
  var ems = config.nfeEmitentes || {};
  if (ems[s]) return { cnpj: ems[s].cnpj, nome: ems[s].nome };
  var byCnpj = Object.keys(ems).filter(function (k) { return ems[k].cnpj === s.replace(/\D/g, ''); });
  if (byCnpj.length) return { cnpj: ems[byCnpj[0]].cnpj, nome: ems[byCnpj[0]].nome };
  var digits = s.replace(/\D/g, '');
  if (digits.length === 14) return { cnpj: digits, nome: 'CNPJ ' + digits };
  throw new Error('emitente invalido: "' + s + '" (use matriz | florianopolis | CNPJ de 14 digitos)');
}

// Upload do certificado A1 (protegido por API key)
router.post('/certificado', apiKeyAuth, express.json({ limit: '10mb' }), function (req, res) {
  try {
    var body = req.body || {};
    var b64 = body.pfxBase64 || body.pfx_base64 || body.certificado || body.arquivo;
    var senha = body.senha || body.password || body.pfxSenha;
    var emitente;
    try { emitente = resolveEmitente(body.emitente || body.empresa); } catch (eE) {
      return res.status(400).json({ sucesso: false, erro: eE.message });
    }
    if (!b64) return res.status(400).json({ erro: 'Envie o arquivo .pfx em base64 no campo "pfxBase64".' });
    if (!senha) return res.status(400).json({ erro: 'Campo "senha" obrigatorio.' });

    var buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
    var info = salvarCertificado(buf, senha, { emitente: emitente.cnpj });
    res.json({
      sucesso: true,
      mensagem: 'Certificado A1 armazenado com sucesso para ' + emitente.nome + '.',
      emitente: emitente,
      certificado: info,
    });
  } catch (err) {
    console.error('[NFE-CERT] Erro no upload: ' + err.message);
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

router.get('/certificado', apiKeyAuth, function (req, res) {
  try {
    var emitente = resolveEmitente(req.query.emitente);
    var st = statusCertificado(emitente.cnpj);
    st.emitenteNome = emitente.nome;
    res.json(st);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.delete('/certificado', apiKeyAuth, function (req, res) {
  try {
    var emitente = resolveEmitente(req.query.emitente || (req.body || {}).emitente);
    removerCertificado(emitente.cnpj);
    res.json({ sucesso: true, mensagem: 'Certificado removido (' + emitente.nome + ').' });
  } catch (err) {
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

// Status de TODOS os emitentes (o painel usa para pintar as abas)
router.get('/emitentes', apiKeyAuth, function (req, res) {
  var ems = config.nfeEmitentes || {};
  var lista = Object.keys(ems).map(function (k) {
    var st = statusCertificado(ems[k].cnpj);
    return {
      id: ems[k].id,
      cnpj: ems[k].cnpj,
      nome: ems[k].nome,
      razao: ems[k].razao,
      certificado: st,
      logo: !!logoPathFor(ems[k].cnpj),
    };
  });
  res.json({ sucesso: true, emitentes: lista });
});

// ============================================================
// LOGO do emitente (usado no DANFE)
// ============================================================
router.post('/logo', apiKeyAuth, express.json({ limit: '6mb' }), function (req, res) {
  try {
    var body = req.body || {};
    var emitente = resolveEmitente(body.emitente || body.empresa);
    var b64 = body.logoBase64 || body.logo_base64 || body.logo || body.imagem;
    if (!b64) return res.status(400).json({ sucesso: false, erro: 'Envie a imagem em base64 no campo "logoBase64".' });
    var buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
    var out = salvarLogo(emitente.cnpj, buf, body.nomeArquivo || body.nome_arquivo || '');
    res.json({ sucesso: true, mensagem: 'Logo armazenado para ' + emitente.nome + '.', logo: out });
  } catch (err) {
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

router.get('/logo', apiKeyAuth, function (req, res) {
  try {
    var emitente = resolveEmitente(req.query.emitente);
    var p = logoPathFor(emitente.cnpj);
    if (!p) return res.json({ sucesso: true, configurado: false, emitente: emitente.nome });
    var stt = fs.statSync(p);
    res.json({ sucesso: true, configurado: true, emitente: emitente.nome, arquivo: p, bytes: stt.size });
  } catch (err) {
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

router.delete('/logo', apiKeyAuth, function (req, res) {
  try {
    var emitente = resolveEmitente(req.query.emitente || (req.body || {}).emitente);
    removerLogo(emitente.cnpj);
    res.json({ sucesso: true, mensagem: 'Logo removido (' + emitente.nome + ').' });
  } catch (err) {
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

// AJL 21/10/2026: consulta a situacao de uma NF-e pela CHAVE de acesso
// (NFeConsultaProtocolo4). Usado para adotar NFs autorizadas na SEFAZ que
// nao foram registradas no Odoo (falha de escrita) — ex: rejeicao 539.
// POST /api/v1/nfe/consultar-chave  body: { "chave": "44digitos" }
router.post('/consultar-chave', apiKeyAuth, async function (req, res) {
  try {
    var chave = String((req.body || {}).chave || '').replace(/\D/g, '');
    if (chave.length !== 44) {
      return res.status(400).json({ sucesso: false, erro: 'Chave deve ter 44 digitos (recebido: ' + chave.length + ').' });
    }
    var r = await consultarChave(chave);
    res.json({ sucesso: true, chave: chave, resultado: r });
  } catch (err) {
    console.error('[NFE-CERT] Erro consultar-chave: ' + err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// AJL 22/10/2026: CANCELAMENTO DIRETO POR CHAVE (sem fatura no Odoo).
// Usado para limpar NFs DUPLICADAS autorizadas por corrida de processamento
// (ex: incidente 21/10/2026 — fatura 269 autorizou 3x: NFs 72962/63/64; as
// duplicatas ficam orfas, sem fatura para o botao "Cancelar NF-e" do Odoo).
// POST /api/v1/nfe/cancelar-chave  body: { chave, protocolo, cnpj?, justificativa? }
router.post('/cancelar-chave', apiKeyAuth, async function (req, res) {
  try {
    var body = req.body || {};
    var chave = String(body.chave || '').replace(/\D/g, '');
    if (chave.length !== 44) {
      return res.status(400).json({ sucesso: false, erro: 'Chave deve ter 44 digitos (recebido: ' + chave.length + ').' });
    }
    var cancelarNFe = require('../services/nfe-cancelamento').cancelarNFe;
    var resultado = await cancelarNFe({
      chave: chave,
      protocolo: String(body.protocolo || ''),
      cnpj: String(body.cnpj || ''),
      justificativa: String(body.justificativa || 'Cancelamento de NF-e emitida em duplicidade'),
    });
    console.log('[NFE-CERT] cancelar-chave ' + chave.slice(-10) + ' -> ' + JSON.stringify(resultado).slice(0, 300));
    res.json(resultado);
  } catch (err) {
    console.error('[NFE-CERT] Erro cancelar-chave: ' + err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// Testa conexao mTLS com a SEFAZ usando o certificado carregado.
// ?emitente= usa o cofre daquele emitente; ?uf= testa outra autorizadora (SC, PR, ...).
router.get('/sefaz/status', apiKeyAuth, async function (req, res) {
  try {
    var emitente = resolveEmitente(req.query.emitente);
    var uf = String(req.query.uf || '').toUpperCase() || undefined;
    res.json(await statusServico({ emitenteCnpj: emitente.cnpj, emitenteNome: emitente.nome, uf: uf }));
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

// Painel HTML com ABAS por emitente (matriz + filial) — certificado, senha e logo
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
 .card{max-width:680px;margin:0 auto 18px;background:#fff;border:1px solid #dde3ea;border-radius:12px;padding:22px}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:0 0 14px}
 p.sub{color:#5b6875;margin:0 0 18px;font-size:14px}
 .tabs{display:flex;gap:8px;margin-bottom:16px}
 .tab{flex:1;padding:12px 10px;border:1px solid #cbd4de;border-radius:10px;background:#f8fafc;cursor:pointer;text-align:center;font-size:13px;font-weight:600;color:#5b6875}
 .tab.active{background:#12508f;color:#fff;border-color:#12508f}
 .tab small{display:block;font-weight:400;font-size:11px;margin-top:3px;opacity:.85}
 .statusdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
 .ok{color:#0a7a41;font-weight:600}.err{color:#b3261e;font-weight:600}
 label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
 input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd4de;border-radius:8px;font-size:14px}
 button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#12508f;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 button.sec{background:#5b6875;margin-top:10px}
 button.danger{background:#b3261e}
 button:disabled{opacity:.6;cursor:progress}
 pre{background:#0f172a;color:#d7e3f4;padding:14px;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
 .hidden{display:none}
</style></head><body>
<div class="card">
  <h1>Certificado Digital A1 - NF-e</h1>
  <p class="sub">Envie o arquivo <b>.pfx</b> de cada empresa do grupo AJL e a senha. O arquivo vai direto para o servidor por HTTPS e a senha fica criptografada em disco. O <b>logo</b> (PNG/JPG) aparece no DANFE de cada emitente.</p>
  <div class="tabs" id="tabs"></div>

  <div id="formArea">
    <label>API Key (a mesma que o Odoo usa)</label>
    <input id="key" type="password" placeholder="x-api-key" autocomplete="off">
    <label id="lblCert">Arquivo do certificado (.pfx ou .p12)</label>
    <input id="pfx" type="file" accept=".pfx,.p12">
    <label>Senha do certificado</label>
    <input id="senha" type="password" placeholder="senha do .pfx" autocomplete="off">
    <label id="lblLogo">Logo do emitente (PNG ou JPG — opcional, sai no DANFE)</label>
    <input id="logo" type="file" accept=".png,.jpg,.jpeg">
    <button id="btnEnviar">Enviar certificado</button>
    <button id="btnLogo" class="sec">Enviar logo</button>
    <button id="btnStatus" class="sec">Ver certificado desta aba</button>
    <button id="btnSefaz" class="sec">Testar conexao com a SEFAZ (cert desta aba)</button>
    <button id="btnRemover" class="sec danger">Remover certificado desta aba</button>
  </div>
</div>
<div class="card"><h2>Resultado</h2><pre id="out">Aguardando...</pre></div>
<script>
 var EMITENTES = [
   {id:'matriz', nome:'AJL Curitiba (Matriz)', cnpj:'22603750000190'},
   {id:'florianopolis', nome:'AJL Florianópolis (Filial)', cnpj:'22603750000514'}
 ];
 var atual = 'matriz';
 var tabsEl = document.getElementById('tabs');
 EMITENTES.forEach(function(e){
   var d=document.createElement('div');
   d.className='tab'+(e.id===atual?' active':'');
   d.id='tab-'+e.id;
   d.innerHTML=e.nome+'<small>'+e.cnpj.replace(/(\\d{2})(\\d{3})(\\d{3})(\\d{4})(\\d{2})/,'$1.$2.$3/$4-$5')+' · <span id="dot-'+e.id+'">…</span></small>';
   d.onclick=function(){atual=e.id;EMITENTES.forEach(function(x){document.getElementById('tab-'+x.id).classList.toggle('active',x.id===atual);});verificar();};
   tabsEl.appendChild(d);
 });
 var out=document.getElementById('out');
 function key(){var k=document.getElementById('key').value.trim();if(!k){show('Informe a API Key.',true);}return k;}
 function show(t,erro){out.textContent=typeof t==='string'?t:JSON.stringify(t,null,2);out.className=erro?'err':'';}
 async function call(m,p,body){
   var r=await fetch(p,{method:m,headers:{'x-api-key':key(),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
   var j=await r.json().catch(function(){return{erro:'resposta invalida'}});
   show('HTTP '+r.status+'\\n'+JSON.stringify(j,null,2), !r.ok); return j;
 }
 async function verificar(){
   if(!key())return;
   show('Verificando '+atual+'...');
   var st=await call('GET','/api/v1/nfe/certificado?emitente='+atual).catch(function(){return null;});
   var dot=document.getElementById('dot-'+atual);
   if(st&&st.configurado){dot.innerHTML='<span class="statusdot ok" style="background:#0a7a41"></span>OK';}
   else{dot.innerHTML='<span class="statusdot" style="background:#b3261e"></span>falta cert';}
 }
 document.getElementById('btnStatus').onclick=function(){if(key())verificar(true);};
 document.getElementById('btnSefaz').onclick=function(){if(key()){show('Consultando a SEFAZ...');call('GET','/api/v1/nfe/sefaz/status?emitente='+atual);}};
 document.getElementById('btnRemover').onclick=function(){if(!key())return;if(!confirm('Remover o certificado de '+atual+'?'))return;call('DELETE','/api/v1/nfe/certificado?emitente='+atual).then(verificar);};
 document.getElementById('btnEnviar').onclick=function(){
   var f=document.getElementById('pfx').files[0], s=document.getElementById('senha').value;
   if(!key())return; if(!f)return show('Selecione o arquivo .pfx.',true); if(!s)return show('Informe a senha.',true);
   var b=this; b.disabled=true; show('Enviando certificado de '+atual+'...');
   var fr=new FileReader();
   fr.onload=function(){
     var b64=String(fr.result).split(',')[1];
     call('POST','/api/v1/nfe/certificado',{pfxBase64:b64,senha:s,emitente:atual}).then(verificar).finally(function(){b.disabled=false;});
   };
   fr.readAsDataURL(f);
 };
 document.getElementById('btnLogo').onclick=function(){
   var f=document.getElementById('logo').files[0];
   if(!key())return; if(!f)return show('Selecione o logo (PNG/JPG).',true);
   var b=this; b.disabled=true; show('Enviando logo de '+atual+'...');
   var fr=new FileReader();
   fr.onload=function(){
     var b64=String(fr.result).split(',')[1];
     call('POST','/api/v1/nfe/logo',{logoBase64:b64,nomeArquivo:f.name,emitente:atual}).finally(function(){b.disabled=false;});
   };
   fr.readAsDataURL(f);
 };
</script></body></html>`;

module.exports = router;
