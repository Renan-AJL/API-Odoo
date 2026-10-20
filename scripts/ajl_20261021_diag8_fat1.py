#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJL 21/10/2026 — fatura 72642 (boleto) + campos fiscais da fatura FAT1."""
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
                raise RuntimeError(str(d.get("error"))[:300])
            return d.get("result")
        except RuntimeError as e:
            last = e
            if "XML-RPC tag" in str(e):
                time.sleep(2 * (i + 1)); continue
            raise
        except urllib.error.HTTPError as e:
            raise RuntimeError("HTTP %s: %s" % (e.code, e.read().decode()[:300]))
    raise last


print("=== 1. procurar fatura 72642 (qualquer tipo) ===")
try:
    mv = rpc("account.move", "search_read", [[["name", "like", "72642"]]],
             {"fields": ["name", "state", "move_type", "journal_id", "amount_total"], "limit": 10})
    for m in mv:
        print("  id=%s | %r | %s | %s | %s | %s" % (
            m["id"], m["name"], m["state"], m.get("move_type"),
            (m.get("journal_id") or ["", ""])[1], m["amount_total"]))
except RuntimeError as e:
    print("  erro: %s" % e)

print("\n=== 2. campos fiscal/cfop/natop/operation em account.move ===")
try:
    fg = rpc("account.move", "fields_get", [], {"attributes": ["string", "type"]})
    cand = [k for k in fg if re.search(r"fiscal|cfop|natop|nat_op|operation", k, re.I)]
    for k in sorted(cand)[:40]:
        print("  %s (%s) = %s" % (k, fg[k].get("type"), fg[k].get("string")))
except RuntimeError as e:
    print("  erro: %s" % e)

print("\n=== 3. fatura FAT1 (transferencia) 72857 — valores desses campos ===")
try:
    fat1 = rpc("account.move", "search_read",
               [[["name", "like", "72857"], ["journal_id", "!=", False]]],
               {"fields": ["name", "journal_id", "narration", "ref"], "limit": 10})
    target = None
    for f in fat1:
        print("  %s | %s" % (f["name"], (f.get("journal_id") or ["", ""])[1]))
        if "Transfer" in (f.get("journal_id") or ["", ""])[1]:
            target = f["id"]
    if target:
        # read com os campos candidatos (pode falhar se algum nao existir)
        flds = ["name", "narration", "ref"] + cand[:25]
        try:
            v = rpc("account.move", "read", [[target], flds])[0]
            for k, val in v.items():
                if k in ("name",):
                    continue
                s = json.dumps(val, ensure_ascii=False)
                if s not in ("false", "null", '""'):
                    print("   %s = %s" % (k, s[:220]))
        except RuntimeError as e:
            print("  read com campos fiscais falhou: %s" % str(e)[:300])
except RuntimeError as e:
    print("  erro: %s" % e)
