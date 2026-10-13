#!/usr/bin/env python3
"""
Diagnóstico de campos Itaú no Odoo
===================================
Lista TODOS os campos customizados em account.move que contêm "itau"
no nome, para identificar field name mismatches.

Run: python3 diagnose_itau_fields.py <ODOO_API_KEY>
"""
import xmlrpc.client
import sys

ODOO_URL = 'https://ajlferroeaco.odoo.com'
ODOO_DB  = 'ajlferroeaco'
ODOO_USER = 'marcus@nytro.com.br'
ODOO_API_KEY = sys.argv[1] if len(sys.argv) > 1 else ''

if not ODOO_API_KEY:
    print('Usage: python3 diagnose_itau_fields.py <ODOO_API_KEY>')
    sys.exit(1)

def main():
    print('Conectando ao Odoo...')
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
    if not uid:
        print('ERRO: Autenticacao falhou!')
        sys.exit(1)
    print(f'Autenticado: UID={uid}')

    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
    def execute(model, method, args, kwargs=None):
        if kwargs:
            return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs)
        return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args)

    # 1. Listar TODOS os campos itau em account.move
    print('\n' + '='*80)
    print('CAMPOS ITAU EM account.move')
    print('='*80)

    field_ids = execute('ir.model.fields', 'search', [
        [('model_id.model', '=', 'account.move'), ('name', 'like', 'itau')]
    ])

    if field_ids:
        fields = execute('ir.model.fields', 'read', [field_ids], {
            'fields': ['name', 'field_description', 'ttype', 'selection', 'store'],
            'order': 'name'
        })
        for f in fields:
            print(f"\n  Campo: {f['name']}")
            print(f"  Label: {f['field_description']}")
            print(f"  Tipo:  {f['ttype']}")
            if f.get('selection'):
                print(f"  Opcoes: {f['selection'][:100]}...")
            print(f"  Store: {f['store']}")
    else:
        print('  NENHUM campo itau encontrado!')

    # 2. Listar campos x_studio_ em account.move
    print('\n' + '='*80)
    print('CAMPOS x_studio_ EM account.move (relacionados ao Itau)')
    print('='*80)

    studio_field_ids = execute('ir.model.fields', 'search', [
        [('model_id.model', '=', 'account.move'), ('name', 'like', 'x_studio_itau')]
    ])

    if studio_field_ids:
        fields = execute('ir.model.fields', 'read', [studio_field_ids], {
            'fields': ['name', 'field_description', 'ttype', 'selection', 'store'],
            'order': 'name'
        })
        for f in fields:
            print(f"\n  Campo: {f['name']}")
            print(f"  Label: {f['field_description']}")
            print(f"  Tipo:  {f['ttype']}")
            if f.get('selection'):
                print(f"  Opcoes: {f['selection'][:200]}...")
            print(f"  Store: {f['store']}")
    else:
        print('  NENHUM campo x_studio_itau encontrado!')

    # 3. Verificar a fatura S01233 (a que tem o problema)
    print('\n' + '='*80)
    print('FATURA S01233 - VALORES DOS CAMPOS ITAU')
    print('='*80)

    inv_ids = execute('account.move', 'search', [
        [('name', '=', 'S01233')]
    ])

    if inv_ids:
        # Get ALL itau-related field names
        all_itau_names = []
        if field_ids:
            all_itau_names = [f['name'] for f in fields]
        if studio_field_ids:
            studio_fields = execute('ir.model.fields', 'read', [studio_field_ids], {
                'fields': ['name']
            })
            for sf in studio_fields:
                if sf['name'] not in all_itau_names:
                    all_itau_names.append(sf['name'])

        # Add known fields even if not found in model
        known_fields = [
            'name', 'payment_state', 'amount_total',
            'x_studio_itau_situacao',
            'x_studio_itau_status_pagamento',
            'x_studio_itau_tipo_pagamento',
            'x_studio_itau_pix_status',
            'x_studio_itau_pix_data_pagamento',
            'x_studio_itau_pix_e2e',
            'x_studio_itau_txid',
            'x_studio_itau_pix_copia_cola',
            'x_studio_itau_nosso_numero',
            'x_studio_itau_boleto_status',
            'x_studio_itau_boleto_data_pagamento',
            'x_studio_itau_link_status',
            'x_studio_itau_boletos_html',
            'x_studio_boleto_cancelado',
        ]
        for kf in known_fields:
            if kf not in all_itau_names:
                all_itau_names.append(kf)

        try:
            inv_data = execute('account.move', 'read', [inv_ids[:1], all_itau_names])
            if inv_data:
                inv = inv_data[0]
                for field_name in all_itau_names:
                    val = inv.get(field_name, '<CAMPO INEXISTENTE>')
                    if val is False:
                        val = 'False (vazio)'
                    elif val is None:
                        val = 'None (nulo)'
                    print(f"  {field_name:45s} = {val}")
        except Exception as e:
            print(f"  Erro ao ler fatura: {e}")
    else:
        print('  Fatura S01233 nao encontrada')

    print('\n' + '='*80)
    print('DIAGNOSTICO COMPLETO')
    print('='*80)

if __name__ == '__main__':
    main()
