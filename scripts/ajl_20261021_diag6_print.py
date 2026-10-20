#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJL 21/10/2026 — Diagnóstico FASE A3: dados que mudam o PDF por empresa.
logo, endereço/CNPJ do parceiro da empresa, idioma dos parceiros das SOs,
view Studio 4470 e views l10n_br que herdam os templates."""
import json
import base64
import time
import urllib.request
import urllib.error

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"


def rpc(model, method, args, kwargs=None):
    body = {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}
    last = None
    for i in range(4):
        req = urllib.request.Request(
            MID_URL, data=json.dumps(body).encode("utf-8"),
            headers={"X-API-Key": API_KEY, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            if not d.get("success"):
                raise RuntimeError("RPC falhou: %s.%s -> %s" % (
                    model, method, str(d.get("error"))[:500]))
            return d.get("result")
        except RuntimeError as e:
            last = e
            if "Unknown XML-RPC tag" in str(e) or "502" in str(e) or "504" in str(e):
                time.sleep(2 * (i + 1))
                continue
            raise
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8")[:500]
            if e.code in (502, 503, 504):
                last = RuntimeError("HTTP %s: %s" % (e.code, msg))
                time.sleep(2 * (i + 1))
                continue
            raise RuntimeError("HTTP %s em %s.%s: %s" % (e.code, model, method, msg))
    raise last


def section(t):
    print("\n" + "=" * 70)
    print(t)
    print("=" * 70)


section("1. logo + parceiro da empresa (cabeçalho do PDF)")
comps = rpc("res.company", "read",
            [[1, 2, 3, 4], ["name", "logo", "partner_id", "vat", "street", "city", "phone", "email"]])
for c in comps:
    logo = c.get("logo")
    print("  [%s] %s | logo=%s bytes | cnpj=%s | %s / %s | tel=%s" % (
        c["id"], c["name"],
        (len(base64.b64decode(logo)) if logo else "AUSENTE"),
        c.get("vat"), c.get("street"), c.get("city"), c.get("phone")))

section("2. idioma dos parceiros das SOs de teste")
sos = rpc("sale.order", "read",
          [[953969, 953970, 953955, 953934],
           ["name", "company_id", "partner_id", "state"]])
for s in sos:
    pid = s["partner_id"][0]
    p = rpc("res.partner", "read", [[pid], ["name", "lang"]])[0]
    print("  SO %s (%s) empresa %s | parceiro %s lang=%s" % (
        s["name"], s["id"], s["company_id"][0], p["name"], p.get("lang")))

section("3. view Studio 4470 (diff custom no 1126)")
try:
    v = rpc("ir.ui.view", "read", [[4470], ["key", "name", "arch_db", "arch"]])[0]
    a = v.get("arch_db") or v.get("arch") or ""
    print("  len=%d | conteúdo:" % len(a))
    print(a[:1500])
except RuntimeError as e:
    print("(falhou: %s)" % str(e)[:200])

section("4. l10n_br views que mexem no template SO")
for vid in [3832, 3833]:
    v = rpc("ir.ui.view", "read", [[vid], ["key", "name", "arch_db", "arch"]])[0]
    a = v.get("arch_db") or v.get("arch") or ""
    print("\n  view %s (%s) len=%d:" % (vid, v["key"], len(a)))
    print("  " + a[:900].replace("\n", "\n  "))

section("5. external_layout (216) e footer (207): condições por empresa")
for vid in [216, 207, 209]:
    v = rpc("ir.ui.view", "read", [[vid], ["key", "arch_db", "arch"]])[0]
    a = v.get("arch_db") or v.get("arch") or ""
    print("  view %s (%s) len=%d | company.id no arch: %s" % (
        vid, v["key"], len(a), "company.id" in a))

print("\nFase A3 concluída.")
