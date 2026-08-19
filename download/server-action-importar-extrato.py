# -*- coding: utf-8 -*-
# Server Action: Importar Extrato Bancario
# Modelo: account.journal (diario bancario)
# Botao: "Importar Extrato Itau"
# Acao: Executa Python
# ---------------------------------------------------------
# Colar no campo "Código Python" da Server Action no Odoo.
# Ou vincular a um botao no formulario do diario bancario.
# ---------------------------------------------------------

import urllib.request
import json
from datetime import datetime, timedelta


# Configuracoes - AJUSTAR CONFORME SEU AMBIENTE
API_BASE_URL = "https://sua-api.render.com"  # URL do seu servidor Render
API_KEY = "sua-api-key-aqui"                 # MIDDLEWARE_API_KEY

# Data: ontem por padrao, ou passe 'data_inicial' como parametro da acao
ontem = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')

url = API_BASE_URL.rstrip('/') + '/api/v1/itau/extrato/importar'
payload = json.dumps({
    'data_inicial': ontem,
    'data_final': ontem,
}).encode('utf-8')

req = urllib.request.Request(url, data=payload, method='POST')
req.add_header('Content-Type', 'application/json')
req.add_header('x-api-key', API_KEY)

try:
    with urllib.request.urlopen(req, timeout=60) as response:
        result = json.loads(response.read().decode('utf-8'))
        if result.get('success'):
            n = result.get('transacoes', 0)
            sid = result.get('statement_id', '')
            raise UserError('Extrato importado com sucesso! %d transacoes (Statement ID: %s) no diario %s' % (
                n, sid, result.get('journal_name', '')))
        else:
            raise UserError('Erro: ' + result.get('message', 'Erro desconhecido'))
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8') if e.fp else ''
    raise UserError('Erro HTTP %d: %s' % (e.code, body[:300]))
except UserError:
    raise
except Exception as e:
    raise UserError('Erro ao importar extrato: %s' % str(e))
