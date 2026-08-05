#!/usr/bin/env python3
"""
odoo-scripts/criar-botao-cancelar-nfe.py
=========================================
Cria via XML-RPC um Server Action "Cancelar NF-e" visivel como botao
no menu Acao (engrenagem) do formulario de faturas (account.move).

Execute:
  ODOO_URL=https://nytro.odoo.com ODOO_DB=nytro \
  ODOO_LOGIN=admin ODOO_PASSWORD=xxx \
  MIDDLEWARE_URL=https://api-odoo.onrender.com \
  MIDDLEWARE_API_KEY=sua-chave \
  python3 odoo-scripts/criar-botao-cancelar-nfe.py
"""
import os, xmlrpc.client

ODOO_URL       = os.environ['ODOO_URL'].rstrip('/')
ODOO_DB        = os.environ['ODOO_DB']
ODOO_LOGIN     = os.environ['ODOO_LOGIN']
ODOO_PASSWORD  = os.environ['ODOO_PASSWORD']
MIDDLEWARE_URL = os.environ.get('MIDDLEWARE_URL', 'https://api-odoo.onrender.com')
MIDDLEWARE_KEY = os.environ.get('MIDDLEWARE_API_KEY', '')

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid    = common.authenticate(ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD, {})
if not uid:
    raise SystemExit('Autenticacao falhou')
print(f'Autenticado como uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, model, method, args or [], kwargs or {})

# ID do modelo account.move
model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
if not model_ids:
    raise SystemExit('Modelo account.move nao encontrado')
model_id = model_ids[0]

codigo = f"""import urllib.request, json
from odoo.exceptions import UserError

move_id    = record.id
move_name  = record.name
nfe_status = record.x_studio_nfe_status or ''

if nfe_status != 'autorizada':
    raise UserError('A NF-e precisa estar com status "autorizada" para ser cancelada. Status atual: ' + (nfe_status or 'vazio'))

justificativa = 'Cancelamento solicitado pelo emitente via Odoo'

url     = '{MIDDLEWARE_URL}/api/v1/sieg/cancelar'
payload = json.dumps({{'move_id': move_id, 'justificativa': justificativa}}).encode('utf-8')
req     = urllib.request.Request(url, data=payload, headers={{
    'Content-Type': 'application/json',
    'X-Api-Key': '{MIDDLEWARE_KEY}',
}}, method='POST')

try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        resultado = json.loads(resp.read().decode('utf-8'))
    if resultado.get('sucesso'):
        raise UserError('NF-e ' + move_name + ' cancelada! Protocolo: ' + str(resultado.get('nProt', '')))
    else:
        raise UserError('Cancelamento rejeitado: ' + str(resultado.get('cStat', '')) + ' - ' + str(resultado.get('xMotivo', 'Erro')))
except urllib.error.URLError as e:
    raise UserError('Erro ao contatar middleware: ' + str(e))
"""

action_id = kw('ir.actions.server', 'create', [{
    'name': 'Cancelar NF-e',
    'model_id': model_id,
    'binding_model_id': model_id,
    'binding_view_types': 'form',
    'state': 'code',
    'code': codigo,
}])

print(f'Botao "Cancelar NF-e" criado com sucesso! (ir.actions.server ID={action_id})')
print('Acesse qualquer fatura no Odoo -> menu Acao (engrenagem) -> "Cancelar NF-e"')
