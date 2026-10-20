#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJL 21/10/2026 — Diagnóstico FASE A2: caminhos de impressão da SO.
413 'Cotação por PDF' (sem binding) vs 455 'Quotation / Order' (binding!) vs 414 PRO FORMA.
Descobre quem chama o quê e o que cada template renderiza."""
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
        raise RuntimeError("HTTP %s em %s.%s: %s" % (
            e.code, model, method, e.read().decode("utf-8")[:500]))
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s.%s -> %s" % (model, method, str(d.get("error"))[:500]))
    return d.get("result")


def section(t):
    print("\n" + "=" * 70)
    print(t)
    print("=" * 70)


section("1. ações de relatório 413 / 414 / 455 — detalhe completo")
acs = rpc("ir.actions.report", "read",
          [[413, 414, 455],
           ["name", "report_name", "report_type", "binding_model_id", "binding_view_types",
            "paperformat_id", "print_report_name", "attachment"]])
for a in acs:
    print("  id=%s\n    name=%s\n    report_name=%s\n    report_type=%s | binding=%s | view_types=%s\n    print_report_name=%s | paper=%s | attachment=%s" % (
        a["id"], a["name"], a["report_name"], a.get("report_type"),
        a.get("binding_model_id"), a.get("binding_view_types"),
        a.get("print_report_name"), a.get("paperformat_id"),
        a.get("attachment")))

section("2. views com key ~ report_saleorder (todas)")
vs = rpc("ir.ui.view", "search_read", [[["key", "like", "report_saleorder"]]],
         {"fields": ["id", "key", "name", "inherit_id", "type", "active", "write_date"]})
raw_vid = None
for v in vs:
    print("  id=%-5s key=%-45s inherit=%-5s active=%s w=%s" % (
        v["id"], v["key"], (v.get("inherit_id") or [0])[0], v.get("active"), v.get("write_date")))
    if v["key"] == "sale.report_saleorder_raw":
        raw_vid = v["id"]

section("3. arch de sale.report_saleorder_raw (id=%s)" % raw_vid)
if raw_vid:
    va = rpc("ir.ui.view", "read", [[raw_vid], ["arch_db", "arch", "key", "name"]])
    raw_arch = va[0].get("arch_db") or va[0].get("arch") or ""
    print("  len=%d | t-call report_saleorder_document: %s | t-call external_layout: %s | AJL-COLW: %s" % (
        len(raw_arch),
        "sale.report_saleorder_document" in raw_arch,
        "external_layout" in raw_arch,
        "AJL-COLW" in raw_arch))
    print("  --- primeiros 1200 chars ---")
    print(raw_arch[:1200])
    open("/home/z/my-project/scripts/out_raw.html", "w").write(raw_arch)

section("4. ir.model.data dos reports (quem criou o raw?)")
try:
    mds = rpc("ir.model.data", "search_read",
              [[["model", "=", "ir.actions.report"], ["res_id", "in", [413, 455, 414]]]],
              {"fields": ["module", "name", "res_id"]})
    for m in mds:
        print("  %s.%s -> action %s" % (m["module"], m["name"], m["res_id"]))
    mds2 = rpc("ir.model.data", "search_read",
               [[["model", "=", "ir.ui.view"], ["res_id", "in", [raw_vid or 0]]]],
               {"fields": ["module", "name", "res_id"]})
    for m in mds2:
        print("  %s.%s -> view %s" % (m["module"], m["name"], m["res_id"]))
except RuntimeError as e:
    print("(ir.model.data read falhou: %s)" % str(e)[:200])

section("5. quem chama a 413? botões/server actions")
try:
    sa = rpc("ir.actions.server", "search_read",
             [[["binding_model_id", "=", "sale.order"]]],
             {"fields": ["id", "name", "state", "binding_view_types"]})
    for s in sa:
        print("  server action id=%s name=%s state=%s" % (s["id"], s["name"], s["state"]))
except RuntimeError as e:
    print("(server actions: %s)" % str(e)[:200])
try:
    f = rpc("ir.ui.view", "search_read", [[["key", "=", "sale.view_order_form"]]],
            {"fields": ["id"]})
    if f:
        fa = rpc("ir.ui.view", "read", [[f[0]["id"]], ["arch_db", "arch"]])
        farch = fa[0].get("arch_db") or fa[0].get("arch") or ""
        print("  form SO len=%d | menciona '413': %s | 'Cotação por PDF': %s | report_action: %s" % (
            len(farch), "413" in farch, "Cota" in farch, "report_action" in farch))
        for ln in farch.split("\n"):
            if "413" in ln or "Cota" in ln or "report" in ln.lower():
                print("    | %s" % ln.strip()[:160])
except RuntimeError as e:
    print("(form view: %s)" % str(e)[:200])

print("\nFase A2 concluída.")
