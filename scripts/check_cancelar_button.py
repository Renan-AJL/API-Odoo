#!/usr/bin/env python3
"""Check Cancelar Boleto button and server action setup in Odoo"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Check the server action details
action = models.execute_kw(db, uid, pwd, 'ir.actions.server', 'read', [
    [1281], ['id', 'name', 'state', 'code', 'model_id', 'binding_model_id', 'binding_view_types']
])
print("Server Action 1281:", action)

# Check if there's an ir.model.data for this action
ext_ids = models.execute_kw(db, uid, pwd, 'ir.model.data', 'search_read', [
    [['res_id', '=', 1281], ['model', '=', 'ir.actions.server']]
], {'fields': ['module', 'name', 'res_id']})
print("\nExternal IDs:", ext_ids)

# Check if there's a button in the invoice form view referencing this action
# Search for inherited views of account.move form
form_views = models.execute_kw(db, uid, pwd, 'ir.ui.view', 'search_read', [
    [['model', '=', 'account.move'], ['type', '=', 'form']]
], {'fields': ['id', 'name', 'inherit_id', 'active'], 'limit': 20})
print(f"\nForm views for account.move: {len(form_views)}")
for v in form_views:
    inherit = v.get('inherit_id', False)
    inherit_str = f"inherits {inherit[1]}" if inherit else "base"
    print(f"  ID={v['id']}  {v['name']}  ({inherit_str})")

# Search for views that contain 'cancelar' or 'boleto' in arch
boleto_views = models.execute_kw(db, uid, pwd, 'ir.ui.view', 'search_read', [
    [['model', '=', 'account.move'], ['arch_db', 'like', 'cancelar']]
], {'fields': ['id', 'name', 'type', 'inherit_id'], 'limit': 10})
print(f"\nViews with 'cancelar': {len(boleto_views)}")
for v in boleto_views:
    print(f"  ID={v['id']}  {v['name']}  type={v['type']}")

# Also check button in account.move form specifically
boleto_views2 = models.execute_kw(db, uid, pwd, 'ir.ui.view', 'search_read', [
    [['model', '=', 'account.move'], ['arch_db', 'like', 'Cancelar Boleto']]
], {'fields': ['id', 'name', 'type', 'inherit_id'], 'limit': 10})
print(f"\nViews with 'Cancelar Boleto' button: {len(boleto_views2)}")
for v in boleto_views2:
    print(f"  ID={v['id']}  {v['name']}  type={v['type']}")
    # Read the arch to see the button
    arch = models.execute_kw(db, uid, pwd, 'ir.ui.view', 'read', [
        [v['id']], ['arch_db']
    ])
    if arch and arch[0] and arch[0].get('arch_db'):
        # Find the button line
        for line in arch[0]['arch_db'].split('\n'):
            if 'Cancelar' in line or 'cancelar' in line:
                print(f"    {line.strip()}")
