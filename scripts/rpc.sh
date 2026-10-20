#!/bin/bash
# Helper: chamada RPC ao Odoo via middleware
# uso: ./rpc.sh '<json-body>'
BODY="$1"
curl -s -m 120 -X POST "https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc" \
  -H "X-API-Key: cnpja-odoo-secret-2024" -H "Content-Type: application/json" \
  -d "$BODY"
