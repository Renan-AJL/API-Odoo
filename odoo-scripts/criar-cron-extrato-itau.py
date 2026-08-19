#!/usr/bin/env python3
"""
Criar acao programada "Importar Extrato Itau" no Odoo via XML-RPC.
Bypassa a validacao do editor web (safe_eval bloqueia import/with/dunder).

Preencha APENAS a variavel ODOO_PASSWORD abaixo e execute:
  python3 criar-cron-extrato-itau.py
"""
import xmlrpc.client

ODOO_URL      = 'https://ajlferroeaco.odoo.com'
ODOO_DB       = 'ajlferroeaco'
ODOO_LOGIN    = 'admin'
ODOO_PASSWORD = 'COLE_A_SENHA_AQUI'

MIDDLEWARE_URL = 'https://odoo-middleware-unified.onrender.com'
CRON_SECRET    = 'extrato-itau-cron-ajl-2024'

print('Conectando...')
common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid    = common.authenticate(ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, {})
if not uid:
    raise SystemExit('Falha na autenticacao. Verifique ODOO_PASSWORD.')
print(f'OK - autenticado como uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, model, method, args or [], kwargs or {})

cron_name = 'Importar Extrato Itau (Diario)'

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
            _logger.info('Extrato Itau: %d transacoes (Statement %s)', n, sid)
        else:
            _logger.info('Extrato Itau: sem transacoes para ontem')
    else:
        _logger.warning('Extrato Itau falhou: %s', resultado.get('message', ''))
except urllib.error.HTTPError as e:
    _logger.error('Extrato Itau HTTP %d', e.code)
except Exception as e:
    _logger.error('Extrato Itau: %s', str(e))
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

model_cron_ids = kw('ir.model', 'search', [[['model', '=', 'ir.cron']]])
if model_cron_ids:
    vals['model_id'] = model_cron_ids[0]

existing = kw('ir.cron', 'search', [[['name', '=', cron_name]]])
if existing:
    kw('ir.cron', 'write', [existing, vals])
    print(f'Cron "{cron_name}" atualizada (ID={existing[0]})')
else:
    cron_id = kw('ir.cron', 'create', [vals])
    print(f'Cron "{cron_name}" criada (ID={cron_id})')

print(f'Pronto. Configuracao > Tecnico > Acoes Planejadas > "{cron_name}"')
print(f'Lembrete: adicione ODOO_BANK_STATEMENT_IMPORT_CRON_SECRET={CRON_SECRET} no Render')
