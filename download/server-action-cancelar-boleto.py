# -*- coding: utf-8 -*-
# Server Action: Cancelar Boleto Itau
# Modelo: account.move
# Botao: "Cancelar Boleto"
# Acao: Executa Python
# ---------------------------------------------------------
# Colar no campo "Código Python" da Server Action no Odoo:
# ---------------------------------------------------------

import urllib.request
import json

# Configuracoes - AJUSTAR CONFORME SEU AMBIENTE
API_BASE_URL = "https://sua-api.render.com"  # URL do seu servidor Render
API_KEY = "sua-api-key-aqui"                 # MIDDLEWARE_API_KEY

# Lê o nosso_numero do campo personalizado da fatura
# Se usar campo Studio, ajuste o nome abaixo
nosso_numero = record.x_studio_nosso_numero or ''

if not nosso_numero:
    raise UserError('Fatura nao possui Nosso Numero (boleto). Nao ha o que cancelar.')

# Chama a API para cancelar
url = API_BASE_URL.rstrip('/') + '/api/v1/itau/cancelar'
payload = json.dumps({"nosso_numero": nosso_numero}).encode('utf-8')

req = urllib.request.Request(url, data=payload, method='POST')
req.add_header('Content-Type', 'application/json')
req.add_header('x-api-key', API_KEY)

try:
    with urllib.request.urlopen(req, timeout=30) as response:
        result = json.loads(response.read().decode('utf-8'))
        if result.get('success'):
            # Marca o boleto como cancelado no Odoo
            # Ajuste o campo conforme seu modelo
            record.x_studio_boleto_cancelado = True
            message = 'Boleto %s cancelado com sucesso no Itau!' % nosso_numero
        else:
            raise UserError('Erro ao cancelar: ' + result.get('message', 'Erro desconhecido'))
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8') if e.fp else ''
    raise UserError('Erro HTTP %d ao cancelar boleto: %s' % (e.code, body[:200]))
except Exception as e:
    raise UserError('Erro ao cancelar boleto: %s' % str(e))
