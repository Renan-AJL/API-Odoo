#!/usr/bin/env python3
"""Create missing product.product fields for IPI and check product.template"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Check product.template for IPI fields
print("=== Checking product.template ===")
for f in ['x_studio_cst_ipi', 'x_studio_aliquota_ipi', 'x_studio_c_trib_nac', 'x_studio_c_nbs']:
    found = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
        [['model', '=', 'product.template'], ['name', '=', f]]
    ], {'fields': ['name', 'ttype']})
    if found:
        print(f"  OK  {f} ({found[0]['ttype']}) on product.template")
    else:
        print(f"  MISSING  {f} on product.template")

# Get model ID for product.product
pp_model = models.execute_kw(db, uid, pwd, 'ir.model', 'search', [[['model', '=', 'product.product']]])
print(f"\nproduct.product model ID: {pp_model}")

# Create x_studio_cst_ipi on product.product
existing = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
    [['model', '=', 'product.product'], ['name', '=', 'x_studio_cst_ipi']]
], {'fields': ['name']})
if not existing:
    fid = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'create', [{
        'name': 'x_studio_cst_ipi',
        'field_description': 'CST IPI',
        'model_id': pp_model[0],
        'ttype': 'char',
        'store': True,
    }])
    print(f"Created x_studio_cst_ipi on product.product: ID={fid}")
else:
    print("x_studio_cst_ipi already exists on product.product")

# Create x_studio_aliquota_ipi on product.product
existing2 = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
    [['model', '=', 'product.product'], ['name', '=', 'x_studio_aliquota_ipi']]
], {'fields': ['name']})
if not existing2:
    fid2 = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'create', [{
        'name': 'x_studio_aliquota_ipi',
        'field_description': 'Aliquota IPI (%)',
        'model_id': pp_model[0],
        'ttype': 'float',
        'store': True,
    }])
    print(f"Created x_studio_aliquota_ipi on product.product: ID={fid2}")
else:
    print("x_studio_aliquota_ipi already exists on product.product")

# Also create on product.template so they show up in product form
pt_model = models.execute_kw(db, uid, pwd, 'ir.model', 'search', [[['model', '=', 'product.template']]])
print(f"\nproduct.template model ID: {pt_model}")

existing3 = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
    [['model', '=', 'product.template'], ['name', '=', 'x_studio_cst_ipi']]
], {'fields': ['name']})
if not existing3:
    fid3 = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'create', [{
        'name': 'x_studio_cst_ipi',
        'field_description': 'CST IPI',
        'model_id': pt_model[0],
        'ttype': 'char',
        'store': True,
    }])
    print(f"Created x_studio_cst_ipi on product.template: ID={fid3}")
else:
    print("x_studio_cst_ipi already exists on product.template")

existing4 = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
    [['model', '=', 'product.template'], ['name', '=', 'x_studio_aliquota_ipi']]
], {'fields': ['name']})
if not not existing4:
    print("x_studio_aliquota_ipi already exists on product.template")
else:
    fid4 = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'create', [{
        'name': 'x_studio_aliquota_ipi',
        'field_description': 'Aliquota IPI (%)',
        'model_id': pt_model[0],
        'ttype': 'float',
        'store': True,
    }])
    print(f"Created x_studio_aliquota_ipi on product.template: ID={fid4}")

print("\nDone!")
