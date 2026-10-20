#!/bin/bash
# price_include via price_include_override (Odoo 19) para todos os nao-IPI
KEY="cnpja-odoo-secret-2024"
URL="https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"

curl -s -m 120 -X POST "$URL" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"model":"account.tax","method":"search_read","args":[[["type_tax_use","in",["sale","none"]],["active","=",true]]],"kwargs":{"fields":["id","name","amount"],"limit":100,"order":"id"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for t in d['result']:
    nome=(t['name'] or '').upper()
    if 'IPI' not in nome:
        print(t['id'])
" > /tmp/tax_naoipi.txt

echo "Nao-IPI a virar: $(wc -l < /tmp/tax_naoipi.txt)"
while read -r id; do
  R=$(curl -s -m 120 -X POST "$URL" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"account.tax\",\"method\":\"write\",\"allowWrite\":true,\"args\":[[${id}],{\"price_include_override\":\"tax_included\"}]}")
  OK=$(echo "$R" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success'))" 2>/dev/null)
  echo "tax $id -> success=$OK"
done < /tmp/tax_naoipi.txt

echo "=== Estado final ==="
curl -s -m 120 -X POST "$URL" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"model":"account.tax","method":"search_read","args":[[["type_tax_use","in",["sale","none"]],["active","=",true]]],"kwargs":{"fields":["id","name","amount","price_include","sequence"],"limit":100,"order":"sequence,id"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for t in d['result']:
    flag='*** SOMA NO TOTAL ***' if (not t['price_include'] and t['amount']) else 'por dentro'
    print(f\"seq={t['sequence']:>2} id={t['id']:>4} {t['name'][:38]:<38} amt={t['amount']:>5} inc={t['price_include']} [{flag}]\")
"
