#!/usr/bin/env python3
"""
Setup Odoo fields for Itaú Payment Status tracking
===================================================
Creates x_studio_* fields on account.move for:
- PIX status polling
- Boleto status polling
- General payment status

Run: python3 setup_itau_payment_fields.py
"""
import xmlrpc.client
import sys

# ============================================================
# CONFIG - adjust these or pass via environment
# ============================================================
ODOO_URL = 'https://ajlferroeaco.odoo.com'
ODOO_DB  = 'ajlferroeaco'
ODOO_USER = 'marcus@nytro.com.br'
ODOO_API_KEY = sys.argv[1] if len(sys.argv) > 1 else ''

if not ODOO_API_KEY:
    print('Usage: python3 setup_itau_payment_fields.py <ODOO_API_KEY>')
    sys.exit(1)

# ============================================================
# XML-RPC helpers
# ============================================================
def get_common():
    return xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')

def get_models():
    return xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

def authenticate():
    uid = get_common().authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
    if not uid:
        print('ERRO: Autenticacao falhou. Verifique API key.')
        sys.exit(1)
    return uid

def execute(uid, model, method, args, kwargs=None):
    models = get_models()
    if kwargs:
        return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs)
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args)

# ============================================================
# FIELD DEFINITIONS
# ============================================================
FIELDS_TO_CREATE = [
    {
        'name': 'x_studio_itau_situacao',
        'field_description': 'Status Itau',
        'ttype': 'selection',
        'selection': "([('emitido', 'Emitido'), ('pago', 'Pago'), ('cancelado', 'Cancelado'), ('expirado', 'Expirado'), ('erro', 'Erro')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_status_pagamento',
        'field_description': 'Status Pagamento Itaú',
        'ttype': 'selection',
        'selection': "([('pendente', 'Pendente'), ('pago', 'Pago'), ('cancelado', 'Cancelado'), ('expirado', 'Expirado')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_pix_status',
        'field_description': 'PIX Status',
        'ttype': 'selection',
        'selection': "([('ativa', 'Ativa'), ('concluida', 'Concluida'), ('removida_pelo_psp', 'Removida pelo PSP'), ('expirada', 'Expirada')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_pix_data_pagamento',
        'field_description': 'PIX Data Pagamento',
        'ttype': 'datetime',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_pix_e2e',
        'field_description': 'PIX End-to-End ID',
        'ttype': 'char',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_txid',
        'field_description': 'PIX TXID',
        'ttype': 'char',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_boleto_status',
        'field_description': 'Boleto Status',
        'ttype': 'selection',
        'selection': "([('em_aberto', 'Em Aberto'), ('pago', 'Pago'), ('cancelado', 'Cancelado'), ('expirado', 'Expirado')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_boleto_data_pagamento',
        'field_description': 'Boleto Data Pagamento',
        'ttype': 'date',
        'model_id': 'account.move',
    },
]

# ============================================================
# MAIN
# ============================================================
def main():
    print('Autenticando no Odoo...')
    uid = authenticate()
    print(f'UID: {uid} - OK')

    # Get model IDs
    model_ids = {}
    for f in FIELDS_TO_CREATE:
        model_name = f['model_id']
        if model_name not in model_ids:
            ids = execute(uid, 'ir.model', 'search', [[('model', '=', model_name)]])
            if ids:
                model_ids[model_name] = ids[0]
            else:
                print(f'ERRO: Modelo {model_name} nao encontrado')
                sys.exit(1)

    created = 0
    skipped = 0

    for f in FIELDS_TO_CREATE:
        field_name = f['name']
        model_name = f['model_id']

        # Check if field already exists
        existing = execute(uid, 'ir.model.fields', 'search', [
            [('name', '=', field_name), ('model_id.model', '=', model_name)]
        ])

        if existing:
            print(f'  {field_name}: JA EXISTE (id={existing[0]})')
            skipped += 1
            continue

        # Create field
        vals = {
            'name': field_name,
            'field_description': f['field_description'],
            'ttype': f['ttype'],
            'model_id': model_ids[model_name],
            'store': True,
        }

        # Handle selection fields
        if f['ttype'] == 'selection':
            vals['selection'] = f['selection']

        # Handle char size
        if f['ttype'] == 'char':
            vals['size'] = 256

        try:
            field_id = execute(uid, 'ir.model.fields', 'create', [vals])
            print(f'  {field_name}: CRIADO (id={field_id})')
            created += 1
        except Exception as e:
            print(f'  {field_name}: ERRO - {e}')

    print(f'\nResultado: {created} criado(s), {skipped} ja existente(s)')

    # Now find the "Diário Banco Itaú" journal
    print('\nBuscando diario bancario Itau...')
    journal_ids = execute(uid, 'account.journal', 'search', [
        [('type', '=', 'bank'), ('name', 'ilike', 'itau')]
    ])
    if journal_ids:
        journal = execute(uid, 'account.journal', 'read', [journal_ids[:1]], {'fields': ['id', 'name', 'code']})
        print(f'  Diario encontrado: {journal[0]["name"]} (id={journal[0]["id"]}, code={journal[0]["code"]})')
        print(f'  Configure ODOO_BANK_JOURNAL_ID={journal[0]["id"]} no Render')
    else:
        # List all bank journals
        all_banks = execute(uid, 'account.journal', 'search', [[('type', '=', 'bank')]])
        if all_banks:
            journals = execute(uid, 'account.journal', 'read', [all_banks], {'fields': ['id', 'name', 'code']})
            print('  Nenhum diario com "Itau" no nome. Diarios bancarios disponiveis:')
            for j in journals:
                print(f'    - {j["name"]} (id={j["id"]}, code={j["code"]})')
        else:
            print('  Nenhum diario bancario encontrado!')

if __name__ == '__main__':
    main()
