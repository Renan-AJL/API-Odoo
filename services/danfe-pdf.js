/**
 * services/danfe-pdf.js — Geracao local do DANFE (PDF) a partir do nfeProc
 * ========================================================================
 * Sem dependencia da SIEG: usa pdfkit + bwip-js (codigo de barras Code128C
 * da chave de acesso). Layout retrato A4 no padrao do DANFE simplificado:
 * canhoto, identificacao, emitente/destinatario, impostos, itens e dados
 * adicionais.
 *
 * v2.0 — Inclui IPI, Numero do Pedido, Boleto (cod barras / linha digitavel)
 */
var PDFDocument = require('pdfkit');
var bwipjs = require('bwip-js');

function tag(xml, name) {
  var m = String(xml || '').match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? m[1].trim() : '';
}
function tagIn(xml, path) {
  var cur = xml;
  var parts = path.split('.');
  for (var i = 0; i < parts.length; i++) cur = tag(cur, parts[i]);
  return cur;
}
function bloco(xml, name) {
  var m = String(xml || '').match(new RegExp('<' + name + '[\\s>][\\s\\S]*?<\\/' + name + '>', 'i'));
  return m ? m[0] : '';
}
function blocos(xml, name) {
  var re = new RegExp('<' + name + '[\\s>][\\s\\S]*?<\\/' + name + '>', 'gi');
  return String(xml || '').match(re) || [];
}
function moeda(v) {
  var n = parseFloat(v || 0) || 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function qtd(v) {
  var n = parseFloat(v || 0) || 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function cnpjFmt(v) {
  var s = String(v || '').replace(/\D/g, '');
  if (s.length === 14) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (s.length === 11) return s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return s;
}
function chaveFmt(c) {
  return String(c || '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}
function dataFmt(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function barcode(chave) {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: String(chave),
    scale: 3,
    height: 12,
    includetext: false,
    paddingwidth: 0,
    paddingheight: 0,
  });
}

/**
 * Gera o PDF do DANFE.
 * @param {string} nfeProcXml XML autorizado (nfeProc) ou NFe + protNFe
 * @param {Object} [opts] Opcoes adicionais
 * @param {string} [opts.saleOrderNumber] Numero do pedido de venda (ex: S00042)
 * @param {Array} [opts.boletoData] Dados do boleto [{nosso_numero, linha_digitavel, codigo_barras}]
 * @returns {Promise<Buffer>}
 */
async function gerarDanfePdf(nfeProcXml, opts) {
  opts = opts || {};
  var xml = String(nfeProcXml || '');
  var infNFe = bloco(xml, 'infNFe');
  if (!infNFe) throw new Error('XML sem <infNFe> — nao eh possivel gerar o DANFE.');

  var ide = bloco(infNFe, 'ide');
  var emit = bloco(infNFe, 'emit');
  var dest = bloco(infNFe, 'dest');
  var total = bloco(infNFe, 'ICMSTot');
  var transp = bloco(infNFe, 'transp');
  var infAdic = bloco(infNFe, 'infAdic');
  var prot = bloco(xml, 'infProt');

  var chave = (infNFe.match(/Id="NFe(\d{44})"/) || [])[1] || tag(prot, 'chNFe');
  var tpAmb = tag(ide, 'tpAmb');
  var homolog = tpAmb === '2';

  var doc = new PDFDocument({ size: 'A4', margin: 24 });
  var chunks = [];
  doc.on('data', function (c) { chunks.push(c); });
  var done = new Promise(function (resolve) { doc.on('end', function () { resolve(Buffer.concat(chunks)); }); });

  var L = doc.page.margins.left;
  var W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  function box(x, y, w, h) { doc.lineWidth(0.6).rect(x, y, w, h).stroke(); }
  function label(x, y, t) { doc.fontSize(5.5).font('Helvetica').fillColor('#444').text(t, x + 3, y + 2, { width: 200 }); doc.fillColor('#000'); }
  function value(x, y, w, t, size, bold) {
    doc.fontSize(size || 8).font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(String(t == null ? '' : t), x + 3, y + 9, { width: w - 6, ellipsis: true, lineBreak: false });
  }
  function campo(x, y, w, h, lab, val, size, bold) { box(x, y, w, h); label(x, y, lab); value(x, y, w, val, size, bold); }

  var y = doc.page.margins.top;

  // Marca d'agua de homologacao
  if (homolog) {
    doc.save().rotate(-40, { origin: [300, 400] }).fontSize(38).fillColor('#e5e5e5')
      .text('SEM VALOR FISCAL - HOMOLOGACAO', 20, 380).restore().fillColor('#000');
  }

  // --- Canhoto ---
  box(L, y, W - 110, 26);
  doc.fontSize(5.5).text('RECEBEMOS DE ' + tag(emit, 'xNome') + ' OS PRODUTOS CONSTANTES DA NOTA FISCAL INDICADA AO LADO', L + 3, y + 3, { width: W - 120 });
  doc.fontSize(5.5).text('DATA DE RECEBIMENTO', L + 3, y + 15);
  doc.text('IDENTIFICACAO E ASSINATURA DO RECEBEDOR', L + 130, y + 15);
  box(L + W - 110, y, 110, 26);
  doc.fontSize(7).font('Helvetica-Bold')
    .text('NF-e  N. ' + tag(ide, 'nNF') + '\nSERIE ' + tag(ide, 'serie'), L + W - 105, y + 6);
  y += 32;

  // --- Cabecalho: emitente + chave ---
  var hHead = 78;
  box(L, y, W, hHead);
  doc.fontSize(9).font('Helvetica-Bold').text(tag(emit, 'xNome'), L + 5, y + 6, { width: 200 });
  var eEnd = bloco(emit, 'enderEmit');
  doc.fontSize(6.5).font('Helvetica').text(
    tag(eEnd, 'xLgr') + ', ' + tag(eEnd, 'nro') + ' ' + tag(eEnd, 'xBairro') + '\n' +
    tag(eEnd, 'xMun') + ' - ' + tag(eEnd, 'UF') + '  CEP ' + tag(eEnd, 'CEP') + '\n' +
    'CNPJ ' + cnpjFmt(tag(emit, 'CNPJ')) + '   IE ' + tag(emit, 'IE') + '\n' +
    'Fone ' + (tag(eEnd, 'fone') || '-'),
    L + 5, y + 22, { width: 200 }
  );

  doc.fontSize(13).font('Helvetica-Bold').text('DANFE', L + 215, y + 6, { width: 90, align: 'center' });
  doc.fontSize(5.5).font('Helvetica').text('Documento Auxiliar da Nota Fiscal Eletronica', L + 210, y + 22, { width: 100, align: 'center' });
  doc.fontSize(7).font('Helvetica-Bold').text((tag(ide, 'tpNF') === '1' ? '1 - SAIDA' : '0 - ENTRADA'), L + 210, y + 36, { width: 100, align: 'center' });
  doc.fontSize(8).text('N. ' + tag(ide, 'nNF') + '\nSERIE ' + tag(ide, 'serie'), L + 210, y + 48, { width: 100, align: 'center' });

  // Codigo de barras
  try {
    var png = await barcode(chave);
    doc.image(png, L + 320, y + 6, { width: W - 330, height: 30 });
  } catch (e) {
    doc.fontSize(6).text('(codigo de barras indisponivel)', L + 320, y + 16);
  }
  box(L + 315, y + 40, W - 315, 18);
  label(L + 315, y + 40, 'CHAVE DE ACESSO');
  doc.fontSize(7).font('Helvetica-Bold').text(chaveFmt(chave), L + 318, y + 49, { width: W - 322 });
  box(L + 315, y + 58, W - 315, 20);
  doc.fontSize(6).font('Helvetica').text(
    'Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da SEFAZ autorizadora',
    L + 318, y + 62, { width: W - 322 }
  );
  y += hHead + 2;

  // --- Protocolo / natureza ---
  campo(L, y, W * 0.55, 20, 'NATUREZA DA OPERACAO', tag(ide, 'natOp'), 7);
  campo(L + W * 0.55, y, W * 0.45, 20, 'PROTOCOLO DE AUTORIZACAO DE USO',
    (tag(prot, 'nProt') || '-') + '  ' + dataFmt(tag(prot, 'dhRecbto')), 7);
  y += 22;

  campo(L, y, W / 3, 20, 'INSCRICAO ESTADUAL', tag(emit, 'IE'), 7);
  campo(L + W / 3, y, W / 3, 20, 'INSC. ESTADUAL DO SUBST. TRIB.', tag(emit, 'IEST') || '', 7);
  campo(L + 2 * W / 3, y, W / 3, 20, 'CNPJ', cnpjFmt(tag(emit, 'CNPJ')), 7);
  y += 24;

  // --- Destinatario ---
  doc.fontSize(6).font('Helvetica-Bold').text('DESTINATARIO / REMETENTE', L, y); y += 8;
  var dEnd = bloco(dest, 'enderDest');
  campo(L, y, W * 0.55, 20, 'NOME / RAZAO SOCIAL', tag(dest, 'xNome'), 7);
  campo(L + W * 0.55, y, W * 0.25, 20, 'CNPJ / CPF', cnpjFmt(tag(dest, 'CNPJ') || tag(dest, 'CPF')), 7);
  campo(L + W * 0.80, y, W * 0.20, 20, 'DATA DA EMISSAO', dataFmt(tag(ide, 'dhEmi')), 7);
  y += 20;
  campo(L, y, W * 0.45, 20, 'ENDERECO', tag(dEnd, 'xLgr') + ', ' + tag(dEnd, 'nro'), 7);
  campo(L + W * 0.45, y, W * 0.25, 20, 'BAIRRO', tag(dEnd, 'xBairro'), 7);
  campo(L + W * 0.70, y, W * 0.15, 20, 'CEP', tag(dEnd, 'CEP'), 7);
  campo(L + W * 0.85, y, W * 0.15, 20, 'DATA SAIDA/ENTRADA', dataFmt(tag(ide, 'dhSaiEnt')) || '-', 7);
  y += 20;
  campo(L, y, W * 0.45, 20, 'MUNICIPIO', tag(dEnd, 'xMun'), 7);
  campo(L + W * 0.45, y, W * 0.10, 20, 'UF', tag(dEnd, 'UF'), 7);
  campo(L + W * 0.55, y, W * 0.15, 20, 'FONE', tag(dEnd, 'fone'), 7);
  campo(L + W * 0.70, y, W * 0.30, 20, 'INSCRICAO ESTADUAL', tag(dest, 'IE') || 'ISENTO', 7);
  y += 24;

  // --- Totais ---
  doc.fontSize(6).font('Helvetica-Bold').text('CALCULO DO IMPOSTO', L, y); y += 8;
  var c6 = W / 6;
  campo(L, y, c6, 20, 'BASE DE CALCULO DO ICMS', moeda(tag(total, 'vBC')), 7);
  campo(L + c6, y, c6, 20, 'VALOR DO ICMS', moeda(tag(total, 'vICMS')), 7);
  campo(L + 2 * c6, y, c6, 20, 'BASE DE CALCULO ICMS ST', moeda(tag(total, 'vBCST')), 7);
  campo(L + 3 * c6, y, c6, 20, 'VALOR DO ICMS ST', moeda(tag(total, 'vST')), 7);
  campo(L + 4 * c6, y, c6, 20, 'VALOR DO IPI', moeda(tag(total, 'vIPI')), 7);
  campo(L + 5 * c6, y, c6, 20, 'VALOR TOTAL DOS PRODUTOS', moeda(tag(total, 'vProd')), 7, true);
  y += 20;
  campo(L, y, c6, 20, 'VALOR DO FRETE', moeda(tag(total, 'vFrete')), 7);
  campo(L + c6, y, c6, 20, 'VALOR DO SEGURO', moeda(tag(total, 'vSeg')), 7);
  campo(L + 2 * c6, y, c6, 20, 'DESCONTO', moeda(tag(total, 'vDesc')), 7);
  campo(L + 3 * c6, y, c6, 20, 'OUTRAS DESPESAS', moeda(tag(total, 'vOutro')), 7);
  campo(L + 4 * c6, y, c6, 20, 'IPI DEVOLVIDO', moeda(tag(total, 'vIPIDevol')), 7);
  campo(L + 5 * c6, y, c6, 20, 'VALOR TOTAL DA NOTA', moeda(tag(total, 'vNF')), 8, true);
  y += 24;

  // --- Transportador ---
  var vol = bloco(transp, 'vol');
  doc.fontSize(6).font('Helvetica-Bold').text('TRANSPORTADOR / VOLUMES TRANSPORTADOS', L, y); y += 8;
  var transporta = bloco(transp, 'transporta');
  campo(L, y, W * 0.5, 20, 'NOME / RAZAO SOCIAL', tag(transporta, 'xNome') || '-', 7);
  campo(L + W * 0.5, y, W * 0.2, 20, 'FRETE POR CONTA', tag(transp, 'modFrete') === '0' ? '0-EMITENTE' : (tag(transp, 'modFrete') === '9' ? '9-SEM FRETE' : tag(transp, 'modFrete')), 7);
  campo(L + W * 0.7, y, W * 0.3, 20, 'CNPJ / CPF', cnpjFmt(tag(transporta, 'CNPJ') || tag(transporta, 'CPF')) || '-', 7);
  y += 20;
  campo(L, y, W * 0.2, 20, 'QUANTIDADE', tag(vol, 'qVol') || '-', 7);
  campo(L + W * 0.2, y, W * 0.2, 20, 'ESPECIE', tag(vol, 'esp') || '-', 7);
  campo(L + W * 0.4, y, W * 0.2, 20, 'MARCA', tag(vol, 'marca') || '-', 7);
  campo(L + W * 0.6, y, W * 0.2, 20, 'PESO BRUTO', tag(vol, 'pesoB') || '-', 7);
  campo(L + W * 0.8, y, W * 0.2, 20, 'PESO LIQUIDO', tag(vol, 'pesoL') || '-', 7);
  y += 24;

  // --- Itens ---
  doc.fontSize(6).font('Helvetica-Bold').text('DADOS DOS PRODUTOS / SERVICOS', L, y); y += 8;
  var cols = [
    { t: 'COD', w: 0.07 }, { t: 'DESCRICAO', w: 0.24 }, { t: 'NCM', w: 0.06 },
    { t: 'CST', w: 0.04 }, { t: 'CFOP', w: 0.04 }, { t: 'UN', w: 0.03 },
    { t: 'QTD', w: 0.07 }, { t: 'V.UNIT', w: 0.08 }, { t: 'V.TOTAL', w: 0.08 },
    { t: 'BC ICMS', w: 0.06 }, { t: 'V.ICMS', w: 0.05 },
    { t: 'CST IPI', w: 0.04 }, { t: 'V.IPI', w: 0.06 }, { t: 'PIPI%', w: 0.04 },
  ];
  var x = L;
  box(L, y, W, 12);
  cols.forEach(function (c) {
    doc.fontSize(5.5).font('Helvetica-Bold').text(c.t, x + 2, y + 4, { width: W * c.w - 3, lineBreak: false });
    x += W * c.w;
  });
  y += 12;

  var dets = blocos(infNFe, 'det');
  dets.forEach(function (det) {
    if (y > doc.page.height - 130) { doc.addPage(); y = doc.page.margins.top; }
    var prod = bloco(det, 'prod');
    var icms = bloco(det, 'ICMS');
    var ipi = bloco(det, 'IPI');
    var ipiTrib = bloco(ipi, 'IPITrib');
    var ipiNT = bloco(ipi, 'IPINT');
    var h = 12;
    box(L, y, W, h);
    var vals = [
      tag(prod, 'cProd'), tag(prod, 'xProd'), tag(prod, 'NCM'),
      tag(icms, 'CST') || tag(icms, 'CSOSN'), tag(prod, 'CFOP'), tag(prod, 'uCom'),
      qtd(tag(prod, 'qCom')), moeda(tag(prod, 'vUnCom')), moeda(tag(prod, 'vProd')),
      moeda(tag(icms, 'vBC')), moeda(tag(icms, 'vICMS')),
      tag(ipiTrib, 'CST') || tag(ipiNT, 'CST') || '',
      moeda(tag(ipiTrib, 'vIPI')),
      tag(ipiTrib, 'pIPI') ? parseFloat(tag(ipiTrib, 'pIPI')).toFixed(2) : '',
    ];
    var xx = L;
    cols.forEach(function (c, i) {
      var align = i >= 6 ? 'right' : 'left';
      doc.fontSize(5.8).font('Helvetica')
        .text(String(vals[i] || ''), xx + 2, y + 4, { width: W * c.w - 4, lineBreak: false, ellipsis: true, align: align });
      xx += W * c.w;
    });
    y += h;
  });
  y += 6;

  // --- Dados adicionais ---
  if (y > doc.page.height - 90) { doc.addPage(); y = doc.page.margins.top; }
  doc.fontSize(6).font('Helvetica-Bold').text('DADOS ADICIONAIS', L, y); y += 8;
  var infoAd = (homolog ? 'AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL. ' : '') +
    (tag(infAdic, 'infCpl') || '') + ' ' + (tag(infAdic, 'infAdFisco') || '');
  // Incluir numero do pedido de venda se disponivel
  if (opts.saleOrderNumber) {
    if (infoAd.indexOf('Pedido') === -1) {
      infoAd = 'Pedido: ' + opts.saleOrderNumber + '. ' + infoAd;
    }
  }
  box(L, y, W, 60);
  doc.fontSize(6.5).font('Helvetica').text(infoAd.trim() || '-', L + 4, y + 4, { width: W - 8, height: 52 });
  y += 66;

  // --- Cobranca (Duplicatas / Boleto) ---
  var cobr = bloco(infNFe, 'cobr');
  var dups = blocos(cobr, 'dup');
  if (dups.length > 0) {
    if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
    doc.fontSize(6).font('Helvetica-Bold').text('FATURA / DUPLICATAS', L, y); y += 8;
    var fatBlock = bloco(cobr, 'fat');
    var fatNum = tag(fatBlock, 'nFat');
    var fatOrig = moeda(tag(fatBlock, 'vOrig'));
    var fatLiq = moeda(tag(fatBlock, 'vLiq'));
    campo(L, y, W * 0.30, 18, 'NUMERO', fatNum, 6.5);
    campo(L + W * 0.30, y, W * 0.35, 18, 'VALOR ORIGINAL', fatOrig, 6.5);
    campo(L + W * 0.65, y, W * 0.35, 18, 'VALOR LIQUIDO', fatLiq, 6.5);
    y += 20;
    // Duplicatas com vencimento e valor
    var dupColW = W / Math.min(dups.length, 6);
    var dupX = L;
    dups.forEach(function (dup, di) {
      if (di > 0 && di % 6 === 0) { y += 18; dupX = L; }
      if (y > doc.page.height - 40) { doc.addPage(); y = doc.page.margins.top; }
      var nDup = tag(dup, 'nDup');
      var dVenc = tag(dup, 'dVenc');
      var vDup = moeda(tag(dup, 'vDup'));
      box(dupX, y, dupColW, 18);
      doc.fontSize(5).font('Helvetica').text('Dup ' + nDup, dupX + 2, y + 2, { width: dupColW - 4, lineBreak: false });
      doc.fontSize(5.5).font('Helvetica').text(dVenc + '  R$ ' + vDup, dupX + 2, y + 9, { width: dupColW - 4, lineBreak: false, ellipsis: true });
      dupX += dupColW;
    });
    y += 22;
  }

  // --- Boleto (linha digitavel / codigo de barras) ---
  // Busca dados de boleto no infAdic (formato: Boleto: NN=xxx LD=xxx CB=xxx)
  // Ou via opts.boletoData passado pelo sieg-odoo-emit
  var boletoMatch = infoAd.match(/Boleto:\s*NN[=:]\s*(\S+)(?:\s+LD[=:]\s*(\S+))?(?:\s+CB[=:]\s*(\S+))?/i);
  // Tambem busca linha digitavel no padrao 47 digitos
  var ldMatch = infoAd.match(/(\d{5}\.\d{5}\s\d{5}\.\d{6}\s\d{5}\.\d{6}\s\d{1}\s\d{14})/);
  // Dados do boleto via opts
  var optBoletos = opts.boletoData || [];
  if (boletoMatch || ldMatch || optBoletos.length > 0) {
    if (y > doc.page.height - 80) { doc.addPage(); y = doc.page.margins.top; }
    doc.fontSize(6).font('Helvetica-Bold').text('BOLETO', L, y); y += 8;
    // Se temos boletos via opts, mostrar cada um
    if (optBoletos.length > 0) {
      for (var bi = 0; bi < optBoletos.length; bi++) {
        var bol = optBoletos[bi];
        if (y > doc.page.height - 50) { doc.addPage(); y = doc.page.margins.top; }
        var bolH = 36;
        box(L, y, W, bolH);
        if (bol.nosso_numero) {
          doc.fontSize(6).font('Helvetica').text('Nosso Numero: ' + bol.nosso_numero, L + 4, y + 3, { width: W - 8 });
        }
        if (bol.linha_digitavel) {
          doc.fontSize(6).font('Helvetica').text('Linha Digitavel: ' + bol.linha_digitavel, L + 4, y + 11, { width: W - 8 });
        }
        if (bol.codigo_barras) {
          try {
            var bolPng3 = await barcode(bol.codigo_barras);
            doc.image(bolPng3, L + 4, y + 21, { width: W - 12, height: 12 });
          } catch (e) {
            doc.fontSize(5.5).font('Helvetica').text('Cod. Barras: ' + bol.codigo_barras, L + 4, y + 22, { width: W - 8 });
          }
        }
        y += bolH + 2;
      }
    } else if (boletoMatch) {
      box(L, y, W, 36);
      var nnBol = boletoMatch[1] || '';
      var ldBol = boletoMatch[2] || '';
      var cbBol = boletoMatch[3] || '';
      if (nnBol) {
        doc.fontSize(6).font('Helvetica').text('Nosso Numero: ' + nnBol, L + 4, y + 3, { width: W - 8 });
      }
      if (ldBol) {
        doc.fontSize(6).font('Helvetica').text('Linha Digitavel: ' + ldBol, L + 4, y + 12, { width: W - 8 });
      }
      if (cbBol) {
        try {
          var bolPng = await barcode(cbBol);
          doc.image(bolPng, L + 4, y + 21, { width: W - 12, height: 12 });
        } catch (e) {
          doc.fontSize(5.5).font('Helvetica').text('Cod. Barras: ' + cbBol, L + 4, y + 22, { width: W - 8 });
        }
      }
      y += 40;
    } else if (ldMatch) {
      box(L, y, W, 36);
      doc.fontSize(6).font('Helvetica').text('Linha Digitavel:', L + 4, y + 3, { width: W - 8 });
      doc.fontSize(7).font('Helvetica-Bold').text(ldMatch[1], L + 4, y + 12, { width: W - 8 });
      var cbDigits = ldMatch[1].replace(/[^0-9]/g, '');
      if (cbDigits.length >= 44) {
        try {
          var bolPng2 = await barcode(cbDigits.substring(0, 44));
          doc.image(bolPng2, L + 4, y + 23, { width: W - 12, height: 12 });
        } catch (e) {}
      }
      y += 40;
    }
  }

  doc.fontSize(5.5).fillColor('#666')
    .text('DANFE gerado pelo middleware AJL (emissao propria com certificado A1) em ' + dataFmt(new Date().toISOString()), L, y);

  doc.end();
  return done;
}

module.exports = { gerarDanfePdf };
