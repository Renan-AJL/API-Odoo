#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Baixa TODOS os municipios IBGE (codigos 7 digitos, base 2026) e gera
data/ibge-municipios.json para o middleware (PR e SC primeiro)."""
import json
import re
import unicodedata
import urllib.request

URL = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios"


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Za-z0-9 ]", " ", s.upper())
    return re.sub(r"\s+", " ", s).strip()


def main():
    raw = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": "ajl-middleware/1.0", "Accept-Encoding": "gzip"}), timeout=120).read()
    if raw[:2] == b"\x1f\x8b":
        import gzip
        raw = gzip.decompress(raw)
    muns = json.loads(raw)
    print("municipios recebidos: %d" % len(muns))
    tabela = {}
    orfãos = 0
    for m in muns:
        uf = (((m.get("microrregiao") or {}).get("mesorregiao") or {}).get("UF") or {}).get("sigla")
        if not uf:
            orfãos += 1
            continue
        tabela.setdefault(uf, {})[norm(m["nome"])] = str(m["id"])
    # PR e SC primeiro
    ordem = ["PR", "SC"] + sorted(u for u in tabela if u not in ("PR", "SC"))
    out = {}
    total = 0
    for uf in ordem:
        cidades = tabela.get(uf, {})
        out[uf] = dict(sorted(cidades.items()))
        total += len(cidades)
        print("  %s: %d municipios" % (uf, len(cidades)))
    print("total: %d | sem UF: %d" % (total, orfãos))

    # checagens de sanidade (casos reais do usuario)
    for uf, cidade, esperado in [
        ("PR", "RESERVA", None), ("PR", "PINHAIS", None), ("PR", "PIRAQUARA", None),
        ("PR", "CURITIBA", "4106902"), ("PR", "PONTA GROSSA", None),
        ("PR", "SAO JOSE DOS PINHAIS", "4125506"), ("PR", "IVAIPORA", None),
        ("SC", "JOINVILLE", "4209102"), ("SC", "BLUMENAU", "4202404"),
    ]:
        cod = out.get(uf, {}).get(cidade)
        ok = "" if cod else "  << FALTA!"
        print("  %s/%s = %s%s %s" % (cidade, uf, cod, ok, ("(esperado %s)" % esperado) if esperado and cod and cod != esperado else ""))

    path = "/home/z/my-project/API-Odoo/data/ibge-municipios.json"
    with open(path, "w") as f:
        json.dump({"_fonte": "IBGE servicodados.ibge.gov.br api/v1/localidades/municipios",
                   "_gerado": "2026-10-20", "_normalizacao": "uppercase, sem acentos, sem pontuacao",
                   "ufs": out}, f, ensure_ascii=False)
    print("gravado: %s (%d bytes)" % (path, len(json.dumps(out))))


if __name__ == "__main__":
    main()
