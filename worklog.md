# Worklog - Diff-guard + Retry para SerializationFailure

## Task ID: 1
## Agent: main
## Task: Implementar diff-guard + retry com backoff+jitter para resolver SerializationFailure (SQLSTATE 40001) em colisoes de escrita concorrente no Odoo

### Work Log:
- Leu e analisou todo o codebase do middleware (routes/cep.js, routes/cnpj.js, services/odoo-*, utils/retry.js, config/index.js, odoo-module Python)
- Identificou que o fluxo CEP (routes/cep.js /odoo-webhook) faz write direto sem diff-guard e sem retry
- Identificou que o fluxo CNPJ (Python: res_partner.py, crm_lead.py) faz write direto sem diff-guard
- Criou utils/odoo-write-guard.js com: normalizeCep/Cnpj, extractMany2oneId, fieldValuesEqual, diffGuard, isRetriableOdooError, retryWithJitter, odooWriteGuarded
- Atualizou routes/cep.js v2.0: substituiu write direto por odooWriteGuarded nos dois endpoints (/consultar-odoo e /odoo-webhook)
- Atualizou res_partner.py: adicionou _diff_guard, _write_with_retry, _normalize_cep/cnpj/str
- Atualizou crm_lead.py: adicionou writes independentes (lead e partner separados), diff-guard + retry proprio para cada um
- Criou scripts/acceptance-test.js para testes de aceitacao pos-deploy
- Executou testes unitarios: 26 passed (normalize, fieldValuesEqual, isRetriableOdooError, retry paths)
- Executou testes de integracao: 14 passed (idempotente, mudanca real, id inexistente, retry em colisao)
- Executou testes E2E: 2 passed (idempotente com CEP real, mudanca real com diff-guard)
- Verificou sintaxe Python: sem erros
- Committed e pushed para GitHub (Render auto-deploy)
- Verificou deploy: servidor respondendo HTTP 200

### Stage Summary:
- **Novo arquivo**: utils/odoo-write-guard.js (367 linhas) - diff-guard + retry + jitter
- **Novo arquivo**: scripts/acceptance-test.js (110 linhas) - testes de aceitacao
- **Modificado**: routes/cep.js - v2.0 com odooWriteGuarded
- **Modificado**: res_partner.py - diff-guard + retry + SerializationFailure
- **Modificado**: crm_lead.py - writes independentes + diff-guard + retry
- **Deploy**: Pushed to origin/main, Render deploy active (HTTP 200)
- **Resultado esperado**: maioria dos write-backs vira no-op (diff-guard), raros writes reais passam a se auto-curar em colisao (retry), erros SerializationFailure cessam
---
Task ID: 1
Agent: main
Task: Fix TE send-invoice endpoint — Defect 1 (readInvoiceFull malformed XML-RPC) and Defect 2 (FIELD-SETUP broken detection)

Work Log:
- Explored codebase: found TE flow files in /home/z/my-project/itau-odoo/ (services/odoo-te.js, services/odoo-field-setup.js, routes/delivery.js, routes/webhook-te.js)
- Analyzed all XML-RPC read/search_read calls in TE flow
- Defect 1 Fix: Added flattenIds() helper to normalize IDs (handles int, [int], [[int]], [[int,"name"]], [int,int,...])
- Defect 1 Fix: Updated read() wrapper to use flattenIds(ids)
- Defect 1 Fix: Updated safeReadCustom() to use flattenIds(ids)
- Defect 1 Fix: Changed searchRead() to use native Odoo search_read (single call) instead of search+read
- Defect 1 Fix: Fixed findSaleOrderByInvoice estrategia 3: lineIds now uses flattenIds(rawLineIds)
- Defect 1 Fix: Fixed getInvoiceLines: lineIds now uses flattenIds(inv.line_ids)
- Defect 1 Fix: Fixed getProducts: uses flattenIds(productIds) for defensive safety
- Defect 1 Fix: Changed delivery.js motorista read from direct executeKw to odooTe.read() wrapper
- Defect 2 Fix: Changed FIELD-SETUP domain from model_id.model to model (char field direto)
- Defect 2 Fix: Simplified kwargs fields to ['name', 'model', 'state'] per spec
- Defect 2 Fix: Added detectionOk flag — if search_read fails, aborts creation to avoid duplicate errors
- Defect 2 Fix: Added early return if all 15 fields exist (skips creation entirely)
- Verified draft invoice handling already in place (409 response)
- Verified nonexistent invoice handling already in place (404 response)
- Verified ir.attachment uses 'raw' (not 'datas') in all files
- All syntax checks passed (node -c)

Stage Summary:
- services/odoo-te.js: flattenIds() added, read/safeReadCustom/searchRead/getProducts/getInvoiceLines/findSaleOrderByInvoice all fixed
- services/odoo-field-setup.js: domain changed to model (not model_id.model), detection failure aborts creation, early return when all fields exist
- routes/delivery.js: motorista partner read uses odooTe.read() wrapper
- All 15 x_studio_itau_* fields already exist — FIELD-SETUP will now detect them correctly and skip creation

---
Task ID: 2
Agent: main
Task: Cancelar boletos, corrigir emissão triplicada, verificar PIX, ajustar TudoEntregue

Work Log:
- Boletos hoje: 2 faturas (ID 114 e 111) com boletos TRIPICADOS (3 NNs cada)
- Cancelamento Itaú: API retorna 403 "Erro ao obter dados rota filter failed" — escopo OAuth2 não autorizado para cancelamento
- Fix idBoleto: DAC estava duplicado no cálculo (23 chars → 22 chars). Corrigido.
- Fix CM PATCH: Adicionado body {motivo_baixa: 'CANCELAMENTO'} e parâmetro body na função
- Emissão triplicada: Root cause = Odoo Server Action dispara 3x por fatura + sem guarda Odoo-side
- Fix: Adicionada função checkOdooBoletoExists() — checa x_studio_itau_nosso_numero no Odoo antes de emitir
- Fix: Odoo-side dedup integrado em /gerar e /pagar — se fatura já tem boleto, retorna DEDUP sem emitir
- PIX: Token OK, polling OK, sem erros
- TudoEntregue: send-invoice testado com fatura 114 → SUCESSO (te_order_id=855, te_received=true)
- TudoEntregue: Fatura 111 também enviada com sucesso (te_order_id=852)
- TudoEntregue: Fatura inexistente 999999999 → 404 correto
- Motorista: Adicionado campo x_studio_motorista (Selection) no account.move com 24 motoristas TE
- Motorista: Campo aparece na aba Itau do form view (grupo "Entrega")
- Motorista: send-invoice já lê invoice.x_studio_motorista primeiro (delivery.js linha 645)

Stage Summary:
- Cancelar boletos: BLOQUEADO pelo Itaú (403 — scope não autorizado). Precisa verificar com Itaú.
- Emissão triplicada: CORRIGIDA com Odoo-side dedup (definitivo, sobrevive a restart)
- PIX: FUNCIONANDO
- TudoEntregue: FUNCIONANDO (faturas 114 e 111 enviadas com sucesso)
- Motorista: Campo Selection adicionado na fatura com 24 motoristas TE

---
Task ID: 3
Agent: main
Task: Revisar emissão de boletos e adicionar guard de re-emissão

Work Log:
- Revisão completa do código de emissão em routes/itau-api.js (888 linhas)
- checkBoletoAtivo() já existia e funcionava bem (consulta Odoo + Itaú API)
- Identificado problema: /gerar endpoint NÃO tinha lock anti-concorrência
- Identificado problema: checkBoletoAtivo() falha-aberta (permite emissão se Odoo falha)
- Identificado problema: mensagens de erro sem acentos (Itau → Itaú, emissao → emissão)
- Identificado problema: sem chatter quando bloqueia re-emissão
- FIX: Adicionado lock anti-concorrência ao /gerar (mesmo padrão do /pagar)
- FIX: checkBoletoAtivo() agora é falha-fechada (bloqueia se não consegue verificar)
- FIX: Mensagens com acentos: "Primeiro, cancele o boleto no Itaú para nova emissão"
- FIX: postBoletoBlockedChatter() posta nota no chatter quando bloqueia
- FIX: Chatter postado tanto em /pagar quanto em /gerar quando bloqueia
- Merge: Resolvidos conflitos com remote (cancelarBoleto + extrato)
- Push para GitHub: commit 54b3558

Stage Summary:
- Emissão de boletos segue forma_pagamento via parseFormaPagamento() ✅
- Proteção 3 camadas contra duplicação: checkBoletoAtivo() + lock + cache ✅
- Guard de re-emissão: "Primeiro, cancele o boleto no Itaú para nova emissão" ✅
- Falha-fechada: bloqueia se não consegue verificar status ✅
- Chatter: nota postada na fatura quando bloqueia ✅
- Código pushado para GitHub (Render deploy pendente - manual deploy)

---
Task ID: 4
Agent: main
Task: Configurar campos PIX no sale.order com nomes reais do Odoo Studio e atualizar ações

Work Log:
- Descobriu nomes reais dos campos Studio no sale.order via dry-run:
  - x_studio_related_field_2jf_1k4uaua7n (html) - "Boletos e QRCode"
  - x_studio_boletos_pix (html) - "Cód PIX"
- Identificou que x_studio_boletos_pix é html (não text como assumido)
- Identificou 87 campos x_studio_* no sale.order, incluindo 6 x_studio_itau_* já existentes
- Atualizou setup-pix-sales.js para usar nomes reais dos campos Studio
- Criou pushPixToSaleOrder() em odoo-push.js - grava PIX CC e HTML nos campos do sale.order
- Criou pushBoletoHtmlToSaleOrder() em odoo-push.js - grava HTML do boleto no sale.order (Finance)
- Atualizou itau-api.js /pagar para chamar pushPixToSaleOrder após criar PIX
- Atualizou itau-api.js /pagar para chamar pushBoletoHtmlToSaleOrder após emitir boleto
- Criou update-pix-actions.js para atualizar Server Action e Automated Actions
- Atualizou Server Action "Gerar PIX" (id=1483) com código sandbox-safe que escreve nos campos corretos
- Atualizou Automated Action "PIX: Travar forma de pagamento" (id=1477/94) para checar x_studio_boletos_pix
- Atualizou Automated Action "PIX: Bloquear cancelar" (id=1478/95) para checar x_studio_boletos_pix
- Verificou sintaxe de todos os arquivos modificados

Stage Summary:
- Server Action "Gerar PIX" atualizado: escreve em x_studio_related_field_2jf_1k4uaua7n (HTML) e x_studio_boletos_pix (Cód PIX) e x_studio_itau_* campos
- Automated Actions atualizadas: agora checam x_studio_boletos_pix (antes: x_studio_itau_tipo_pagamento)
- Middleware PIX (/pagar) agora também grava dados no sale.order vinculado
- Boleto HTML também pode ser gravado no sale.order quando Finance emite
- Arquivos modificados: scripts/setup-pix-sales.js, services/odoo-push.js, routes/itau-api.js
- Arquivo criado: scripts/update-pix-actions.js

---
Task ID: 4b
Agent: main
Task: Executar setup-pix-sales.js e update-pix-actions.js em produção + atualizar pushPixToSaleOrder com campos x_studio_itau_*

Work Log:
- Rodou setup-pix-sales.js com API key (sem --dry-run)
- Confirmou 87 campos x_studio_* em sale.order, incluindo 6 x_studio_itau_* já existentes
- Confirmou campos PIX: x_studio_related_field_2jf_1k4uaua7n (html) e x_studio_boletos_pix (html)
- Server Action "Gerar PIX" já existe (id=1483)
- Automated Action "PIX: Travar forma de pagamento" já existe (id=94)
- Automated Action "PIX: Bloquear cancelar/voltar rascunho" já existe (id=95)
- Rodou update-pix-actions.js para atualizar código do Server Action e Automated Actions
- Server Action atualizado: agora grava x_studio_itau_tipo_pagamento, x_studio_itau_situacao, x_studio_itau_txid, x_studio_itau_pix_status, x_studio_itau_pix_copia_cola, x_studio_itau_boletos_html
- Atualizou pushPixToSaleOrder() em odoo-push.js para também gravar nos campos x_studio_itau_*
- Commit e push: a3f789f

Stage Summary:
- Setup PIX sales 100% completo no Odoo (campos + Server Action + Automated Actions)
- Middleware (odoo-push.js) agora grava campos x_studio_itau_* no sale.order automaticamente
- Deploy acionado via push para main (Render auto-deploy)

---
Task ID: 4
Agent: main
Task: URGENTE 20/10 - Fix icmsInternoPR is not defined (NF-e 00072846) + IPI no total (S01472) + visual pedido venda

Work Log:
- Diagnosticado erro 'icmsInternoPR is not defined' que bloqueava emissao NF-e (faturas 146/147, pedido S01522)
- Root cause: variavel icmsInternoPR declarada em processOne() mas referenciada dentro de buildLineData() (scopes diferentes) — ReferenceError apos descoberta de NCM
- Fix: buildLineData() agora recebe icmsInternoPR como parametro (processOne passa) + fallback defensivo 12% se undefined
- Diagnostico Odoo S01472: amount_total=65047.50 JA inclui IPI 3.25% (tax 481) no banco — o problema era a VIEW
- Root cause view: Studio view 3513 tinha <field name="amount_total" string="Sub total"/> e <field name="x_studio_total"/> (related=amount_untaxed) — rotulos invertidos
- Fix view 3513 (aplicado via XML-RPC): amount_untaxed string="Sub total" + amount_total string="Total" — agora Sub total=63.000,00 / Total=65.047,50 (c/ IPI)
- Fix report 1126 report_saleorder_document (aplicado via XML-RPC): bloco <style> AJL-FONT12 — fonte 12px global, @page A4 10mm/8mm, padding 3px 5px, word-wrap, imagens max-height 60px, page-breaks neutralizados
- Verificado: 0 produtos com x_studio_aliquota_ipi > 0 — IPI vem dos taxes_id dos produtos (1018 tem apenas ICMS 19.5%; IPI 3.25% foi adicionado manualmente na linha S01472)
- Verificado: 767 linhas de pedidos em rascunho — todas com IPI correto, nada a corrigir
- Fatura 146 nao existe mais (deletada); fatura 147 = NFe 00072846 (posted, nfe_status=erro, untaxed 2016, tax 241.92 ICMS 12%, total 2257.92)
- Poller SIEG so processa x_studio_nfe_status='pendente' — fatura 147 sera reativada para 'pendente' apos deploy

Stage Summary:
- services/sieg-odoo-emit.js: icmsInternoPR passado como parametro para buildLineData (fix NF-e)
- Odoo view 3513: Sub total/Total corrigidos (IPI agora aparece no Total)
- Odoo report 1126: fonte 12px + containers ajustados
- Pendente observacao: fatura 147 total Odoo = 2257.92 (ICMS 12% soma no total do Odoo pois price_include=false) — XML NF-e ignora ICMS no vNF (vNF = vProd + vIPI), correto fiscalmente; avaliar com cliente se ICMS deve virar price_include (afetaria vBC/vProd do XML)
