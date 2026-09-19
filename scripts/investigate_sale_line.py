#!/usr/bin/env python3
"""
Investigate sale.order.line fields with new API key.
"""
import xmlrpc.client
import sys

URL = 'https://ajlferroeaco.odoo.com/'
DB = 'ajlferroeaco'
USER = 'marcus@nytro.com.br'
APIKEY = 'a60341a34aedd0b37b3786d53ea8df061357c31d'

common = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/common')
uid = common.authenticate(DB, USER, APIKEY, {})
print(f"Authenticated as uid={uid}")
if not uid:
    sys.exit(1)
models = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/object')

# 1. User info
print("\n=== User info ===")
user = models.execute_kw(DB, uid, APIKEY, 'res.users', 'read', [uid], 
    {'fields': ['id', 'name', 'login']})
print(f"  User: {user[0]['name']}, login: {user[0]['login']}")

# 2. Model access (use [[]] for empty domain in search_count)
test_models = ['sale.order', 'sale.order.line', 'product.product', 'ir.actions.server', 'ir.model', 'ir.ui.view']
print("\n=== Model access ===")
for m in test_models:
    try:
        c = models.execute_kw(DB, uid, APIKEY, m, 'search_count', [[]])
        print(f"  ✅ {m}: {c} records")
    except Exception as e:
        print(f"  ❌ {m}: {str(e)[:100]}")

# 3. Read sale order + lines
print("\n=== Sample sale order ===")
so_ids = models.execute_kw(DB, uid, APIKEY, 'sale.order', 'search', [[]], {'limit': 1, 'order': 'id desc'})
if so_ids:
    so = models.execute_kw(DB, uid, APIKEY, 'sale.order', 'read', [so_ids[0]], 
        {'fields': ['id', 'name', 'order_line', 'state']})
    print(f"  SO: {so[0]['name']}, state={so[0]['state']}, lines={len(so[0].get('order_line',[]))}")
    
    line_ids = so[0].get('order_line', [])
    if line_ids:
        # Test individual fields
        print("\n=== Testing fields on sale.order.line ===")
        fields_to_test = ['id', 'name', 'price_unit', 'purchase_price', 'product_id', 
                         'product_uom_qty', 'price_subtotal', 'discount', 'x_studio_margem_']
        available_fields = []
        for f in fields_to_test:
            try:
                result = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'read', 
                    [line_ids[0]], {'fields': [f]})
                val = result[0].get(f, 'NOT_IN_DICT')
                print(f"  ✅ {f} = {val}")
                available_fields.append(f)
            except Exception as e:
                err = str(e)[:120]
                print(f"  ❌ {f}: {err}")
        
        # Read full line data
        print(f"\n=== Full line data (sample) ===")
        read_fields = [f for f in available_fields if f != 'id']
        if read_fields:
            lines = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'read', 
                line_ids[:3], {'fields': read_fields})
            for l in lines:
                print(f"  ---")
                for k, v in l.items():
                    print(f"    {k} = {v}")

# 4. Product cost
print("\n=== Product cost info ===")
try:
    prod_ids = models.execute_kw(DB, uid, APIKEY, 'product.product', 'search', [[]], {'limit': 3})
    for pid in prod_ids:
        try:
            prod = models.execute_kw(DB, uid, APIKEY, 'product.product', 'read', [pid], 
                {'fields': ['id', 'name', 'standard_price', 'lst_price']})
            print(f"  {prod[0]['name']}: standard_price={prod[0].get('standard_price','N/A')}, lst_price={prod[0].get('lst_price','N/A')}")
        except Exception as e:
            try:
                prod = models.execute_kw(DB, uid, APIKEY, 'product.product', 'read', [pid], 
                    {'fields': ['id', 'name', 'standard_price']})
                print(f"  {prod[0]['name']}: standard_price={prod[0].get('standard_price','N/A')}")
            except Exception as e2:
                print(f"  Product {pid}: {str(e2)[:100]}")
except Exception as e:
    print(f"  Error: {e}")

# 5. ir.model.fields
print("\n=== ir.model.fields for sale.order.line ===")
try:
    sol_model = models.execute_kw(DB, uid, APIKEY, 'ir.model', 'search_read', [
        [['model', '=', 'sale.order.line']]
    ], {'limit': 1, 'fields': ['id']})
    if sol_model:
        model_id = sol_model[0]['id']
        fields = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'search_read', [
            [['model_id', '=', model_id]]
        ], {'limit': 500, 'fields': ['name', 'field_description', 'ttype', 'store', 'compute']})
        
        relevant = [f for f in fields if any(k in f['name'].lower() for k in ['x_studio', 'margem', 'purchase', 'price_unit', 'cost', 'standard'])]
        for f in sorted(relevant, key=lambda x: x['name']):
            print(f"  {f['name']}: type={f.get('ttype','')}, desc='{f.get('field_description','')}', store={f.get('store','')}, compute={f.get('compute','')}")
    else:
        print("  Model not found")
except Exception as e:
    print(f"  Error: {e}")

# 6. Existing server actions
print("\n=== Existing server actions for sale.order.line ===")
try:
    actions = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'search_read', [
        [['model_id.model', '=', 'sale.order.line']]
    ], {'limit': 20, 'fields': ['id', 'name', 'state']})
    if not actions:
        print("  (none)")
    for a in actions:
        print(f"  ID={a['id']}, name='{a['name']}', state={a.get('state','')}")
except Exception as e:
    print(f"  Error: {e}")
