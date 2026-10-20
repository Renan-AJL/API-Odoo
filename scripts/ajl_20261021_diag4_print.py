#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJL 21/10/2026 — Diagnóstico FASE A: por que a impressão de cotação/pedido
das filiais ainda difere da Matriz mesmo após unificação do branding (Task 7)?

Checa (tudo read-only, whitelist atual):
  1. res.company 1-4: font/cores/layout + paperformat_id (se existir no Odoo 19)
  2. ir.actions.report vinculados a sale.order (pode haver >1 binding!)
  3. view 1126: AJL-COLW e w-100 ainda presentes? (upgrade de módulo pode ter revertido)
  4. view do layout externo (209): key/origem + cópias custom
  5. views que herdam do layout externo com condições por empresa (t-if company.id)
  6. sample de SOs por empresa p/ render na fase B
"""
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


# ---------------------------------------------------------------- 1. empresas
section("1. res.company 1-4 — branding + paperformat")
FIELDS = ["name", "font", "primary_color", "secondary_color", "external_report_layout_id"]
try:
    comps = rpc("res.company", "read", [[1, 2, 3, 4], FIELDS + ["paperformat_id"]])
    tem_paper = True
except RuntimeError as e:
    print("(paperformat_id indisponível: %s)" % str(e)[:150])
    comps = rpc("res.company", "read", [[1, 2, 3, 4], FIELDS])
    tem_paper = False
for c in comps:
    lay = c.get("external_report_layout_id")
    print("  [%s] %s | font=%s | prim=%s sec=%s | layout=%s%s" % (
        c["id"], c["name"], c.get("font"), c.get("primary_color"),
        c.get("secondary_color"), lay,
        (" | paper=%s" % c.get("paperformat_id")) if tem_paper else ""))

# ------------------------------------------------------------- 2. bindings SO
section("2. ir.actions.report com binding em sale.order")
binds = rpc("ir.actions.report", "search_read",
            [[["binding_model_id", "=", "sale.order"]]],
            {"fields": ["id", "name", "report_name", "binding_type",
                        "paperformat_id", "attachment", "report_type"]})
for b in binds:
    print("  id=%s | %s | report_name=%s | paper=%s | attachment=%s | type=%s" % (
        b["id"], b["name"], b["report_name"], b.get("paperformat_id"),
        b.get("attachment"), b.get("binding_type")))
rel = rpc("ir.actions.report", "search_read",
          [[["report_name", "like", "saleorder"]]],
          {"fields": ["id", "name", "report_name", "binding_model_id", "paperformat_id"]})
print("  -- ações com report_name ~saleorder:")
for a in rel:
    print("  id=%s | %s | %s | binding=%s | paper=%s" % (
        a["id"], a["name"], a["report_name"], a.get("binding_model_id"), a.get("paperformat_id")))

# --------------------------------------------------------------- 3. view 1126
section("3. view sale.report_saleorder_document — AJL-COLW ainda lá?")
vs = rpc("ir.ui.view", "search_read", [[["key", "=", "sale.report_saleorder_document"]]],
         {"fields": ["id", "name", "write_date"]})
vid = vs[0]["id"]
va = rpc("ir.ui.view", "read", [[vid], ["arch_db", "arch"]])
arch = va[0].get("arch_db") or va[0].get("arch") or ""
print("  view=%s write_date=%s | len(arch)=%d" % (vid, vs[0].get("write_date"), len(arch)))
print("  AJL-COLW presente: %s" % ("AJL-COLW" in arch))
print("  AJL-FONT12 presente: %s" % ("AJL-FONT12" in arch))
print("  w-100 no td_product_name: %s" % ('<td name="td_product_name" class="w-100"' in arch))
open("/home/z/my-project/scripts/out_view1126.html", "w").write(arch)

# ------------------------------------------------------------- 4/5. layout ext
section("4. view do layout externo (external_report_layout_id da Matriz)")
lay_id = comps[0]["external_report_layout_id"][0]
v209 = rpc("ir.ui.view", "read", [[lay_id],
                                  ["key", "name", "inherit_id", "mode", "type", "active"]])[0]
print("  view %s: key=%s name=%s inherit=%s mode=%s" % (
    lay_id, v209.get("key"), v209.get("name"), v209.get("inherit_id"), v209.get("mode")))

section("5. todas as views com key ~ external_layout (procura cópias custom)")
lays = rpc("ir.ui.view", "search_read",
           [[["key", "like", "external_layout"]]],
           {"fields": ["id", "key", "name", "inherit_id", "active", "website_id", "write_date"]})
for l in lays:
    print("  id=%-5s key=%-38s inherit=%-5s active=%s site=%s w=%s" % (
        l["id"], l["key"], (l.get("inherit_id") or [0])[0], l.get("active"),
        l.get("website_id"), l.get("write_date")))

section("5b. herdeiros diretos do layout usado + condições por empresa")
herd = rpc("ir.ui.view", "search_read", [[["inherit_id", "=", lay_id]]],
           {"fields": ["id", "key", "name", "active"]})
print("  herdeiros diretos: %s" % [(h["id"], h.get("key")) for h in herd])
for h in herd:
    ha = rpc("ir.ui.view", "read", [[h["id"]], ["arch_db", "arch"]])
    ha_arch = ha[0].get("arch_db") or ha[0].get("arch") or ""
    if "company.id" in ha_arch:
        print("  !! view %s (%s) contém company.id no arch" % (h["id"], h.get("key")))

# ------------------------------------------------------------- 6. sample SOs
section("6. SOs recentes por empresa (p/ render na fase B)")
sos = rpc("sale.order", "search_read",
          [[["company_id", "in", [1, 2, 3, 4]]]],
          {"fields": ["name", "company_id", "state"], "order": "id desc", "limit": 80})
vistos = {}
for s in sos:
    cid = s["company_id"][0]
    if cid not in vistos:
        vistos[cid] = s
for cid in sorted(vistos):
    s = vistos[cid]
    print("  empresa %s -> SO id=%s %s (%s)" % (cid, s["id"], s["name"], s["state"]))

print("\nFase A concluída.")
