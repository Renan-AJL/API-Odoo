#!/usr/bin/env python3
"""
odoo-scripts/criar-cron-extrato-itau.py
======================================
Cria via XML-RPC uma Acao Programada (ir.cron) que executa diariamente
a importacao automatica do extrato bancario Itau para dentro do Odoo.

A cron chama: GET /api/v1/itau/extrato/cron?secret=...
A middleware busca o extrato de ontem (D-1) no Itau e cria
account.bank.statement + account.bank.statement.line no diario bancario.

ANTES DE EXECUTAR:
  1. No Render > odoo-middleware-unified > Environment, adicione:
     ODOO_BANK_STATEMENT_IMPORT_CRON_SECRET = extrato-itau-cron-ajl-2024
  2. Salve e espere o redeploy

Execute:
  ODOO_URL=https://nytro.odoo.com ODOO_DB=nytro \\
  ODOO_LOGIN=admin ODOO_PASSWORD=xxx \\
  python3 odoo-scripts/criar-cron-extrato-itau.py
"""
import os, xmlrpc.client

ODOO_URL      = os.environ['ODOO_URL'].rstrip('/')
ODOO_DB       = os.environ['ODOO_DB']
ODOO_LOGIN    = os.environ['ODOO_LOGIN']
ODOO_PASSWORD = os.environ['ODOO_PASSWORD']

MIDDLEWARE_URL = 'https://odoo-middleware-unified.onrender.com'
CRON_SECRET    = 'extrato-itau-cron-ajl-2024'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid    = common.authenticate(ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, {})
if not uid:
    raise SystemExit('Autenticacao falhou')
print(f'Autenticado como uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, model, method, args or [], kwargs or {})

# Verifica se ja existe uma cron com esse nome
cron_name = 'Importar Extrato Itau (Diario)'
existing = kw('ir.cron', 'search', [[['name', '=', cron_name]]])
if existing:
    print(f'Ja existe uma cron com nome "{cron_name}" (ID={existing[0]}). Atualizando...')
    cron_id = existing[0]
else:
    cron_id = None

codigo = f"""import urllib.request, json
from odoo.exceptions import UserError

url = '{MIDDLEWARE_URL}/api/v1/itau/extrato/cron?secret={CRON_SECRET}'
req = urllib.request.Request(url, method='GET')
req.add_header('Content-Type', 'application/json')

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        resultado = json.loads(resp.read().decode('utf-8'))
    if resultado.get('success'):
        n = resultado.get('transacoes', 0)
        sid = resultado.get('statement_id', '')
        if n > 0:
            _logger.info('Extrato Itau importado: %d transacoes (Statement ID: %s)', n, sid)
        else:
            _logger.info('Extrato Itau: sem transacoes para ontem')
    else:
        _logger.warning('Extrato Itau falhou: %s', resultado.get('message', ''))
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8') if e.fp else ''
    _logger.error('Extrato Itau HTTP %d: %s', e.code, body[:300])
except Exception as e:
    _logger.error('Extrato Itau erro: %s', str(e))
"""

vals = {
    'name': cron_name,
    'active': True,
    'model_id': 1,
    'state': 'code',
    'code': codigo,
    'interval_number': 1,
    'interval_type': 'days',
    'numbercall': -1,
    'nextcall': '2026-08-21 06:00:00',
    'priority': 10,
}

# Busca o model_id correto (ir.cron)
model_cron_ids = kw('ir.model', 'search', [[['model', '=', 'ir.cron']]])
if model_cron_ids:
    vals['model_id'] = model_cron_ids[0]

if cron_id:
    kw('ir.cron', 'write', [[cron_id], vals])
    print(f'Cron "{cron_name}" atualizada (ID={cron_id})')
else:
    cron_id = kw('ir.cron', 'create', [vals])
    print(f'Cron "{cron_name}" criada (ID={cron_id})')

print(f'')
print(f'--- Resumo ---')
print(f'Nome: {cron_name}')
print(f'ID: {cron_id}')
print(f'Intervalo: 1 dia (as 06:00)')
print(f'URL: {MIDDLEWARE_URL}/api/v1/itau/extrato/cron')
print(f'Secret: ***' + CRON_SECRET[-4:] + ')')
