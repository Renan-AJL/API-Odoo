#!/usr/bin/env python3
"""Check product.product x_studio fields and account.move fields used in sieg-odoo-emit"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Check product.product fields
prod_fields = ['x_studio_c_trib_nac', 'x_studio_c_nbs', 'x_studio_aliquota_iss', 'x_studio_ibge_code',
               'x_studio_cst_ipi', 'x_studio_aliquota_ipi']
print("=== product.product fields ===")
for f in prod_fields:
    found = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
        [['model', '=', 'product.product'], ['name', '=', f]]
    ], {'fields': ['name', 'ttype']})
    if found:
        print(f"  OK  {f} ({found[0]['ttype']})")
    else:
        print(f"  MISSING  {f}")

# Check res.company fields
comp_fields = ['x_studio_sieg_ultimo_nfe', 'x_studio_sieg_ultimo_nfse',
               'x_studio_sieg_serie_nfe', 'x_studio_sieg_serie_nfse']
print("\n=== res.company fields ===")
for f in comp_fields:
    found = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
        [['model', '=', 'res.company'], ['name', '=', f]]
    ], {'fields': ['name', 'ttype']})
    if found:
        print(f"  OK  {f} ({found[0]['ttype']})")
    else:
        print(f"  MISSING  {f}")

# Check account.move: invoice_origin, sale_order_ids
am_fields = ['invoice_origin', 'sale_order_ids', 'x_studio_forma_de_pagamento', 'x_studio_motorista']
print("\n=== account.move additional fields ===")
for f in am_fields:
    found = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
        [['model', '=', 'account.move'], ['name', '=', f]]
    ], {'fields': ['name', 'ttype']})
    if found:
        print(f"  OK  {f} ({found[0]['ttype']})")
    else:
        print(f"  MISSING  {f}")
