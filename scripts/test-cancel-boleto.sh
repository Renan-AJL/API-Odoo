#!/bin/bash
API="https://api-odoo-rhzf.onrender.com"
KEY="cnpja-odoo-secret-2024"

echo "=== Teste de Cancelamento de Boleto ==="
echo ""

# 1. Check token
echo "1. Status do token Itau:"
curl -s -H "X-API-Key: $KEY" "$API/api/v1/itau/token/status" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  Token presente:', d.get('hasToken') is not None)
print('  Token valido:', d.get('isValid'))
print('  Expira em:', d.get('expiresIn'))
" 2>/dev/null

echo ""
echo "2. Boleto NN 62362135 - Tentativa de cancelar:"
curl -s -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -X POST -d '{"nosso_numero":"62362135"}' \
  "$API/api/v1/itau/cancelar" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  Sucesso:', d.get('success'))
print('  Mensagem:', d.get('message'))
print('  Hint:', d.get('hint',''))
" 2>/dev/null

echo ""
echo "3. Boleto NN 62362135 - Consultar status:"
curl -s -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -X POST "$API/api/v1/itau/status/consultar-boleto/62362135" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('  Resultado:', json.dumps(d,indent=2)[:500])
except:
    print('  Erro ao consultar')
" 2>/dev/null

echo ""
echo "4. Listar boletos hoje:"
curl -s -H "X-API-Key: $KEY" "$API/api/v1/itau/status/boletos-hoje" | python3 -c "
import sys,json
d=json.load(sys.stdin)
boletos = d.get('boletos',[])
print(f'  Total: {len(boletos)} faturas com boleto hoje')
for b in boletos:
    print(f'  - ID:{b[\"id\"]} {b[\"nome\"]} NN:{b[\"nosso_numero\"]} Valor:R${b[\"valor\"]} Parceiro:{b[\"parceiro\"]}')
" 2>/dev/null
