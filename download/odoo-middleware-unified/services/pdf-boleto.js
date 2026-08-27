/**
 * services/pdf-boleto.js - v7.0 Layout Itau AJL
 * =============================================
 * Layout IDENTICO ao boleto padrao Itau usado pela AJL
 * Baseado no PDF de referencia: Bol341-4-109-51773.pdf
 * - Celulas com fundo branco e borda cinza (0.5pt)
 * - Logo Itau real (arquivo PNG)
 * - 341-7 em 18pt bold | Linha digitavel em 12pt bold
 * - Nosso numero: 109/XXXXXXXX-Y (com DV)
 * - Instrucoes padrao (juros, multa, Serasa)
 * - Codigo de barras Code128
 * - QR Code PIX + Copia e Cola (quando disponivel)
 * - bwip-js callback-based
 * =============================================
 */
var PDFDocument = require('pdfkit');
var bwipjs = null;
try { bwipjs = require('bwip-js'); } catch (e) { console.log('[PDF] bwip-js N/D'); }
var fs = require('fs');
var path = require('path');

/* === STORAGE === */
var store = new Map();
var nnMap = new Map();

function storeBoleto(txid, dados) {
  store.set(txid, Object.assign({}, dados, { ts: Date.now() }));
  if (dados.nosso_numero) {
    nnMap.set(dados.nosso_numero, txid);
  }
}

function getBoleto(txid) {
  return store.get(txid) || null;
}

function getTxidByNn(nossoNumero) {
  return nnMap.get(nossoNumero) || null;
}

/* === FORMATADORES === */

function formatCnpj(v) {
  var s = String(v || '').replace(/\D/g, '');
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return v || '';
}

function fmtData(d) {
  if (!d) return '';
  var p = d.split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
}

function fmtValor(v) {
  var s = String(v || '0').padStart(15, '0');
  var c = parseInt(s.slice(-2), 10);
  var r = parseInt(s.slice(0, -2), 10);
  var val = (r + c / 100).toFixed(2);
  var parts = val.split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + parts[1];
}

function fmtValorDecimal(v) {
  // Formata valor decimal (ex: 4882.06 -> "4.882,06")
  var n = parseFloat(v) || 0;
  var val = n.toFixed(2);
  var parts = val.split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + parts[1];
}

// Formata nosso numero com carteira e DV: 109/00051773-0
function calcDvNN(nn) {
  var s = String(nn).padStart(8, '0');
  var weights = [2, 3, 4, 5, 6, 7, 8, 9];
  var sum = 0;
  for (var i = 0; i < 8 && i < s.length; i++) {
    sum += parseInt(s[i]) * weights[i];
  }
  var dv = 11 - (sum % 11);
  if (dv === 10 || dv === 11) dv = 0;
  return dv;
}

function formatNN(nn, carteira) {
  var c = carteira || '109';
  var s = String(nn).padStart(8, '0');
  var dv = calcDvNN(s);
  return c + '/' + s + '-' + dv;
}

// Formata agencia/codigo: 7764/22338-9
function formatAgCodigo(ag, idBen) {
  var a = ag || '7764';
  var id = idBen || '776400223389';
  // Remove prefixo da agencia (primeiros 4 digitos)
  var code = id.substring(4);
  // Remove zeros a esquerda
  code = code.replace(/^0+/, '') || '0';
  // Insere hifen antes do ULTIMO digito: 223389 -> 22338-9
  if (code.length >= 2) {
    code = code.substring(0, code.length - 1) + '-' + code.substring(code.length - 1);
  }
  return a + '/' + code;
}

// Formata linha digitavel com pontos e espacos (estilo Itau)
// Input: 47-digit string ou ja formatada
function fmtLinhaDigitavel(ld) {
  if (!ld) return '';
  var s = String(ld).replace(/\s/g, '').replace(/\./g, '');
  if (s.length >= 47) {
    return s.substring(0, 5) + '.' + s.substring(5, 10) + ' ' +
           s.substring(10, 15) + '.' + s.substring(15, 21) + ' ' +
           s.substring(21, 26) + '.' + s.substring(26, 32) + ' ' +
           s.substring(32, 33) + ' ' + s.substring(33);
  }
  return ld;
}

// Gera instrucoes padrao com juros e multa
function getInstrucoes(valorTitulo) {
  var vt = String(valorTitulo || '0').padStart(15, '0');
  var cents = parseInt(vt.slice(-2), 10);
  var reais = parseInt(vt.slice(0, -2), 10);
  var val = reais + cents / 100;
  // Juros: 0.03% ao dia sobre o valor
  var juros = (val * 0.0003).toFixed(2).replace('.', ',');
  // Multa: 2% do valor
  var multa = (val * 0.02).toFixed(2).replace('.', ',');
  return [
    'APOS O VENCIMENTO COBRAR JUROS DE..........R$ ' + juros + ' AO DIA',
    'APOS O VENCIMENTO COBRAR MULTA DE..........R$ ' + multa,
    'Sujeito a inclusao no Serasa no 8 dias apos o vencimento.'
  ];
}

/* === LOGO === */
var logoBuf = null;
var LOGO_LOADED = false;
try {
  var logoP = path.join(__dirname, '..', 'assets', 'logo-itau.png');
  if (fs.existsSync(logoP)) {
    logoBuf = fs.readFileSync(logoP);
    LOGO_LOADED = true;
    console.log('[PDF] Logo Itau carregado:', logoP);
  }
} catch (e) {
  console.log('[PDF] Logo N/D:', e.message);
}

/* === BARCODE / QR CODE === */

function genBarcode(text) {
  return new Promise(function (resolve) {
    if (!bwipjs) { resolve(null); return; }
    bwipjs.toBuffer({ bcid: 'code128', text: text, scale: 3, height: 20, includetext: false }, function (err, buf) {
      resolve(err ? null : buf);
    });
  });
}

function genQRCode(text) {
  return new Promise(function (resolve) {
    if (!bwipjs) { resolve(null); return; }
    bwipjs.toBuffer({ bcid: 'qrcode', text: text, scale: 5, includetext: false }, function (err, buf) {
      resolve(err ? null : buf);
    });
  });
}

/* === CONSTANTES DE LAYOUT (pontos, baseado no PDF de referencia) === */
var LM = 27;          // Left margin
var PW = 542;         // Page width (27 to 569)
var RM = LM + PW;     // Right margin (569)
var RH = 11;          // Cell row height
var BOX_H = 27;       // Header box height
var CELL_GAP = 6;     // Gap between cells in same row
var LABEL_GAP = 1.5;  // Gap between label bottom and cell top (padrao ~7.5pt total com label de 6pt)
var LC = '#808080';   // Cell border color (cinza)
var LW = 0.5;         // Cell border width
var FL = 6;            // Label font size
var FV = 8;            // Value font size

/* === FUNCOES AUXILIARES DE DESENHO === */

// Desenha celula (retangulo com borda cinza)
function drawCell(doc, x, y, w, h) {
  doc.rect(x, y, w, h).lineWidth(LW).stroke(LC);
}

// Desenha label (texto 6pt)
function drawLabel(doc, x, y, text, maxW) {
  doc.fillColor('#333').fontSize(FL).font('Helvetica');
  doc.text(text, x, y, { width: maxW || 200, lineBreak: false });
}

// Desenha valor dentro de celula (texto 8pt)
function drawVal(doc, x, y, w, text, opts) {
  var sz = (opts && opts.size) || FV;
  var bold = opts && opts.bold;
  var color = (opts && opts.color) || '#000';
  var align = (opts && opts.align) || 'left';
  doc.fillColor(color).fontSize(sz).font(bold ? 'Helvetica-Bold' : 'Helvetica');
  doc.text(text || '', x, y, { width: w, align: align, lineBreak: false });
}

// Desenha faixa de header (3 caixas: logo + banco + linha digitavel)
function drawHeaderStrip(doc, y, title, linhaDigitavel, barcodeBuf) {
  // Titulo da secao (canto superior direito)
  if (title) {
    doc.fillColor('#333').fontSize(8).font('Helvetica-Bold');
    doc.text(title, LM, y - 16, { width: PW, align: 'right', lineBreak: false });
  }

  // Dimensoes das 3 caixas
  var bw1 = 117;  // Logo
  var bw2 = 52;   // Banco 341-7
  var bw3 = PW - bw1 - bw2 - 2 * CELL_GAP;  // Linha digitavel ou barcode

  // Caixa 1: Logo Itau
  drawCell(doc, LM, y, bw1, BOX_H);
  if (LOGO_LOADED && logoBuf) {
    doc.image(logoBuf, LM + 3, y + (BOX_H - 20) / 2, { height: 20 });
  } else {
    // Fallback: desenhar logo vetorial
    drawVectorLogo(doc, LM + 4, y + 2);
  }

  // Caixa 2: Codigo do banco 341-7
  var x2 = LM + bw1 + CELL_GAP;
  drawCell(doc, x2, y, bw2, BOX_H);
  doc.fillColor('#000').fontSize(18).font('Helvetica-Bold');
  doc.text('341-7', x2, y + 4, { width: bw2, align: 'center', lineBreak: false });

  // Caixa 3: Linha digitavel OU codigo de barras
  var x3 = x2 + bw2 + CELL_GAP;
  drawCell(doc, x3, y, bw3, BOX_H);
  if (barcodeBuf) {
    // Barcode image
    doc.image(barcodeBuf, x3 + 4, y + 4, { width: bw3 - 8, height: BOX_H - 8 });
  } else {
    // Linha digitavel formatada
    var ld = fmtLinhaDigitavel(linhaDigitavel);
    doc.fillColor('#000').fontSize(12).font('Helvetica-Bold');
    doc.text(ld, x3 + 4, y + 8, { width: bw3 - 8, align: 'center', lineBreak: false });
  }

  return y + BOX_H;
}

// Logo vetorial fallback
function drawVectorLogo(doc, x, y) {
  var bw = 8, bh = 23;
  var faixas = [
    { c: '#003DA5', h: bh * 0.32 },
    { c: '#F68B1F', h: bh * 0.22 },
    { c: '#009B3A', h: bh * 0.22 },
    { c: '#ED1C24', h: bh * 0.24 }
  ];
  var fy = y;
  for (var i = 0; i < faixas.length; i++) {
    doc.rect(x, fy, bw, faixas[i].h).fill(faixas[i].c);
    fy += faixas[i].h;
  }
  doc.fillColor('#003DA5').fontSize(12).font('Helvetica-Bold');
  doc.text('itaú', x + bw + 3, y, { width: 60, lineBreak: false });
  doc.fillColor('#555').fontSize(5).font('Helvetica');
  doc.text('Banco Itaú S.A.', x + bw + 3, y + 13, { width: 80, lineBreak: false });
}

// Desenha linha horizontal (corte)
function drawCutLine(doc, y) {
  doc.moveTo(LM, y).lineTo(RM, y).lineWidth(0.5).dash(4, { space: 2 }).stroke('#808080');
  doc.undash();
}

// Desenha texto "Corte na linha abaixo" centralizado
function drawCutText(doc, y) {
  doc.fillColor('#808080').fontSize(5.5).font('Helvetica');
  doc.text('Corte na linha abaixo', LM, y, { width: PW, align: 'center', lineBreak: false });
}

/* === RECIBO DO PAGADOR === */

function drawRecibo(doc, dados, barcodeBuf) {
  var y = 20; // Inicio do recibo
  var cx; // cursor X

  // === FAIXA DE HEADER ===
  y = drawHeaderStrip(doc, y, 'RECIBO DO PAGADOR', dados.linha_digitavel, null) + 6;

  // === LINHA 1: Beneficiario | Agencia/Codigo | Especie | Quantidade | Nosso numero ===
  var colW1 = [265, 85, 26, 34, PW - 265 - 85 - 26 - 34 - 4 * CELL_GAP];
  var labelY = y;

  // Labels
  cx = LM;
  drawLabel(doc, cx, labelY, 'Beneficiário', colW1[0]); cx += colW1[0] + CELL_GAP;
  drawLabel(doc, cx, labelY, 'Agência / Código', colW1[1]); cx += colW1[1] + CELL_GAP;
  drawLabel(doc, cx, labelY, 'Espécie', colW1[2]); cx += colW1[2] + CELL_GAP;
  drawLabel(doc, cx, labelY, 'Quantidade', colW1[3]); cx += colW1[3] + CELL_GAP;
  drawLabel(doc, cx, labelY, 'Nosso número', colW1[4]);

  // Cells + Values
  y = labelY + 7.5;
  var nnFormatted = formatNN(dados.nosso_numero, dados.carteira);
  var agCodigo = formatAgCodigo(dados.agencia, dados.id_beneficiario);
  var nomeBen = dados.nome_beneficiario || 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA';

  cx = LM;
  drawCell(doc, cx, y, colW1[0], RH); drawVal(doc, cx + 1, y + 1, colW1[0] - 2, nomeBen); cx += colW1[0] + CELL_GAP;
  drawCell(doc, cx, y, colW1[1], RH); drawVal(doc, cx + 1, y + 1, colW1[1] - 2, agCodigo); cx += colW1[1] + CELL_GAP;
  drawCell(doc, cx, y, colW1[2], RH); drawVal(doc, cx + 1, y + 1, colW1[2] - 2, 'R$'); cx += colW1[2] + CELL_GAP;
  drawCell(doc, cx, y, colW1[3], RH); // Quantidade vazio cx += colW1[3] + CELL_GAP;
  drawCell(doc, cx, y, colW1[4], RH); drawVal(doc, cx + 1, y + 1, colW1[4] - 2, nnFormatted, { bold: true });

  y += RH + 4;

  // === ENDEREÇO BENEFICIÁRIO ===
  drawLabel(doc, LM, y, 'Endereço Beneficiário');
  y += 7.5;
  drawCell(doc, LM, y, PW, RH);
  var endBen = dados.endereco_beneficiario || 'Avenida Juscelino K. Oliveira, 7525 - CIC - 81.350-160 - Curitiba - PR - Brasil';
  drawVal(doc, LM + 1, y + 1, PW - 2, endBen);
  y += RH + 4;

  // === LINHA 4 COLUNAS: Numero documento | CPF/CNPJ | Vencimento | Valor ===
  var colW4 = [161, 104, 108, PW - 161 - 104 - 108 - 3 * CELL_GAP]; // manter
  var labelY4 = y;

  cx = LM;
  drawLabel(doc, cx, labelY4, 'Número do documento'); cx += colW4[0] + CELL_GAP;
  drawLabel(doc, cx, labelY4, 'CPF / CNPJ'); cx += colW4[1] + CELL_GAP;
  drawLabel(doc, cx, labelY4, 'Data de Vencimento'); cx += colW4[2] + CELL_GAP;
  drawLabel(doc, cx, labelY4, 'Valor Documento');

  y = labelY4 + 7.5;
  var cnpjBen = dados.cnpj_beneficiario || '22.603.750/0001-90';

  cx = LM;
  drawCell(doc, cx, y, colW4[0], RH); drawVal(doc, cx + 1, y + 1, colW4[0] - 2, dados.seu_numero || ''); cx += colW4[0] + CELL_GAP;
  drawCell(doc, cx, y, colW4[1], RH); drawVal(doc, cx + 1, y + 1, colW4[1] - 2, formatCnpj(cnpjBen)); cx += colW4[1] + CELL_GAP;
  drawCell(doc, cx, y, colW4[2], RH); drawVal(doc, cx + 1, y + 1, colW4[2] - 2, fmtData(dados.data_vencimento)); cx += colW4[2] + CELL_GAP;
  drawCell(doc, cx, y, colW4[3], RH); drawVal(doc, cx + 1, y + 1, colW4[3] - 2, 'R$ ' + fmtValor(dados.valor_titulo), { bold: true });

  y += RH + 4;

  // === LINHA 5 COLUNAS: Descontos | Deducoes | Mora/Multa | Acrescimos | Valor Cobrado ===
  var colW5 = [107, 88, 86, 87, PW - 107 - 88 - 86 - 87 - 4 * CELL_GAP]; // manter
  var labelY5 = y;

  cx = LM;
  drawLabel(doc, cx, labelY5, '(-) Descontos / Abatimentos'); cx += colW5[0] + CELL_GAP;
  drawLabel(doc, cx, labelY5, '(-) Outras deduções'); cx += colW5[1] + CELL_GAP;
  drawLabel(doc, cx, labelY5, '(+) Mora / Multa'); cx += colW5[2] + CELL_GAP;
  drawLabel(doc, cx, labelY5, '(+) Outros acréscimos'); cx += colW5[3] + CELL_GAP;
  drawLabel(doc, cx, labelY5, '(=) Valor Cobrado');

  y = labelY5 + 7.5;
  cx = LM;
  for (var i = 0; i < 5; i++) {
    drawCell(doc, cx, y, colW5[i], RH);
    cx += colW5[i] + CELL_GAP;
  }

  y += RH + 4;

  // === INSTRUÇÕES | AUTENTICAÇÃO MECÂNICA ===
  drawLabel(doc, LM, y, 'Instruções');
  drawLabel(doc, RM - 62, y, 'Autenticação Mecânica');
  y += 7.5;
  drawCell(doc, LM, y, PW, RH);

  y += RH + 4;

  // === PAGADOR ===
  drawLabel(doc, LM, y, 'Pagador');
  y += 7.5;
  drawCell(doc, LM, y, PW, RH);
  var pagadorText = (dados.nome_pagador || '') + ', CNPJ: ' + formatCnpj(dados.cpf_cnpj_pagador);
  drawVal(doc, LM + 1, y + 1, PW - 2, pagadorText, { bold: true });

  y += RH + 10;

  // === FAIXA DE CÓDIGO DE BARRAS ===
  y = drawHeaderStrip(doc, y, null, null, barcodeBuf) + 6;

  // === CORTE ===
  drawCutText(doc, y);
  y += 8;
  drawCutLine(doc, y);
  y += 10;

  return y;
}

/* === FICHA DE COMPENSAÇÃO === */

function drawFicha(doc, startY, dados, barcodeBuf, qrBuf) {
  var y = startY;
  var cx;

  // === LINHA 1: Local de pagamento | Vencimento ===
  var colL = PW - 122 - CELL_GAP; // left column
  var colR = 122; // right column (vencimento)

  drawLabel(doc, LM, y, 'Local de pagamento');
  drawLabel(doc, LM + colL + CELL_GAP, y, 'Vencimento');
  y += 7.5;
  drawCell(doc, LM, y, colL, RH);
  drawVal(doc, LM + 1, y + 1, colL - 2, 'PAGÁVEL EM QUALQUER AGÊNCIA BANCÁRIA ATÉ A DATA DO VENCIMENTO');
  drawCell(doc, LM + colL + CELL_GAP, y, colR, RH);
  drawVal(doc, LM + colL + CELL_GAP + 1, y + 1, colR - 2, fmtData(dados.data_vencimento), { bold: true });
  y += RH + 4;

  // === LINHA 2: Beneficiário | Agência/Código ===
  var nomeBen = dados.nome_beneficiario || 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA';
  var cnpjBen = dados.cnpj_beneficiario || '22.603.750/0001-90';
  var agCodigo = formatAgCodigo(dados.agencia, dados.id_beneficiario);

  drawLabel(doc, LM, y, 'Beneficiário');
  drawLabel(doc, LM + colL + CELL_GAP, y, 'Agência / Código do Beneficiário');
  y += 7.5;
  drawCell(doc, LM, y, colL, RH);
  drawVal(doc, LM + 1, y + 1, colL - 2, nomeBen + ', CNPJ :' + cnpjBen);
  drawCell(doc, LM + colL + CELL_GAP, y, colR, RH);
  drawVal(doc, LM + colL + CELL_GAP + 1, y + 1, colR - 2, agCodigo);
  y += RH + 4;

  // === LINHA 6 COLUNAS: Data Doc | No Doc | Especie | Aceite | Data Proc | Nosso Numero ===
  var col6 = [64, 77, 79, 53, 107, PW - 64 - 77 - 79 - 53 - 107 - 5 * CELL_GAP];
  var labelY6 = y;

  cx = LM;
  drawLabel(doc, cx, labelY6, 'Data do Documento'); cx += col6[0] + CELL_GAP;
  drawLabel(doc, cx, labelY6, 'Nº do Documento'); cx += col6[1] + CELL_GAP;
  drawLabel(doc, cx, labelY6, 'Espécie Doc.'); cx += col6[2] + CELL_GAP;
  drawLabel(doc, cx, labelY6, 'Aceite'); cx += col6[3] + CELL_GAP;
  drawLabel(doc, cx, labelY6, 'Data Processamento'); cx += col6[4] + CELL_GAP;
  drawLabel(doc, cx, labelY6, 'Nosso Número');

  y = labelY6 + 7.5;
  var nnFormatted = formatNN(dados.nosso_numero, dados.carteira);
  var dataEmissao = fmtData(dados.data_emissao || dados.data_vencimento);

  cx = LM;
  drawCell(doc, cx, y, col6[0], RH); drawVal(doc, cx + 1, y + 1, col6[0] - 2, dataEmissao); cx += col6[0] + CELL_GAP;
  drawCell(doc, cx, y, col6[1], RH); drawVal(doc, cx + 1, y + 1, col6[1] - 2, dados.seu_numero || ''); cx += col6[1] + CELL_GAP;
  drawCell(doc, cx, y, col6[2], RH); drawVal(doc, cx + 1, y + 1, col6[2] - 2, 'DM'); cx += col6[2] + CELL_GAP;
  drawCell(doc, cx, y, col6[3], RH); drawVal(doc, cx + 1, y + 1, col6[3] - 2, 'N'); cx += col6[3] + CELL_GAP;
  drawCell(doc, cx, y, col6[4], RH); drawVal(doc, cx + 1, y + 1, col6[4] - 2, dataEmissao); cx += col6[4] + CELL_GAP;
  drawCell(doc, cx, y, col6[5], RH); drawVal(doc, cx + 1, y + 1, col6[5] - 2, nnFormatted, { bold: true });

  y += RH + 4;

  // === LINHA 6 COLUNAS: Uso Banco | Carteira | Especie | Quantidade | Valor | Valor Documento ===
  var labelY6b = y;
  cx = LM;
  drawLabel(doc, cx, labelY6b, 'Uso do Banco'); cx += col6[0] + CELL_GAP;
  drawLabel(doc, cx, labelY6b, 'Carteira'); cx += col6[1] + CELL_GAP;
  drawLabel(doc, cx, labelY6b, 'Espécie'); cx += col6[2] + CELL_GAP;
  drawLabel(doc, cx, labelY6b, 'Quantidade'); cx += col6[3] + CELL_GAP;
  drawLabel(doc, cx, labelY6b, 'Valor'); cx += col6[4] + CELL_GAP;
  drawLabel(doc, cx, labelY6b, 'Valor Documento');

  y = labelY6b + 7.5;
  cx = LM;
  drawCell(doc, cx, y, col6[0], RH); // Uso do banco vazio cx += col6[0] + CELL_GAP;
  drawCell(doc, cx, y, col6[1], RH); drawVal(doc, cx + 1, y + 1, col6[1] - 2, dados.carteira || '109'); cx += col6[1] + CELL_GAP;
  drawCell(doc, cx, y, col6[2], RH); drawVal(doc, cx + 1, y + 1, col6[2] - 2, 'R$'); cx += col6[2] + CELL_GAP;
  drawCell(doc, cx, y, col6[3], RH); // Quantidade vazio cx += col6[3] + CELL_GAP;
  drawCell(doc, cx, y, col6[4], RH); // Valor vazio cx += col6[4] + CELL_GAP;
  drawCell(doc, cx, y, col6[5], RH); drawVal(doc, cx + 1, y + 1, col6[5] - 2, 'R$ ' + fmtValor(dados.valor_titulo), { bold: true });

  y += RH + 4;

  // === INSTRUÇÕES (lado esquerdo) | DEDUÇÕES (lado direito, 5 celulas empilhadas) ===
  // Lado esquerdo: instruções
  var leftW = PW - 122 - CELL_GAP;
  var rightX = LM + leftW + CELL_GAP;
  var rightW = 122;
  var dedRowH = RH;

  // Labels das deduções (lado direito)
  var dedLabels = [
    '(-) Descontos / Abatimentos',
    '(-) Outras deduções',
    '(+) Mora / Multa',
    '(+) Outros acréscimos',
    '(=) Valor Cobrado'
  ];

  // Label "Instruções" (esquerda) + primeira label dedução (direita)
  drawLabel(doc, LM, y, 'Instruções (Instruções de responsabilidade do beneficiário.', leftW);
  drawLabel(doc, rightX, y, dedLabels[0], rightW);

  y += 7.5;

  // Texto das instruções (lado esquerdo)
  var instrucoes = getInstrucoes(dados.valor_titulo);
  var instY = y;
  for (var i = 0; i < instrucoes.length; i++) {
    doc.fillColor('#000').fontSize(FV).font('Helvetica');
    doc.text(instrucoes[i], LM + 2, instY, { width: leftW - 4, lineBreak: false });
    instY += 12;
  }

  // Celulas de dedução (lado direito, empilhadas)
  drawCell(doc, rightX, y, rightW, dedRowH);
  y += dedRowH + 7.5;

  for (var i = 1; i < dedLabels.length; i++) {
    drawLabel(doc, rightX, y, dedLabels[i]);
    y += 7.5;
    drawCell(doc, rightX, y, rightW, dedRowH);
    y += dedRowH + (i < dedLabels.length - 1 ? 7.5 : 0);
  }

  y += 4;

  // === PAGADOR (3 linhas) ===
  drawLabel(doc, LM, y, 'Pagador');
  y += 7.5;

  // Linha 1: Nome + CNPJ
  drawCell(doc, LM, y, PW, RH);
  drawVal(doc, LM + 1, y + 1, PW - 2, (dados.nome_pagador || '') + ', CNPJ: ' + formatCnpj(dados.cpf_cnpj_pagador), { bold: true });
  y += RH + 1;

  // Linha 2: Cidade/UF
  var endereco1 = [dados.cidade, dados.estado].filter(Boolean).join(' - ');
  if (dados.logradouro) endereco1 = dados.logradouro + ' - ' + (endereco1 || dados.cidade || '');
  drawCell(doc, LM, y, PW, RH);
  drawVal(doc, LM + 1, y + 1, PW - 2, endereco1 || '');
  y += RH + 1;

  // Linha 3: CEP
  drawCell(doc, LM, y, PW, RH);
  var endereco2 = dados.cep ? 'CEP: ' + dados.cep : '';
  drawVal(doc, LM + 1, y + 1, PW - 2, endereco2);
  y += RH + 4;

  // === BENEFICIÁRIO FINAL ===
  drawLabel(doc, LM, y, 'Beneficiário Final');
  y += 7.5;
  drawCell(doc, LM, y, PW, RH);

  y += RH + 6;

  // === FAIXA DE RODAPÉ (logo largo + autenticação + titulo) ===
  var rodapeH = 37;
  var logoW = 309;

  // Logo box (largo)
  drawCell(doc, LM, y, logoW, rodapeH);
  if (LOGO_LOADED && logoBuf) {
    doc.image(logoBuf, LM + 4, y + (rodapeH - 22) / 2, { height: 22 });
  } else {
    drawVectorLogo(doc, LM + 5, y + 6);
  }

  // Autenticação Mecânica (texto)
  doc.fillColor('#333').fontSize(FL).font('Helvetica');
  doc.text('Autenticação Mecânica', LM + logoW + 20, y + 12, { width: 80, lineBreak: false });

  // FICHA DE COMPENSAÇÃO (titulo)
  doc.fillColor('#333').fontSize(8).font('Helvetica-Bold');
  doc.text('FICHA DE COMPENSAÇÃO', RM - 103, y + 14, { width: 100, align: 'right', lineBreak: false });

  y += rodapeH + 6;

  // === SEÇÃO PIX (opcional, abaixo da ficha) ===
  var pix = dados.pix_copia_cola || '';
  if (pix || qrBuf) {
    y = drawPixSection(doc, y, dados, qrBuf);
  }

  return y;
}

/* === SEÇÃO PIX === */

function drawPixSection(doc, y, dados, qrBuf) {
  var pix = dados.pix_copia_cola || '';

  // Linha separadora
  doc.moveTo(LM, y).lineTo(RM, y).lineWidth(0.5).stroke(LC);
  y += 6;

  // QR Code (lado esquerdo)
  if (qrBuf) {
    try {
      doc.image(qrBuf, LM + 10, y, { width: 75, height: 75 });
    } catch (e) {}
  }

  // Textos PIX
  doc.fillColor('#333').fontSize(7).font('Helvetica-Bold');
  doc.text('Pagamento via PIX', LM + 95, y + 2, { width: 200 });
  doc.font('Helvetica').fontSize(5.5);
  doc.text('Escaneie o QR Code ou copie o código abaixo', LM + 95, y + 12, { width: 300 });
  doc.text('para pagar instantaneamente com PIX.', LM + 95, y + 21, { width: 300 });

  // Caixa do Copia e Cola
  var ccY = y + 30;
  var ccW = PW - 100;
  var ccH = 30;
  doc.rect(LM + 95, ccY, ccW, ccH).fill('#f8f8ff').lineWidth(0.3).stroke('#666');
  doc.fillColor('#333').fontSize(5).font('Helvetica-Bold');
  doc.text('PIX Copia e Cola:', LM + 100, ccY + 2, { width: ccW - 10 });
  doc.fillColor('#000').fontSize(4.5).font('Courier');
  doc.text(pix, LM + 100, ccY + 10, { width: ccW - 15 });
  doc.font('Helvetica');

  // TXID
  doc.fillColor('#999').fontSize(4.5);
  doc.text('TXID: ' + (dados.txid || ''), LM + 95, y + 68, { width: 300 });

  y += 82;

  // Linha final
  doc.moveTo(LM, y).lineTo(RM, y).lineWidth(0.5).stroke(LC);

  return y;
}

/* === MONTAGEM PRINCIPAL === */

async function drawBoleto(doc, dados) {
  var barcodeText = dados.codigo_barras || '';
  var barcodeBuf = await genBarcode(barcodeText);

  var qrBuf = dados.qrcode_base64 ? Buffer.from(dados.qrcode_base64, 'base64') : null;
  if (!qrBuf && (dados.pix_copia_cola || '')) {
    qrBuf = await genQRCode(dados.pix_copia_cola);
  }

  // ===== RECIBO DO PAGADOR =====
  var y = drawRecibo(doc, dados, barcodeBuf);

  // ===== FICHA DE COMPENSAÇÃO =====
  y = drawFicha(doc, y, dados, barcodeBuf, qrBuf);

  return y;
}

/* === GERACAO DO PDF === */

async function buildPdfBuffer(dados) {
  return new Promise(function (resolve, reject) {
    try {
      var doc = new PDFDocument({
        size: 'A4',
        margins: { top: 5, bottom: 5, left: LM, right: 27 },
        info: { Title: 'Boleto ' + (dados.nosso_numero || ''), Author: 'AJL Ferro e Aco' }
      });
      var chunks = [];
      doc.on('data', function (chunk) { chunks.push(chunk); });

      drawBoleto(doc, dados).then(function (finalY) {
        doc.fillColor('#999').fontSize(4);
        doc.text('Emitido por AJL Ferro e Aco | Boleto gerado via API BoleCode Itau', LM, finalY + 4, { width: PW, align: 'center' });
        doc.end();
        doc.on('end', function () { resolve(Buffer.concat(chunks)); });
      }).catch(reject);
    } catch (err) { reject(err); }
  });
}

async function generatePdf(txid) {
  var dados = getBoleto(txid);
  if (!dados) throw new Error('Boleto expirado. Use POST /boletos/pdf');
  return buildPdfBuffer(dados);
}

async function generatePdfFromData(data) {
  var ind = (data.dado_boleto && data.dado_boleto.dados_individuais_boleto && data.dado_boleto.dados_individuais_boleto[0]) || {};
  var qr = data.dados_qrcode || {};
  var d = {
    txid: qr.txid || '',
    nosso_numero: ind.numero_nosso_numero || '',
    linha_digitavel: ind.numero_linha_digitavel || '',
    codigo_barras: ind.codigo_barras || '',
    data_vencimento: ind.data_vencimento || '',
    data_emissao: data.data_emissao || '',
    valor_titulo: ind.valor_titulo || '',
    pix_copia_cola: qr.emv || '',
    qrcode_base64: qr.base64 || '',
    nome_pagador: data.nome_pagador || '',
    cpf_cnpj_pagador: data.cpf_cnpj_pagador || '',
    tipo_pessoa: data.tipo_pessoa || '',
    logradouro: data.logradouro || '',
    cidade: data.cidade || '',
    estado: data.estado || '',
    cep: data.cep || '',
    seu_numero: data.seu_numero || '',
    agencia: data.agencia || '7764',
    conta: data.conta || '22338-9',
    carteira: data.carteira || '109',
    id_beneficiario: data.id_beneficiario || '776400223389',
    nome_beneficiario: data.nome_beneficiario || 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    cnpj_beneficiario: data.cnpj_beneficiario || '22.603.750/0001-90',
    endereco_beneficiario: data.endereco_beneficiario || 'Avenida Juscelino K. Oliveira, 7525 - CIC - 81.350-160 - Curitiba - PR - Brasil',
    parcela: data.parcela || 0,
    total_parcelas: data.total_parcelas || 0,
  };
  return buildPdfBuffer(d);
}

module.exports = { storeBoleto, getBoleto, getTxidByNn, generatePdf, generatePdfFromData, generatePdfFromFields };

/**
 * Gera PDF a partir de campos flat (dados vindos do Odoo)
 */
async function generatePdfFromFields(data) {
  var vt = data.valor_titulo || '0';
  var vtStr = String(vt).replace(/\D/g, '');
  if (vtStr.length < 15) {
    vtStr = String(Math.round(parseFloat(vt) * 100)).padStart(15, '0');
  }

  var d = {
    txid: data.txid || '',
    nosso_numero: data.nosso_numero || '',
    linha_digitavel: data.linha_digitavel || '',
    codigo_barras: data.codigo_barras || '',
    data_vencimento: data.data_vencimento || '',
    data_emissao: data.data_emissao || '',
    valor_titulo: vtStr,
    pix_copia_cola: data.pix_copia_cola || '',
    qrcode_base64: data.qrcode_base64 || '',
    nome_pagador: data.nome_pagador || '',
    cpf_cnpj_pagador: data.cpf_cnpj_pagador || '',
    logradouro: data.logradouro || '',
    cidade: data.cidade || '',
    estado: data.estado || '',
    cep: data.cep || '',
    seu_numero: data.seu_numero || data.nosso_numero || '',
    parcela: data.parcela || 0,
    total_parcelas: data.total_parcelas || 0,
    agencia: data.agencia || '7764',
    conta: data.conta || '22338-9',
    carteira: data.carteira || '109',
    id_beneficiario: data.id_beneficiario || '776400223389',
    nome_beneficiario: data.nome_beneficiario || 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    cnpj_beneficiario: data.cnpj_beneficiario || '22.603.750/0001-90',
    endereco_beneficiario: data.endereco_beneficiario || 'Avenida Juscelino K. Oliveira, 7525 - CIC - 81.350-160 - Curitiba - PR - Brasil',
  };
  return buildPdfBuffer(d);
}
