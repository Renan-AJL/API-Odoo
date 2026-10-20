#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJL 21/10 — report actions do pedido (empresas/paperformat/binding)."""
import json
import urllib.request
import urllib.error

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"


def rpc(model, method, args, kwargs=None):
    body = {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}
    req = urllib.request.Request(
        MID_URL, data=json.dumps(body).encode("utf-8"),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        print("!! HTTP %s em %s.%s: %s" % (e.code, model, method, e.read().decode("utf-8")[:400]))
        raise
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s -> %s" % (model, str(d.get("error"))[:300]))
    return d.get("result")


print("=== ir.actions.report com report_name ilike sale.report_saleorder ===")
reps = rpc("ir.actions.report", "search_read",
           [[[ "report_name", "ilike", "sale.report_saleorder" ]]],
           {"fields": ["id", "name", "report_name", "paperformat_id",
                       "binding_model_id", "binding_type", "print_report_name"]})
for r in reps:
    pf = r.get("paperformat_id")
    bm = r.get("binding_model_id")
    print("  [%s] %s | report_name=%s | paperformat=%s | binding=%s(%s)" % (
        r["id"], r["name"], r["report_name"],
        pf[1] if pf else None,
        bm[1] if bm else None, r.get("binding_type")))

print()
print("=== arcos das copias (copy_1 / copy_2): primeira linha da tabela ===")
for vid in (4477, 4489):
    try:
        a = rpc("ir.ui.view", "read", [[vid], ["arch_db", "arch"]])
        arch = a[0].get("arch_db") or a[0].get("arch") or ""
        print("  view %s len=%d | th_description=%s | w-100=%s | th_quantity=%s" % (
            vid, len(arch),
            'th_description' in arch, 'w-100' in arch, 'th_quantity' in arch))
    except Exception as e:
        print("  view %s ERRO: %s" % (vid, e))

print()
print("=== Qual view o report action usa? (report action 1o registro) ===")
act = rpc("ir.actions.report", "search_read",
          [[[ "report_name", "=", "sale.report_saleorder" ]]],
          {"fields": ["id", "name", "report_name"]})
print(json.dumps(act, ensure_ascii=False))

print()
print("=== cores dos 4 layouts usados por empresa (res.company 2,3,4) ===")
cs = rpc("res.company", "read", [[2, 3, 4], ["name", "external_report_layout_id",
                                            "font", "primary_color", "secondary_color"]])
for c in cs:
    print(" ", json.dumps(c, ensure_ascii=False))
