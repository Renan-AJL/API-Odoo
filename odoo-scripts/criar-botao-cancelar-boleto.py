#!/usr/bin/env python3
"""
odoo-scripts/criar-botao-cancelar-boleto.py
============================================
Cria (ou atualiza) via XML-RPC o Server Action "Cancelar Boleto".
Bypassa a validacao do editor web do Odoo.

Execute:
  ODOO_URL=https://nytro.odoo.com ODOO_DB=nytro \\
  ODOO_LOGIN=admin ODOO_PASSWORD=xxx \\
  python3 odoo-scripts/criar-botao-cancelar-boleto.py
"""
import os, xmlrpc.client

ODOO_URL      = os.environ['ODOO_URL'].rstrip('/')
ODOO_DB       = os.environ['ODOO_DB']
ODOO_LOGIN    = os.environ['ODOO_LOGIN']
ODOO_PASSWORD = os.environ['ODOO_PASSWORD']

MIDDLEWARE_URL = 'https://odoo-middleware-unified.onrender.com'
MIDDLEWARE_KEY = 'cnpja-odoo-secret-2024'

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid    = common.authenticate(ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, {})
if not uid:
    raise SystemExit('Autenticacao falhou')
print(f'Autenticado como uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, model, method, args or [], kwargs or {})

model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
if not model_ids:
    raise SystemExit('Modelo account.move nao encontrado')
model_id = model_ids[0]

codigo = f"""import urllib.request, json
from odoo.exceptions import UserError

nosso_numero = record.x_studio_nosso_numero or ''

if not nosso_numero:
    raise UserError('Fatura nao possui Nosso Numero (boleto). Nao ha o que cancelar.')

url     = '{MIDDLEWARE_URL}/api/v1/itau/cancelar'
payload = json.dumps({{'nosso_numero': nosso_numero}}).encode('utf-8')
req     = urllib.request.Request(url, data=payload, headers={{
    'Content-Type': 'application/json',
    'X-Api-Key': '{MIDDLEWARE_KEY}',
}}, method='POST')

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        resultado = json.loads(resp.read().decode('utf-8'))
    if resultado.get('success'):
        record.x_studio_boleto_cancelado = True
        raise UserError('Boleto %s cancelado com sucesso no Itau!' % nosso_numero)
    else:
        raise UserError('Erro ao cancelar: ' + str(resultado.get('message', 'Erro desconhecido')))
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8') if e.fp else ''
    raise UserError('Erro HTTP %d ao cancelar boleto: %s' % (e.code, body[:200]))
except UserError:
    raise
except Exception as e:
    raise UserError('Erro ao cancelar boleto: %s' % str(e))
"""

vals = {
    'name': 'Cancelar Boleto',
    'model_id': model_id,
    'binding_model_id': model_id,
    'binding_view_types': 'form',
    'state': 'code',
    'code': codigo,
}

# Se ja existe, atualiza; senao cria
existing = kw('ir.actions.server', 'search', [[['name', '=', 'Cancelar Boleto']]])
if existing:
    kw('ir.actions.server', 'write', [existing, vals])
    print(f'Acao "Cancelar Boleto" atualizada (ID={existing[0]})')
else:
    action_id = kw('ir.actions.server', 'create', [vals])
    print(f'Acao "Cancelar Boleto" criada (ID={action_id})')

print('Acesse qualquer fatura > menu Acao (engrenagem) > "Cancelar Boleto"')
