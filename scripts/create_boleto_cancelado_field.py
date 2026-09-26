#!/usr/bin/env python3
"""Create missing x_studio_boleto_cancelado field on account.move"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# First find the model ID for account.move
model_ids = models.execute_kw(db, uid, pwd, 'ir.model', 'search', [[['model', '=', 'account.move']]])
print(f"account.move model ID: {model_ids}")

# Check if x_studio_boleto_cancelado already exists
existing = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
    [['model', '=', 'account.move'], ['name', '=', 'x_studio_boleto_cancelado']]
], {'fields': ['name']})
if existing:
    print("x_studio_boleto_cancelado already exists!")
else:
    # Create the field
    field_id = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'create', [{
        'name': 'x_studio_boleto_cancelado',
        'field_description': 'Boleto Cancelado',
        'model_id': model_ids[0],
        'ttype': 'boolean',
        'store': True,
    }])
    print(f"Created x_studio_boleto_cancelado field ID: {field_id}")

# Verify all needed fields now exist
needed = ['x_studio_itau_nosso_numero', 'x_studio_itau_resposta_json', 'x_studio_boleto_cancelado',
          'x_studio_nfe_status', 'x_studio_nfe_chave', 'x_studio_nfe_protocolo',
          'x_studio_itau_codigo_barras', 'x_studio_itau_linha_digitavel']
for n in needed:
    found = models.execute_kw(db, uid, pwd, 'ir.model.fields', 'search_read', [
        [['model', '=', 'account.move'], ['name', '=', n]]
    ], {'fields': ['name', 'ttype']})
    if found:
        print(f"  OK  {n} ({found[0]['ttype']})")
    else:
        print(f"  MISSING  {n}")
