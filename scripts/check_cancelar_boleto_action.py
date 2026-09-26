#!/usr/bin/env python3
"""Check and fix the Cancelar Boleto server action in Odoo"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Search for server actions related to boleto
actions = models.execute_kw(db, uid, pwd, 'ir.actions.server', 'search_read', [
    [['name', 'like', 'oleto']]
], {'fields': ['id', 'name', 'state', 'code', 'model_id'], 'limit': 20})

print(f"Found {len(actions)} server actions related to 'boleto':")
for a in actions:
    print(f"\n  ID={a['id']}  name={a['name']}")
    print(f"  model_id={a.get('model_id')}")
    print(f"  state={a['state']}")
    code = a.get('code', '')
    if code:
        print(f"  code (first 500 chars):")
        print(f"  {code[:500]}")
    # Check if it references the old field
    if 'x_studio_nosso_numero' in (code or ''):
        print(f"  *** REFERENCES OLD FIELD x_studio_nosso_numero - NEEDS FIX! ***")

# Also check buttons in views
views = models.execute_kw(db, uid, pwd, 'ir.ui.view', 'search_read', [
    [['name', 'like', 'oleto']]
], {'fields': ['id', 'name', 'type', 'inherit_id'], 'limit': 20})

print(f"\nFound {len(views)} views related to 'boleto':")
for v in views:
    print(f"  ID={v['id']}  name={v['name']}  type={v['type']}  inherit_id={v.get('inherit_id')}")
