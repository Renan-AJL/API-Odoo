#!/usr/bin/env python3
"""
ConsultFlex - Criar Server Action v3
Usa records.write() em vez de atribuicao direta (evita STORE_ATTR)
"""
import xmlrpc.client

ODOO_URL = 'https://ajlferroeaco.odoo.com/'
ODOO_DB = 'ajlferroeaco'
ODOO_USER = 'marcus@nytro.com.br'
ODOO_API_KEY = '5d50bc0616508c0a167218116d53199f710bca9b'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/common', allow_none=True)
uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
models = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/object', allow_none=True)

def kw(model, method, args, kwargs=None):
    if kwargs:
        return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs)
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args)

action_name = 'AJL-ConsultFlex Consultar'

# Check existing
existing = kw('ir.actions.server', 'search', [
    [['name', '=', action_name], ['model_id.model', '=', 'sale.order']]
])
if existing:
    print(f'[SKIP] Server Action ja existe (ID: {existing[0]})')
    # Read and show it
    data = kw('ir.actions.server', 'read', [existing, ['name', 'state', 'code']])[0]
    print(f'  state: {data.get("state")}')
    print(f'  code: {data.get("code", "")[:300]}')
else:
    model_ids = kw('ir.model', 'search', [[['model', '=', 'sale.order']]])
    model_id = model_ids[0]
    
    # Abordagem 1: records.write() - evita STORE_ATTR
    python_code = '''records.write({
    'x_studio_cf_status': 'pendente',
    'x_studio_resposta_consultflex': '<p style="color:orange;font-weight:bold">Consulta em processamento... atualize a pagina em alguns segundos.</p>',
})
log('ConsultFlex: Consulta marcada como pendente para sale.order(s) %s', records.ids)'''
    
    vals = {
        'name': action_name,
        'model_id': model_id,
        'state': 'code',
        'code': python_code,
    }
    
    try:
        new_id = kw('ir.actions.server', 'create', [vals])
        print(f'[OK] Server Action criada (ID: {new_id})')
    except Exception as e:
        err = str(e)
        print(f'[ERRO] Abordagem 1: {err[:300]}')
        
        # Abordagem 2: state = 'object_write'
        try:
            vals2 = {
                'name': action_name,
                'model_id': model_id,
                'state': 'object_write',
                'update_field_name': 'x_studio_cf_status',
                'evaluation_type': 'value',
                'value': 'pendente',
            }
            new_id = kw('ir.actions.server', 'create', [vals2])
            print(f'[OK] Server Action (object_write) criada (ID: {new_id})')
        except Exception as e2:
            print(f'[ERRO] Abordagem 2: {str(e2)[:300]}')
            
            # Abordagem 3: Multi action com code simples
            try:
                vals3 = {
                    'name': action_name,
                    'model_id': model_id,
                    'state': 'code',
                    'code': 'records.write({"x_studio_cf_status": "pendente"})\nlog("ConsultFlex: pendente")',
                }
                new_id = kw('ir.actions.server', 'create', [vals3])
                print(f'[OK] Server Action (simples) criada (ID: {new_id})')
            except Exception as e3:
                print(f'[ERRO] Abordagem 3: {str(e3)[:300]}')
