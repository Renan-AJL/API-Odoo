#!/usr/bin/env python3
"""
Create server action + button for margin calculation on sale.order.
- Server action: iterates order lines, calculates margin % based on product cost
- Button: added to sale order form header
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

# ===== STEP 1: Create the server action =====
print("\n=== STEP 1: Create Server Action ===")

# Get model id for sale.order
so_model = models.execute_kw(DB, uid, APIKEY, 'ir.model', 'search_read', [
    [['model', '=', 'sale.order']]
], {'limit': 1, 'fields': ['id', 'name', 'model']})
if not so_model:
    print("ERROR: sale.order model not found!")
    sys.exit(1)
so_model_id = so_model[0]['id']
print(f"sale.order model ID: {so_model_id}")

# Server action code - calculates margin for all lines in the order
ACTION_CODE = """# Calcular margem % para todas as linhas do pedido
for order in records:
    for line in order.order_line:
        price_unit = line.price_unit or 0.0
        # Preço de custo/compra do produto
        purchase_price = line.product_id.standard_price or 0.0
        if purchase_price > 0:
            margem = ((price_unit - purchase_price) / purchase_price) * 100.0
        else:
            margem = 0.0
        line['x_studio_margem_'] = round(margem, 2)"""

# Check if action already exists
existing = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'search_read', [
    [['name', '=', 'Calcular Margem %'], ['model_id', '=', so_model_id]]
], {'limit': 1, 'fields': ['id', 'name']})

if existing:
    # Update existing action
    action_id = existing[0]['id']
    print(f"Updating existing server action ID={action_id}")
    result = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'write', [action_id, {
        'code': ACTION_CODE,
    }])
    print(f"Update result: {result}")
else:
    # Create new server action
    print("Creating new server action...")
    try:
        action_id = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'create', [{
            'name': 'Calcular Margem %',
            'model_id': so_model_id,
            'state': 'code',
            'code': ACTION_CODE,
        }])
        print(f"✅ Server action created with ID={action_id}")
    except Exception as e:
        print(f"Error creating action: {e}")
        sys.exit(1)

# Verify the action
action = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'read', [action_id], 
    {'fields': ['id', 'name', 'state', 'code', 'model_id']})
print(f"Verified action: ID={action[0]['id']}, name='{action[0]['name']}', state={action[0]['state']}")

# ===== STEP 2: Add button to sale.order form view =====
print("\n=== STEP 2: Add Button to Sale Order Form ===")

# Find the sale.order form view
form_views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
    [['model', '=', 'sale.order'], ['type', '=', 'form'], ['key', '=', 'sale.view_order_form']]
], {'limit': 1, 'fields': ['id', 'name', 'key', 'inherit_id']})

if not form_views:
    # Try broader search
    form_views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
        [['model', '=', 'sale.order'], ['type', '=', 'form'], ['key', 'like', 'view_order_form']]
    ], {'limit': 5, 'fields': ['id', 'name', 'key', 'inherit_id']})

print(f"Found {len(form_views)} form view(s):")
for v in form_views:
    print(f"  ID={v['id']}, name='{v['name']}', key={v.get('key','')}, inherit_id={v.get('inherit_id','')}")

if not form_views:
    print("ERROR: No sale.order form view found!")
    sys.exit(1)

# Instead of modifying the main form (risky), create an inherited view with the button
# Check if our inherited view already exists
our_views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', [
    [['key', '=', 'ajl.sale_order_margin_button'], ['type', '=', 'form']]
], {'limit': 1, 'fields': ['id', 'name']})

parent_view_id = form_views[0]['id']

# The button XML - adds a "Calcular Margem %" button in the header area
# Using XPath to insert after the confirm button
BUTTON_ARCH = """<data>
    <xpath expr="//header/button[@name='action_confirm']" position="after">
        <button name="%(ajl_sale_order_margin_action)d" string="Calcular Margem %" type="action" class="btn-secondary" groups="base.group_user"/>
    </xpath>
</data>"""

if our_views:
    # Update existing
    view_id = our_views[0]['id']
    print(f"Updating existing inherited view ID={view_id}")
    try:
        result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [view_id, {
            'arch_db': BUTTON_ARCH,
        }])
        print(f"View update result: {result}")
    except Exception as e:
        print(f"Error updating view: {e}")
else:
    # Create inherited view
    print("Creating inherited view with button...")
    try:
        view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
            'name': 'Sale Order Margin Button',
            'key': 'ajl.sale_order_margin_button',
            'model': 'sale.order',
            'type': 'form',
            'inherit_id': parent_view_id,
            'arch_db': BUTTON_ARCH,
            'priority': 99,
        }])
        print(f"✅ Inherited view created with ID={view_id}")
    except Exception as e:
        print(f"Error creating inherited view: {e}")
        # Try alternative approach - use action_id directly in button name
        print("\nTrying alternative button approach...")
        BUTTON_ARCH_ALT = f"""<data>
    <xpath expr="//header/button[@name='action_confirm']" position="after">
        <button name="{action_id}" string="Calcular Margem %" type="object" class="btn-secondary" groups="base.group_user"/>
    </xpath>
</data>"""
        # Actually, for server actions, type should be "action" and name should reference the action
        # Let's try with ir.actions.server id directly
        BUTTON_ARCH_ALT2 = """<data>
    <xpath expr="//header" position="inside">
        <button name="%d" string="Calcular Margem %%" type="action" class="btn-secondary"/>
    </xpath>
</data>""" % action_id
        try:
            view_id = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'create', [{
                'name': 'Sale Order Margin Button',
                'key': 'ajl.sale_order_margin_button',
                'model': 'sale.order',
                'type': 'form',
                'inherit_id': parent_view_id,
                'arch_db': BUTTON_ARCH_ALT2,
                'priority': 99,
            }])
            print(f"✅ Inherited view created with ID={view_id} (alt approach)")
        except Exception as e2:
            print(f"Error with alt approach: {e2}")

print("\n=== DONE ===")
print(f"Server Action ID: {action_id}")
print(f"View ID: {view_id if 'view_id' in dir() else 'N/A'}")
