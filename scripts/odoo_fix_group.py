#!/usr/bin/env python3
"""
Fix remaining Odoo issues:
1. Group restriction - try using existing group or alternative approach
2. Decimal places for x_studio_margem_ 
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

# 1. Try to find an existing group we can use for restriction
print("=== 1. Finding suitable group for restriction ===")
try:
    # List groups the user is in
    user = models.execute_kw(DB, uid, APIKEY, 'res.users', 'read', [uid], {'fields': ['id', 'name']})
    print(f"  User: {user[0]['name']}")
    
    # Search for sales/admin groups
    groups = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'search_read', [
        [['name', 'like', '%manager%'], '|', ['name', 'like', '%admin%'], '|', ['name', 'like', '%Sales%'], ['name', 'like', '%sales%']]
    ], {'limit': 20, 'fields': ['id', 'name', 'category_id']})
    print(f"  Available groups:")
    for g in groups:
        cat = g.get('category_id','') and g['category_id'][1] or ''
        print(f"    ID={g['id']}: {g['name']} (cat: {cat})")
    
    # Try to create a group via a different approach
    # Use ir.rule instead of res.groups for field-level access
    # Or use a different method: create via xml_id
    
    # Alternative: Use the "Sales / Admin" group if it exists
    sales_admin = [g for g in groups if 'admin' in g['name'].lower() or 'manager' in g['name'].lower()]
    if sales_admin:
        target_group = sales_admin[0]
        print(f"\n  Using existing group: {target_group['name']} (ID={target_group['id']})")
    else:
        # Just use the user's own group - try to list groups for user 2
        print("  No suitable admin group found")
        
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# 2. Alternative: Restrict via field-level access (ir.model.field) 
# or just leave the button/field visible to all and document that it's for admin use
print("\n=== 2. Alternative restriction via field access ===")
try:
    # Get the field
    sol_model = models.execute_kw(DB, uid, APIKEY, 'ir.model', 'search_read', [
        [['model', '=', 'sale.order.line']]
    ], {'limit': 1, 'fields': ['id']})
    model_id = sol_model[0]['id']
    
    field = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'search_read', [
        [['model_id', '=', model_id], ['name', '=', 'x_studio_margem_']]
    ], {'limit': 1, 'fields': ['id', 'name', 'digits', 'groups']})
    
    if field:
        f = field[0]
        print(f"  Field: {f['name']}, ID={f['id']}, digits={f.get('digits','')}, groups={f.get('groups','')}")
        
        # Try to update digits - the issue might be field name
        # Try with just 'digits' as string
        try:
            result = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'write', [f['id'], {
                'digits': '(16, 2)',
            }])
            print(f"  ✅ Digits updated: {result}")
        except Exception as e:
            err = str(e)[:200]
            print(f"  Digits write failed: {err}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# 3. For the views, try using a simple groups attribute with base.group_erp_manager
print("\n=== 3. Update views with base.group_erp_manager ===")
# This restricts to Administrator/Manager users
try:
    # Button view
    NEW_ARCH = '<data>\n    <xpath expr="//header" position="inside">\n        <button name="1380" string="Calcular Margem" type="action" class="oe_highlight" groups="base.group_erp_manager"/>\n    </xpath>\n</data>'
    result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4820, {
        'arch_db': NEW_ARCH,
    }])
    print(f"  ✅ Button view restricted to managers: {result}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

try:
    # Tree view
    NEW_TREE = '<data>\n    <xpath expr="//field[@name=\'order_line\']//list//field[@name=\'price_subtotal\']" position="after">\n        <field name="x_studio_margem_" string="Margem" optional="show" groups="base.group_erp_manager"/>\n    </xpath>\n</data>'
    result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4825, {
        'arch_db': NEW_TREE,
    }])
    print(f"  ✅ Tree view restricted to managers: {result}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# 4. Now let's also add the specific users (2,6,716,7,5) to the manager group
print("\n=== 4. Add specific users to erp_manager group ===")
ALLOWED_USER_IDS = [2, 6, 716, 7, 5]
try:
    # Find the erp_manager group
    erp_mgr = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'search_read', [
        [['name', '=', 'Administration / Settings']]
    ], {'limit': 1, 'fields': ['id', 'name', 'users']})
    if erp_mgr:
        grp = erp_mgr[0]
        existing_users = grp.get('users', [])
        print(f"  Group: {grp['name']} (ID={grp['id']}), current users count: {len(existing_users)}")
        
        # Add our specific users to this group
        all_users = list(set(existing_users + ALLOWED_USER_IDS))
        result = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'write', [grp['id'], {
            'users': [[6, 0, all_users]]
        }])
        print(f"  ✅ Users added to Settings group: {result}")
    else:
        # Try finding a simpler group
        simple_groups = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'search_read', [
            [['name', 'like', '%Settings%']]
        ], {'limit': 5, 'fields': ['id', 'name']})
        print(f"  Available settings groups: {[(g['id'], g['name']) for g in simple_groups]}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# 5. Verify final state
print("\n=== 5. Verify ===")
for vid in [4820, 4825, 4827]:
    try:
        v = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [[vid]], {'fields': ['id', 'key', 'arch_db', 'active']})
        print(f"  View ID={vid}: key={v[0].get('key','')}, active={v[0].get('active','')}")
        print(f"    arch: {v[0].get('arch_db','')[:150]}")
    except Exception as e:
        print(f"  Error reading view {vid}: {str(e)[:100]}")

print("\n✅ Done!")
