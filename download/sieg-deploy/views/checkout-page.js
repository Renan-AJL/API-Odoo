// ============================================
// PAGINA DE CHECKOUT DE CARTAO (HTML)
// ============================================
// Retorna HTML da pagina de pagamento hospedada

function buildInstallments(valor, maxParcelas) {
  var html = '';
  for (var i = 1; i <= (maxParcelas || 1); i++) {
    var val = (valor / i).toFixed(2).replace('.', ',');
    html += '<option value="' + i + '">' + i + 'x de R$ ' + val + (i === 1 ? ' (a vista)' : '') + '</option>';
  }
  return html;
}

function checkoutHtml(order) {
  return '<!DOCTYPE html>' +
'<html lang="pt-BR">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>Pagamento - ' + (order.descricao || '') + '</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}' +
'.card{background:#fff;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,.1);max-width:440px;width:100%;overflow:hidden}' +
'.header{background:#EC7000;color:#fff;padding:24px;text-align:center}' +
'.header h1{font-size:20px;font-weight:600;margin-bottom:4px}' +
'.header p{font-size:13px;opacity:.9}' +
'.amount{font-size:32px;font-weight:700;margin:20px 0;text-align:center;color:#222}' +
'.amount span{font-size:16px;color:#666}' +
'.form{padding:0 24px 24px}' +
'.field{margin-bottom:16px}' +
'.field label{display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}' +
'.field input,.field select{width:100%;padding:12px 14px;border:2px solid #e0e0e0;border-radius:8px;font-size:15px;transition:border-color .2s;outline:none;background:#fafafa}' +
'.field input:focus,.field select:focus{border-color:#EC7000;background:#fff}' +
'.row{display:flex;gap:12px}' +
'.row .field{flex:1}' +
'.btn-pay{width:100%;padding:16px;background:#EC7000;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s;margin-top:8px}' +
'.btn-pay:hover{background:#d46200}' +
'.btn-pay:disabled{background:#ccc;cursor:not-allowed}' +
'.msg{text-align:center;padding:20px 24px;font-size:14px}' +
'.msg.ok{color:#2e7d32}' +
'.msg.err{color:#c62828}' +
'.footer{text-align:center;padding:16px;font-size:11px;color:#999;border-top:1px solid #eee}' +
'.loading{display:inline-block;width:20px;height:20px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;margin-right:8px;vertical-align:middle}' +
'@keyframes spin{to{transform:rotate(360deg)}}' +
'</style>' +
'</head>' +
'<body>' +
'<div class="card">' +
'<div class="header"><h1>' + (order.descricao || 'Pagamento') + '</h1><p>Pagamento seguro via Rede</p></div>' +
'<div class="amount">R$ ' + order.valor.toFixed(2).replace('.', ',') + '<br><span>' + (order.maxParcelas > 1 ? 'em ate ' + order.maxParcelas + 'x sem juros' : '') + '</span></div>' +
(order.status === 'pago'
  ? '<div class="msg ok"><h2>Pagamento Confirmado!</h2><p>TID: ' + ((order.resultado && order.resultado.tid) || '') + '<br>NSU: ' + ((order.resultado && order.resultado.nsu) || '') + '</p></div>'
  : order.status === 'negado'
  ? '<div class="msg err"><h2>Nao Aprovado</h2><p>' + ((order.resultado && order.resultado.returnMessage) || 'Tente novamente') + '</p></div>'
  : '<form id="payForm" onsubmit="pagar(event)"><div class="form">' +
    '<div class="field"><label>Numero do Cartao</label><input type="text" id="cardNumber" placeholder="0000 0000 0000 0000" maxlength="19" required></div>' +
    '<div class="field"><label>Nome no Cartao</label><input type="text" id="cardHolder" placeholder="Como esta no cartao" required></div>' +
    '<div class="row"><div class="field"><label>Validade</label><input type="text" id="cardExpiry" placeholder="MM/AA" maxlength="5" required></div>' +
    '<div class="field"><label>CVV</label><input type="text" id="cardCvv" placeholder="000" maxlength="4" required></div></div>' +
    '<div class="field"><label>Parcelas</label><select id="installments">' + buildInstallments(order.valor, order.maxParcelas) + '</select></div>' +
    '<button type="submit" class="btn-pay" id="btnPay">Pagar Agora</button>' +
    '</div></form>') +
'<div class="footer">AJL Ferro e Aco &middot; Pagamento processado pela Rede/Itau</div>' +
'</div>' +
'<script>' +
'function fc(el){var v=el.value.replace(/\\D/g,"").substring(0,16);el.value=v.replace(/(\\d{4})(?=\\d)/g,"$1 ");}' +
'function fe(el){var v=el.value.replace(/\\D/g,"").substring(0,4);if(v.length>=3)v=v.substring(0,2)+"/"+v.substring(2);el.value=v;}' +
'document.getElementById("cardNumber").addEventListener("input",function(){fc(this)});' +
'document.getElementById("cardExpiry").addEventListener("input",function(){fe(this)});' +
'async function pagar(e){e.preventDefault();var btn=document.getElementById("btnPay");btn.disabled=true;btn.innerHTML="<span class=\\"loading\\"></span>Processando...";' +
'try{var num=document.getElementById("cardNumber").value.replace(/\\D/g,"");' +
'var exp=document.getElementById("cardExpiry").value.split("/");' +
'var r=await fetch("/api/v1/itau/checkout/' + order.id + '/pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({numero:num,titular:document.getElementById("cardHolder").value.toUpperCase(),validade_mes:exp[0],validade_ano:exp[1],cvv:document.getElementById("cardCvv").value,parcelas:document.getElementById("installments").value})});' +
'var d=await r.json();if(d.autorizado){document.querySelector(".card").innerHTML="<div class=\\"header\\"><h1>Pagamento Confirmado!</h1></div><div class=\\"msg ok\\"><h2>Aprovado</h2><p>TID: "+(d.tid||"")+"<br>NSU: "+(d.nsu||"")+"<br>Cod: "+(d.authorizationCode||"")+"</p></div><div class=\\"footer\\">AJL Ferro e Aco</div>"}' +
'else{document.querySelector(".card").innerHTML="<div class=\\"header\\"><h1>Nao Aprovado</h1></div><div class=\\"msg err\\"><h2>Recusado</h2><p>"+(d.returnMessage||"Tente novamente")+"</p></div><div class=\\"footer\\">AJL Ferro e Aco</div>"}}' +
'catch(err){btn.disabled=false;btn.textContent="Pagar Agora";alert("Erro de conexao. Tente novamente.")}}' +
'</script></body></html>';
}

module.exports = { checkoutHtml, buildInstallments };