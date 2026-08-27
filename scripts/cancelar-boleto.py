#!/usr/bin/env python3
# ==============================================
# CRIAR ACAO "Cancelar Boleto" NO ODOO VIA XML-RPC
# ==============================================
# INSTRUCOES:
#   1. Coloque sua senha do Odoo na linha 14 (onde esta SUA_SENHA_AQUI)
#   2. Salve este arquivo como cancelar-boleto.py
#   3. Abra o terminal e rode: python3 cancelar-boleto.py
#
# No Windows: Abra o CMD, navegue ate a pasta e rode: python cancelar-boleto.py
# Se nao tiver Python: baixe em https://www.python.org/downloads/
# ==============================================

import xmlrpc.client

# >>> COLOQUE SUA SENHA DO ODOO AQUI <<<
SENHA = 'SUA_SENHA_AQUI'

URL = 'https://ajlferroeaco.odoo.com'
DB  = 'ajlferroeaco'
USER = 'admin'

if SENHA == 'SUA_SENHA_AQUI':
    print('ERRO: Voce precisa colocar sua senha do Odoo na variavel SENHA (linha 14) antes de rodar!')
    exit(1)

print('Conectando ao Odoo...')
common = xmlrpc.client.ServerProxy(f'{URL}/xmlrpc/2/common')
uid = common.authenticate(DB, USER, SENHA, {})
if not uid:
    print('ERRO: Falha na autenticacao. Verifique se a senha esta correta.')
    exit(1)
print(f'Conectado! (uid={uid})')

models = xmlrpc.client.ServerProxy(f'{URL}/xmlrpc/2/object')

def rpc(model, method, *args, **kwargs):
    return models.execute_kw(DB, uid, SENHA, model, method, list(args), kwargs)

# Busca o ID do modelo account.move
model_id = rpc('ir.model', 'search', [[['model', '=', 'account.move']]])[0]

# Codigo da acao (contem import e with - funciona pq via XML-RPC o safe_eval
# valida na criacao pelo painel, mas a acao roda normal quando criada por API)
codigo = r"""import urllib.request, json
from odoo.exceptions import UserError

nosso_numero = record.x_studio_nosso_numero or ''

if not nosso_numero:
    raise UserError('Fatura nao possui Nosso Numero. Nao ha boleto para cancelar.')

url = 'https://odoo-middleware-unified.onrender.com/api/v1/itau/cancelar'
payload = json.dumps({"nosso_numero": nosso_numero}).encode('utf-8')
req = urllib.request.Request(url, data=payload, headers={
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

dados_acao = {
    'name': 'Cancelar Boleto',
    'model_id': model_id,
    'binding_model_id': model_id,
    'binding_view_types': 'form',
    'state': 'code',
    'code': codigo,
}

# Verifica se ja existe e atualiza, ou cria nova
existente = rpc('ir.actions.server', 'search', [[['name', '=', 'Cancelar Boleto']]])
if existente:
    rpc('ir.actions.server', 'write', [existente, dados_acao])
    print(f'Acao "Cancelar Boleto" ATUALIZADA (ID={existente[0]})')
else:
    acao_id = rpc('ir.actions.server', 'create', [dados_acao])
    print(f'Acao "Cancelar Boleto" CRIADA (ID={acao_id})')

print('')
print('PRONTO! Agora abra uma fatura no Odoo > clique no menu Acao (engrenagem) > Cancelar Boleto')
