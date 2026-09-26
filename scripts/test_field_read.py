#!/usr/bin/env python3
"""Check if there are pending invoices and try reading them with corrected fields"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Search for pending NF-e invoices
pending_nfe = models.execute_kw(db, uid, pwd, 'account.move', 'search_read', [
    [['x_studio_nfe_status', '=', 'pendente'], ['move_type', '=', 'out_invoice']]
], {'fields': ['id', 'name', 'amount_total', 'x_studio_nfe_status', 'x_studio_itau_nosso_numero'], 'limit': 5})

print(f"Pending NF-e invoices: {len(pending_nfe)}")
for inv in pending_nfe:
    print(f"  ID={inv['id']}  name={inv['name']}  R${inv['amount_total']}  nosso_num={inv.get('x_studio_itau_nosso_numero', 'N/A')}")

# Test reading all the fields that sieg-odoo-emit.js reads
if pending_nfe:
    test_id = pending_nfe[0]['id']
    print(f"\nTesting field read on invoice {test_id}...")
    try:
        result = models.execute_kw(db, uid, pwd, 'account.move', 'read', [
            [test_id], [
                'name', 'partner_id', 'company_id', 'invoice_date', 'date',
                'amount_total', 'narration',
                'x_studio_nfe_status', 'x_studio_nfse_status', 'payment_state',
                'x_studio_itau_nosso_numero', 'x_studio_itau_resposta_json', 'x_studio_boleto_cancelado',
                'invoice_line_ids', 'line_ids',
            ]
        ])
        print("  SUCCESS - all fields readable!")
        move = result[0]
        print(f"  name={move['name']}")
        print(f"  x_studio_itau_nosso_numero={move.get('x_studio_itau_nosso_numero', 'N/A')}")
        print(f"  x_studio_itau_resposta_json={str(move.get('x_studio_itau_resposta_json', ''))[:100]}...")
        print(f"  x_studio_boleto_cancelado={move.get('x_studio_boleto_cancelado', 'N/A')}")
    except Exception as e:
        print(f"  ERROR: {e}")

# Also check the fatura 107 that was failing
print("\n--- Checking fatura 107 specifically ---")
try:
    result107 = models.execute_kw(db, uid, pwd, 'account.move', 'read', [
        [107], [
            'name', 'partner_id', 'company_id', 'invoice_date', 'date',
            'amount_total', 'narration',
            'x_studio_nfe_status', 'x_studio_nfse_status', 'payment_state',
            'x_studio_itau_nosso_numero', 'x_studio_itau_resposta_json', 'x_studio_boleto_cancelado',
            'invoice_line_ids', 'line_ids',
        ]
    ])
    print("  Fatura 107 - all fields readable!")
    m107 = result107[0]
    print(f"  name={m107['name']}  status={m107.get('x_studio_nfe_status')}  amount={m107['amount_total']}")
except Exception as e:
    print(f"  ERROR on fatura 107: {e}")
