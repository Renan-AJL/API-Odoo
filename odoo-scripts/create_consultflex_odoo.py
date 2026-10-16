#!/usr/bin/env python3
"""
Create ConsultFlex fields, view tab, and server action on Odoo sale.order.
Run with a valid API key: python3 create_consultflex_odoo.py <API_KEY>
"""
import xmlrpc.client
import sys

if len(sys.argv) < 2:
    print("Usage: python3 create_consultflex_odoo.py <ODOO_API_KEY>")
    sys.exit(1)

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = sys.argv[1]

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

def ekw(model, method, args=None, kwargs=None):
    if args is None: args = []
    if kwargs:
        return models.execute_kw(db, uid, pwd, model, method, args, kwargs)
    return models.execute_kw(db, uid, pwd, model, method, args)

# Test connection
try:
    test = ekw('sale.order', 'search_count', [[]])
    print(f"Connected! Sale orders: {test}")
except Exception as e:
    print(f"Connection failed: {e}")
    sys.exit(1)

# Get model ID for sale.order
so_models = ekw('ir.model', 'search_read', [[['model', '=', 'sale.order']]], {'fields': ['id'], 'limit': 1})
if not so_models:
    print("ERROR: sale.order model not found")
    sys.exit(1)
so_model_id = so_models[0]['id']
print(f"sale.order model_id: {so_model_id}")

# === Create Fields ===
fields_to_create = [
    {'name': 'x_studio_cf_tipo_pessoa', 'field_description': 'ConsultFlex - Tipo Pessoa', 'model_id': so_model_id, 'ttype': 'selection', 'selection': "[('J','Pessoa Jurídica (CNPJ)'), ('F','Pessoa Física (CPF)')]", 'store': True},
    {'name': 'x_studio_cf_cpfcnpj', 'field_description': 'ConsultFlex - CPF/CNPJ', 'model_id': so_model_id, 'ttype': 'char', 'store': True},
    {'name': 'x_studio_cf_resultado_html', 'field_description': 'ConsultFlex - Resultado', 'model_id': so_model_id, 'ttype': 'html', 'store': True},
    {'name': 'x_studio_cf_status', 'field_description': 'ConsultFlex - Status', 'model_id': so_model_id, 'ttype': 'selection', 'selection': "[('pendente','Pendente'), ('consultando','Consultando'), ('concluido','Concluído'), ('erro','Erro')]", 'store': True},
    {'name': 'x_studio_cf_data_consulta', 'field_description': 'ConsultFlex - Data Consulta', 'model_id': so_model_id, 'ttype': 'datetime', 'store': True},
]

for fld in fields_to_create:
    existing = ekw('ir.model.fields', 'search_read', [[['model', '=', 'sale.order'], ['name', '=', fld['name']]]], {'fields': ['id', 'name']})
    if existing:
        print(f"  SKIP (exists): {fld['name']} ID={existing[0]['id']}")
    else:
        fid = ekw('ir.model.fields', 'create', [fld])
        print(f"  CREATED: {fld['name']} ID={fid}")

# === Create Server Action (Consultar CPF/CNPJ) ===
existing_action = ekw('ir.actions.server', 'search_read', [[['name', '=', 'ConsultFlex - Consultar CPF/CNPJ']]], {'fields': ['id']})
if existing_action:
    action_id = existing_action[0]['id']
    print(f"  SKIP action (exists): ID={action_id}")
else:
    codigo = """import urllib.request, json
from odoo.exceptions import UserError

cpfcnpj = (record.x_studio_cf_cpfcnpj or '').replace('.', '').replace('-', '').replace('/', '')
tipo = record.x_studio_cf_tipo_pessoa or ''

if not cpfcnpj:
    raise UserError('Preencha o campo CPF/CNPJ na aba ConsultFlex antes de consultar.')

if not tipo:
    tipo = 'J' if len(cpfcnpj) == 14 else 'F'

record.write({'x_studio_cf_status': 'consultando'})

url = 'https://api-odoo-rhzf.onrender.com/api/v1/consultflex/consultar-odoo/' + str(record.id)
payload = json.dumps({'cpfcnpj': cpfcnpj, 'tipoPessoa': tipo}).encode('utf-8')
req = urllib.request.Request(url, data=payload, headers={
    'Content-Type': 'application/json',
    'X-Api-Key': 'cnpja-odoo-secret-2024',
}, method='POST')

try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        resultado = json.loads(resp.read().decode('utf-8'))
    if resultado.get('success'):
        record.write({
            'x_studio_cf_status': 'concluido',
            'x_studio_cf_data_consulta': fields.Datetime.now(),
        })
    else:
        record.write({'x_studio_cf_status': 'erro'})
        raise UserError('Erro ConsultFlex: ' + str(resultado.get('error', 'Desconhecido')))
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8') if e.fp else ''
    record.write({'x_studio_cf_status': 'erro'})
    raise UserError('Erro HTTP %d ao consultar: %s' % (e.code, body[:200]))
except UserError:
    raise
except Exception as e:
    record.write({'x_studio_cf_status': 'erro'})
    raise UserError('Erro ao consultar ConsultFlex: %s' % str(e))
"""
    action_id = ekw('ir.actions.server', 'create', [{
        'name': 'ConsultFlex - Consultar CPF/CNPJ',
        'model_id': so_model_id,
        'state': 'code',
        'code': codigo,
    }])
    print(f"  CREATED action: ID={action_id}")

    # Create external ID
    ext_id = ekw('ir.model.data', 'create', [{
        'module': 'ajl_custom',
        'name': 'action_consultflex_consultar',
        'model': 'ir.actions.server',
        'res_id': action_id,
    }])
    print(f"  CREATED external ID: {ext_id}")

# === Create View with ConsultFlex Tab ===
base_views = ekw('ir.ui.view', 'search_read', [[['model', '=', 'sale.order'], ['type', '=', 'form'], ['inherit_id', '=', False]]], {'fields': ['id', 'name'], 'limit': 3})
if not base_views:
    print("ERROR: No base sale.order form view found")
    sys.exit(1)

existing_view = ekw('ir.ui.view', 'search', [[['name', '=', 'AJL ConsultFlex Tab'], ['model', '=', 'sale.order']]])
if existing_view:
    print(f"  SKIP view (exists): ID={existing_view}")
else:
    arch = """<data>
    <xpath expr="//page[last()]" position="after">
        <page string="ConsultFlex" name="consultflex" groups="account.group_account_manager">
            <group>
                <group string="Consulta">
                    <field name="x_studio_cf_tipo_pessoa" widget="radio"/>
                    <field name="x_studio_cf_cpfcnpj" placeholder="Somente números"/>
                    <field name="x_studio_cf_status"/>
                    <field name="x_studio_cf_data_consulta"/>
                    <button name="%(ajl_custom.action_consultflex_consultar)d" 
                            type="action" 
                            string="Consultar CPF/CNPJ" 
                            class="btn-primary"
                            icon="fa-search"
                            groups="account.group_account_manager"/>
                </group>
                <group string="Resultado da Consulta">
                    <field name="x_studio_cf_resultado_html" nolabel="1" colspan="2"/>
                </group>
            </group>
        </page>
    </xpath>
</data>"""
    view_id = ekw('ir.ui.view', 'create', [{
        'name': 'AJL ConsultFlex Tab',
        'model': 'sale.order',
        'type': 'form',
        'inherit_id': base_views[0]['id'],
        'arch_db': arch,
        'priority': 100,
    }])
    print(f"  CREATED view: ID={view_id}")

    ext_vid = ekw('ir.model.data', 'create', [{
        'module': 'ajl_custom',
        'name': 'view_consultflex_tab',
        'model': 'ir.ui.view',
        'res_id': view_id,
    }])
    print(f"  CREATED view external ID: {ext_vid}")

print("\n=== CONSULTFLEX SETUP COMPLETE ===")
