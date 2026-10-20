#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AJL 21/10 — Destrava fatura NFe 00072857 (id 157, diario Transferência).

Causa: fatura duplicada de NFe 00072856 (cancelada) -> Odoo copiou
x_studio_nfe_chave e x_studio_nfe_protocolo antigos. O guarda anti-dup
do emissor (sieg-odoo-emit.js) ve chave presente e SKIPa a emissao.

Fix: limpar chave/protocolo das faturas 'pendente' cuja chave pertence
a outra NF (nNF da chave != numero do nome da fatura). Status fica
'pendente' -> poller emite em ~30s com CFOP 5901.

Uso:
  python3 scripts/ajl_20261021_destrava_157.py            # aplica
  python3 scripts/ajl_20261021_destrava_157.py --dry-run  # so mostra
"""
import json
import re
import sys
import urllib.request
import urllib.error

MID_URL = "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"
API_KEY = "cnpja-odoo-secret-2024"

DRY = "--dry-run" in sys.argv
# ids alvo: padrao 157 (NF 72857 do usuario); passe ids via argv p/ outros
ALVO_IDS = [int(a) for a in sys.argv[1:] if a.isdigit()] or [157]


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
            e.code, model, method, e.read().decode("utf-8")[:300]))
    if not d.get("success"):
        raise RuntimeError("RPC falhou: %s.%s -> %s" % (model, method, str(d.get("error"))[:300]))
    return d.get("result")


def nf_da_chave(chave):
    """nNF fica nas posicoes 26-34 (1-based 26..34) da chave de 44 digitos:
    UF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) DV(1)."""
    c = re.sub(r"\D", "", chave or "")
    if len(c) != 44:
        return ""
    return c[25:34].lstrip("0")


def nf_do_nome(nome):
    """'NFe 00072857' -> '72857'"""
    m = re.search(r"(\d{5,})", nome or "")
    return m.group(1).lstrip("0") if m else ""


print("=== Destrava faturas pendentes com chave de OUTRA NF ===")

moves = rpc("account.move", "search_read",
            [[["move_type", "=", "out_invoice"],
              ["x_studio_nfe_status", "in", ["pendente", "erro"]]]],
            {"fields": ["name", "x_studio_nfe_chave", "x_studio_nfe_protocolo",
                        "x_studio_nfe_status", "journal_id"]})

for m in moves:
    if ALVO_IDS and m["id"] not in ALVO_IDS:
        print("  %s (id %s): fora da lista de alvos %s — skip" % (
            m["name"], m["id"], ALVO_IDS))
        continue
    chave = m.get("x_studio_nfe_chave") or ""
    nf_chave = nf_da_chave(chave)
    nf_nome = nf_do_nome(m["name"])
    if not chave:
        continue
    if nf_chave == nf_nome:
        print("  %s (id %s): chave nNF=%s == nome %s — ok, não mexo" % (
            m["name"], m["id"], nf_chave or "?", nf_nome or "?"))
        continue
    print("  %s (id %s): CHAVE STALE — nNF da chave=%s != nome %s | protocolo=%s -> LIMPAR" % (
        m["name"], m["id"], nf_chave or "?", nf_nome or "?", m.get("x_studio_nfe_protocolo")))
    if DRY:
        print("      DRY-RUN — não gravou")
        continue
    rpc("account.move", "write", [[m["id"]],
         {"x_studio_nfe_chave": False, "x_studio_nfe_protocolo": False}], allow_write=True)
    # mensagem no chatter
    try:
        rpc("mail.message", "create", [{
            "model": "account.move",
            "res_id": m["id"],
            "message_type": "comment",
            "body": "AJL middleware: chave/protocolo %s removidos — pertenciam à NF-e %s "
                    "(fatura duplicada de NF cancelada). Fatura destravada para nova emissão (CFOP 5901)."
                    % (chave, nf_chave),
        }], allow_write=True)
    except Exception as eMsg:
        print("      (chatter: %s)" % eMsg)
    print("      OK — limpos; poller deve emitir em ~30s")

print()
print("=== Estado final da 157 ===")
final = rpc("account.move", "read", [[157],
            ["name", "state", "x_studio_nfe_status", "x_studio_nfe_chave",
             "x_studio_nfe_protocolo"]])
print(json.dumps(final[0], ensure_ascii=False, indent=1))
