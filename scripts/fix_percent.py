#!/usr/bin/env python3
"""
Fix the %% → % in button and column strings, and also update the server action
to work when called from the button properly.
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

# Fix button view - use single %
print("=== Fix button view (4820) ===")
FIXED_BUTTON_ARCH = """<data>
    <xpath expr="//header" position="inside">
        <button name="%(ajl_custom.action_calculate_margin)d" string="Calcular Margem" type="action" class="oe_highlight"/>
    </xpath>
</data>"""
try:
    result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4820, {
        'arch_db': FIXED_BUTTON_ARCH,
    }])
    print(f"  ✅ Button view updated: {result}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")
    # Try with direct ID reference and single %
    ALT_ARCH = """<data>
    <xpath expr="//header" position="inside">
        <button name="1380" string="Calcular Margem" type="action" class="oe_highlight"/>
    </xpath>
</data>"""
    try:
        result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4820, {
            'arch_db': ALT_ARCH,
        }])
        print(f"  ✅ Button view updated (alt): {result}")
    except Exception as e2:
        print(f"  Alt error: {str(e2)[:200]}")

# Fix tree view - use single %
print("\n=== Fix tree view (4825) ===")
FIXED_TREE_ARCH = """<data>
    <xpath expr="//field[@name='order_line']//list//field[@name='price_subtotal']" position="after">
        <field name="x_studio_margem_" string="Margem" optional="show"/>
    </xpath>
</data>"""
try:
    result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [4825, {
        'arch_db': FIXED_TREE_ARCH,
    }])
    print(f"  ✅ Tree view updated: {result}")
except Exception as e:
    print(f"  Error: {str(e)[:200]}")

# Verify
print("\n=== Verify ===")
for vid in [4820, 4825]:
    v = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [[vid]], 
        {'fields': ['id', 'key', 'arch_db']})
    print(f"  ID={vid}, arch: {v[0].get('arch_db','')}")
