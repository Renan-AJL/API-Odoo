---
Task ID: 1
Agent: main
Task: Corrigir XML NF-e rejeitado pelo SIEG (409) - comparacao com XML de referencia aceito

Work Log:
- Leu XML de referencia aceito pelo SIEG (41260716859095000133551000000002131431458224.xml)
- Comparacao linha a linha entre XML gerado e XML de referencia
- Encontrou 5 diferencas criticas:
  1. pPIS=0.00 e pCOFINS=0.00 (XML ref usa 1.65 e 7.60) - PRINCIPAL
  2. Whitespace extra no bloco <imposto>
  3. Linha em branco entre </indIEDest> e <email> no <dest>
  4. vBC total=7.90 no ICMSTot (XML ref usa 0.00 para CSOSN 103)
  5. <indPag> ausente no <detPag>
- Corrigiu sieg-odoo-emit.js: ppis=1.65, pcofins=7.60, vbc_icms=0 para Simples Nacional
- Corrigiu sieg-nfe-xml.js: blocos ICMS/PIS/COFINS compactos (sem whitespace extra), indPag, dest sem linha em branco
- Commit 67a0c8e criado

Stage Summary:
- Correcao PRINCIPAL: CST 01 (tributavel por aliquota) com pPIS=0.00 era semanticamente invalido
- O XML de referencia aceito usa CST 01 + pPIS=1.65 + pCOFINS=7.60 + vBC=0.00 para Simples Nacional
- Todas as 5 diferencas foram corrigidas
- Commit pronto para deploy no servidor do cliente
