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
