#!/usr/bin/env python3
"""Reset fatura 107 status to pendente for re-emission"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Read current state
inv = models.execute_kw(db, uid, pwd, 'account.move', 'read', [
    [107], ['name', 'x_studio_nfe_status', 'move_type', 'state', 'payment_state']
])
print("Current state:", inv)

# Reset to pendente
result = models.execute_kw(db, uid, pwd, 'account.move', 'write', [
    [107], {'x_studio_nfe_status': 'pendente'}
])
print(f"Reset status to pendente: {result}")

# Verify
inv2 = models.execute_kw(db, uid, pwd, 'account.move', 'read', [
    [107], ['name', 'x_studio_nfe_status', 'move_type', 'state']
])
print("After reset:", inv2)
