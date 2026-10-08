#!/usr/bin/env python3
"""
Create ConsultFlex fields on sale.order and inherited view with tab.
API: https://api.consultflex.com.br/json/service.aspx
Produto: 1761 (CREDITO BASICO PJ), Versao: 20180521
"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '3dd19d4815044c45ae30fee45ffd54efc5f771d5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

def ekw(model, method, args=None, kwargs=None):
    if args is None: args = []
    if kwargs:
        return models.execute_kw(db, uid, pwd, model, method, args, kwargs)
    return models.execute_kw(db, uid, pwd, model, method, args)

# Get model ID for sale.order
so_model_ids = ekw('ir.model', 'search', [[['model', '=', 'sale.order']]])
print(f"sale.order model ID: {so_model_ids}")
so_model_id = so_model_ids[0]

# === Create fields ===
fields_to_create = [
    {
        'name': 'x_studio_cf_tipo_pessoa',
        'field_description': 'ConsultFlex - Tipo Pessoa',
        'model_id': so_model_id,
        'ttype': 'selection',
        'selection': "[(u'J', u'Pessoa Jurídica (CNPJ)'), (u'F', u'Pessoa Física (CPF)')]",
        'store': True,
    },
    {
        'name': 'x_studio_cf_cpfcnpj',
        'field_description': 'ConsultFlex - CPF/CNPJ',
        'model_id': so_model_id,
        'ttype': 'char',
        'store': True,
    },
    {
        'name': 'x_studio_cf_resultado_html',
        'field_description': 'ConsultFlex - Resultado',
        'model_id': so_model_id,
        'ttype': 'html',
        'store': True,
    },
    {
        'name': 'x_studio_cf_status',
        'field_description': 'ConsultFlex - Status',
        'model_id': so_model_id,
        'ttype': 'selection',
        'selection': "[(u'pendente', u'Pendente'), (u'consultando', u'Consultando'), (u'concluido', u'Concluído'), (u'erro', u'Erro')]",
        'store': True,
    },
    {
        'name': 'x_studio_cf_data_consulta',
        'field_description': 'ConsultFlex - Data Consulta',
        'model_id': so_model_id,
        'ttype': 'datetime',
        'store': True,
    },
]

created_fields = []
for fld in fields_to_create:
    # Check if already exists
    existing = ekw('ir.model.fields', 'search_read', [
        [['model', '=', 'sale.order'], ['name', '=', fld['name']]]
    ], {'fields': ['id', 'name']})
    if existing:
        print(f"  SKIP (exists): {fld['name']} ID={existing[0]['id']}")
        created_fields.append(existing[0]['id'])
    else:
        fid = ekw('ir.model.fields', 'create', [fld])
        print(f"  CREATED: {fld['name']} ID={fid}")
        created_fields.append(fid)

print(f"\nField IDs: {created_fields}")

# === Create inherited view with ConsultFlex tab ===
# Find the base sale order form view
base_views = ekw('ir.ui.view', 'search_read', [
    [['model', '=', 'sale.order'], ['type', '=', 'form'], ['inherit_id', '=', False]]
], {'fields': ['id', 'name'], 'limit': 5})
print(f"\nBase sale.order form views: {base_views}")

# Check if our view already exists
existing_views = ekw('ir.ui.view', 'search', [
    [['name', '=', 'AJL ConsultFlex Tab'], ['model', '=', 'sale.order']]
])
if existing_views:
    print(f"View already exists: {existing_views}")
else:
    # Create the inherited view with ConsultFlex tab
    # The tab should be visible only for financial administrators (group)
    # We use groups="account.group_account_manager" or similar
    arch = """
<data>
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
</data>
"""
    view_id = ekw('ir.ui.view', 'create', [{
        'name': 'AJL ConsultFlex Tab',
        'model': 'sale.order',
        'type': 'form',
        'inherit_id': base_views[0]['id'],
        'arch_db': arch,
        'priority': 100,
    }])
    print(f"Created view ID: {view_id}")
    
    # Create external ID for the view
    ext_id = ekw('ir.model.data', 'create', [{
        'module': 'ajl_custom',
        'name': 'view_consultflex_tab',
        'model': 'ir.ui.view',
        'res_id': view_id,
    }])
    print(f"Created external ID for view: {ext_id}")

print("\n=== DONE: Fields and View created ===")
