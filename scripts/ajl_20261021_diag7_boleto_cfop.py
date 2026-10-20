#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJL 21/10/2026 — Fatos p/ boleto (NF-e no número) e CFOP transferência."""
import json
import re
import time
import urllib.request
import urllib.error

MID = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
KEY = "cnpja-odoo-secret-2024"


def rpc(model, method, args, kwargs=None):
    body = {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}
    last = None
    for i in range(4):
        req = urllib.request.Request(MID, data=json.dumps(body).encode("utf-8"),
                                     headers={"X-API-Key": KEY, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            if not d.get("success"):
                raise RuntimeError(str(d.get("error"))[:400])
            return d.get("result")
        except RuntimeError as e:
            last = e
            if "XML-RPC tag" in str(e):
                time.sleep(2 * (i + 1)); continue
            raise
        except urllib.error.HTTPError as e:
            raise RuntimeError("HTTP %s: %s" % (e.code, e.read().decode()[:400]))
    raise last


print("=== 1. faturas ~72642 ===")
try:
    mv = rpc("account.move", "search_read",
             [[["name", "like", "72642"], ["move_type", "=", "out_invoice"]]],
             {"fields": ["name", "amount_total", "state"], "limit": 6})
    for m in mv:
        print("  id=%s | name=%r | %s | %s" % (m["id"], m["name"], m["state"], m["amount_total"]))
    ids72642 = [m["id"] for m in mv]
except RuntimeError as e:
    print("  erro: %s" % e); ids72642 = []

if ids72642:
    det = rpc("account.move", "read", [ids72642[:2],
              ["name", "x_studio_itau_nosso_numero", "x_studio_itau_resposta_json",
               "x_studio_boleto_cancelado", "invoice_payment_term_id", "journal_id"]])
    for d in det:
        print("\n  fatura id=%s name=%r" % (d["id"], d["name"]))
        print("   nn=%r" % (d.get("x_studio_itau_nosso_numero"),))
        print("   cancelado=%r | journal=%s | termo=%s" % (
            d.get("x_studio_boleto_cancelado"), d.get("journal_id"),
            (d.get("invoice_payment_term_id") or ["", ""])[1]))
        rj = d.get("x_studio_itau_resposta_json") or ""
        print("   resposta_json len=%d" % len(rj))
        m = re.findall(r'"txid"\s*:\s*"([^"]+)"', rj)[:3]
        print("   txids=%s" % m)

print("\n=== 2. diários de venda (nomes p/ detectar transferencia/remessa) ===")
try:
    js = rpc("account.journal", "search_read",
             [[["type", "=", "sale"]]],
             {"fields": ["name", "code"], "limit": 30})
    for j in js:
        print("  id=%s | %s (%s)" % (j["id"], j["name"], j.get("code")))
except RuntimeError as e:
    print("  erro: %s" % e)

print("\n=== 3. CFOPs no Odoo (l10n_br_fiscal.cfop) ===")
try:
    cfs = rpc("l10n_br_fiscal.cfop", "search_read",
              [[["code", "in", ["5151", "5152", "5901", "5902", "6151", "6152", "6901"]]]],
              {"fields": ["code", "name"], "limit": 20})
    for c in cfs:
        print("  %s = %s" % (c["code"], c["name"]))
except RuntimeError as e:
    print("  l10n_br_fiscal.cfop falhou: %s" % str(e)[:200])

print("\n=== 4. nome do diário nas últimas faturas NF ===")
try:
    fat = rpc("account.move", "search_read",
              [[["move_type", "=", "out_invoice"], ["name", "like", "NFe"]]],
              {"fields": ["name", "journal_id"], "order": "id desc", "limit": 8})
    for f in fat:
        print("  %s | journal=%s" % (f["name"], (f.get("journal_id") or ["", ""])[1]))
except RuntimeError as e:
    print("  erro: %s" % e)
