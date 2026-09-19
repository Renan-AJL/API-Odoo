#!/usr/bin/env python3
"""
Investigate Odoo access - check which models are accessible.
"""
import xmlrpc.client
import sys

URL = 'https://ajlferroeaco.odoo.com/'
DB = 'ajlferroeaco'
USER = 'marcus@nytro.com.br'
APIKEY = '35a6a8b79f1fa688bd5c49b3ba45ec390cfe1b52'

common = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/common')
uid = common.authenticate(DB, USER, APIKEY, {})
print(f"Authenticated as uid={uid}")
models = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/object')

# Check user info
print("\n=== User info ===")
try:
    user = models.execute_kw(DB, uid, APIKEY, 'res.users', 'read', [uid], 
        {'fields': ['id', 'name', 'login', 'groups_id']})
    print(f"  User: {user[0]['name']}, login: {user[0]['login']}")
    print(f"  Groups count: {len(user[0].get('groups_id', []))}")
except Exception as e:
    print(f"  Error: {e}")

# Try various models
test_models = [
    'sale.order', 'sale.order.line', 'product.product', 'product.template',
    'ir.actions.server', 'ir.model', 'ir.model.fields', 'ir.ui.view',
    'res.partner', 'account.move',
]

print("\n=== Model access test ===")
for model in test_models:
    try:
        count = models.execute_kw(DB, uid, APIKEY, model, 'search_count', [[]])
        print(f"  ✅ {model}: {count} records")
    except Exception as e:
        err = str(e)[:80]
        print(f"  ❌ {model}: {err}")

# Try sale.order to get lines
print("\n=== Try reading a sale.order ===")
try:
    so_ids = models.execute_kw(DB, uid, APIKEY, 'sale.order', 'search', [], {'limit': 1})
    if so_ids:
        so = models.execute_kw(DB, uid, APIKEY, 'sale.order', 'read', so_ids, 
            {'fields': ['id', 'name', 'order_line', 'state']})
        print(f"  SO: {so[0]['name']}, state={so[0]['state']}, lines={so[0].get('order_line', [])}")
        
        # Try reading lines through sale.order
        line_ids = so[0].get('order_line', [])
        if line_ids:
            print(f"  Line IDs: {line_ids[:3]}")
            # Try reading a line
            try:
                line = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'read', 
                    [line_ids[0]], {'fields': ['id', 'name', 'price_unit', 'product_id', 'purchase_price']})
                print(f"  Line: {line}")
            except Exception as e2:
                print(f"  Line read error: {e2}")
                # Try without purchase_price
                try:
                    line = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'read', 
                        [line_ids[0]], {'fields': ['id', 'name', 'price_unit', 'product_id']})
                    print(f"  Line (without purchase_price): {line}")
                except Exception as e3:
                    print(f"  Line read error 2: {e3}")
    else:
        print("  No sale orders found")
except Exception as e:
    print(f"  Error: {e}")
