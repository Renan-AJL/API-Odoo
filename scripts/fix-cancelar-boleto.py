#!/usr/bin/env python3
"""
Corrigir e atualizar o Server Action "Cancelar Boleto" no Odoo.
Mudancas:
  - URL do middleware atualizada (api-odoo-rhzf.onrender.com)
  - Leitura de multiplos boletos do x_studio_itau_resposta_json
  - Fallback para x_studio_nosso_numero
  - Marcar x_studio_boleto_cancelado = True apos cancelamento
  - Mensagens de erro mais claras

Uso: python3 fix-cancelar-boleto.py <API_KEY>
"""
import sys, xmlrpc.client

API_KEY = sys.argv[1] if len(sys.argv) > 1 else 'a60341a34aedd0b37b3786d53ea8df061357c31d'
URL = 'https://ajlferroeaco.odoo.com'
DB  = 'ajlferroeaco'
USER = 'admin'

print('Conectando ao Odoo...')
common = xmlrpc.client.ServerProxy(f'{URL}/xmlrpc/2/common')
uid = common.authenticate(DB, USER, API_KEY, {})
if not uid:
    print('ERRO: Falha na autenticacao. Verifique a API key.')
    sys.exit(1)
print(f'OK - uid={uid}')

models = xmlrpc.client.ServerProxy(f'{URL}/xmlrpc/2/object')
def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(DB, uid, API_KEY, model, method, args or [], kwargs or {})

# Busca o ID do modelo account.move
model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
if not model_ids:
    print('ERRO: Modelo account.move nao encontrado')
    sys.exit(1)
model_id = model_ids[0]

# Codigo da acao v2 - suporta multiplos boletos via JSON
codigo = r"""import urllib.request, json, re
from odoo.exceptions import UserError

# === Cancelar Boleto v2 ===
# Le todos os nossos numeros do campo JSON ou campo simples
nosso_numeros = []
raw_json = record.x_studio_itau_resposta_json or ''

if raw_json:
    try:
        json_str = raw_json.replace("'", '"').replace('True', 'true').replace('False', 'false').replace('None', 'null')
        data = json.loads(json_str)
        pagamentos = data.get('pagamentos', [])
        for p in pagamentos:
            nn = p.get('nosso_numero', '')
            if nn:
                nosso_numeros.append(nn)
    except Exception:
        pass

# Fallback: campo simples x_studio_nosso_numero
if not nosso_numeros:
    nn_simple = record.x_studio_nosso_numero or ''
    if nn_simple:
        nosso_numeros.append(nn_simple)

if not nosso_numeros:
    raise UserError('Fatura nao possui dados de boleto (x_studio_itau_resposta_json e x_studio_nosso_numero estao vazios).')

# Cancelar cada boleto no Itau
resultados = []
for nn in nosso_numeros:
    url = 'https://api-odoo-rhzf.onrender.com/api/v1/itau/cancelar'
    payload = json.dumps({"nosso_numero": nn}).encode('utf-8')
    req = urllib.request.Request(url, data=payload, headers={
        'Content-Type': 'application/json',
        'X-Api-Key': 'cnpja-odoo-secret-2024',
    }, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resultado = json.loads(resp.read().decode('utf-8'))
        if resultado.get('success'):
            resultados.append(('OK', nn))
        else:
            resultados.append(('ERRO', nn + ': ' + str(resultado.get('message', 'Erro desconhecido'))))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8') if e.fp else ''
        resultados.append(('ERRO', nn + ': HTTP %d - %s' % (e.code, body[:200])))
    except Exception as e:
        resultados.append(('ERRO', nn + ': ' + str(e)))

# Resumo
ok_count = sum(1 for r in resultados if r[0] == 'OK')
erro_count = sum(1 for r in resultados if r[0] == 'ERRO')

# Marcar como cancelado se todos OK
if erro_count == 0:
    record.x_studio_boleto_cancelado = True

msg = 'Cancelar Boleto: %d cancelado(s), %d erro(s)\n' % (ok_count, erro_count)
for r in resultados:
    msg += '  %s: %s\n' % r
raise UserError(msg)
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
existente = kw('ir.actions.server', 'search', [[['name', '=', 'Cancelar Boleto']]])
if existente:
    kw('ir.actions.server', 'write', [existente, dados_acao])
    print(f'Server Action "Cancelar Boleto" ATUALIZADA (ID={existente[0]})')
    action_id = existente[0]
else:
    action_id = kw('ir.actions.server', 'create', [dados_acao])
    print(f'Server Action "Cancelar Boleto" CRIADA (ID={action_id})')

# Criar external ID para referencia no botao
ext_id_exist = kw('ir.model.data', 'search', [[['module', '=', 'ajl_custom'], ['name', '=', 'action_cancelar_boleto']]])
if not ext_id_exist:
    kw('ir.model.data', 'create', [{
        'name': 'action_cancelar_boleto',
        'module': 'ajl_custom',
        'model': 'ir.actions.server',
        'res_id': action_id,
    }])
    print('External ID ajl_custom.action_cancelar_boleto criado')
else:
    kw('ir.model.data', 'write', [ext_id_exist, {'res_id': action_id}])
    print('External ID ajl_custom.action_cancelar_boleto atualizado')

# Adicionar botao no formulario de fatura (account.move form)
# Verificar se ja existe view herdada
btn_view_exist = kw('ir.ui.view', 'search', [[['name', '=', 'AJL Cancelar Boleto Button']]])
if btn_view_exist:
    print(f'Botao ja existe na view (ID={btn_view_exist[0]})')
else:
    # Buscar a view original do account.move form
    form_view = kw('ir.ui.view', 'search', [[['model', '=', 'account.move'], ['type', '=', 'form']]], {'limit': 1})
    if form_view:
        # Criar view herdada com botao
        btn_arch = '''<data>
            <xpath expr="//header" position="inside">
                <button name="%(ajl_custom.action_cancelar_boleto)d" string="Cancelar Boleto" type="action" class="oe_highlight" groups="base.group_user"/>
            </xpath>
        </data>'''
        btn_view_id = kw('ir.ui.view', 'create', [{
            'name': 'AJL Cancelar Boleto Button',
            'model': 'account.move',
            'type': 'form',
            'inherit_id': form_view[0],
            'arch_db': btn_arch,
            'priority': 100,
        }])
        print(f'Botao criado na view ID={btn_view_id} (herdando de {form_view[0]})')
    else:
        print('AVISO: Nao encontrou view form de account.move para adicionar botao')

print('')
print('PRONTO! Acao "Cancelar Boleto" atualizada com:')
print('  - URL: api-odoo-rhzf.onrender.com (middleware atual)')
print('  - Leitura de multiplos boletos via x_studio_itau_resposta_json')
print('  - Fallback para x_studio_nosso_numero')
print('  - Marcacao automatica de x_studio_boleto_cancelado')
print('  - Botao "Cancelar Boleto" no cabecalho da fatura')
