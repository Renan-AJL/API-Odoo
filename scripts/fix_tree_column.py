#!/usr/bin/env python3
"""
Add x_studio_margem_ column to the sale order line list view.
Use correct XPath for Odoo 19 <list> structure.
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

PARENT_VIEW_ID = 1157

# Delete existing tree view if it was created with wrong arch
existing = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
    [['key', '=', 'ajl.sale_order_line_margin_tree']]
], {'limit': 1, 'fields': ['id']})
if existing:
    print(f"Deleting existing view ID={existing[0]['id']}")
    models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'unlink', [[existing[0]['id']]])

# The correct XPath: add after the last price_subtotal in the list
# In Odoo 19, the list uses <list> tag. The price_subtotal has string="Amount"
LINE_LIST_ARCH = """<data>
    <xpath expr="//field[@name='order_line']/list/field[@name='price_subtotal'][@string='Amount']" position="after">
        <field name="x_studio_margem_" string="Margem %%" optional="show" widget="percentage"/>
    </xpath>
</data>"""

print("Creating inherited view for margin column...")
try:
    tree_view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
        'name': 'Sale Order Line Margin Column',
        'key': 'ajl.sale_order_line_margin_tree',
        'model': 'sale.order',
        'type': 'form',
        'inherit_id': PARENT_VIEW_ID,
        'arch_db': LINE_LIST_ARCH,
        'priority': 33,
    }])
    print(f"✅ Tree view created with ID={tree_view_id}")
except Exception as e:
    err = str(e)[:300]
    print(f"Error: {err}")
    
    # Try alternative XPath - just find any price_subtotal in the list
    print("\nTrying alternative XPath 1...")
    ALT1 = """<data>
    <xpath expr="//list[@string='Sales Order Lines']/field[@name='price_subtotal']" position="after">
        <field name="x_studio_margem_" string="Margem %%" optional="show"/>
    </xpath>
</data>"""
    try:
        tree_view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
            'name': 'Sale Order Line Margin Column',
            'key': 'ajl.sale_order_line_margin_tree',
            'model': 'sale.order',
            'type': 'form',
            'inherit_id': PARENT_VIEW_ID,
            'arch_db': ALT1,
            'priority': 33,
        }])
        print(f"✅ Tree view created with ID={tree_view_id} (alt1)")
    except Exception as e2:
        print(f"Error alt1: {str(e2)[:300]}")
        
        # Try with just the list reference
        print("\nTrying alternative XPath 2...")
        ALT2 = """<data>
    <xpath expr="//field[@name='order_line']//list//field[@name='price_subtotal']" position="after">
        <field name="x_studio_margem_" string="Margem %%" optional="show"/>
    </xpath>
</data>"""
        try:
            tree_view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
                'name': 'Sale Order Line Margin Column',
                'key': 'ajl.sale_order_line_margin_tree',
                'model': 'sale.order',
                'type': 'form',
                'inherit_id': PARENT_VIEW_ID,
                'arch_db': ALT2,
                'priority': 33,
            }])
            print(f"✅ Tree view created with ID={tree_view_id} (alt2)")
        except Exception as e3:
            print(f"Error alt2: {str(e3)[:300]}")
            
            # Try without the string attribute
            print("\nTrying alternative XPath 3 (no string filter)...")
            ALT3 = """<data>
    <xpath expr="//field[@name='order_line']/list/field[@name='price_subtotal']" position="after">
        <field name="x_studio_margem_" string="Margem %%" optional="show"/>
    </xpath>
</data>"""
            try:
                tree_view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
                    'name': 'Sale Order Line Margin Column',
                    'key': 'ajl.sale_order_line_margin_tree',
                    'model': 'sale.order',
                    'type': 'form',
                    'inherit_id': PARENT_VIEW_ID,
                    'arch_db': ALT3,
                    'priority': 33,
                }])
                print(f"✅ Tree view created with ID={tree_view_id} (alt3)")
            except Exception as e4:
                print(f"Error alt3: {str(e4)[:300]}")

# Verify
print("\n=== Verify all our views ===")
our_views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
    [['key', 'like', 'ajl.sale_order%']]
], {'limit': 10, 'fields': ['id', 'name', 'key', 'type', 'inherit_id', 'active']})
for v in our_views:
    print(f"  ID={v['id']}, key={v.get('key','')}, type={v.get('type','')}, inherit={v.get('inherit_id','')}, active={v.get('active','')}")
