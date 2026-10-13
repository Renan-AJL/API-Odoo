#!/bin/bash
# ============================================================
# test-itau-status.sh - Teste das novas rotas de status PIX/Boleto/Extrato
# ============================================================
# Uso: ./test-itau-status.sh [API_KEY] [BASE_URL]
#
# Exemplos:
#   ./test-itau-status.sh sua-api-key
#   ./test-itau-status.sh sua-api-key https://api-odoo-rhzf.onrender.com
# ============================================================

API_KEY="${1:-$MIDDLEWARE_API_KEY}"
BASE_URL="${2:-https://api-odoo-rhzf.onrender.com}"
HEADER="X-API-Key: $API_KEY"

if [ -z "$API_KEY" ]; then
  echo "ERRO: Forneça a API Key como argumento ou defina MIDDLEWARE_API_KEY"
  echo "Uso: $0 <api_key> [base_url]"
  exit 1
fi

echo "=========================================="
echo "  TESTE ITAU STATUS - AJL"
echo "=========================================="
echo "  Base URL: $BASE_URL"
echo "  API Key:  ***${API_KEY: -4}"
echo ""

# 1. Teste conexão Odoo
echo "1. Teste de conexão Odoo..."
curl -s "$BASE_URL/api/v1/itau/status/odoo-test" -H "$HEADER" | python3 -m json.tool 2>/dev/null
echo ""

# 2. Diário bancário
echo "2. Diário bancário configurado..."
curl -s "$BASE_URL/api/v1/itau/status/diario" -H "$HEADER" | python3 -m json.tool 2>/dev/null
echo ""

# 3. Faturas pendentes
echo "3. Faturas com pagamento pendente..."
curl -s "$BASE_URL/api/v1/itau/status/pendentes" -H "$HEADER" | python3 -m json.tool 2>/dev/null
echo ""

# 4. Polling PIX
echo "4. Disparar polling PIX manual..."
curl -s -X POST "$BASE_URL/api/v1/itau/status/poll-pix" -H "$HEADER" | python3 -m json.tool 2>/dev/null
echo ""

# 5. Polling Boletos
echo "5. Disparar polling boletos manual..."
curl -s -X POST "$BASE_URL/api/v1/itau/status/poll-boletos" -H "$HEADER" | python3 -m json.tool 2>/dev/null
echo ""

# 6. Importar extrato (ontem)
echo "6. Importar extrato bancário (ontem)..."
curl -s -X POST "$BASE_URL/api/v1/itau/status/importar-extrato" -H "$HEADER" -H "Content-Type: application/json" | python3 -m json.tool 2>/dev/null
echo ""

echo "=========================================="
echo "  TESTES CONCLUÍDOS"
echo "=========================================="
echo ""
echo "Rotas disponíveis:"
echo "  GET  /api/v1/itau/status/odoo-test            - Teste conexão Odoo"
echo "  GET  /api/v1/itau/status/diario                - Diário bancário"
echo "  GET  /api/v1/itau/status/pendentes             - Faturas pendentes"
echo "  GET  /api/v1/itau/status/invoice/:id           - Status de fatura"
echo "  POST /api/v1/itau/status/poll-pix              - Polling PIX manual"
echo "  POST /api/v1/itau/status/poll-boletos          - Polling boletos manual"
echo "  POST /api/v1/itau/status/poll-all              - Polling PIX+Boletos"
echo "  POST /api/v1/itau/status/consultar-pix/:txid   - Consultar PIX direto Itaú"
echo "  POST /api/v1/itau/status/consultar-boleto/:nn  - Consultar boleto direto Itaú"
echo "  POST /api/v1/itau/status/importar-extrato      - Importar extrato manual"
