#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJL 20/10/2026 — NAO aplicar ICMS automatico na cotacao/pedido (pedido Renan).

Remove os impostos ICMS (venda) dos impostos padrao dos produtos
(product.product.taxes_id). Mantem IPI, DIFAL, PIS/COFINS, ISS etc.
Fonte: era isso que aplicava ICMS automaticamente em toda linha nova
de cotacao/pedido. ICMS continua disponivel manualmente e na NF
(o emissor calcula ICMS/Difal por regra PR; fatura tem ICMS manual).

Uso:
  python3 scripts/remove-default-icms-products.py --dry-run
  python3 scripts/remove-default-icms-products.py            # aplica
  python3 scripts/remove-default-icms-products.py --limit 50
"""
import json
import sys
import urllib.request

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"

DRY = "--dry-run" in sys.argv
LIMIT = 0
for i, a in enumerate(sys.argv):
    if a == "--limit":
        LIMIT = int(sys.argv[i + 1])

BATCH = 40


def rpc(model, method, args, kwargs=None, allow_write=False):
    body = {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}
    if allow_write:
        body["allowWrite"] = True
    req = urllib.request.Request(
        MID_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=240) as r:
        d = json.load(r)
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s.%s -> %s" % (model, method, str(d.get("error"))[:400]))
    return d.get("result")


def main():
    # 1. Impostos ICMS de venda (nome contem ICMS e nao contem DIFAL)
    taxes = rpc("account.tax", "search_read",
                [[["type_tax_use", "=", "sale"]]],
                {"fields": ["id", "name"], "limit": 500})
    icms_ids = []
    for t in taxes:
        nm = (t["name"] or "").upper()
        if ("ICMS" in nm) and ("DIFAL" not in nm):
            icms_ids.append(t["id"])
    print("Impostos ICMS (venda) que serao removidos dos produtos:",
          [(i, t) for i, t in [(t["id"], t["name"]) for t in taxes] if i in icms_ids])

    if not icms_ids:
        print("Nenhum ICMS de venda encontrado — nada a fazer.")
        return

    # 2. Produtos com algum desses ICMS no taxes_id
    domain = [["taxes_id", "in", icms_ids]]
    if LIMIT:
        domain.append(["id", "<=", LIMIT])
    prod_ids = rpc("product.product", "search", [domain],
                   ({"order": "id"} if not LIMIT else {"limit": 200000, "order": "id"}))
    print("Produtos com ICMS padrao: %d" % len(prod_ids))

    alterados = 0
    grupos = {}  # novos_taxes(tuple) -> [product_ids]
    exibidos = 0
    for i in range(0, len(prod_ids), 200):
        chunk = prod_ids[i:i + 200]
        prods = rpc("product.product", "read", [chunk, ["taxes_id", "default_code"]])
        for p in prods:
            atual = p.get("taxes_id") or []
            novos = [t for t in atual if t not in icms_ids]
            if novos != atual:
                grupos.setdefault(tuple(novos), []).append(p["id"])
                alterados += 1
                if exibidos < 5:
                    print("  ex: [%s] %s taxes %s -> %s" % (p.get("default_code"), p["id"], atual, novos))
                    exibidos += 1
    print("TOTAL produtos a alterar: %d em %d grupos (dry=%s)" % (alterados, len(grupos), DRY))

    if not DRY:
        feitos = 0
        for novos, ids in grupos.items():
            for j in range(0, len(ids), 100):
                lote = ids[j:j + 100]
                rpc("product.product", "write", [lote, {"taxes_id": [[6, 0, list(novos)]]}],
                    allow_write=True)
                feitos += len(lote)
                print("  grupo taxes=%s: %d/%d escritos" % (list(novos), feitos, alterados))

    # 3. Verificacao final
    if not DRY:
        restantes = rpc("product.product", "search_count", [domain])
        print("Produtos ainda com ICMS padrao (deve ser 0): %d" % restantes)


if __name__ == "__main__":
    print("=== Remocao do ICMS padrao dos produtos (dry=%s) ===" % DRY)
    main()
