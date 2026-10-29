/**
 * Teste local do DANFE v2.1 — VALOR TOTAL junto ao canhoto.
 * Uso: node scripts/test-danfe-v21.js <xml> <saida.pdf>
 */
var fs = require('fs');
var path = require('path');
var { gerarDanfePdf } = require('../services/danfe-pdf');

(async function () {
  var xmlPath = process.argv[2] || path.join(__dirname, '..', 'scripts', 'nfe_00073287.xml');
  var outPath = process.argv[3] || path.join(__dirname, 'danfe_teste_v21.pdf');
  var xml = fs.readFileSync(xmlPath, 'utf8');
  var pdf = await gerarDanfePdf(xml, { saleOrderNumber: 'S00000' });
  fs.writeFileSync(outPath, pdf);
  console.log('PDF gerado:', outPath, '(' + pdf.length + ' bytes)');
})().catch(function (e) { console.error('ERRO:', e.message); process.exit(1); });
