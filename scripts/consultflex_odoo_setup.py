#!/usr/bin/env python3
"""
ConsultFlex Integration - Odoo Setup v2
========================================
Cria campos, view herdida e server action para ConsultFlex no sale.order.

Estratégia:
- Server Action marca status como 'pendente' (safe_eval compatível)
- Middleware polling processa consultas pendentes (como SIEG)
- Campo HTML x_studio_resposta_consultflex recebe o resultado
"""

import xmlrpc.client
import json
import sys

# ============================================================
# CONFIG
# ============================================================
ODOO_URL = 'https://ajlferroeaco.odoo.com/'
ODOO_DB = 'ajlferroeaco'
ODOO_USER = 'marcus@nytro.com.br'
ODOO_API_KEY = '5d50bc0616508c0a167218116d53199f710bca9b'

def get_models():
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/common', allow_none=True)
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
    if not uid:
        raise Exception('Falha na autenticacao Odoo')
    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/object', allow_none=True)
    return uid, models

def kw(models, uid, model, method, args, kwargs=None):
    if kwargs:
        return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs)
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args)

def field_exists(models, uid, model_name, field_name):
    ids = kw(models, uid, 'ir.model.fields', 'search', [
        [['model_id.model', '=', model_name], ['name', '=', field_name]]
    ])
    return len(ids) > 0

def get_model_id(models, uid, model_name):
    ids = kw(models, uid, 'ir.model', 'search', [[['model', '=', model_name]]])
    return ids[0] if ids else None

def create_field(models, uid, model_name, field_name, field_desc, field_type,
                 selection=None, store=True, readonly=False):
    if field_exists(models, uid, model_name, field_name):
        print(f'  [SKIP] {field_name} ja existe em {model_name}')
        return True
    model_id = get_model_id(models, uid, model_name)
    if not model_id:
        print(f'  [ERRO] Modelo {model_name} nao encontrado')
        return False
    vals = {
        'name': field_name,
        'field_description': field_desc,
        'ttype': field_type,
        'model_id': model_id,
        'store': store,
        'readonly': readonly,
    }
    if selection:
        vals['ttype'] = 'selection'
        vals['selection'] = selection
    try:
        new_id = kw(models, uid, 'ir.model.fields', 'create', [vals])
        print(f'  [OK] {field_name} criado em {model_name} (ID: {new_id})')
        return new_id
    except Exception as e:
        print(f'  [ERRO] {field_name}: {e}')
        return False

def create_view(models, uid):
    """Cria view herdida - herda do Studio customization view (3513) que tem a aba Consult Flex"""
    view_name = 'AJL - ConsultFlex Campos Consulta'
    
    existing = kw(models, uid, 'ir.ui.view', 'search', [
        [['name', '=', view_name], ['model', '=', 'sale.order']]
    ])
    if existing:
        print(f'  [SKIP] View ja existe (ID: {existing[0]})')
        return existing[0]
    
    # Herdar do Studio customization view (ID 3513) que contem a aba Consult Flex
    studio_view_id = 3513
    
    # Verificar se o studio view ainda existe e tem o page
    try:
        studio_data = kw(models, uid, 'ir.ui.view', 'read', [
            [studio_view_id], ['name', 'arch_db']
        ])
        if studio_data and studio_data[0]:
            arch_db = studio_data[0].get('arch_db', '')
            if 'studio_page_7b7' in arch_db:
                print(f'  Studio view 3513 contem a aba Consult Flex - OK')
            else:
                print(f'  Studio view 3513 NAO contem a aba - buscando alternativa...')
                studio_view_id = None
    except:
        studio_view_id = None
    
    # Se nao achou o studio view, herdar do base e adicionar aba nova
    if not studio_view_id:
        base_ids = kw(models, uid, 'ir.ui.view', 'search', [
            [['key', '=', 'sale.view_order_form']]
        ])
        if not base_ids:
            base_ids = kw(models, uid, 'ir.ui.view', 'search', [
                [['name', '=', 'sale.order.form'], ['model', '=', 'sale.order']]
            ], {'limit': 1})
        studio_view_id = base_ids[0] if base_ids else None
    
    if not studio_view_id:
        print('  [ERRO] Nenhuma view base encontrada')
        return False
    
    print(f'  Herdando da view ID: {studio_view_id}')
    
    # XPath para a aba Consult Flex do Studio
    arch = '''<data>
  <xpath expr="//page[@name='studio_page_7b7_1k4e8rnuv']" position="inside">
    <group name="cf_input_group" string="Dados da Consulta" groups="account.group_account_manager">
      <group name="cf_input_left">
        <field name="x_studio_cf_tipo_pessoa" string="Tipo de Pessoa"/>
        <field name="x_studio_cf_cpfcnpj" string="CPF / CNPJ" placeholder="Somente numeros"/>
      </group>
      <group name="cf_input_right">
        <field name="x_studio_cf_status" string="Status" readonly="1"/>
        <field name="x_studio_cf_data_consulta" string="Data da Consulta" readonly="1"/>
      </group>
    </group>
  </xpath>
</data>'''
    
    # Tentar criar a view
    for arch_field in ['arch_base', 'arch']:
        try:
            vals = {
                'name': view_name,
                'model': 'sale.order',
                'inherit_id': studio_view_id,
                arch_field: arch,
                'priority': 32,
            }
            new_id = kw(models, uid, 'ir.ui.view', 'create', [vals])
            print(f'  [OK] View criada (ID: {new_id}) com {arch_field}')
            return new_id
        except Exception as e:
            err_str = str(e)
            if 'cannot be located' in err_str:
                # O xpath nao funciona herdando do studio view, tentar outra abordagem
                print(f'  XPath nao encontrado no studio view. Tentando abordagem alternativa...')
                break
            if arch_field == 'arch_base':
                continue
            print(f'  [ERRO] View ({arch_field}): {err_str[:200]}')
    
    # Abordagem alternativa:Modificar o Studio view diretamente para adicionar os campos
    print('  Tentando modificar o Studio view diretamente...')
    try:
        studio_arch = kw(models, uid, 'ir.ui.view', 'read', [
            [3513], ['arch_db']
        ])[0]['arch_db']
        
        # Encontrar o grupo dentro da aba Consult Flex e adicionar campos antes do campo resposta_consultflex
        insert_before = 'x_studio_resposta_consultflex'
        fields_to_add = '''<field name="x_studio_cf_tipo_pessoa" string="Tipo de Pessoa"/>
        <field name="x_studio_cf_cpfcnpj" string="CPF / CNPJ" placeholder="Somente numeros"/>
        <field name="x_studio_cf_status" string="Status" readonly="1"/>
        <field name="x_studio_cf_data_consulta" string="Data da Consulta" readonly="1"/>
        '''
        
        if insert_before in studio_arch and 'x_studio_cf_tipo_pessoa' not in studio_arch:
            new_arch = studio_arch.replace(
                f'<field name="{insert_before}"/>',
                fields_to_add + f'<field name="{insert_before}"/>'
            )
            kw(models, uid, 'ir.ui.view', 'write', [[3513], {'arch_db': new_arch}])
            print('  [OK] Campos adicionados diretamente no Studio view 3513')
            return 3513
        elif 'x_studio_cf_tipo_pessoa' in studio_arch:
            print('  [SKIP] Campos ja existem no Studio view 3513')
            return 3513
        else:
            print('  [ERRO] Nao conseguiu localizar ponto de insercao no Studio view')
            return False
    except Exception as e:
        print(f'  [ERRO] Modificacao direta: {str(e)[:300]}')
        return False

def create_server_action(models, uid):
    """Cria Server Action que marca a consulta como pendente.
    O middleware polling processa automaticamente (como SIEG)."""
    action_name = 'AJL-ConsultFlex Consultar'
    
    existing = kw(models, uid, 'ir.actions.server', 'search', [
        [['name', '=', action_name], ['model_id.model', '=', 'sale.order']]
    ])
    if existing:
        print(f'  [SKIP] Server Action ja existe (ID: {existing[0]})')
        return existing[0]
    
    model_id = get_model_id(models, uid, 'sale.order')
    if not model_id:
        print('  [ERRO] Modelo sale.order nao encontrado')
        return False
    
    # Server action simples: marca status='pendente' para o polling processar
    # Safe_eval compativel - sem imports, sem dunder names
    python_code = '''action = records
for order in action:
    cpfcnpj = (order.x_studio_cf_cpfcnpj or '').replace('-', '').replace('.', '').replace('/', '')
    if not cpfcnpj:
        if order.partner_id and order.partner_id.vat:
            cpfcnpj = order.partner_id.vat.replace('-', '').replace('.', '').replace('/', '')
    if not cpfcnpj:
        raise UserError('Preencha o campo CPF/CNPJ ou vincule um parceiro com CNPJ/CPF na cotacao.')
    order.x_studio_cf_status = 'pendente'
    order.x_studio_resposta_consultflex = '<p style="color:orange;font-weight:bold">Consulta em processamento... atualize a pagina em alguns segundos.</p>'
    log('ConsultFlex: Consulta marcada como pendente para sale.order %s', order.id)
'''
    
    vals = {
        'name': action_name,
        'model_id': model_id,
        'state': 'code',
        'code': python_code,
    }
    
    try:
        new_id = kw(models, uid, 'ir.actions.server', 'create', [vals])
        print(f'  [OK] Server Action criada (ID: {new_id})')
        return new_id
    except Exception as e:
        print(f'  [ERRO] Server Action: {e}')
        # Fallback: criar object_write action
        try:
            vals2 = {
                'name': action_name,
                'model_id': model_id,
                'state': 'object_write',
                'use_write': 'current',
                'write_expression': 'x_studio_cf_status = "pendente"',
            }
            new_id = kw(models, uid, 'ir.actions.server', 'create', [vals2])
            print(f'  [OK] Server Action (object_write) criada (ID: {new_id})')
            return new_id
        except Exception as e2:
            print(f'  [ERRO] Server Action (fallback): {e2}')
            return False

def set_config_params(models, uid):
    """Configura parametros de sistema"""
    params = {
        'ajl.middleware.url': 'https://api-odoo-ajl.onrender.com',
    }
    for key, value in params.items():
        existing = kw(models, uid, 'ir.config_parameter', 'search', [[['key', '=', key]]])
        if existing:
            kw(models, uid, 'ir.config_parameter', 'write', [existing, {'value': value}])
            print(f'  [OK] {key} atualizado')
        else:
            try:
                kw(models, uid, 'ir.config_parameter', 'create', [{'key': key, 'value': value}])
                print(f'  [OK] {key} criado')
            except Exception as e:
                print(f'  [ERRO] {key}: {e}')

def main():
    print('=' * 60)
    print('ConsultFlex Integration - Odoo Setup v2')
    print('=' * 60)
    
    uid, models = get_models()
    print(f'UID: {uid}')
    print()
    
    # 1. Campos
    print('1. Criando campos no sale.order...')
    print('-' * 40)
    create_field(models, uid, 'sale.order', 'x_studio_cf_tipo_pessoa', 'Tipo de Pessoa', 'selection',
                 selection="[('F', 'CPF - Pessoa Fisica'), ('J', 'CNPJ - Pessoa Juridica')]", store=True)
    create_field(models, uid, 'sale.order', 'x_studio_cf_cpfcnpj', 'CPF / CNPJ Consulta', 'char', store=True)
    create_field(models, uid, 'sale.order', 'x_studio_cf_status', 'Status Consulta', 'char', store=True, readonly=True)
    create_field(models, uid, 'sale.order', 'x_studio_cf_data_consulta', 'Data Consulta', 'datetime', store=True, readonly=True)
    print()
    
    # 2. View
    print('2. Criando view herdida...')
    print('-' * 40)
    view_id = create_view(models, uid)
    print()
    
    # 3. Server Action
    print('3. Criando Server Action...')
    print('-' * 40)
    action_id = create_server_action(models, uid)
    print()
    
    # 4. Config params
    print('4. Configurando parametros...')
    print('-' * 40)
    set_config_params(models, uid)
    print()
    
    # 5. Verify
    print('5. Verificacao...')
    print('-' * 40)
    if field_exists(models, uid, 'sale.order', 'x_studio_resposta_consultflex'):
        print('  [OK] x_studio_resposta_consultflex existe')
    else:
        print('  [ERRO] x_studio_resposta_consultflex NAO existe!')
    print()
    
    print('=' * 60)
    print('RESUMO:')
    print(f'  View ID: {view_id}')
    print(f'  Server Action ID: {action_id}')
    print()
    print('PROXIMOS PASSOS:')
    print(f'  1. Crie um botao "Consultar ConsultFlex" no Studio')
    print(f'  2. Vincule a Server Action ID {action_id}')
    print(f'  3. Configure CONSULTFLEX_API_KEY no Render')
    print(f'  4. O middleware fara polling automatico de consultas pendentes')
    print('=' * 60)

if __name__ == '__main__':
    main()
