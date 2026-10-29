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

---
Task ID: 5
Agent: main
Task: NF-e 147 autorizada + guardas anti-corrida + ICMS manual + fix cMun vazio (cStat 225 fatura 148)

Work Log:
- NF-e 00072846 (fatura 147) AUTORIZADA pela SEFAZ PR: chave 41261022603750000190551000000728521108228101, protocolo 141260426529110, XML+DANFE anexados
- Deploy overlap no Render fez 2 pollers processarem a mesma fatura: codigo novo autorizou, codigo velho (round2 bug) regravou status 'erro' por cima de 'autorizada'
- Corrigido status da fatura 147 para 'autorizada' via XML-RPC (chave confirmada, sem duplicar emissao)
- GUARDA 1 (processOne): skip se fatura ja 'autorizada' ou ja tem x_studio_nfe_chave — nunca reemitir
- GUARDA 2 (writeStatusSafe): bloqueia downgrade 'autorizada' -> 'erro'/'pendente' (le status atual antes de gravar; cancelando/cancelada permitidos)
- ICMS MANUAL (pedido do Renan): campos x_studio_icms_manual/aliquota/bc/valor em account.move — se manual ativo, sobrescreve vBC/pICMS/vICMS das linhas (rateio proporcional ao vProd); alíquota 0 => CST 40 isento; infCpl informa "ICMS informado manualmente"
- Campos criados no Odoo + view herdada 'AJL - ICMS Manual NF-e' (id 4935) no form da fatura
- Fix cStat 225 (fatura 148, EVERALDO DOS REIS JAPONES): parceiro sem cidade — cMun/xMun vazios rejeitados pelo XSD TCodMunIBGE
- Parceiro 129796: city_id=1235 Campo Magro/PR; res.city 1235 x_ibge_code corrigido 4104401->4104253 (IBGE oficial)
- Tabela IBGE_FALLBACK corrigida: Lages 4209300 (era 4209102=Joinville), Sao Jose 4209602 (era 4205407=Florianopolis), Itapema 4208302 (era 4208601), Joacaba 4209003 (era 4210600), Palhoca nome, Cacador key sem acento, Videira key uppercase

Stage Summary:
- NF-e 147 autorizada e status corrigido — NAO reemitir
- Guardas anti-duplicacao e anti-downgrade de status implementados
- ICMS manual disponivel na fatura (4 campos + view)
- Fatura 148 pronta para reemissao (cidade/IBGE corrigidos)

---
Task ID: 6
Agent: main
Task: 20/10 noite — IPI no boleto/PIX (valor igual NF) + CFOP 5901 diario transferencia + mesma sequencia NF + sem ICMS automatico em cotacao/pedido + forma de pagamento no DANFE

Work Log:
- Diagnosticado valor do boleto: Server Action 1166 "Processar Pgto Itau" enviava amount_untaxed (sem IPI). NF 72855 (autorizada, correta): vNF = amount_untaxed 35090.00 + IPI 1140.43 = 36230.43
- Middleware (routes/itau-api.js): novo corrigirValorComIpi() — le a fatura no Odoo (amount_untaxed + linhas de imposto IPI via tax_line_id ilike IPI) e corrige o valor em /pagar (boleto, PIX, cartao) e /gerar; cache 60s; so atua para faturas (nome 'NFe ...'), pedidos passam direto
- Server Action 1166 atualizado no Odoo: _valor_cobranca = amount_untaxed + soma |balance| das linhas IPI (marca AJL268-IPI)
- Diario "Transferência entre Filiais" (id 24, FAT1): emissor agora detecta (nome contendo transfer/filial/remessa ou NFE_TRANSFER_JOURNAL_IDS) -> CFOP 5901 interna / 6901 interestadual + natOp "Remessa para outra filial da mesma empresa"
- MESMA SEQUENCIA p/ os dois diarios: nNF segue o numero do NOME da fatura ('NFe 000NNNNN') quando novo (> contador global x_studio_sieg_ultimo_nfe); contador avanca para o numero usado; se numero do nome ja usado, usa contador+1 (seguro SEFAZ)
- ICMS automatico em cotacao/pedido removido: (1) limpou taxes_id ICMS de 1264 produtos (script remove-default-icms-products.py, mantidos IPI/Difal/PIS/COFINS); (2) SA 1186 "Automação 2" agora remove ICMS automatico na 1a passada da linha (preco_base vazio), preservando ICMS manual do vendedor (marca AJL-SEM-ICMS-AUTO)
- DIFAL automatico REATIVADO: base.automation 15 "Automação 2: Impostos" estava INATIVA — reativada a pedido (difal pode ser o automatico); acréscimo PR 7,5% continua desligado; Difal so p/ interestadual sem IE, por dentro, nao soma no total
- DANFE (services/danfe-pdf.js): novo campo FORMA DE PAGAMENTO (mapeia tPag/indPag/detPag, ex: "Boleto bancário — à prazo (3 parcelas)") na linha Natureza/Protocolo; testado com XML real da NF 72855
- NF 72853: fatura 150 esta CANCELADA (nfe_status=cancelada) e SEM boleto Itau (nosso_numero vazio) — condicao "remontar/reenviar se tiver boleto" nao se aplica; nada feito (nao reemitir)
- node -c OK nos 3 arquivos; scripts aplicados em producao via /api/v1/admin/odoo-rpc (1166+1186 gravados, auto 15 ativa, 0 produtos com ICMS padrao)

Stage Summary:
- Boleto/PIX/Cartao passam a usar valor fiscal igual NF (vProd + vIPI; apenas IPI soma) — na origem (SA 1166) e com garantia no middleware
- NF de diario de transferencia sai com CFOP 5901/6901 e natOp de remessa; os dois diarios (FAT/FAT1) compartilham a mesma sequencia de NF via nome da fatura
- Cotacao/pedido sem ICMS automatico (manual ok); Difal automatico reativado e nao soma no total; IPI somando
- DANFE mostra FORMA DE PAGAMENTO
- Arquivos: routes/itau-api.js, services/sieg-odoo-emit.js, services/danfe-pdf.js, scripts/ajl_20261020_night.py, scripts/remove-default-icms-products.py

---
Task ID: 7
Agent: main (sessão IM AJL)
Task: 21/10 — Layout de impressão (Cotação/Venda) igual à Matriz em TODAS as filiais + colunas de dados do produto maiores + boleto segue valor da NF (IPI soma, ICMS não) + regras fiscais (Difal auto / ICMS manual / IPI manual) confirmadas para todas as unidades

Work Log:
- Confirmado: boleto/PIX sempre seguem o valor da NF — corrigirValorComIpi() presente nos 4 pontos (routes/itau-api.js: /pagar, /gerar, /pagar boleto, PIX) + SA 1166 com _valor_cobranca = vProd + vIPI; ICMS/Difal não entram (ilike IPI apenas)
- Diagnóstico empresas: Matriz (1) = external_layout_standard + Lato + #190a1e/#010101; Pinhais (3) = cores cinza #898989/#131313; Ponta Grossa (2) e Ivaiporã (4) sem layout/cores definidos -> por isso imprimiam diferente
- Aplicado layout da Matriz em TODAS as filiais (2, 3, 4): external_report_layout_id=209 (external_layout_standard), font=Lato, primary_color=#190a1e, secondary_color=#010101 (scripts/ajl_20261021_apply.py, idempotente)
- View sale.report_saleorder_document (1126) — relatório "Cotação por PDF" (cotação E pedido, compartilhado por todas as empresas): removida class w-100 do td do nome do produto (forçava 100% de largura e espremia as colunas numéricas) + CSS AJL-COLW com larguras maiores: quantidade 10%, valor unitário 12%, desconto 6%, impostos 10%, valor total 12%; nome do produto absorve o restante
- Regras fiscais por filial — verificadas GLOBALmente (nada a aplicar): base.automation 15 "Automação 2: Impostos" ativa e sem filtro de empresa (Difal automático em todas as unidades); SA 1186 usa pedido.company_id (dinâmico, sem condições fixas de Matriz); 0 produtos com imposto de saída padrão em TODAS as empresas -> ICMS nunca automático na cotação/pedido (manual na fatura), IPI manual do vendedor
- Validação pós-escrita: 3 filiais idênticas à Matriz (True/True/True); view 1126 com marca AJL-COLW e sem w-100; relatório continua 1 página (AJL-FONT12 preservado)

Stage Summary:
- Cotação/Pedido de TODAS as filiais imprimem com o mesmo layout da Matriz (mesmo cabeçalho/rodapé/cores/fonte)
- Colunas de dados do produto (quantidade, valor, desconto, impostos, total) maiores — sem quebra de números
- Boleto = valor da NF (IPI soma; ICMS/Difal não somam) — confirmado nos 4 pontos + SA 1166
- Difal automático / ICMS manual (só fatura) / IPI manual — valendo para todas as unidades
- Arquivos: scripts/ajl_20261021_apply.py, scripts/ajl_20261021_diag.py, scripts/ajl_20261021_diag2.py, scripts/ajl_20261021_diag3.py

---
Task ID: 8
Agent: main (sessão IM AJL)
Task: 21/10 — NF-e de transferência 72857 pendente: diagnóstico + destravamento + emissão autorizada (CFOP 5901) + guard anti-chave-stale

Work Log:
- Diagnóstico: fatura 157 "NFe 00072857" (diário Transferência entre Filiais) duplicada de 156 (cancelada) — Odoo copiou x_studio_nfe_chave (nNF 72856) e protocolo 141260426915072 da NF cancelada; guarda anti-duplicação do emissor via chave presente e SKIPava todo ciclo ("ja_autorizada")
- Destravamento (scripts/ajl_20261021_destrava_157.py): limpou chave/protocolo stale da 157 -> poller emitiu em ~30s
- NF-e 72857 AUTORIZADA: chave 41261022603750000190551000000728571204677937, protocolo 141260427055777, cStat 100; XML verificado: natOp "Remessa para outra filial da mesma empresa", CFOP 5901, vNF 35090.00 (vIPI 0)
- Guard no emissor (services/sieg-odoo-emit.js): se fatura pendente/erro tem chave cujo nNF (pos. 26-34) != número do nome da fatura -> chave STALE (cópia de duplicação) -> limpa chave/protocolo e emite; faturas autorizadas nunca são tocadas
- Achado adicional: NFe 00071908 (id 129, erro, 19/10) tem o mesmo problema (chave nNF 71913 != 71908) — aguardando decisão do usuário antes de destravar

Stage Summary:
- NF 72857 de transferência autorizada com CFOP 5901 — caso resolvido
- Emissor agora auto-destrava faturas duplicadas com chave de outra NF (não trava mais para sempre)
- Arquivos: services/sieg-odoo-emit.js, scripts/ajl_20261021_destrava_157.py, scripts/ajl_20261021_nf72857_diag.py, scripts/ajl_20261021_verifica_cfop_157.py

---
Task ID: 9
Agent: main (sessão IM AJL)
Task: 29/10 — Demandas Odoo (A) 4 casas decimais desconto/acréscimo, (B) financeiro do contato só Admin Financeiro, (C) VALOR TOTAL junto ao canhoto do DANFE

Work Log:
- (A) Odoo: decimal.precision 'Discount' já estava 4 (linha discount herda); aplicado digits="[16, 4]" nas views 4953 (Acréscimo %/R$), 3513 (Desconto Aplicado R$), 4832 (wizard Desconto/Acréscimo %/R$) e 4830 (painel aprovação, x_desconto_solicitado 2x); backups backup_demAB_20261029_132948.json
- (B) Odoo: page "Financeiro AJL" (views 4985 + override na 4468) e campos Limite de Crédito (4468) / Crédito Disponível (5013) restritos a ajl.group_admin_financeiro; banner VERMELHO de cliente bloqueado continua visível a todos (guarda de venda), botões já eram restritos
- (C) Middleware: services/danfe-pdf.js v2.1 — VALOR TOTAL DA NOTA (vNF do ICMSTot) em destaque no canhoto: caixa esquerda (bold 7, direita da linha DATA/IDENTIFICACAO, acima da linha da assinatura) e caixa do número da NF (abaixo do cliente, sobrevive ao picote); testado localmente com XML real nfe_00073287 (R$ 59.557,49) — layout sem colisões (scripts/test-danfe-v21.js)
- server.js -> version 1.2.4-danfe-valor-canhoto p/ confirmar deploy no Render

Stage Summary:
- A/B aplicados direto no Odoo prod (sem deploy necessário)
- C precisa deploy do middleware no Render (junto com PIX 1.2.3 pendente desde 27/10)
- Arquivos: services/danfe-pdf.js, scripts/test-danfe-v21.js, server.js, worklog.md
