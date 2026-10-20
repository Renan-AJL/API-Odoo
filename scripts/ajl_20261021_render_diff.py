#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AJL 21/10/2026 — FASE B: render real do relatório de cotação por empresa
via endpoint /api/v1/admin/report-render (controlador HTTP do Odoo).
Salva o HTML de 1 SO por empresa e extrai marcadores de layout."""
import json
import re
import time
import urllib.request
import urllib.error

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/report-render"
API_KEY = "cnpja-odoo-secret-2024"

SOs = {
    1: 953969,   # S01769 Matriz
    2: 953970,   # S01770 Ponta Grossa
    3: 953955,   # S01755 Pinhais
    4: 953934,   # S01734 Ivaiporã
}


def render(docid):
    body = {"report": "sale.report_saleorder", "docids": [docid], "format": "html"}
    last = None
    for i in range(3):
        req = urllib.request.Request(
            MID_URL, data=json.dumps(body).encode("utf-8"),
            headers={"X-API-Key": API_KEY, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.load(r)
            if not d.get("success"):
                raise RuntimeError("render falhou: %s" % str(d.get("error"))[:400])
            return d["html"]
        except Exception as e:
            last = e
            time.sleep(2 * (i + 1))
    raise last


def markers(html):
    m = {}
    m["len"] = len(html)
    m["companies"] = sorted(set(re.findall(r"o_company_(\d+)_layout", html)))
    m["lato"] = "Lato" in html
    m["prim_190a1e"] = "190a1e" in html.lower()
    m["sec_010101"] = "010101" in html.lower()
    m["outros_hex"] = sorted(set(re.findall(
        r"#(?:[0-9a-fA-F]{6})\b", html)))[:12]
    m["ajl_colw"] = "AJL-COLW" in html
    m["ajl_font12"] = "AJL-FONT12" in html
    m["brazil_totals"] = "document_tax_totals_brazil" in html or "Tributos" in html
    m["title"] = re.findall(r"layout_document_title[^>]*>([^<]+)<", html)[:3] or \
                 re.findall(r"<title>([^<]+)</title>", html)[:2]
    m["head_fonts"] = sorted(set(re.findall(
        r"font-family:\s*'?([A-Za-z ]+)'?[;\"]", html)))[:8]
    m["classe_header"] = re.findall(r'class="(o_company_\d+_layout header[^"]*)"', html)[:2]
    m["imgs"] = re.findall(r"<img[^>]*src=\"([^\"]{0,60})", html)[:4]
    return m


def section(t):
    print("\n" + "=" * 70)
    print(t)
    print("=" * 70)


outs = {}
for cid, sid in SOs.items():
    section("empresa %s — SO %s" % (cid, sid))
    html = render(sid)
    fn = "/home/z/my-project/scripts/out_so_%d.html" % cid
    open(fn, "w").write(html)
    outs[cid] = html
    for k, v in markers(html).items():
        print("  %s = %s" % (k, v))

# diferença estrutural entre Matriz e cada filial
def norm(h):
    h = re.sub(r"S0\d{4,}", "SO", h)
    h = re.sub(r"o_company_\d+_layout", "o_company_N_layout", h)
    h = re.sub(r"\s+", " ", h)
    return h

section("diff normalizado (Matriz vs filiais)")
base = norm(outs[1])
import difflib
for cid in (2, 3, 4):
    other = norm(outs[cid])
    sm = difflib.SequenceMatcher(None, base, other)
    print("  empresa %s: similaridade=%.3f" % (cid, sm.ratio()))
    # blocos diferentes
    blocos = [op for op in sm.get_opcodes() if op[0] != "equal"]
    print("  blocos divergentes: %d" % len(blocos))
    for tag, i1, i2, j1, j2 in blocos[:6]:
        frag_b = base[i1:i2][:180].strip()
        frag_o = other[j1:j2][:180].strip()
        print("    [%s]\n      M: %s\n      F: %s" % (tag, frag_b, frag_o))

print("\nFase B concluída — HTMLs em scripts/out_so_{1,2,3,4}.html")
