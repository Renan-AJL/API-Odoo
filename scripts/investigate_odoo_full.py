#!/usr/bin/env python3
"""
Deep investigation of Odoo instance for validation checklist.
"""
import xmlrpc.client
import json

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '3dd19d4815044c45ae30fee45ffd54efc5f771d5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

def ekw(model, method, args=None, kwargs=None):
    if args is None: args = []
    try:
        if kwargs:
            return models.execute_kw(db, uid, pwd, model, method, args, kwargs)
        return models.execute_kw(db, uid, pwd, model, method, args)
    except Exception as e:
        return {'_error': str(e)}

def safe(v, default=0):
    return v if not isinstance(v, dict) else default

results = {}

# === 1. CRM ===
print("1. CRM")
leads_count = safe(ekw('crm.lead', 'search_count', [[['type', '=', 'lead']]]))
opps_count = safe(ekw('crm.lead', 'search_count', [[['type', '=', 'opportunity']]]))
stages = ekw('crm.stage', 'search_read', [[]], {'fields': ['id', 'name', 'sequence']})
teams = ekw('crm.team', 'search_read', [[]], {'fields': ['id', 'name']})
lead_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'crm.lead'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 50})
lost_reasons = ekw('crm.lost.reason', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
results['crm'] = {'leads_count': leads_count, 'opps_count': opps_count,
    'stages': stages if not isinstance(stages, dict) else [],
    'teams': teams if not isinstance(teams, dict) else [],
    'studio_fields': lead_fields if not isinstance(lead_fields, dict) else [],
    'lost_reasons': lost_reasons if not isinstance(lost_reasons, dict) else []}
print(f"  Leads={leads_count} Opps={opps_count}")
if not isinstance(stages, dict): print(f"  Stages: {[s['name'] for s in stages]}")
if not isinstance(teams, dict): print(f"  Teams: {[t['name'] for t in teams]}")
if not isinstance(lead_fields, dict):
    print(f"  Studio fields ({len(lead_fields)}):")
    for f in lead_fields[:10]: print(f"    {f['name']:45s} {f['ttype']:8s} ({f['field_description']})")

# === 2. SALES ===
print("\n2. SALES / PEDIDOS")
so_count = safe(ekw('sale.order', 'search_count', [[]]))
so_states = {}
for state in ['draft', 'sent', 'sale', 'done', 'cancel']:
    so_states[state] = safe(ekw('sale.order', 'search_count', [[['state', '=', state]]]))
so_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'sale.order'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 50})
sol_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'sale.order.line'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 50})
pricelists = ekw('product.pricelist', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
quot_templates = ekw('sale.order.template', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
results['sales'] = {'so_count': so_count, 'so_states': so_states,
    'studio_fields_so': so_fields if not isinstance(so_fields, dict) else [],
    'studio_fields_sol': sol_fields if not isinstance(sol_fields, dict) else [],
    'pricelists': pricelists if not isinstance(pricelists, dict) else [],
    'quot_templates': quot_templates if not isinstance(quot_templates, dict) else []}
print(f"  Total SO: {so_count}  States: {so_states}")
if not isinstance(so_fields, dict):
    print(f"  Studio fields sale.order ({len(so_fields)}):")
    for f in so_fields[:10]: print(f"    {f['name']:45s} {f['ttype']:8s} ({f['field_description']})")
if not isinstance(sol_fields, dict):
    print(f"  Studio fields sale.order.line ({len(sol_fields)}):")
    for f in sol_fields[:10]: print(f"    {f['name']:45s} {f['ttype']:8s} ({f['field_description']})")
if not isinstance(pricelists, dict): print(f"  Pricelists: {[p['name'] for p in pricelists]}")

# === 3. FINANCEIRO ===
print("\n3. FINANCEIRO")
inv_out = safe(ekw('account.move', 'search_count', [[['move_type', '=', 'out_invoice']]]))
inv_in = safe(ekw('account.move', 'search_count', [[['move_type', '=', 'in_invoice']]]))
inv_states = {}
for state in ['draft', 'posted', 'cancel']:
    inv_states[state] = safe(ekw('account.move', 'search_count', [[['move_type', '=', 'out_invoice'], ['state', '=', state]]]))
pay_terms = ekw('account.payment.term', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
journals = ekw('account.journal', 'search_read', [[]], {'fields': ['id', 'name', 'type'], 'limit': 20})
am_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'account.move'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 60})
nfe_pend = safe(ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'pendente']]]))
nfe_auth = safe(ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'autorizada']]]))
nfe_err = safe(ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'erro']]]))
nfe_canc = safe(ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'cancelando']]]))
has_boleto = safe(ekw('account.move', 'search_count', [[['x_studio_itau_nosso_numero', '!=', False]]]))
has_pix = safe(ekw('account.move', 'search_count', [[['x_studio_itau_txid_1', '!=', False]]]))
# Credit notes
credit_notes = safe(ekw('account.move', 'search_count', [[['move_type', '=', 'out_refund']]]))
# Payments
payments = safe(ekw('account.payment', 'search_count', [[]]))
results['finance'] = {'inv_out': inv_out, 'inv_in': inv_in, 'inv_states': inv_states,
    'pay_terms': pay_terms if not isinstance(pay_terms, dict) else [],
    'journals': journals if not isinstance(journals, dict) else [],
    'studio_fields': am_fields if not isinstance(am_fields, dict) else [],
    'nfe_pend': nfe_pend, 'nfe_auth': nfe_auth, 'nfe_err': nfe_err, 'nfe_canc': nfe_canc,
    'has_boleto': has_boleto, 'has_pix': has_pix,
    'credit_notes': credit_notes, 'payments': payments}
print(f"  Out Invoices: {inv_out}  In: {inv_in}  Credit Notes: {credit_notes}")
print(f"  States: {inv_states}")
print(f"  NF-e: pend={nfe_pend} auth={nfe_auth} err={nfe_err} canc={nfe_canc}")
print(f"  Boleto: {has_boleto}  PIX: {has_pix}  Payments: {payments}")
if not isinstance(journals, dict): print(f"  Journals: {[(j['name'], j['type']) for j in journals]}")
if not isinstance(pay_terms, dict): print(f"  Payment Terms: {[p['name'] for p in pay_terms]}")
if not isinstance(am_fields, dict):
    print(f"  Studio fields account.move ({len(am_fields)}):")
    for f in am_fields[:20]: print(f"    {f['name']:45s} {f['ttype']:8s} ({f['field_description']})")

# === 4. COMPRAS ===
print("\n4. COMPRAS")
po_count = safe(ekw('purchase.order', 'search_count', [[]]))
po_states = {}
for state in ['draft', 'sent', 'purchase', 'done', 'cancel']:
    po_states[state] = safe(ekw('purchase.order', 'search_count', [[['state', '=', state]]]))
vendors = safe(ekw('res.partner', 'search_count', [[['supplier_rank', '>', 0]]]))
po_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'purchase.order'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 20})
receptions = safe(ekw('stock.picking', 'search_count', [[['picking_type_code', '=', 'incoming']]]))
results['purchase'] = {'po_count': po_count, 'po_states': po_states, 'vendors': vendors,
    'receptions': receptions, 'studio_fields': po_fields if not isinstance(po_fields, dict) else []}
print(f"  PO: {po_count}  States: {po_states}  Vendors: {vendors}  Receptions: {receptions}")
if not isinstance(po_fields, dict) and po_fields:
    print(f"  Studio fields ({len(po_fields)}):")
    for f in po_fields[:5]: print(f"    {f['name']:45s} {f['ttype']:8s} ({f['field_description']})")

# === 5. PRODUÇÃO / MRP ===
print("\n5. PRODUÇÃO / MRP")
mo_count = safe(ekw('mrp.production', 'search_count', [[]]))
if isinstance(ekw('mrp.production', 'search_count', [[]]), dict):
    print("  MRP not available")
    results['mrp'] = 'not_available'
else:
    mo_states = {}
    for state in ['draft', 'confirmed', 'progress', 'done', 'cancel']:
        mo_states[state] = safe(ekw('mrp.production', 'search_count', [[['state', '=', state]]]))
    bom_count = safe(ekw('mrp.bom', 'search_count', [[]]))
    workcenters = ekw('mrp.workcenter', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
    results['mrp'] = {'mo_count': mo_count, 'mo_states': mo_states,
        'bom_count': bom_count, 'workcenters': workcenters if not isinstance(workcenters, dict) else []}
    print(f"  MO: {mo_count}  States: {mo_states}  BOMs: {bom_count}")
    if not isinstance(workcenters, dict): print(f"  Work Centers: {[w['name'] for w in workcenters]}")

# === 6. ESTOQUE ===
print("\n6. ESTOQUE")
products = safe(ekw('product.product', 'search_count', [[]]))
products_tmpl = safe(ekw('product.template', 'search_count', [[]]))
locations = ekw('stock.location', 'search_read', [[['usage', '=', 'internal']]], {'fields': ['id', 'name', 'complete_name'], 'limit': 20})
warehouses = ekw('stock.warehouse', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
pickings = safe(ekw('stock.picking', 'search_count', [[]]))
quants = safe(ekw('stock.quant', 'search_count', [[['quantity', '>', 0], ['location_id.usage', '=', 'internal']]]))
categories = ekw('product.category', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 30})
type_counts = {}
for ptype in ['consu', 'service', 'product']:
    type_counts[ptype] = safe(ekw('product.template', 'search_count', [[['type', '=', ptype]]]))
tracking = safe(ekw('product.template', 'search_count', [[['tracking', '!=', 'none']]]))
# Stock moves
stock_moves = safe(ekw('stock.move', 'search_count', [[]]))
# Inventory adjustments
inv_adj = safe(ekw('stock.inventory', 'search_count', [[]]))
pp_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'product.product'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 30})
results['stock'] = {'products': products, 'products_tmpl': products_tmpl,
    'locations': locations if not isinstance(locations, dict) else [],
    'warehouses': warehouses if not isinstance(warehouses, dict) else [],
    'pickings': pickings, 'quants': quants,
    'categories': categories if not isinstance(categories, dict) else [],
    'type_counts': type_counts, 'tracking': tracking,
    'stock_moves': stock_moves, 'inv_adj': inv_adj,
    'studio_fields': pp_fields if not isinstance(pp_fields, dict) else []}
print(f"  Products: {products} (variants) / {products_tmpl} (templates)")
print(f"  Types: {type_counts}  Tracking(lot/serial): {tracking}")
print(f"  Quants w/ stock: {quants}  Pickings: {pickings}  Moves: {stock_moves}  Adjustments: {inv_adj}")
if not isinstance(warehouses, dict): print(f"  Warehouses: {[w['name'] for w in warehouses]}")
if not isinstance(locations, dict): print(f"  Internal Locations: {[l['name'] for l in locations]}")
if not isinstance(categories, dict): print(f"  Categories ({len(categories)}): {[c['name'] for c in categories[:15]]}")
if not isinstance(pp_fields, dict) and pp_fields:
    print(f"  Studio fields product ({len(pp_fields)}):")
    for f in pp_fields[:10]: print(f"    {f['name']:45s} {f['ttype']:8s} ({f['field_description']})")

# === 7. API / INTEGRATIONS ===
print("\n7. API INTEGRATIONS")
server_actions = ekw('ir.actions.server', 'search_read', [[]], {'fields': ['id', 'name', 'state', 'model_id'], 'limit': 50})
crons = ekw('ir.cron', 'search_read', [[]], {'fields': ['id', 'name', 'active', 'interval_number', 'interval_type', 'model_id'], 'limit': 30})
results['integrations'] = {
    'server_actions': server_actions if not isinstance(server_actions, dict) else [],
    'crons': crons if not isinstance(crons, dict) else []}
if not isinstance(server_actions, dict):
    print(f"  Server Actions ({len(server_actions)}):")
    for a in server_actions: print(f"    ID={a['id']}  {a['name']}  model={a.get('model_id','')}")
if not isinstance(crons, dict):
    print(f"  Cron Jobs ({len(crons)}):")
    for c in crons: print(f"    ID={c['id']}  {c['name']}  active={c['active']}  {c['interval_number']}{c['interval_type']}")

# === 8. DELIVERY ===
print("\n8. ENTREGA / DELIVERY")
carriers = ekw('delivery.carrier', 'search_read', [[]], {'fields': ['id', 'name', 'delivery_type'], 'limit': 10})
te_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'account.move'], ['name', 'like', 'x_studio_te%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 10})
deliveries = safe(ekw('stock.picking', 'search_count', [[['picking_type_code', '=', 'outgoing']]]))
results['delivery'] = {'carriers': carriers if not isinstance(carriers, dict) else [],
    'te_fields': te_fields if not isinstance(te_fields, dict) else [], 'deliveries': deliveries}
if not isinstance(carriers, dict): print(f"  Carriers: {[(c['name'], c['delivery_type']) for c in carriers]}")
if not isinstance(te_fields, dict): print(f"  TudoEntregue fields: {[f['name'] for f in te_fields]}")
print(f"  Outgoing pickings: {deliveries}")

# === 9. USERS ===
print("\n9. USERS")
users = ekw('res.users', 'search_read', [[['active', '=', True]]], {'fields': ['id', 'name', 'login', 'share'], 'limit': 30})
results['users'] = users if not isinstance(users, dict) else []
if not isinstance(users, dict):
    print(f"  Active ({len(users)}):")
    for u in users: print(f"    ID={u['id']}  {u['name']}  login={u['login']}  portal={u.get('share',False)}")

# === 10. COMPANY ===
print("\n10. COMPANY")
companies = ekw('res.company', 'search_read', [[]], {'fields': ['id', 'name', 'vat', 'street', 'city', 'state_id', 'phone', 'email'], 'limit': 5})
results['company'] = companies if not isinstance(companies, dict) else []
if not isinstance(companies, dict):
    for c in companies: print(f"  {c['name']}  CNPJ={c.get('vat','')}  {c.get('street','')} {c.get('city','')}")

# === 11. PARTNERS ===
print("\n11. PARTNERS (CLIENTES)")
partners = safe(ekw('res.partner', 'search_count', [[]]))
customers = safe(ekw('res.partner', 'search_count', [[['customer_rank', '>', 0]]]))
vendors2 = safe(ekw('res.partner', 'search_count', [[['supplier_rank', '>', 0]]]))
both = safe(ekw('res.partner', 'search_count', [[['customer_rank', '>', 0], ['supplier_rank', '>', 0]]]))
results['partners'] = {'total': partners, 'customers': customers, 'vendors': vendors2, 'both': both}
print(f"  Total: {partners}  Customers: {customers}  Vendors: {vendors2}  Both: {both}")

with open('/home/z/my-project/scripts/odoo_investigation.json', 'w') as f:
    json.dump(results, f, ensure_ascii=False, indent=2, default=str)
print("\nSaved to odoo_investigation.json")
