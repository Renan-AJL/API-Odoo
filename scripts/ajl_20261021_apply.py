#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJL 21/10/2026 — Layout de impressão da Cotação/Venda igual à Matriz em
TODAS as filiais + colunas de dados do produto maiores.

1. res.company (2 Ponta Grossa, 3 Pinhais, 4 Ivaiporã) recebe o mesmo
   layout de documento da Matriz (1):
     external_report_layout_id = external_layout_standard (view 209)
     font = Lato | primary_color = #190a1e | secondary_color = #010101
2. View sale.report_saleorder_document (1126) — usada por "Cotação por PDF"
   (cotação E pedido, todas as empresas):
     - tira class w-100 do td do nome do produto (forçava 100% da largura
       e espremia as coluninhas)
     - CSS AJL-COLW: larguras maiores p/ quantidade, valor unitário,
       desconto, impostos e valor total.

Regras fiscais por filial (Difal automático / ICMS manual / IPI manual):
já globais — automação 15 ativa sem filtro de empresa, SA 1186 usa
pedido.company_id, 0 produtos com imposto de saída padrão. Verificado
em scripts/ajl_20261021_diag.py — nada a aplicar.

Uso:
  python3 scripts/ajl_20261021_apply.py            # aplica
  python3 scripts/ajl_20261021_apply.py --dry-run  # só mostra
"""
import json
import sys
import urllib.request
import urllib.error

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"

DRY = "--dry-run" in sys.argv


def rpc(model, method, args, kwargs=None, allow_write=False):
    body = {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}
    if allow_write:
        body["allowWrite"] = True
    req = urllib.request.Request(
        MID_URL, data=json.dumps(body).encode("utf-8"),
        headers={"X-API-Key": API_KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %s em %s.%s: %s" % (
            e.code, model, method, e.read().decode("utf-8")[:400]))
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s.%s -> %s" % (model, method, str(d.get("error"))[:400]))
    return d.get("result")


# ============================================================
# 1. Layout da Matriz para todas as filiais
# ============================================================
MATRIZ = 1
FILIAIS = [2, 3, 4]
LAYOUT_FIELDS = ["external_report_layout_id", "font", "primary_color", "secondary_color"]


def fix_layouts():
    comps = rpc("res.company", "read", [[MATRIZ] + FILIAIS, ["name"] + LAYOUT_FIELDS])
    by_id = {c["id"]: c for c in comps}
    m = by_id[MATRIZ]
    layout_id = (m.get("external_report_layout_id") or [0])[0]
    alvo = {
        "external_report_layout_id": layout_id,
        "font": m.get("font") or "Lato",
        "primary_color": m.get("primary_color"),
        "secondary_color": m.get("secondary_color"),
    }
    print("[LAYOUT] Matriz=%s -> alvo: %s" % (m["name"], json.dumps(alvo, ensure_ascii=False)))
    for cid in FILIAIS:
        c = by_id[cid]
        atual = {
            "external_report_layout_id": (c.get("external_report_layout_id") or [0])[0],
            "font": c.get("font"),
            "primary_color": c.get("primary_color"),
            "secondary_color": c.get("secondary_color"),
        }
        if atual == alvo:
            print("  [%s] %s: já igual à Matriz — skip" % (cid, c["name"]))
            continue
        if DRY:
            print("  [%s] %s: DRY-RUN — aplicaria %s" % (cid, c["name"], json.dumps(alvo)))
            continue
        rpc("res.company", "write", [[cid], alvo], allow_write=True)
        print("  [%s] %s: OK — layout da Matriz aplicado" % (cid, c["name"]))


# ============================================================
# 2. View do relatório: colunas de dados do produto maiores
# ============================================================
MARCA = "AJL-COLW"

CSS_COLW = """      /* AJL-COLW (21/10/2026): colunas de dados do produto maiores
         (quantidade, valor unitario, desconto, impostos, valor total) */
      th[name="th_quantity"], td[name="td_product_quantity"], td[name="td_combo_quantity"] { width: 10%; }
      th[name="th_priceunit"], td[name="td_product_priceunit"] { width: 12%; }
      th[name="th_discount"], td[name="td_product_discount"] { width: 6%; }
      th[name="th_taxes"], td[name="td_product_taxes"] { width: 10%; }
      th[name="th_subtotal"], td[name="td_product_subtotal"] { width: 12%; }
      td[name="td_product_name"] { width: auto !important; }
"""

ANCORA_STYLE = '      [style*="page-break-before: always"] { page-break-before: auto !important; }\n    </style>'

OLD_W100 = '<td name="td_product_name" class="w-100" t-att-style="padding_style">'
NEW_W100 = '<td name="td_product_name" t-att-style="padding_style">'


def get_view():
    views = rpc("ir.ui.view", "search_read",
                [[[ "key", "=", "sale.report_saleorder_document" ]]],
                {"fields": ["id", "name"]})
    if not views:
        views = rpc("ir.ui.view", "search_read",
                    [[[ "name", "ilike", "report_saleorder_document" ]]],
                    {"fields": ["id", "name"]})
    vid = views[0]["id"]
    a = rpc("ir.ui.view", "read", [[vid], ["arch_db", "arch"]])
    arch = a[0].get("arch_db") or a[0].get("arch") or ""
    return vid, arch


def fix_view():
    vid, arch = get_view()
    if MARCA in arch:
        print("[VIEW] %s já tem %s — skip" % (vid, MARCA))
        return
    novo = arch
    mudou = []
    if ANCORA_STYLE in novo:
        novo = novo.replace(ANCORA_STYLE,
                            '      [style*="page-break-before: always"] { page-break-before: auto !important; }\n'
                            + CSS_COLW + '    </style>', 1)
        mudou.append("css-colunas")
    elif "</style>" in novo:
        novo = novo.replace("</style>", CSS_COLW + "    </style>", 1)
        mudou.append("css-colunas-fallback")
    else:
        raise RuntimeError("view %s: bloco <style> não encontrado" % vid)
    if OLD_W100 in novo:
        novo = novo.replace(OLD_W100, NEW_W100, 1)
        mudou.append("w-100-removido")
    print("[VIEW] %s: mudanças=%s (antes %d chars -> %d)" % (
        vid, ", ".join(mudou), len(arch), len(novo)))
    if not mudou:
        print("[VIEW] nada a fazer")
        return
    if DRY:
        print("[VIEW] DRY-RUN — não gravou")
        return
    # SaaS: gravar via arch_db (com fallback p/ arch)
    try:
        rpc("ir.ui.view", "write", [[vid], {"arch_db": novo}], allow_write=True)
    except RuntimeError:
        rpc("ir.ui.view", "write", [[vid], {"arch": novo}], allow_write=True)
    print("[VIEW] %s: OK — gravado" % vid)


# ============================================================
# 3. Validação
# ============================================================
def validar():
    comps = rpc("res.company", "read", [FILIAIS, ["name"] + LAYOUT_FIELDS])
    m = rpc("res.company", "read", [[MATRIZ], ["name"] + LAYOUT_FIELDS])[0]
    mid = (m.get("external_report_layout_id") or [0])[0]
    ok = True
    for c in comps:
        same = ((c.get("external_report_layout_id") or [0])[0] == mid
                and c.get("primary_color") == m.get("primary_color")
                and c.get("secondary_color") == m.get("secondary_color"))
        ok = ok and same
        print("  empresa %s igual à Matriz: %s" % (c["name"], same))
    vid, arch = get_view()
    print("  view %s: marca=%s | w-100=%s" % (
        vid, MARCA in arch, 'class="w-100" t-att-style="padding_style"' in arch))
    return ok


if __name__ == "__main__":
    print("=== AJL 21/10/2026 — layout Matriz p/ filiais + colunas maiores (dry=%s) ===" % DRY)
    fix_layouts()
    fix_view()
    if not DRY:
        print("--- VALIDAÇÃO ---")
        validar()
    print("Concluído.")
