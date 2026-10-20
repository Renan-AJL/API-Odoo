#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJL 21/10 — verifica escopo de empresa na SA 1186 + variantes de view."""
import json
import urllib.request

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"


def rpc(model, method, args, kwargs=None):
    body = {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}
    req = urllib.request.Request(
        MID_URL, data=json.dumps(body).encode("utf-8"),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.load(r)
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s -> %s" % (model, str(d.get("error"))[:300]))
    return d.get("result")


print("=== SA 1186 (Automação 2: Impostos) — procura condições de empresa ===")
code = rpc("ir.actions.server", "read", [[1186], ["code"]])[0]["code"]
print("len:", len(code))
for kw in ["company", "empresa", "filial", "Matriz", "Curitiba", "warehouse_id"]:
    idx = 0
    low = code.lower()
    k = kw.lower()
    hits = []
    while True:
        i = low.find(k, idx)
        if i < 0:
            break
        hits.append(code[max(0, i - 60): i + 80].replace("\n", " | "))
        idx = i + len(k)
    print("  '%s': %d ocorrencias" % (kw, len(hits)))
    for h in hits[:4]:
        print("      ...", h)

print()
print("=== SA 1166 — procura condições de empresa ===")
code2 = rpc("ir.actions.server", "read", [[1166], ["code"]])[0]["code"]
low2 = code2.lower()
for kw in ["company", "filial", "warehouse_id"]:
    print("  '%s': %d ocorrencias" % (kw, low2.count(kw.lower())))

print()
print("=== Views relacionadas ao relatorio de venda ===")
views = rpc("ir.ui.view", "search_read",
            [[[ "key", "ilike", "report_saleorder" ]]],
            {"fields": ["id", "name", "key", "type", "inherit_id", "mode"]})
for v in views:
    inh = (v.get("inherit_id") or [0, ""])[1]
    print("  [%s] %s | key=%s | type=%s | inherit=%s | mode=%s" % (
        v["id"], v["name"], v.get("key"), v.get("type"), inh, v.get("mode")))

print()
print("=== Views external_layout (variantes de cabecalho) ===")
views2 = rpc("ir.ui.view", "search_read",
             [[[ "key", "ilike", "external_layout" ]]],
             {"fields": ["id", "name", "key", "type"]})
for v in views2:
    print("  [%s] %s | key=%s | type=%s" % (v["id"], v["name"], v.get("key"), v.get("type")))

print()
print("=== external_report_layout_id exato da Matriz (empresa 1) ===")
c1 = rpc("res.company", "read", [[1], ["external_report_layout_id", "font",
                                      "primary_color", "secondary_color"]])[0]
print(json.dumps(c1, ensure_ascii=False))
