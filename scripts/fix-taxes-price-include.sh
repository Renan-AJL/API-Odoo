#!/bin/bash
# Corrige os impostos de venda no Odoo:
#  - NAO-IPI (ICMS/DIFAL/ACRESCIMO/PIS/COFINS/ISSQN/...): price_include=true,
#    include_base_amount=true, sequence=5 -> NAO somam no total (por dentro)
#  - IPI: mantem price_include=false, sequence=10 -> SOMENTE IPI soma no total
KEY="cnpja-odoo-secret-2024"
URL="https://api-odoo-rhzf.onrender.com/api/v1/admin/odoo-rpc"

TAXES=$(curl -s -m 120 -X POST "$URL" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"model":"account.tax","method":"search_read","args":[[["type_tax_use","in",["sale","none"]],["active","=",true]]],"kwargs":{"fields":["id","name","amount","price_include","include_base_amount","sequence"],"limit":100,"order":"id"}}')

echo "$TAXES" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for t in d['result']:
    print(t['id'], t['name'])
"
echo "=== Aplicando writes ==="

echo "$TAXES" | python3 -c "
import json,sys
d=json.load(sys.stdin)
out=[]
for t in d['result']:
    nome=(t['name'] or '').upper()
    if 'IPI' in nome:
        out.append({'id':t['id'],'vals':{'sequence':10},'why':'IPI mantem price_include=false (soma no total)'})
    else:
        out.append({'id':t['id'],'vals':{'price_include':True,'include_base_amount':True,'sequence':5},'why':'por dentro (nao soma)'})
for o in out:
    print(o['id'], json.dumps(o['vals']))
" > /tmp/tax_writes.txt

while read -r id vals; do
  R=$(curl -s -m 120 -X POST "$URL" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"account.tax\",\"method\":\"write\",\"allowWrite\":true,\"args\":[[${id}],${vals}]}")
  echo "tax $id -> $(echo $R | head -c 120)"
done < /tmp/tax_writes.txt

echo "=== Estado final ==="
curl -s -m 120 -X POST "$URL" -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"model":"account.tax","method":"search_read","args":[[["type_tax_use","in",["sale","none"]],["active","=",true]]],"kwargs":{"fields":["id","name","amount","price_include","include_base_amount","sequence"],"limit":100,"order":"sequence,id"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for t in d['result']:
    flag='SOMA NO TOTAL' if (not t['price_include'] and t['amount']) else 'por dentro'
    print(f\"seq={t['sequence']:>2} id={t['id']:>4} {t['name'][:38]:<38} amt={t['amount']:>5} inc={t['price_include']} incbase={t['include_base_amount']} [{flag}]\")
"
