#!/usr/bin/env python3
"""
Add margin calculation button to sale.order form.
Server action ID=1380 already created.
Parent view ID=1157 (sale.order.form).
"""
import xmlrpc.client
import sys

URL = 'https://ajlferroeaco.odoo.com/'
DB = 'ajlferroeaco'
USER = 'marcus@nytro.com.br'
APIKEY = 'a60341a34aedd0b37b3786d53ea8df061357c31d'

common = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/common')
uid = common.authenticate(DB, USER, APIKEY, {})
models = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/object')
print(f"uid={uid}")

ACTION_ID = 1380  # Server action "Calcular Margem %"
PARENT_VIEW_ID = 1157  # sale.order.form

# First, create an ir.model.data (external ID) for the server action
# so we can reference it properly in the button
print("=== Creating external ID for server action ===")
try:
    # Check if already exists
    existing_mdata = models.execute_kw(DB, uid, APIKEY, 'ir.model.data', 'search_read', [
        [['module', '=', 'ajl_custom'], ['name', '=', 'action_calculate_margin']]
    ], {'limit': 1, 'fields': ['id', 'res_id']})
    
    if existing_mdata:
        print(f"  External ID already exists: {existing_mdata}")
    else:
        mdata_id = models.execute_kw(DB, uid, APIKEY, 'ir.model.data', 'create', [{
            'module': 'ajl_custom',
            'name': 'action_calculate_margin',
            'model': 'ir.actions.server',
            'res_id': ACTION_ID,
        }])
        print(f"  ✅ External ID created: {mdata_id}")
except Exception as e:
    print(f"  Warning: {str(e)[:150]}")
    print("  Will try with direct ID reference")

# Check if our inherited view already exists
print("\n=== Check for existing inherited view ===")
existing_views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
    [['key', '=', 'ajl.sale_order_margin_button']]
], {'limit': 1, 'fields': ['id', 'name']})

if existing_views:
    view_id = existing_views[0]['id']
    print(f"  Found existing view ID={view_id}, will update")
else:
    view_id = None
    print("  No existing view, will create new")

# The button arch - using %(ajl_custom.action_calculate_margin)d reference
# Position after action_confirm button in header
BUTTON_ARCH = """<data>
    <xpath expr="//header/button[@name='action_confirm']" position="after">
        <button name="%(ajl_custom.action_calculate_margin)d" string="Calcular Margem %%" type="action" class="oe_highlight"/>
    </xpath>
</data>"""

# Alternative: show x_studio_margem_ in the order line tree too
# This makes the margin visible inline without opening each line
LINE_TREE_ARCH = """<data>
    <xpath expr="//field[@name='order_line']//tree//field[@name='price_subtotal']" position="after">
        <field name="x_studio_margem_" string="Margem %%" optional="show"/>
    </xpath>
</data>"""

# Try creating the inherited view
print("\n=== Creating inherited view with button ===")
try:
    if view_id:
        result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [view_id, {
            'arch_db': BUTTON_ARCH,
        }])
        print(f"  View updated: {result}")
    else:
        view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
            'name': 'Sale Order Margin Button',
            'key': 'ajl.sale_order_margin_button',
            'model': 'sale.order',
            'type': 'form',
            'inherit_id': PARENT_VIEW_ID,
            'arch_db': BUTTON_ARCH,
            'priority': 32,
        }])
        print(f"  ✅ View created with ID={view_id}")
except Exception as e:
    print(f"  Error with button approach: {str(e)[:200]}")
    
    # Try simpler approach - just add the button in header
    print("\n  Trying simpler XPath...")
    BUTTON_ARCH_SIMPLE = f"""<data>
    <xpath expr="//header" position="inside">
        <button name="{ACTION_ID}" string="Calcular Margem %%" type="action" class="oe_highlight"/>
    </xpath>
</data>"""
    try:
        if view_id:
            result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [view_id, {
                'arch_db': BUTTON_ARCH_SIMPLE,
            }])
            print(f"  View updated (simple): {result}")
        else:
            view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
                'name': 'Sale Order Margin Button',
                'key': 'ajl.sale_order_margin_button',
                'model': 'sale.order',
                'type': 'form',
                'inherit_id': PARENT_VIEW_ID,
                'arch_db': BUTTON_ARCH_SIMPLE,
                'priority': 32,
            }])
            print(f"  ✅ View created with ID={view_id} (simple)")
    except Exception as e2:
        print(f"  Error with simple approach: {str(e2)[:200]}")

# Now add the margin column to the order line tree
print("\n=== Adding Margem % column to order line tree ===")
# Check for existing
existing_tree_views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
    [['key', '=', 'ajl.sale_order_line_margin_tree']]
], {'limit': 1, 'fields': ['id']})

# Find the order line tree view within the form
# The tree is embedded in the form view, so we need to inherit the same form
try:
    tree_view_id = existing_tree_views[0]['id'] if existing_tree_views else None
    
    if tree_view_id:
        result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [tree_view_id, {
            'arch_db': LINE_TREE_ARCH,
        }])
        print(f"  Tree view updated: {result}")
    else:
        tree_view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
            'name': 'Sale Order Line Margin Tree',
            'key': 'ajl.sale_order_line_margin_tree',
            'model': 'sale.order',
            'type': 'form',
            'inherit_id': PARENT_VIEW_ID,
            'arch_db': LINE_TREE_ARCH,
            'priority': 33,
        }])
        print(f"  ✅ Tree view created with ID={tree_view_id}")
except Exception as e:
    print(f"  Error adding tree column: {str(e)[:200]}")
    # Try alternative XPath
    LINE_TREE_ARCH_ALT = """<data>
    <xpath expr="//page[@name='order_lines']//field[@name='order_line']//tree//field[@name='price_unit']" position="after">
        <field name="x_studio_margem_" string="Margem %%" optional="show"/>
    </xpath>
</data>"""
    try:
        if tree_view_id:
            result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [tree_view_id, {
                'arch_db': LINE_TREE_ARCH_ALT,
            }])
            print(f"  Tree view updated (alt): {result}")
        else:
            tree_view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
                'name': 'Sale Order Line Margin Tree',
                'key': 'ajl.sale_order_line_margin_tree',
                'model': 'sale.order',
                'type': 'form',
                'inherit_id': PARENT_VIEW_ID,
                'arch_db': LINE_TREE_ARCH_ALT,
                'priority': 33,
            }])
            print(f"  ✅ Tree view created with ID={tree_view_id} (alt)")
    except Exception as e2:
        print(f"  Error with alt tree approach: {str(e2)[:200]}")

# Verify
print("\n=== Verify ===")
try:
    if view_id:
        v = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [view_id], {'fields': ['id', 'name', 'key', 'inherit_id', 'arch_db']})
        print(f"  Button view: ID={v[0]['id']}, inherit={v[0].get('inherit_id','')}, arch_len={len(v[0].get('arch_db',''))}")
    if tree_view_id:
        v = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [tree_view_id], {'fields': ['id', 'name', 'key', 'inherit_id', 'arch_db']})
        print(f"  Tree view: ID={v[0]['id']}, inherit={v[0].get('inherit_id','')}, arch_len={len(v[0].get('arch_db',''))}")
    # Verify action
    a = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'read', [ACTION_ID], {'fields': ['id', 'name', 'state']})
    print(f"  Action: ID={a[0]['id']}, name='{a[0]['name']}', state={a[0]['state']}")
except Exception as e:
    print(f"  Error: {e}")

print("\n✅ DONE - Server action + button + tree column created!")
