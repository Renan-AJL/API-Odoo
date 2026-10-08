#!/usr/bin/env python3
"""Quick test of Odoo API access"""
import xmlrpc.client

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'

# Try authenticating with the API key as password
common = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common')
models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# Test 1: authenticate
print("Test 1: Authenticate")
uid = common.authenticate(db, 2, '7453620b69c6edc4511bacd6a541b66d789afcd5', {})
print(f"  UID with int login: {uid}")

uid2 = common.authenticate(db, 'marcus@nytro.com.br', '7453620b69c6edc4511bacd6a541b66d789afcd5', {})
print(f"  UID with email login: {uid2}")

# Test 2: Try with uid=2
if uid:
    print(f"\nTest 2: Search with uid={uid}")
    try:
        count = models.execute_kw(db, uid, '7453620b69c6edc4511bacd6a541b66d789afcd5', 
            'sale.order', 'search_count', [[]])
        print(f"  sale.order count: {count}")
    except Exception as e:
        print(f"  Error: {e}")

if uid2:
    print(f"\nTest 3: Search with uid={uid2}")
    try:
        count = models.execute_kw(db, uid2, '7453620b69c6edc4511bacd6a541b66d789afcd5', 
            'sale.order', 'search_count', [[]])
        print(f"  sale.order count: {count}")
    except Exception as e:
        print(f"  Error: {e}")

    # Try reading some basic data
    try:
        users = models.execute_kw(db, uid2, '7453620b69c6edc4511bacd6a541b66d789afcd5',
            'res.users', 'search_read', [[['active', '=', True]]], {'fields': ['id', 'name', 'login'], 'limit': 20})
        print(f"\n  Users ({len(users)}):")
        for u in users:
            print(f"    ID={u['id']}  {u['name']}  login={u['login']}")
    except Exception as e:
        print(f"  Users error: {e}")

    try:
        products = models.execute_kw(db, uid2, '7453620b69c6edc4511bacd6a541b66d789afcd5',
            'product.product', 'search_count', [[]])
        print(f"\n  product.product count: {products}")
    except Exception as e:
        print(f"  Products error: {e}")

    try:
        so = models.execute_kw(db, uid2, '7453620b69c6edc4511bacd6a541b66d789afcd5',
            'sale.order', 'search_count', [[]])
        print(f"  sale.order count: {so}")
    except Exception as e:
        print(f"  sale.order error: {e}")

    try:
        partners = models.execute_kw(db, uid2, '7453620b69c6edc4511bacd6a541b66d789afcd5',
            'res.partner', 'search_count', [[]])
        print(f"  res.partner count: {partners}")
    except Exception as e:
        print(f"  Partners error: {e}")
