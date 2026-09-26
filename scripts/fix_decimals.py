#!/usr/bin/env python3
"""
Fix x_studio_margem_ field to show 2 decimal places in the sale order line list.
The issue: values like 4889% and 2097% need to show as 48.89% and 20.97% (or similar).
Looking at the data: price=67, cost would give margem=4889% which means cost is ~1.34
So the formula is correct but the display needs formatting.

Two issues to fix:
1. The field should show 2 decimal places (e.g., 4889.00 instead of 4889)
2. Add % symbol or use percentage widget
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

# 1. Update the field's digits attribute via ir.model.fields
print("=== Fix x_studio_margem_ decimal precision ===")

# Find the field
sol_model = models.execute_kw(DB, uid, APIKEY, 'ir.model', 'search_read', [
    [['model', '=', 'sale.order.line']]
], {'limit': 1, 'fields': ['id']})
model_id = sol_model[0]['id']

field = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'search_read', [
    [['model_id', '=', model_id], ['name', '=', 'x_studio_margem_']]
], {'limit': 1, 'fields': ['id', 'name', 'ttype', 'field_description', 'digits', 'store']})
print(f"  Field: {field}")

if field:
    field_id = field[0]['id']
    print(f"  Current digits: {field[0].get('digits', 'not set')}")
    
    # Try to update digits to (16,2) - 2 decimal places
    try:
        result = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'write', [field_id, {
            'digits': '(16, 2)',
        }])
        print(f"  ✅ Digits updated: {result}")
    except Exception as e:
        print(f"  Error writing digits: {str(e)[:200]}")
        # Try with tuple format
        try:
            result = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'write', [field_id, {
                'digits': [16, 2],
            }])
            print(f"  ✅ Digits updated (list): {result}")
        except Exception as e2:
            print(f"  Error writing digits as list: {str(e2)[:200]}")

# 2. Update the tree/list view to add widget="percentage" or decimal precision
print("\n=== Update list view with proper formatting ===")

# Read current view
v = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [[4825]], 
    {'fields': ['arch_db']})
current_arch = v[0]['arch_db']
print(f"  Current arch: {current_arch}")

# Update with decimal precision widget and % display
NEW_TREE_ARCH = """<data>
    <xpath expr="//field[@name='order_line']//list//field[@name='price_subtotal']" position="after">
        <field name="x_studio_margem_" string="Margem" optional="show" widget="float" digits="[16,2]"/>
    </xpath>
</data>"""

try:
    result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4825, {
        'arch_db': NEW_TREE_ARCH,
    }])
    print(f"  ✅ View updated with digits: {result}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")
    # Try without digits attribute
    NEW_TREE_ARCH2 = """<data>
    <xpath expr="//field[@name='order_line']//list//field[@name='price_subtotal']" position="after">
        <field name="x_studio_margem_" string="Margem" optional="show" force_save="1"/>
    </xpath>
</data>"""
    try:
        result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4825, {
            'arch_db': NEW_TREE_ARCH2,
        }])
        print(f"  ✅ View updated (basic): {result}")
    except Exception as e2:
        print(f"  Error2: {str(e2)[:200]}")

# 3. Check what the actual field values are on real lines
print("\n=== Check real values ===")
line_ids = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'search', [
    [['x_studio_margem_', '>', 0]]
], {'limit': 10})
if line_ids:
    lines = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'read', 
        [line_ids[:10]], {'fields': ['id', 'name', 'price_unit', 'product_id', 'x_studio_margem_']})
    for l in lines:
        pname = l.get('product_id','') and l['product_id'][1][:40] or l.get('name','')[:40]
        print(f"  {pname}: venda={l.get('price_unit',0)}, margem={l.get('x_studio_margem_',0)}")
else:
    print("  No lines with margin > 0")

# Verify
print("\n=== Verify ===")
v = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [[4825]], {'fields': ['arch_db']})
print(f"  Final arch: {v[0]['arch_db']}")
