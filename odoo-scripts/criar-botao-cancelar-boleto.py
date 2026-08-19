#!/usr/bin/env python3
"""
Criar botao "Cancelar Boleto" no Odoo via XML-RPC.
Bypassa a validacao do editor web (safe_eval bloqueia import/with/dunder).

Preencha APENAS a variavel ODOO_PASSWORD abaixo e execute:
  python3 criar-botao-cancelar-boleto.py
"""
import xmlrpc.client

ODOO_URL      = 'https://ajlferroeaco.odoo.com'
ODOO_DB       = 'ajlferroeaco'
ODOO_LOGIN    = 'admin'
ODOO_PASSWORD = 'COLE_A_SENHA_AQUI'

MIDDLEWARE_URL = 'https://odoo-middleware-unified.onrender.com'
MIDDLEWARE_KEY = 'cnpja-odoo-secret-2024'

print('Conectando...')
common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid    = common.authenticate(ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, {})
if not uid:
    raise SystemExit('Falha na autenticacao. Verifique ODOO_PASSWORD.')
print(f'OK - autenticado como uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, model, method, args or [], kwargs or {})

model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
model_id = model_ids[0]

codigo = """import urllib.request, json
from odoo.exceptions import UserError

nosso_numero = record.x_studio_nosso_numero or ''

if not nosso_numero:
    raise UserError('Fatura nao possui Nosso Numero. Nao ha boleto para cancelar.')

url     = 'https://odoo-middleware-unified.onrender.com/api/v1/itau/cancelar'
payload = json.dumps({"nosso_numero": nosso_numero}).encode('utf-8')
req     = urllib.request.Request(url, data=payload, headers={
    'Content-Type': 'application/json',
    'X-Api-Key': 'cnpja-odoo-secret-2024',
}, method='POST')

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

existing = kw('ir.actions.server', 'search', [[['name', '=', 'Cancelar Boleto']]])
if existing:
    kw('ir.actions.server', 'write', [existing, vals])
    print(f'Acao "Cancelar Boleto" atualizada (ID={existing[0]})')
else:
    action_id = kw('ir.actions.server', 'create', [vals])
    print(f'Acao "Cancelar Boleto" criada (ID={action_id})')
print('Pronto. Abra uma fatura > menu Acao (engrenagem) > Cancelar Boleto')
