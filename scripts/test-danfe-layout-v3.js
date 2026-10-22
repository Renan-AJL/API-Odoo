// Teste local: renderiza DANFE com XML nfeProc de homologacao (valida edicoes do layout)
var fs = require('fs');
var gerarDanfePdf = require('../services/danfe-pdf').gerarDanfePdf;

var NFE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc><NFe><infNFe versao="4.00" Id="NFe41260822603750000190550010000000071234567890"><ide>
<cUF>41</cUF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>100</serie><nNF>00072907</nNF>
<dhEmi>2026-10-21T10:00:00-03:00</dhEmi><tpNF>1</tpNF><dhSaiEnt>2026-10-21T10:00:00-03:00</dhSaiEnt>
</ide><emit><CNPJ>22603750000190</CNPJ><xNome>AJL FERRO E ACO LTDA</xNome>
<enderEmit><xLgr>AV ANTONIO BATISTTI</xLgr><nro>500</nro><xBairro>CENTRO</xBairro>
<xMun>PONTA GROSSA</xMun><UF>PR</UF><CEP>84015230</CEP><fone>4232200000</fone></enderEmit>
<IE>9069585890</IE></emit>
<dest><CNPJ>12345678000199</CNPJ><xNome>CLIENTE TESTE LTDA</xNome>
<enderDest><xLgr>RUA TESTE</xLgr><nro>100</nro><xBairro>JARDIM</xBairro><xMun>CURITIBA</xMun><UF>PR</UF><CEP>80000000</CEP><fone>4199990000</fone></enderDest>
<IE>1234567890</IE></dest>
<det nItem="1"><prod><cProd>PROD001</cProd><xProd>PERFIL DE ACO TESTE 6 METROS</xProd><NCM>72166900</NCM>
<CFOP>5102</CFOP><uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>40.0000000000</vUnCom><vProd>400.00</vProd></prod>
<imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>400.00</vBC><pICMS>18.00</pICMS><vICMS>72.00</vICMS></ICMS00></ICMS>
<IPI><IPITrib><CST>50</CST><vIPI>20.00</vIPI><pIPI>5.00</pIPI></IPITrib></IPI></imposto></det>
<total><ICMSTot><vBC>400.00</vBC><vICMS>72.00</vICMS><vBCST>0.00</vBCST><vST>0.00</vST><vProd>400.00</vProd>
<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>20.00</vIPI><vOutro>0.00</vOutro><vNF>420.00</vNF></ICMSTot></total>
<transp><modFrete>9</modFrete><vol><qVol>10</qVol><esp>UN</esp><pesoB>50.000</pesoB><pesoL>48.000</pesoL></vol></transp>
<pag><detPag><tPag>01</tPag><indPag>0</indPag><vPag>420.00</vPag></detPag></pag>
<infAdic><infCpl>Teste de layout - canhoto maior + nome AJL espacado + linhas de produto</infCpl></infAdic>
</infNFe></NFe>
<protNFe versao="4.00"><infProt><chNFe>41260822603750000190550010000000071234567890</chNFe>
<dhRecbto>2026-10-21T10:05:00-03:00</dhRecbto><nProt>141260000729070</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;

(async function () {
  var pdf = await gerarDanfePdf(NFE, {});
  var out = '/home/z/my-project/download/danfe_teste_layout_v3.pdf';
  fs.writeFileSync(out, pdf);
  console.log('OK ->', out, pdf.length, 'bytes');
})().catch(function (e) { console.error('ERRO:', e.message); process.exit(1); });
