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
---
Task ID: 1
Agent: main
Task: Fix Cancelar Boleto + Add IPI/Pedido/Boleto to NF-e PDF

Work Log:
- Investigated cancelar boleto flow: server action + /cancelar/web route + Itaú API
- Found server action uses old middleware URL (odoo-middleware-unified.onrender.com → should be api-odoo-rhzf.onrender.com)
- Found server action only handles single x_studio_nosso_numero, not multiple boletos from JSON
- Updated danfe-pdf.js v2.0: added IPI columns (CST IPI, V.IPI, PIPI%) in items table, IPI + IPI Devolvido in totals, FATURA/DUPLICATAS section, BOLETO section with Nosso Numero + Linha Digitavel + Codigo de Barras
- Updated sieg-nfe-xml.js: IPI now emitted for any CRT (not just CRT=3) when cst_ipi is defined; vIPI total calculated from item sum; sale_order_number and boleto_info included in infAdic/infCpl
- Updated sieg-odoo-emit.js: reads invoice_origin/sale_order_ids for sale order number; reads x_studio_itau_resposta_json for boleto data; reads x_studio_cst_ipi/x_studio_aliquota_ipi from products; passes sale_order_number and boletoData to DANFE
- Updated sieg-api.js: gerarDanfe() now accepts opts parameter with saleOrderNumber and boletoData
- Updated routes/sieg.js: /danfe endpoint accepts sale_order_number and boleto_data in request body
- Updated routes/admin.js: fixed middleware URL references from odoo-middleware-unified.onrender.com to api-odoo-rhzf.onrender.com
- Created fix-cancelar-boleto.py script to update Odoo server action with: correct URL, multiple boleto support, fallback logic, boleto_cancelado flag
- Committed and pushed all changes (deploy triggered on Render)
- Odoo API key expired - user needs to provide new one to run fix-cancelar-boleto.py

Stage Summary:
- DANFE PDF now shows IPI, Pedido, and Boleto data
- NF-e XML includes IPI for any CRT, sale order number, and boleto info in infAdic
- Middleware URL fixed across codebase
- Cancelar Boleto server action script ready but needs new API key to execute
