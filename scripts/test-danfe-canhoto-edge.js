// Teste edge: canhoto com nome de cliente LONGO (ellipsis) e NF sem nome de dest
var fs = require('fs');
var gerarDanfePdf = require('../services/danfe-pdf').gerarDanfePdf;

var base = fs.readFileSync('/home/z/my-project/repos/API-Odoo/scripts/test-danfe-layout-v3.js', 'utf8');
var xmlBase = base.match(/var NFE = `([\s\S]*?)`;/)[1];

// Caso 1: nome MUITO longo (deve truncar com ellipsis sem quebrar o box)
var xmlLongo = xmlBase.replace(
  '<xNome>CLIENTE TESTE LTDA</xNome>',
  '<xNome>CONSTRUTORA MARAVILHA ENGENHARIA E EMPREENDIMENTOS IMOBILIARIOS DO SUDOESTE PARANAENSE LTDA - FILIAL 47</xNome>'
);

// Caso 2: sem xNome no dest (fallback '-')
var xmlSemNome = xmlBase.replace('<xNome>CLIENTE TESTE LTDA</xNome>', '');

(async function () {
  var p1 = '/home/z/my-project/download/danfe_canhoto_nome_longo.pdf';
  var p2 = '/home/z/my-project/download/danfe_canhoto_sem_nome.pdf';
  fs.writeFileSync(p1, await gerarDanfePdf(xmlLongo, {}));
  fs.writeFileSync(p2, await gerarDanfePdf(xmlSemNome, {}));
  console.log('OK ->', p1, 'e', p2);
})().catch(function (e) { console.error('ERRO:', e.message); process.exit(1); });
