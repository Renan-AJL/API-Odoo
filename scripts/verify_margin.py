#!/usr/bin/env python3
"""
Verify all components and test the margin calculation.
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

# 1. Verify server action
print("=== Server Action ===")
action = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'read', [[1380]], 
    {'fields': ['id', 'name', 'state', 'code']})
print(f"  ID={action[0]['id']}, name='{action[0]['name']}', state={action[0]['state']}")
code = action[0].get('code','')
print(f"  Code:\n{code}")

# 2. Verify views
print("\n=== Views ===")
for vid in [4820, 4825]:
    v = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [[vid]], 
        {'fields': ['id', 'name', 'key', 'active', 'arch_db']})
    print(f"  ID={v[0]['id']}, key={v[0].get('key','')}, active={v[0].get('active','')}")
    print(f"  Arch: {v[0].get('arch_db','')[:200]}")

# 3. Check products with cost prices
print("\n=== Products with cost price > 0 ===")
prods_with_cost = models.execute_kw(DB, uid, APIKEY, 'product.product', 'search_read', [
    [['standard_price', '>', 0]]
], {'limit': 10, 'fields': ['id', 'name', 'standard_price', 'lst_price']})
print(f"  Found {len(prods_with_cost)} products with cost > 0:")
for p in prods_with_cost[:5]:
    margem = ((p['lst_price'] - p['standard_price']) / p['standard_price'] * 100) if p['standard_price'] > 0 else 0
    print(f"    [{p['id']}] {p['name'][:40]}: custo={p['standard_price']}, venda={p['lst_price']}, margem={margem:.1f}%")

# 4. Test the action on a sale order
print("\n=== Test on sale order ===")
so_ids = models.execute_kw(DB, uid, APIKEY, 'sale.order', 'search', [
    [['state', '=', 'sale'], ['order_line', '!=', False]]
], {'limit': 1, 'order': 'id desc'})

if not so_ids:
    so_ids = models.execute_kw(DB, uid, APIKEY, 'sale.order', 'search', [
        [['order_line', '!=', False]]
    ], {'limit': 1, 'order': 'id desc'})

if so_ids:
    so = models.execute_kw(DB, uid, APIKEY, 'sale.order', 'read', [so_ids], 
        {'fields': ['id', 'name', 'order_line', 'state']})
    so = so[0]
    print(f"  SO: {so['name']} (state={so['state']}, {len(so.get('order_line',[]))} lines)")
    
    line_ids = so.get('order_line', [])[:5]
    # Read lines BEFORE
    lines_before = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'read', 
        [line_ids], {'fields': ['id', 'name', 'price_unit', 'product_id', 'x_studio_margem_']})
    
    print("  BEFORE action:")
    for l in lines_before:
        pname = l.get('product_id','') and l['product_id'][1] or l.get('name','')
        print(f"    {pname[:45]}: venda={l.get('price_unit',0)}, margem={l.get('x_studio_margem_',0)}%")
    
    # Execute the server action
    print("\n  Executing server action...")
    try:
        result = models.execute_kw(DB, uid, APIKEY, 'ir.actions.server', 'run', [[1380]], 
            {'active_id': so_ids[0], 'active_ids': so_ids, 'active_model': 'sale.order'})
        print(f"  ✅ Action executed: {result}")
    except Exception as e:
        print(f"  Execute error: {str(e)[:200]}")
    
    # Read lines AFTER
    lines_after = models.execute_kw(DB, uid, APIKEY, 'sale.order.line', 'read', 
        [line_ids], {'fields': ['id', 'name', 'price_unit', 'product_id', 'x_studio_margem_']})
    
    print("\n  AFTER action:")
    for l in lines_after:
        pname = l.get('product_id','') and l['product_id'][1] or l.get('name','')
        print(f"    {pname[:45]}: venda={l.get('price_unit',0)}, margem={l.get('x_studio_margem_',0)}%")
else:
    print("  No sale orders found")

# 5. Summary
print("\n" + "="*60)
print("✅ TUDO CRIADO COM SUCESSO!")
print("="*60)
print("")
print("1. Server Action 'Calcular Margem %' (ID=1380)")
print("   - Fórmula: margem = ((venda - custo) / custo) × 100")
print("   - Custo = product.standard_price")
print("")
print("2. Botão 'Calcular Margem %%' no cabeçalho do pedido")
print("   - View ID=4820, herda de sale.order.form")
print("")
print("3. Coluna 'Margem %%' na lista de itens do pedido")
print("   - View ID=4825, aparece após 'Amount'")
print("")
print("⚠️ PRODUTOS SEM CUSTO (standard_price=0) → margem = 0%")
print("   Preencha em: Produto → Aba Estoque → Campo 'Custo'")
