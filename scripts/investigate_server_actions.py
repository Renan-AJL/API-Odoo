#!/usr/bin/env python3
"""Investigar server actions existentes e campos disponíveis"""
import xmlrpc.client

ODOO_URL = 'https://ajlferroeaco.odoo.com/'
ODOO_DB = 'ajlferroeaco'
ODOO_USER = 'marcus@nytro.com.br'
ODOO_API_KEY = '5d50bc0616508c0a167218116d53199f710bca9b'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/common', allow_none=True)
uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
models = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/object', allow_none=True)

def kw(model, method, args, kwargs=None):
    if kwargs:
        return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs)
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args)

# 1. Verificar campos do ir.actions.server
print("=== ir.actions.server fields ===")
fields_data = kw('ir.actions.server', 'fields_get', [[]])
# Sort and show relevant
for f in sorted(fields_data.keys()):
    fd = fields_data[f]
    if fd.get('type') not in ('one2many', 'many2many', 'many2one') or f in ['model_id', 'crud_model_id', 'groups_id']:
        print(f"  {f}: {fd.get('type')} - {fd.get('string', '')}")

# 2. Listar server actions no sale.order
print("\n=== Server Actions on sale.order ===")
action_ids = kw('ir.actions.server', 'search', [[['model_id.model', '=', 'sale.order']]])
print(f"Found {len(action_ids)} actions")

# Ler as primeiras 5
if action_ids:
    # Get all available fields first
    actions = kw('ir.actions.server', 'read', [action_ids[:5]])
    for a in actions:
        print(f"\n--- Action: {a.get('name', '?')} (ID: {a['id']}) ---")
        print(f"  state: {a.get('state')}")
        print(f"  type: {a.get('type')}")
        if a.get('code'):
            code = a['code']
            print(f"  code (first 300): {code[:300]}...")
