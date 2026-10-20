#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJL 20/10/2026 (noite) — Ajustes fiscais no Odoo via middleware RPC:

1. SA 1166 "Processar Pgto Itau": valor da cobranca = vProd + vIPI (igual NF).
   APENAS IPI soma — ICMS/Difal nao somam no boleto/PIX.
2. SA 1186 "Automação 2: Impostos": NAO aplicar ICMS automatico na cotacao/
   pedido (remove ICMS padrao do produto na 1a passada da linha; ICMS manual
   do vendedor e preservado). IPI preservado; DIFAL automatico mantido.
3. Reativa base.automation 15 (Automação 2) — Difal automatico volta a rodar.

Uso:
  python3 scripts/ajl_20261020_night.py            # aplica
  python3 scripts/ajl_20261020_night.py --dry-run  # so mostra
"""
import json
import sys
import urllib.request

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"

DRY = "--dry-run" in sys.argv


def rpc(model, method, args, kwargs=None, allow_write=False):
    body = {
        "model": model,
        "method": method,
        "args": args,
        "kwargs": kwargs or {},
    }
    if allow_write:
        body["allowWrite"] = True
    req = urllib.request.Request(
        MID_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.load(r)
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s.%s -> %s" % (model, method, d.get("error"))[:400])
    return d.get("result")


# ============================================================
# 1. SA 1166 — Processar Pgto Itau: valor com IPI
# ============================================================
MARCA_1166 = "AJL268-IPI"

INSERT_1166_AFTER = "partner = record.partner_id\ncompany = record.company_id\n"

BLOCO_IPI_1166 = """
# ============================================================
# AJL268-IPI (20/10/2026): valor da cobranca = vProd + vIPI (igual NF).
# APENAS O IPI SOMA. ICMS/Difal e outros impostos NAO somam no
# valor do boleto/PIX (por dentro ou informativos).
# ============================================================
_valor_base = float(record.amount_untaxed or 0.0)
_valor_ipi = 0.0
for _l in record.line_ids:
    if _l.tax_line_id and "IPI" in (_l.tax_line_id.name or "").upper():
        _valor_ipi += abs(float(_l.balance or 0.0))
_valor_cobranca = round(_valor_base + _valor_ipi, 2)
"""

OLD_1166_VALOR = '"valor_nominal": record.amount_untaxed or 0,  # AJL268: sem impostos (PIX e BOLETO)'
NEW_1166_VALOR = '"valor_nominal": _valor_cobranca,  # AJL268-IPI: vProd + vIPI (igual NF; apenas IPI soma)'


def fix_sa_1166():
    code = rpc("ir.actions.server", "read", [[1166], ["code"]])[0]["code"]
    if MARCA_1166 in code:
        print("[1166] ja atualizada (marca %s presente) — skip" % MARCA_1166)
        return
    if OLD_1166_VALOR not in code:
        raise RuntimeError("1166: ancoras nao encontradas — revisar manualmente")
    if INSERT_1166_AFTER not in code:
        raise RuntimeError("1166: ponto de insercao nao encontrado")
    novo = code.replace(
        INSERT_1166_AFTER,
        INSERT_1166_AFTER + BLOCO_IPI_1166,
        1,
    )
    novo = novo.replace(OLD_1166_VALOR, NEW_1166_VALOR, 1)
    print("[1166] Novo codigo: %d chars (antes %d)" % (len(novo), len(code)))
    if DRY:
        print("[1166] DRY-RUN — nao gravou")
        return
    rpc("ir.actions.server", "write", [[1166], {"code": novo}], allow_write=True)
    print("[1166] OK — valor cobranca = vProd + vIPI")


# ============================================================
# 2. SA 1186 — Automação 2: strip ICMS automatico (1a passada)
# ============================================================
MARCA_1186 = "AJL-SEM-ICMS-AUTO"

OLD_1186_LOOP = """            # Preserva impostos normais (ex: IPI), remove automaticos antigos
            impostos_atuais = linha[campo_taxa_linha]
            impostos_finais_ids = []

            for imposto_linha in impostos_atuais:
                remover_imposto = False
                nome_taxa_atual = imposto_linha.name or ""
                for prefixo in PREFIXOS_REMOVER:
                    if nome_taxa_atual.startswith(prefixo):
                        remover_imposto = True
                        break
                if not remover_imposto:
                    impostos_finais_ids.append(imposto_linha.id)"""

NEW_1186_LOOP = """            # Preserva impostos normais (ex: IPI), remove automaticos antigos
            impostos_atuais = linha[campo_taxa_linha]
            impostos_finais_ids = []

            # ============================================================
            # AJL-SEM-ICMS-AUTO (20/10/2026): NAO aplicar ICMS automatico
            # na cotacao/pedido de venda (pedido Renan/AJL). O ICMS padrao
            # do produto e removido SOMENTE na primeira passada da linha
            # (preco_base ainda vazio). ICMS inserido manualmente pelo
            # vendedor depois disso e PRESERVADO. IPI e DIFAL automatico
            # NAO sao tocados.
            # ============================================================
            primeira_vez_linha = preco_base_salvo <= 0

            for imposto_linha in impostos_atuais:
                remover_imposto = False
                nome_taxa_atual = imposto_linha.name or ""
                for prefixo in PREFIXOS_REMOVER:
                    if nome_taxa_atual.startswith(prefixo):
                        remover_imposto = True
                        break
                if not remover_imposto and primeira_vez_linha:
                    _nome_upper = nome_taxa_atual.upper()
                    if ("ICMS" in _nome_upper) and ("DIFAL" not in _nome_upper):
                        remover_imposto = True
                if not remover_imposto:
                    impostos_finais_ids.append(imposto_linha.id)"""


def fix_sa_1186():
    code = rpc("ir.actions.server", "read", [[1186], ["code"]])[0]["code"]
    if MARCA_1186 in code:
        print("[1186] ja atualizada (marca %s presente) — skip" % MARCA_1186)
        return
    if OLD_1186_LOOP not in code:
        raise RuntimeError("1186: bloco de impostos nao encontrado — revisar manualmente")
    novo = code.replace(OLD_1186_LOOP, NEW_1186_LOOP, 1)
    print("[1186] Novo codigo: %d chars (antes %d)" % (len(novo), len(code)))
    if DRY:
        print("[1186] DRY-RUN — nao gravou")
        return
    rpc("ir.actions.server", "write", [[1186], {"code": novo}], allow_write=True)
    print("[1186] OK — ICMS automatico removido na 1a passada; IPI/Difal preservados")


# ============================================================
# 3. Reativar base.automation 15 (Automação 2: Impostos)
# ============================================================
def ativar_automacao_2():
    recs = rpc(
        "base.automation",
        "search_read",
        [[["id", "=", 15]]],
        {"fields": ["id", "name", "active"], "context": {"active_test": False}},
    )
    if not recs:
        raise RuntimeError("base.automation 15 nao encontrada")
    ativo = recs[0].get("active")
    if ativo:
        print("[AUTO2] Ja ativa — skip")
        return
    if DRY:
        print("[AUTO2] DRY-RUN — ativaria base.automation 15 (%s)" % recs[0]["name"])
        return
    rpc("base.automation", "write", [[15], {"active": True}], allow_write=True)
    print("[AUTO2] Reativada: %s (Difal automatico)" % recs[0]["name"])


# ============================================================
# Validacao: leitura pos-escrita
# ============================================================
def validar():
    c1166 = rpc("ir.actions.server", "read", [[1166], ["code"]])[0]["code"]
    c1186 = rpc("ir.actions.server", "read", [[1186], ["code"]])[0]["code"]
    auto = rpc(
        "base.automation",
        "read",
        [[15], ["active"]],
        {"context": {"active_test": False}},
    )[0]
    print("--- VALIDACAO ---")
    print("1166 tem marca IPI:", MARCA_1166 in c1166, "| usa _valor_cobranca:", "_valor_cobranca" in c1166)
    print("1186 tem marca ICMS:", MARCA_1186 in c1186, "| primeira_vez:", "primeira_vez_linha" in c1186)
    print("base.automation 15 active:", auto.get("active"))


if __name__ == "__main__":
    print("=== AJL 20/10/2026 noite — ajustes fiscais Odoo (dry=%s) ===" % DRY)
    fix_sa_1166()
    fix_sa_1186()
    ativar_automacao_2()
    if not DRY:
        validar()
    print("Concluido.")
