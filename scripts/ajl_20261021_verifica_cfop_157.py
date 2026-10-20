#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verifica CFOP/natOp/vNF no XML autorizado da fatura 157."""
import base64
import json
import re
import urllib.error
import urllib.request

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"


def rpc(model, method, args, kwargs=None):
    body = {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}
    req = urllib.request.Request(
        MID_URL, data=json.dumps(body).encode(),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        print("!! HTTP %s: %s" % (e.code, e.read().decode("utf-8")[:300]))
        raise
    if not d.get("success"):
        raise RuntimeError(str(d.get("error"))[:300])
    return d.get("result")


atts = rpc("ir.attachment", "search_read",
           [[["res_model", "=", "account.move"], ["res_id", "=", 157],
             ["name", "ilike", ".xml"]]],
           {"fields": ["name", "file_size"], "limit": 5})
print("anexos XML:", [(a["name"], a.get("file_size")) for a in atts])

xml = ""
for a in atts:
    try:
        recs = rpc("ir.attachment", "read", [[a["id"]], ["raw"]])
        raw = recs[0].get("raw")
        if isinstance(raw, list) and raw:
            raw = raw[0]  # (base64, nome) tuple em Odoo 19
        if isinstance(raw, bytes):
            raw = base64.b64encode(raw).decode()
        if not raw:
            continue
        xml = base64.b64decode(raw).decode("utf-8", errors="replace")
        print("XML lido de:", a["name"], "len:", len(xml))
        break
    except Exception as e:
        print("falha raw em %s: %s" % (a["name"], e))

if not xml:
    raise SystemExit("nao consegui ler o XML")

print()
print("natOp :", re.findall(r"<natOp>([^<]+)</natOp>", xml))
print("CFOP  :", re.findall(r"<CFOP>(\d+)</CFOP>", xml))
print("vNF   :", re.findall(r"<vNF>([^<]+)</vNF>", xml))
print("vIPI  :", re.findall(r"<vIPI>([^<]+)</vIPI>", xml))
print("vProd :", re.findall(r"<vProd>([^<]+)</vProd>", xml))
