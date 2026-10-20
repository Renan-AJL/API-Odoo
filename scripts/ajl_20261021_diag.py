#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJL 21/10/2026 — Diagnóstico (leitura apenas):

1. Empresas (Matriz + filiais) e seus layouts de relatório
2. base.automation de impostos (escopo/empresas)
3. Produtos com ICMS padrão restante, por empresa
4. View sale.report_saleorder_document (arco da tabela de linhas)
5. ir.actions.report do pedido (paperformat)

Uso:
  python3 scripts/ajl_20261021_diag.py
"""
import json
import sys
import urllib.request

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"


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
        raise RuntimeError("RPC falhou: %s.%s -> %s" % (model, method, str(d.get("error"))[:400]))
    return d.get("result")


def main():
    print("=" * 70)
    print("1) EMPRESAS + LAYOUT DE RELATORIO")
    print("=" * 70)
    fields = ["name", "external_report_layout_id", "font", "primary_color",
              "secondary_color", "street", "city"]
    try:
        comps = rpc("res.company", "search_read", [[]], {"fields": fields})
        for c in comps:
            lay = c.get("external_report_layout_id")
            print("  [%s] %s | layout=%s font=%s pri=%s sec=%s | %s/%s" % (
                c["id"], c["name"],
                lay[1] if lay else None,
                c.get("font"), c.get("primary_color"), c.get("secondary_color"),
                c.get("city"), c.get("street")))
    except Exception as e:
        print("  ERRO companies:", e)

    print("=" * 70)
    print("2) BASE.AUTOMATIONS (impostos)")
    print("=" * 70)
    autos = rpc("base.automation", "search_read", [[]],
                {"fields": ["id", "name", "active", "model_id", "filter_domain", "trigger"],
                 "context": {"active_test": False}})
    for a in autos:
        m = a.get("model_id")
        print("  [%s] %s | active=%s | model=%s | trigger=%s" % (
            a["id"], a["name"], a.get("active"),
            m[1] if m else None, str(a.get("trigger"))[:60]))
        fd = a.get("filter_domain")
        if fd:
            print("        filter_domain: %s" % str(fd)[:300])

    print("=" * 70)
    print("3) PRODUTOS COM ICMS PADRAO RESTANTE (por empresa)")
    print("=" * 70)
    prods = rpc("product.template", "search_read",
                [[[ "taxes_id", "!=", False ]]],
                {"fields": ["name", "company_id", "taxes_id", "list_price"]})
    total = len(prods)
    icms_prods = []
    for p in prods:
        taxes = p.get("taxes_id") or []
        if not taxes:
            continue
        taxnames = rpc("account.tax", "read", [taxes, ["name"]])
        nomes = [t["name"] for t in taxnames]
        tem_icms = any("ICMS" in (n or "").upper() and "DIFAL" not in (n or "").upper()
                       and "ST" not in (n or "").upper() for n in nomes)
        if tem_icms:
            icms_prods.append((p, nomes))
    print("  produtos com alguma taxa de saida: %d | com ICMS padrao: %d" % (total, len(icms_prods)))
    by_co = {}
    for p, nomes in icms_prods:
        co = (p.get("company_id") or [0, "Todas (global)"])[1]
        by_co.setdefault(co, []).append((p["name"], nomes))
    for co, itens in sorted(by_co.items()):
        print("  - %s: %d produtos" % (co, len(itens)))
        for nome, nomes in itens[:8]:
            print("      * %s -> %s" % (nome[:60], nomes))
        if len(itens) > 8:
            print("      ... (+%d)" % (len(itens) - 8))

    print("=" * 70)
    print("4) VIEW sale.report_saleorder_document")
    print("=" * 70)
    views = rpc("ir.ui.view", "search_read",
                [[[ "key", "=", "sale.report_saleorder_document" ]]],
                {"fields": ["id", "name", "key", "type", "inherit_id"]})
    if not views:
        views = rpc("ir.ui.view", "search_read",
                    [[[ "name", "ilike", "report_saleorder_document" ]]],
                    {"fields": ["id", "name", "key", "type", "inherit_id"]})
    for v in views:
        print("  view id=%s name=%s key=%s type=%s inherit=%s" % (
            v["id"], v["name"], v.get("key"), v.get("type"),
            (v.get("inherit_id") or [0, ""])[1]))
    if views:
        archs = rpc("ir.ui.view", "read", [[views[0]["id"]], ["arch_db", "arch"]])
        arch = (archs[0].get("arch_db") or archs[0].get("arch") or "")
        print("  arch len: %d" % len(arch))
        # Achar a tabela de linhas
        i0 = arch.find("<t t-if=\"not line.display_type\"")
        if i0 < 0:
            i0 = arch.find('name="th_description"')
        if i0 < 0:
            i0 = arch.find("<table")
        # imprimir trecho da tabela (th + td)
        i_th = arch.find("th_description")
        if i_th > 0:
            print("  --- TRECHO THEAD ---")
            print(arch[max(0, i_th - 600): i_th + 1400])
        i_qty = arch.find("th_quantity")
        if i_qty > 0:
            print("  --- TRECHO QTD/VALOR ---")
            print(arch[i_qty - 100: i_qty + 1200])
        # salvar arch completo p/ inspecao
        with open("/tmp/so_arch.html", "w", encoding="utf-8") as f:
            f.write(arch)
        print("  (arch completo salvo em /tmp/so_arch.html)")

    print("=" * 70)
    print("5) REPORT ACTION DO PEDIDO")
    print("=" * 70)
    reps = rpc("ir.actions.report", "search_read",
               [[[ "report_name", "=", "sale.report_saleorder" ]]],
               {"fields": ["id", "name", "paperformat_id", "print_report_name"]})
    for r in reps:
        pf = r.get("paperformat_id")
        print("  [%s] %s | paperformat=%s | print_name=%s" % (
            r["id"], r["name"], pf[1] if pf else None, r.get("print_report_name")))
    if reps and reps[0].get("paperformat_id"):
        pfs = rpc("report.paperformat", "read",
                  [[reps[0]["paperformat_id"][0]],
                   ["name", "format", "margin_top", "margin_bottom", "orientation"]])
        print("  paperformat:", json.dumps(pfs[0], ensure_ascii=False))


if __name__ == "__main__":
    main()
