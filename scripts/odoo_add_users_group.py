#!/usr/bin/env python3
"""
Add specific users (2,6,716,7,5) to the Administration/Access Rights group
so they can see the Margem field.
"""
import xmlrpc.client

URL = 'https://ajlferroeaco.odoo.com/'
DB = 'ajlferroeaco'
USER = 'marcus@nytro.com.br'
APIKEY = 'a60341a34aedd0b37b3786d53ea8df061357c31d'

common = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/common')
uid = common.authenticate(DB, USER, APIKEY, {})
models = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/object')
print(f"uid={uid}")

# Find groups by searching with just name (no category_id which doesn't exist in SaaS)
ALLOWED_USER_IDS = [2, 6, 716, 7, 5]

# Try to find the erp_manager group
print("=== Finding erp_manager group ===")
try:
    groups = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'search_read', [
        [['name', '=', 'Access Rights']]
    ], {'limit': 3, 'fields': ['id', 'name']})
    print(f"  'Access Rights' groups: {groups}")
except Exception as e:
    print(f"  Error: {str(e)[:100]}")

# Try via xml_id
try:
    mdata = models.execute_kw(DB, uid, APIKEY, 'ir.model.data', 'search_read', [
        [['module', '=', 'base'], ['name', '=', 'group_erp_manager']]
    ], {'limit': 1, 'fields': ['id', 'res_id']})
    print(f"  base.group_erp_manager via ir.model.data: {mdata}")
    if mdata:
        group_id = mdata[0]['res_id']
        print(f"  Group ID: {group_id}")
        
        # Read the group with minimal fields
        grp = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'read', [[group_id]], {'fields': ['id', 'name']})
        print(f"  Group: {grp}")
        
        # Now add users - we need to add via res.users instead of res.groups
        # because res.groups.users might not be writable
        for user_id in ALLOWED_USER_IDS:
            try:
                # Add group to user via write on res.users
                u = models.execute_kw(DB, uid, APIKEY, 'res.users', 'read', [[user_id]], {'fields': ['id', 'name']})
                if u:
                    print(f"  User {user_id}: {u[0].get('name','')}")
            except Exception as e:
                print(f"  User {user_id}: {str(e)[:80]}")
        
        # Try writing groups_id on each user
        print("\n  Adding group to allowed users via res.users.groups_id...")
        for user_id in ALLOWED_USER_IDS:
            try:
                # Add the group to the user's groups_id (Many2many)
                result = models.execute_kw(DB, uid, APIKEY, 'res.users', 'write', [user_id, {
                    'groups_id': [[4, group_id]],  # Add group (4 = link)
                }])
                print(f"  ✅ User {user_id}: {result}")
            except Exception as e:
                print(f"  ❌ User {user_id}: {str(e)[:100]}")
        
except Exception as e:
    print(f"  Error via ir.model.data: {str(e)[:200]}")

# Also verify the x_studio_local_armazenagem field works
print("\n=== Verify local armazenagem field ===")
try:
    # Test on a product
    prod_ids = models.execute_kw(DB, uid, APIKEY, 'product.product', 'search', [[]], {'limit': 1})
    if prod_ids:
        # Check stock.quant
        quants = models.execute_kw(DB, uid, APIKEY, 'stock.quant', 'search_count', [
            [['product_id', '=', prod_ids[0]], ['quantity', '>', 0]]
        ])
        print(f"  Product {prod_ids[0]}: {quants} quants with qty > 0")
        
        if quants > 0:
            q = models.execute_kw(DB, uid, APIKEY, 'stock.quant', 'search_read', [
                [['product_id', '=', prod_ids[0]], ['quantity', '>', 0]]
            ], {'limit': 1, 'fields': ['id', 'location_id', 'quantity']})
            print(f"  Quant: location={q[0].get('location_id','')}, qty={q[0].get('quantity','')}")
except Exception as e:
    print(f"  Error: {str(e)[:150]}")

print("\n✅ Done!")
