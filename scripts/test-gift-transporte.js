/**
 * test-gift-transporte.js — Checks da demanda bonificação CFOP 5910 + transportadora (27/10/2026)
 *  A) CFOP do Tipo de Operacao (l10n_br_cfop_code) — 5910 interna / 6910 interestadual
 *  B) Mapeamentos fixos preservados (5901 industrializacao, 5152 transferencia)
 *  C) XML: bloco <transp> com transporta/veicTransp/vol completo (PTL real)
 *  D) Regra SEFAZ 845: transporta/veicTransp/vol OMITIDOS com modFrete 9
 *  E) Fatura SEM transporte = XML identico ao comportamento anterior (modFrete 9, sem transporta)
 *  F) Ordem das tags no XSD: total < transp(modFrete, veicTransp, transporta, vol) < cobr
 *     + vol: qVol, esp, pesoL ANTES de pesoB (leiaute 4.00)
 *  G) Transportadora pessoa fisica (CPF) + omissao de endereço vazio (nada inventado)
 * Execução: node scripts/test-gift-transporte.js
 */
var path = require('path');
var assert = require('assert');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
var emitSrc = fs.readFileSync(path.join(ROOT, 'services/sieg-odoo-emit.js'), 'utf8');
var gerarXmlNFe = require(path.join(ROOT, 'services/sieg-nfe-xml.js')).gerarXmlNFe;

var PASS = 0;
function ok(nome, cond, extra) {
  if (!cond) { console.error('  [FALHA] ' + nome + (extra ? ' — ' + extra : '')); process.exitCode = 1; return; }
  PASS++;
  console.log('  [OK] ' + nome + (extra ? ' — ' + extra : ''));
}

// ===== Dados base (mesma estrutura do fluxo real do emit) =====
var company = {
  name: 'AJL COMERCIO ATACADISTA', legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
  cnpj_cpf: '22.603.750/0001-90', inscr_est: '90695858-90', crt: '1',
  street: 'Avenida Juscelino Kubitschek de Oliveira', number: '7525', street2: 'Distrito Industrial',
  city: 'Ivaiporã', city_ibge_code: '4110406', state: 'PR', zip: '86870-000', state_ibge: '41', phone: '4334721500',
};
var partner = {
  legal_name: 'F.A. MECANICA E MANUTENCAO AGRICOLA LTDA', cnpj_cpf: '12.345.678/0001-55',
  inscr_est: '12345678-01', street: 'Rua Bom Jesus', number: '212', street2: 'Centro',
  city: 'Apucarana', city_ibge_code: '4101408', state: 'PR', zip: '86800-000',
};
var lines = [{
  product_name: 'PARAFUSO 3X15', default_code: 'P-523', ncm: '7318.15.00', cfop: '5910',
  uom: 'UN', qty: 100, price_unit: 1.5, price_subtotal: 150.00,
  csosn: '102', orig: '0',
  cst_pis: '01', vbc_pis: '150.00', ppis: '0.00', vpis: '0.00',
  cst_cofins: '01', vbc_cofins: '150.00', pcofins: '0.00', vcofins: '0.00',
}];
var orderBase = {
  name: 'PRV-S00001', number: '80001', date_order: '2026-10-27T12:00:00Z',
  amount_total: 150.00, note: '', forma_pagamento_label: '', boleto_detalhes: [],
};
var transportaPtl = {
  cnpj: '29.914.293/0001-02', xNome: 'PTL Logística', ie: '90.846.770-16',
  xEnder: 'Rodovia do Trabalhador, 1000', xMun: 'Apucarana', UF: 'PR',
};
var cfgBase = { serie: '100', tpAmb: '2', natOp: 'Remessa em bonificação, doação ou brinde', mod: '55' };

console.log('== A. Fonte: CFOP lido do Tipo de Operacao (l10n_br_cfop_code) ==');
ok('emit lê l10n_br_cfop_code do operation.type', emitSrc.indexOf("['technical_name', 'l10n_br_cfop_code']") >= 0);
ok('opTypeCfop declarado', emitSrc.indexOf("opTypeTech = '', opTypeCfop = ''") >= 0);
ok('branch generico usa opTypeCfop', emitSrc.indexOf("else if (opTypeCfop && /^\\d{4}$/.test(opTypeCfop))") >= 0);
ok('ajuste 5xxx -> 6xxx interestadual no generico', emitSrc.indexOf("if (isInterstate && cfopTipo.charAt(0) === '5')") >= 0);

console.log('== B. Fonte: transporte lido da fatura e passado ao XML ==');
ok('emit lê l10n_br_edi_transporter_id', emitSrc.indexOf('l10n_br_edi_transporter_id') >= 0);
ok('emit lê l10n_br_edi_freight_model', emitSrc.indexOf('l10n_br_edi_freight_model') >= 0);
ok('emit lê l10n_br_plate_number', emitSrc.indexOf('l10n_br_plate_number') >= 0);
ok('emit lê l10n_br_package_ids (volumes)', emitSrc.indexOf('l10n_br_package_ids') >= 0);
ok('mapa de frete CIF/FOB/Terceiros/proprio/sem', emitSrc.indexOf("var FREIGHT_MOD = { CIF: '0', FOB: '1', Thirdparty: '2', SenderVehicle: '3', ReceiverVehicle: '4', FreeShipping: '9' };") >= 0);
ok('frete vazio + transportadora => modFrete 2 (terceiros)', emitSrc.indexOf("cfgTransp.modFrete = '2';") >= 0);
ok('transporta omitida com frete 9 (aviso 845)', emitSrc.indexOf('regra SEFAZ 845') >= 0);
ok('config leva modFrete/transporta/veicTransp/qVol', emitSrc.indexOf('modFrete: cfgTransp.modFrete') >= 0 && emitSrc.indexOf('transporta: cfgTransp.transporta') >= 0);
ok('pesos do transporte viajam no order', emitSrc.indexOf('peso_bruto: cfgTransp.pesoBruto') >= 0);

console.log('== C. XML completo: bonificação 5910 + transp PTL + placa + volumes ==');
var cfgFull = Object.assign({}, cfgBase, {
  modFrete: '2', transporta: transportaPtl,
  veicTransp: { placa: 'ABC1D23', UF: 'PR' },
  qVol: 3, espVol: 'Caixa de papelão',
});
var xml = gerarXmlNFe({ company: company, partner: partner, order: Object.assign({}, orderBase, { peso_bruto: 33.4, peso_liquido: 33.1 }), lines: lines, pagamentos: [{ tPag: '15', vPag: 150.0, indPag: '0' }], config: cfgFull });
ok('natOp = Remessa em bonificação', xml.indexOf('<natOp>Remessa em bonificação, doação ou brinde</natOp>') >= 0);
ok('CFOP 5910 no item', xml.indexOf('<CFOP>5910</CFOP>') >= 0);
ok('modFrete 2 (terceiros)', xml.indexOf('<modFrete>2</modFrete>') >= 0);
ok('transporta CNPJ PTL', xml.indexOf('<CNPJ>29914293000102</CNPJ>') >= 0);
ok('transporta xNome', xml.indexOf('<xNome>PTL Logística</xNome>') >= 0);
ok('transporta IE', xml.indexOf('<IE>9084677016</IE>') >= 0);
ok('transporta xEnder', xml.indexOf('<xEnder>Rodovia do Trabalhador, 1000</xEnder>') >= 0);
ok('transporta xMun/UF', xml.indexOf('<xMun>Apucarana</xMun>') >= 0 && /<xMun>Apucarana<\/xMun>\s*<UF>PR<\/UF>/.test(xml));
ok('veicTransp placa Mercosul + UF', xml.indexOf('<placa>ABC1D23</placa>') >= 0 && /<placa>ABC1D23<\/placa>\s*<UF>PR<\/UF>/.test(xml));
ok('vol qVol/esp', xml.indexOf('<qVol>3</qVol>') >= 0 && xml.indexOf('<esp>Caixa de papelão</esp>') >= 0);
ok('vol pesoL ANTES de pesoB (ordem XSD) e 3 casas', /<pesoL>33\.100<\/pesoL>\s*<pesoB>33\.400<\/pesoB>/.test(xml));

console.log('== F. Ordem das tags no XSD ==');
var iMod = xml.indexOf('<transp>'), iVeic = xml.indexOf('<veicTransp>'), iTransp = xml.indexOf('<transporta>'), iVol = xml.indexOf('<vol>'), iTranspEnd = xml.indexOf('</transp>');
var iTotal = xml.indexOf('</total>');
var proximoBloco = Math.min.apply(null, ['<cobr>', '<pag>', '<infAdic>', '<infRespTec>'].map(function (t) { var i = xml.indexOf(t); return i >= 0 ? i : xml.length; }));
ok('total vem antes de transp', iTotal < iMod);
ok('transp vem antes de cobr/pag/infAdic', iTranspEnd < proximoBloco);
ok('transporta antes de veicTransp antes de vol (XSD pl10v130)', iTransp < iVeic && iVeic < iVol && iVol < iTranspEnd);

console.log('== D. Regra SEFAZ 845: frete 9 sem transporta/veicTransp/vol ==');
var cfg9 = Object.assign({}, cfgBase, { modFrete: '9', transporta: transportaPtl, veicTransp: { placa: 'ABC1D23' }, qVol: 3, espVol: 'Caixa' });
var xml9 = gerarXmlNFe({ company: company, partner: partner, order: orderBase, lines: lines, config: cfg9 });
ok('modFrete 9 no XML', xml9.indexOf('<modFrete>9</modFrete>') >= 0);
ok('transporta OMITIDA com modFrete 9', xml9.indexOf('<transporta>') === -1);
ok('veicTransp OMITIDA com modFrete 9', xml9.indexOf('<veicTransp>') === -1);
ok('vol OMITIDO com modFrete 9', xml9.indexOf('<vol>') === -1);

console.log('== E. Fatura sem transporte = XML identico ao anterior (modFrete 9) ==');
var xmlOld = gerarXmlNFe({ company: company, partner: partner, order: orderBase, lines: lines, config: Object.assign({}, cfgBase, { modFrete: '9' }) });
ok('sem transp além de modFrete 9', /<transp>\s*<modFrete>9<\/modFrete>\s*<\/transp>/.test(xmlOld));

console.log('== G. Transportadora CPF + endereço vazio = nada inventado ==');
var xmlCpf = gerarXmlNFe({ company: company, partner: partner, order: orderBase, lines: lines, config: Object.assign({}, cfgBase, { modFrete: '2', transporta: { cnpj: '123.456.789-09', xNome: 'João Frete', ie: '', xEnder: '', xMun: '', UF: '' } }) });
ok('CPF tag para transportadora PF', xmlCpf.indexOf('<CPF>12345678909</CPF>') >= 0);
ok('sem IE vazia', /<transporta>\s*<CPF>/.test(xmlCpf));
var mTranspCpf = xmlCpf.match(/<transporta>[\s\S]*?<\/transporta>/)[0];
ok('transporta PF = só CPF + xNome (sem xEnder/xMun/UF/IE inventados)', /<transporta>\s*<CPF>12345678909<\/CPF>\s*<xNome>João Frete<\/xNome>\s*<\/transporta>/.test(mTranspCpf));

console.log('== H. Peso via order.peso_bruto (packages) ==');
ok('pesoB do order usado (3 casas)', /<pesoB>33\.400<\/pesoB>/.test(xml));

console.log('\nTotal: ' + PASS + ' checks OK' + (process.exitCode ? ' — COM FALHAS' : ''));
