#!/usr/bin/env python3
"""
Setup Odoo fields for Itau Payment Status tracking
===================================================
⚠️ ATENÇÃO: NÃO rodar este script se os campos já existem no Odoo Studio!
Os campos e a aba Itaú já foram criados manualmente via Studio.
Rodar este script pode criar campos duplicados ou abas extras.

Se precisar verificar se campos existem, use:
  python3 diagnose_itau_fields.py <ODOO_API_KEY>

Creates ALL x_studio_* fields on account.move for Itau integration.
This script is idempotent - safe to run multiple times.

Fields created:
  x_studio_itau_situacao           - Status Itau (EMITIDO/PAGO/CANCELADO/EXPIRADO/ERRO)
  x_studio_itau_status_pagamento   - Status Pagamento (PENDENTE/PAGO/CANCELADO/EXPIRADO)
  x_studio_itau_tipo_pagamento     - Tipo Pagamento (PIX/BOLETO/CARTAO)
  x_studio_itau_pix_status         - PIX Status (ATIVA/CONCLUIDA/REMOVIDA_PELO_PSP/EXPIRADA)
  x_studio_itau_pix_data_pagamento - PIX Data Pagamento (datetime)
  x_studio_itau_pix_e2e            - PIX End-to-End ID (char)
  x_studio_itau_txid               - PIX TXID (char) - CRITICAL for polling!
  x_studio_itau_pix_copia_cola     - PIX Copia e Cola (text)
  x_studio_itau_nosso_numero       - Nosso Numero (char)
  x_studio_itau_boleto_status      - Boleto Status (EM_ABERTO/PAGO/CANCELADO/EXPIRADO)
  x_studio_itau_boleto_data_pagamento - Boleto Data Pagamento (date)
  x_studio_itau_link_status        - Link/PDF URL (char)
  x_studio_itau_boletos_html       - HTML with QR Code (html)
  x_studio_itau_resposta_json      - Resposta JSON (text)
  x_studio_boleto_cancelado        - Boleto Cancelado (boolean)

Run: python3 setup_itau_payment_fields.py <ODOO_API_KEY>
"""
import xmlrpc.client
import sys

# ============================================================
# CONFIG
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
# FIELD DEFINITIONS (complete list)
# ============================================================
FIELDS_TO_CREATE = [
    {
        'name': 'x_studio_itau_situacao',
        'field_description': 'Status Itau',
        'ttype': 'selection',
        'selection': "[('emitido', 'Emitido'), ('pago', 'Pago'), ('cancelado', 'Cancelado'), ('expirado', 'Expirado'), ('erro', 'Erro')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_status_pagamento',
        'field_description': 'Status Pagamento Itau',
        'ttype': 'selection',
        'selection': "[('pendente', 'Pendente'), ('pago', 'Pago'), ('cancelado', 'Cancelado'), ('expirado', 'Expirado')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_tipo_pagamento',
        'field_description': 'Tipo Pagamento Itau',
        'ttype': 'selection',
        'selection': "[('pix', 'PIX'), ('boleto', 'Boleto'), ('cartao', 'Cartao')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_pix_status',
        'field_description': 'PIX Status',
        'ttype': 'selection',
        'selection': "[('ativa', 'Ativa'), ('concluida', 'Concluida'), ('removida_pelo_psp', 'Removida pelo PSP'), ('expirada', 'Expirada')]",
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
        'name': 'x_studio_itau_pix_copia_cola',
        'field_description': 'PIX Copia e Cola',
        'ttype': 'text',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_nosso_numero',
        'field_description': 'Nosso Numero Itau',
        'ttype': 'char',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_boleto_status',
        'field_description': 'Boleto Status',
        'ttype': 'selection',
        'selection': "[('em_aberto', 'Em Aberto'), ('pago', 'Pago'), ('cancelado', 'Cancelado'), ('expirado', 'Expirado')]",
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_boleto_data_pagamento',
        'field_description': 'Boleto Data Pagamento',
        'ttype': 'date',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_link_status',
        'field_description': 'Itau Link Status',
        'ttype': 'char',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_boletos_html',
        'field_description': 'Itau Boletos HTML',
        'ttype': 'html',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_itau_resposta_json',
        'field_description': 'Itau Resposta JSON',
        'ttype': 'text',
        'model_id': 'account.move',
    },
    {
        'name': 'x_studio_boleto_cancelado',
        'field_description': 'Boleto Cancelado',
        'ttype': 'boolean',
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

    # Get model ID for account.move
    model_ids = execute(uid, 'ir.model', 'search', [[('model', '=', 'account.move')]])
    if not model_ids:
        print('ERRO: Modelo account.move nao encontrado')
        sys.exit(1)
    model_id = model_ids[0]
    print(f'Model account.move ID: {model_id}')

    # First, list existing itau fields
    print('\n--- Campos itau existentes ---')
    existing_fields = execute(uid, 'ir.model.fields', 'search', [
        [('model_id.model', '=', 'account.move'), ('name', 'like', 'itau')]
    ])
    if existing_fields:
        existing_data = execute(uid, 'ir.model.fields', 'read', [existing_fields], {
            'fields': ['name', 'field_description', 'ttype']
        })
        for f in existing_data:
            print(f'  {f["name"]:45s} ({f["ttype"]:10s}) - {f["field_description"]}')
    else:
        print('  (nenhum)')

    # Also check x_studio_itau_ prefix
    studio_fields = execute(uid, 'ir.model.fields', 'search', [
        [('model_id.model', '=', 'account.move'), ('name', 'like', 'x_studio_itau')]
    ])
    if studio_fields:
        studio_data = execute(uid, 'ir.model.fields', 'read', [studio_fields], {
            'fields': ['name', 'field_description', 'ttype']
        })
        for f in studio_data:
            print(f'  {f["name"]:45s} ({f["ttype"]:10s}) - {f["field_description"]}')

    created = 0
    skipped = 0
    errors = 0

    print(f'\n--- Criando campos ({len(FIELDS_TO_CREATE)} definidos) ---')
    for f in FIELDS_TO_CREATE:
        field_name = f['name']

        # Check if field already exists
        existing = execute(uid, 'ir.model.fields', 'search', [
            [('name', '=', field_name), ('model_id.model', '=', 'account.move')]
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
            'model_id': model_id,
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
            errors += 1

    print(f'\n--- Resultado ---')
    print(f'  Criados: {created}')
    print(f'  Ja existentes: {skipped}')
    print(f'  Erros: {errors}')

    if created > 0:
        print(f'\n  IMPORTANTE: Reinicie o worker do Odoo para que os novos campos')
        print(f'  sejam reconhecidos. Va em Settings > Activate Developer Mode >')
        print(f'  Settings > Technical > Actions > Restart')

    # Now find the journal
    print('\n--- Diario bancario Itau ---')
    journal_ids = execute(uid, 'account.journal', 'search', [
        [('type', '=', 'bank'), ('name', 'ilike', 'itau')]
    ])
    if journal_ids:
        journal = execute(uid, 'account.journal', 'read', [journal_ids[:1]], {'fields': ['id', 'name', 'code']})
        print(f'  Diario encontrado: {journal[0]["name"]} (id={journal[0]["id"]}, code={journal[0]["code"]})')
        print(f'  Configure ODOO_BANK_JOURNAL_ID={journal[0]["id"]} no Render')
    else:
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
