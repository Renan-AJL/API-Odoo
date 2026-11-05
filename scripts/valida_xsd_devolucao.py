#!/usr/bin/env python3
"""Valida o XML da devolução 5902 contra o XSD (mesmo método do valida_xsd_transfer)."""
from lxml import etree

XSD = '/home/z/my-project/repos/API-Odoo/scripts/xsd/_nfe_global_wrapper.xsd'
ALVO = '/tmp/nfe_devolucao_5902.xml'

schema = etree.XMLSchema(etree.parse(XSD))
doc = etree.parse(ALVO)
ok = schema.validate(doc)
erros = [(e.line, str(e.message)) for e in schema.error_log]
falsos = ('IBSCBS', 'vNFTot', 'IBSCBSTot', 'gCBS', 'gIBS', 'Signature', 'infRespTec', 'hashCSRT', 'idCSRT')
reais = [(l, m) for (l, m) in erros if not any(f.lower() in m.lower() for f in falsos)]
print(f'DEVOLOCAO 5902: {"VALIDO" if ok else "ERROS"} — total={len(erros)} reais={len(reais)}')
for l, m in reais[:12]:
    print(f'  linha {l}: {m[:220]}')
