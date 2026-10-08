#!/usr/bin/env python3
"""
ConsultFlex - Adicionar campo Tipo de Operacao (Basico / Credito Total)
e atualizar view + server action no Odoo.
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
                 selection=None, store=True, readonly=False, default=None):
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
    if default:
        vals['default'] = default
    try:
        new_id = kw(models, uid, 'ir.model.fields', 'create', [vals])
        print(f'  [OK] {field_name} criado em {model_name} (ID: {new_id})')
        return new_id
    except Exception as e:
        print(f'  [ERRO] {field_name}: {e}')
        return False

def update_view_with_tipo_operacao(models, uid):
    """Atualiza o Studio view 3513 para incluir o campo tipo_operacao"""
    print('  Atualizando view para incluir tipo_operacao...')
    
    # Ler o Studio view 3513
    try:
        studio_data = kw(models, uid, 'ir.ui.view', 'read', [
            [3513], ['name', 'arch_db']
        ])
        if not studio_data or not studio_data[0]:
            print('  [ERRO] View 3513 nao encontrada')
            return False
    except Exception as e:
        print(f'  [ERRO] Leitura view 3513: {e}')
        return False
    
    arch_db = studio_data[0].get('arch_db', '')
    
    # Check if field already exists in view
    if 'x_studio_cf_tipo_operacao' in arch_db:
        print('  [SKIP] Campo x_studio_cf_tipo_operacao ja existe na view 3513')
        return True
    
    # Insert the tipo_operacao field BEFORE the tipo_pessoa field
    # This way it shows: Tipo Operacao -> Tipo Pessoa -> CPF/CNPJ
    if 'x_studio_cf_tipo_pessoa' in arch_db:
        new_arch = arch_db.replace(
            '<field name="x_studio_cf_tipo_pessoa"',
            '<field name="x_studio_cf_tipo_operacao" string="Tipo de Operacao"/>\n        <field name="x_studio_cf_tipo_pessoa"'
        )
    elif 'x_studio_cf_cpfcnpj' in arch_db:
        # Fallback: insert before CPF/CNPJ
        new_arch = arch_db.replace(
            '<field name="x_studio_cf_cpfcnpj"',
            '<field name="x_studio_cf_tipo_operacao" string="Tipo de Operacao"/>\n        <field name="x_studio_cf_cpfcnpj"'
        )
    else:
        print('  [ERRO] Nao encontrou ponto de insercao na view 3513')
        return False
    
    try:
        kw(models, uid, 'ir.ui.view', 'write', [[3513], {'arch_db': new_arch}])
        print('  [OK] Campo x_studio_cf_tipo_operacao adicionado na view 3513')
        return True
    except Exception as e:
        print(f'  [ERRO] Escrita view 3513: {str(e)[:300]}')
        return False

def update_server_action(models, uid):
    """Atualiza Server Action para incluir tipo_operacao e usar records.write()"""
    action_name = 'AJL-ConsultFlex Consultar'
    
    existing = kw(models, uid, 'ir.actions.server', 'search', [
        [['name', '=', action_name], ['model_id.model', '=', 'sale.order']]
    ])
    
    if not existing:
        print('  [ERRO] Server Action nao encontrada para atualizar')
        return False
    
    action_id = existing[0]
    
    # Updated code with records.write() and tipo_operacao
    python_code = '''# ConsultFlex - Marcar consulta como pendente
# O middleware polling processa automaticamente
records.write({
    'x_studio_cf_status': 'pendente',
    'x_studio_resposta_consultflex': '<p style="color:orange;font-weight:bold">Consulta em processamento... atualize a pagina em alguns segundos.</p>',
})
log('ConsultFlex: Consulta marcada como pendente (tipo=%s) para sale.order(s) %s', records[:1].x_studio_cf_tipo_operacao or 'basico', records.ids)'''
    
    try:
        kw(models, uid, 'ir.actions.server', 'write', [
            [action_id],
            {'code': python_code}
        ])
        print(f'  [OK] Server Action {action_id} atualizada com tipo_operacao')
        return True
    except Exception as e:
        print(f'  [ERRO] Atualizar Server Action: {str(e)[:300]}')
        return False

def main():
    print('=' * 60)
    print('ConsultFlex - Adicionar Tipo de Operacao')
    print('=' * 60)
    
    uid, models = get_models()
    print(f'UID: {uid}')
    print()
    
    # 1. Criar campo x_studio_cf_tipo_operacao
    print('1. Criando campo x_studio_cf_tipo_operacao...')
    print('-' * 40)
    create_field(
        models, uid, 'sale.order', 
        'x_studio_cf_tipo_operacao', 
        'Tipo de Operacao ConsultFlex',
        'selection',
        selection="[('basico', 'Basico'), ('credito_total', 'Credito Total')]",
        store=True,
        default='basico'
    )
    print()
    
    # 2. Atualizar view
    print('2. Atualizando view para incluir tipo_operacao...')
    print('-' * 40)
    update_view_with_tipo_operacao(models, uid)
    print()
    
    # 3. Atualizar Server Action
    print('3. Atualizando Server Action...')
    print('-' * 40)
    update_server_action(models, uid)
    print()
    
    # 4. Verificar todos os campos CF existem
    print('4. Verificacao...')
    print('-' * 40)
    cf_fields = [
        'x_studio_cf_tipo_operacao',
        'x_studio_cf_tipo_pessoa', 
        'x_studio_cf_cpfcnpj',
        'x_studio_cf_status',
        'x_studio_cf_data_consulta',
        'x_studio_resposta_consultflex',
    ]
    for f in cf_fields:
        exists = field_exists(models, uid, 'sale.order', f)
        print(f'  {"[OK]" if exists else "[ERRO]"} {f}')
    
    print()
    print('=' * 60)
    print('CONCLUIDO!')
    print('  Campo x_studio_cf_tipo_operacao criado com opcoes:')
    print('    - basico: Basico (produtos 1760 PF / 1761 PJ)')
    print('    - credito_total: Credito Total (produtos 1762 PF / 1763 PJ)')
    print('=' * 60)

if __name__ == '__main__':
    main()
