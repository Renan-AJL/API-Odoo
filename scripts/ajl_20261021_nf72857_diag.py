#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJL 21/10 — Diagnóstico NF-e de transferência 72857/72856 pendente.
Le fatura, status, chatter (mail.message) e anexos (XML assinado).
"""
import json
import re
import sys
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
        print("!! HTTP %s em %s.%s: %s" % (e.code, model, method, e.read().decode("utf-8")[:300]))
        raise
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s.%s -> %s" % (model, method, str(d.get("error"))[:300]))
    return d.get("result")


print("=== 1) Faturas NFe 72856 / 72857 ===")
moves = rpc("account.move", "search_read",
            [[["name", "ilike", "72856"]]],
            {"fields": ["name", "move_type", "state", "journal_id",
                        "x_studio_nfe_status", "x_studio_nfe_chave",
                        "x_studio_nfe_protocolo", "amount_total",
                        "x_studio_forma_de_pagamento", "partner_id", "company_id"]})
for m in moves:
    print(json.dumps(m, ensure_ascii=False, indent=1))

moves2 = rpc("account.move", "search_read",
             [[["name", "ilike", "72857"]]],
             {"fields": ["name", "move_type", "state", "journal_id",
                         "x_studio_nfe_status", "x_studio_nfe_chave",
                         "x_studio_nfe_protocolo", "amount_total",
                         "x_studio_forma_de_pagamento", "partner_id", "company_id"]})
for m in moves2:
    print(json.dumps(m, ensure_ascii=False, indent=1))

alvo = None
if moves:
    alvo = moves[0]["id"]
if moves2:
    alvo = moves2[0]["id"]
if not alvo:
    print("NENHUMA fatura 72856/72857 encontrada!")
    sys.exit(0)

print()
print("=== 2) Chatter (últimas 15 mensagens) da fatura %s ===" % alvo)
msgs = rpc("mail.message", "search_read",
           [[["model", "=", "account.move"], ["res_id", "=", alvo]]],
           {"fields": ["subject", "body", "date", "message_type"],
            "order": "id desc", "limit": 15})
for msg in msgs:
    body = re.sub("<[^>]+>", " ", msg.get("body") or "")
    body = re.sub(r"\s+", " ", body).strip()
    print("  [%s] (%s) %s" % (msg.get("date"), msg.get("message_type"), body[:500]))

print()
print("=== 3) Anexos XML/PDF da fatura %s ===" % alvo)
atts = rpc("ir.attachment", "search_read",
           [[["res_model", "=", "account.move"], ["res_id", "=", alvo]]],
           {"fields": ["name", "file_size", "mimetype", "create_date"], "order": "id desc", "limit": 20})
for a in atts:
    print("  %s | %s bytes | %s | %s | id=%s" % (
        a["name"], a.get("file_size"), a.get("mimetype"), a.get("create_date"), a["id"]))

print()
print("=== 4) Outras faturas pendentes/erro (contexto) ===")
pend = rpc("account.move", "search_read",
           [[["move_type", "=", "out_invoice"],
             ["x_studio_nfe_status", "in", ["pendente", "processando", "erro"]]]],
           {"fields": ["name", "x_studio_nfe_status", "journal_id", "amount_total", "invoice_date"], "limit": 10})
for p in pend:
    j = (p.get("journal_id") or [0, ""])[1]
    print("  %s | %s | %s | R$ %s | %s" % (p["name"], p.get("x_studio_nfe_status"), j, p.get("amount_total"), p.get("invoice_date")))
