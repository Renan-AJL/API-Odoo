#!/usr/bin/env python3
"""
Odoo API changes:
1. Restrict Margem visibility to users 2,6,716,7,5
2. Fix decimal display for x_studio_margem_
3. Add storage location field on sale order line
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
models = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/object')

# ─── 1. Restrict Margem visibility to specific users ───
print("\n=== 1. Restrict Margem visibility to users 2,6,716,7,5 ===")
ALLOWED_USER_IDS = [2, 6, 716, 7, 5]
margin_group_id = None

try:
    # Check for existing group
    groups = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'search_read', [
        [['name', '=', 'AJL / Ver Margem']]
    ], {'limit': 1, 'fields': ['id', 'name']})
    
    if groups:
        margin_group_id = groups[0]['id']
        print(f"  Found existing group: ID={margin_group_id}")
        result = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'write', [margin_group_id, {
            'users': [[6, 0, ALLOWED_USER_IDS]]
        }])
        print(f"  Updated users: {result}")
    else:
        print("  Creating AJL / Ver Margem group...")
        margin_group_id = models.execute_kw(DB, uid, APIKEY, 'res.groups', 'create', [{
            'name': 'AJL / Ver Margem',
            'category_id': 1,
            'users': [[6, 0, ALLOWED_USER_IDS]],
        }])
        print(f"  ✅ Group created: ID={margin_group_id}")
        
        try:
            models.execute_kw(DB, uid, APIKEY, 'ir.model.data', 'create', [{
                'module': 'ajl_custom',
                'name': 'group_ver_margem',
                'model': 'res.groups',
                'res_id': margin_group_id,
            }])
            print(f"  ✅ External ID created")
        except Exception as e:
            print(f"  Warning: {str(e)[:100]}")
except Exception as e:
    print(f"  Error with group: {str(e)[:200]}")

# Update views with group restriction
if margin_group_id:
    print("\n  Updating button view (4820) with group...")
    try:
        NEW_ARCH = '<data>\n    <xpath expr="//header" position="inside">\n        <button name="1380" string="Calcular Margem" type="action" class="oe_highlight" groups="ajl_custom.group_ver_margem"/>\n    </xpath>\n</data>'
        result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4820, {
            'arch_db': NEW_ARCH,
        }])
        print(f"  ✅ Button view updated: {result}")
    except Exception as e:
        print(f"  Error: {str(e)[:200]}")
    
    print("\n  Updating tree view (4825) with group...")
    try:
        NEW_TREE = '<data>\n    <xpath expr="//field[@name=\'order_line\']//list//field[@name=\'price_subtotal\']" position="after">\n        <field name="x_studio_margem_" string="Margem" optional="show" groups="ajl_custom.group_ver_margem"/>\n    </xpath>\n</data>'
        result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4825, {
            'arch_db': NEW_TREE,
        }])
        print(f"  ✅ Tree view updated: {result}")
    except Exception as e:
        print(f"  Error: {str(e)[:200]}")

# Also restrict the server action itself
print("\n  Restricting server action (1380)...")
try:
    result = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'write', [1380, {
        'groups_id': [[6, 0, [margin_group_id]]] if margin_group_id else [[5]],
    }])
    print(f"  ✅ Action restricted: {result}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# ─── 2. Fix x_studio_margem_ decimal places ───
print("\n=== 2. Fix x_studio_margem_ decimal places ===")
try:
    sol_model = models.execute_kw(DB, uid, APIKEY, 'ir.model', 'search_read', [
        [['model', '=', 'sale.order.line']]
    ], {'limit': 1, 'fields': ['id']})
    model_id = sol_model[0]['id']
    
    field = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'search_read', [
        [['model_id', '=', model_id], ['name', '=', 'x_studio_margem_']]
    ], {'limit': 1, 'fields': ['id', 'digits']})
    
    if field:
        field_id = field[0]['id']
        try:
            result = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'write', [field_id, {
                'digits': '(16, 2)',
            }])
            print(f"  ✅ Digits updated: {result} (was: {field[0].get('digits','')})")
        except Exception as e:
            print(f"  Write error: {str(e)[:150]}")
            # Try with list format
            try:
                result = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'write', [field_id, {
                    'digits': [16, 2],
                }])
                print(f"  ✅ Digits updated (list): {result}")
            except Exception as e2:
                print(f"  List write error: {str(e2)[:150]}")
    else:
        print("  Field not found")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# ─── 3. Add storage location field ───
print("\n=== 3. Add storage location field on sale order line ===")
try:
    existing = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'search_read', [
        [['model', '=', 'sale.order.line'], ['name', '=', 'x_studio_local_armazenagem']]
    ], {'limit': 1, 'fields': ['id', 'name']})
    
    if existing:
        print(f"  Field already exists: ID={existing[0]['id']}")
    else:
        # Check product stock/location fields first
        prod_fields = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'search_read', [
            [['model', '=', 'product.product'], ['name', 'in', ['stock_move_ids', 'qty_available', 'virtual_available', 'product_tmpl_id']]]
        ], {'limit': 10, 'fields': ['name', 'field_description', 'ttype']})
        print(f"  Product fields found: {[f['name'] for f in prod_fields]}")
        
        # Create computed field for storage location
        COMPUTE = "for record in self:\n    product = record.product_id\n    if product:\n        quants = product.env['stock.quant'].search([('product_id', '=', product.id), ('quantity', '>', 0)], limit=1)\n        record['x_studio_local_armazenagem'] = quants.location_id.display_name if quants else ''\n    else:\n        record['x_studio_local_armazenagem'] = ''"
        
        try:
            field_id = models.execute_kw(DB, uid, APIKEY, 'ir.model.fields', 'create', [{
                'name': 'x_studio_local_armazenagem',
                'field_description': 'Local Armazenagem',
                'model_id': model_id,
                'ttype': 'char',
                'store': False,
                'compute': COMPUTE,
                'depends': 'product_id',
            }])
            print(f"  ✅ Field created: ID={field_id}")
        except Exception as e:
            print(f"  Error: {str(e)[:200]}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# Add the field to the sale order line list view
print("\n  Adding local armazenagem to order line list...")
try:
    existing_views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
        [['key', '=', 'ajl.sale_order_line_local_armazenagem']]
    ], {'limit': 1, 'fields': ['id']})
    
    if existing_views:
        print(f"  View already exists: ID={existing_views[0]['id']}")
    else:
        LOC_ARCH = '<data>\n    <xpath expr="//field[@name=\'order_line\']//list//field[@name=\'product_uom_qty\']" position="before">\n        <field name="x_studio_local_armazenagem" string="Local" optional="hide"/>\n    </xpath>\n</data>'
        view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
            'name': 'Sale Order Line Local Armazenagem',
            'key': 'ajl.sale_order_line_local_armazenagem',
            'model': 'sale.order',
            'type': 'form',
            'inherit_id': 1157,
            'arch_db': LOC_ARCH,
            'priority': 34,
        }])
        print(f"  ✅ View created: ID={view_id}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

print("\n✅ All Odoo changes complete!")
