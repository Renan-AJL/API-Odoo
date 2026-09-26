#!/usr/bin/env python3
"""Check which x_studio fields exist on account.move in Odoo"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

common = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common')
models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Search for all x_studio fields on account.move
studio_fields = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
    [['model', '=', 'account.move'], ['name', 'like', 'x_studio%']]
], {'fields': ['name', 'field_description', 'ttype', 'store'], 'limit': 100})

print(f"Found {len(studio_fields)} x_studio fields on account.move:")
for f in studio_fields:
    print(f"  {f['name']:45s}  {f['ttype']:10s}  store={f['store']}  ({f['field_description']})")

# Check specific fields we need
needed = ['x_studio_nosso_numero', 'x_studio_itau_resposta_json', 'x_studio_boleto_cancelado',
          'x_studio_nfe_status', 'x_studio_nfe_chave', 'x_studio_nfe_protocolo']
existing_names = {f['name'] for f in studio_fields}

print("\n--- Field check ---")
for n in needed:
    status = "EXISTS" if n in existing_names else "MISSING"
    print(f"  {n:45s}  {status}")
