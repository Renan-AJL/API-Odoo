#!/usr/bin/env python3
"""
Deep investigation of Odoo instance for validation checklist.
Handles permission errors gracefully for SaaS-restricted models.
"""
import xmlrpc.client
import json

url = 'https://ajlferroeaco.odoo.com'
db = 'ajlferroeaco'
uid = 2
pwd = '7453620b69c6edc4511bacd6a541b66d789afcd5'

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

def ekw(model, method, args=None, kwargs=None):
    if args is None: args = []
    try:
        if kwargs:
            return models.execute_kw(db, uid, pwd, model, method, args, kwargs)
        return models.execute_kw(db, uid, pwd, model, method, args)
    except Exception as e:
        return {'_error': str(e)}

results = {}

# === 1. INSTALLED MODULES ===
print("=" * 60)
print("1. INSTALLED MODULES")
print("=" * 60)
mods = ekw('ir.module.module', 'search_read', 
    [[['state', '=', 'installed']]], 
    {'fields': ['name', 'shortdesc'], 'limit': 500})
if isinstance(mods, dict) and '_error' in mods:
    print(f"  ACCESS DENIED to ir.module.module (SaaS restriction)")
    print(f"  Will infer modules from available models instead")
    results['modules'] = 'access_denied'
else:
    results['modules'] = mods
    print(f"  Total installed: {len(mods)}")
    for m in mods[:30]:
        print(f"    {m['name']:40s}  {m.get('shortdesc','')[:50]}")

# === 2. CRM ===
print("\n" + "=" * 60)
print("2. CRM - Leads & Opportunities")
print("=" * 60)
leads_count = ekw('crm.lead', 'search_count', [[['type', '=', 'lead']]])
opps_count = ekw('crm.lead', 'search_count', [[['type', '=', 'opportunity']]])
stages = ekw('crm.stage', 'search_read', [[]], {'fields': ['id', 'name', 'sequence']})
teams = ekw('crm.team', 'search_read', [[]], {'fields': ['id', 'name']})
lead_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'crm.lead'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 50})
lost_reasons = ekw('crm.lost.reason', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
results['crm'] = {
    'leads_count': leads_count if not isinstance(leads_count, dict) else 0,
    'opps_count': opps_count if not isinstance(opps_count, dict) else 0,
    'stages': stages if not isinstance(stages, dict) else [],
    'teams': teams if not isinstance(teams, dict) else [],
    'studio_fields': lead_fields if not isinstance(lead_fields, dict) else [],
    'lost_reasons': lost_reasons if not isinstance(lost_reasons, dict) else []
}
print(f"  Leads: {results['crm']['leads_count']}")
print(f"  Opportunities: {results['crm']['opps_count']}")
if not isinstance(stages, dict):
    print(f"  Stages: {[s['name'] for s in stages]}")
if not isinstance(teams, dict):
    print(f"  Teams: {[t['name'] for t in teams]}")
if not isinstance(lead_fields, dict):
    print(f"  Studio fields ({len(lead_fields)}):")
    for f in lead_fields[:20]:
        print(f"    {f['name']:45s}  {f['ttype']:10s}  ({f['field_description']})")

# === 3. SALES ===
print("\n" + "=" * 60)
print("3. SALES / PEDIDOS")
print("=" * 60)
so_count = ekw('sale.order', 'search_count', [[]])
so_states = {}
for state in ['draft', 'sent', 'sale', 'done', 'cancel']:
    c = ekw('sale.order', 'search_count', [[['state', '=', state]]])
    so_states[state] = c if not isinstance(c, dict) else 0
so_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'sale.order'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 50})
sol_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'sale.order.line'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 50})
pricelists = ekw('product.pricelist', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
quotation_templates = ekw('sale.order.template', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
results['sales'] = {
    'so_count': so_count if not isinstance(so_count, dict) else 0,
    'so_states': so_states,
    'studio_fields_so': so_fields if not isinstance(so_fields, dict) else [],
    'studio_fields_sol': sol_fields if not isinstance(sol_fields, dict) else [],
    'pricelists': pricelists if not isinstance(pricelists, dict) else [],
    'quotation_templates': quotation_templates if not isinstance(quotation_templates, dict) else []
}
print(f"  Total Sale Orders: {results['sales']['so_count']}")
print(f"  By state: {so_states}")
if not isinstance(so_fields, dict):
    print(f"  Studio fields sale.order ({len(so_fields)}):")
    for f in so_fields[:15]:
        print(f"    {f['name']:45s}  {f['ttype']:10s}  ({f['field_description']})")
if not isinstance(sol_fields, dict):
    print(f"  Studio fields sale.order.line ({len(sol_fields)}):")
    for f in sol_fields[:15]:
        print(f"    {f['name']:45s}  {f['ttype']:10s}  ({f['field_description']})")
if not isinstance(pricelists, dict):
    print(f"  Pricelists: {[p['name'] for p in pricelists]}")

# === 4. FINANCEIRO ===
print("\n" + "=" * 60)
print("4. FINANCEIRO / FATURAMENTO / PAGAMENTOS")
print("=" * 60)
inv_count = ekw('account.move', 'search_count', [[['move_type', '=', 'out_invoice']]])
inv_states = {}
for state in ['draft', 'posted', 'cancel']:
    c = ekw('account.move', 'search_count', [[['move_type', '=', 'out_invoice'], ['state', '=', state]]])
    inv_states[state] = c if not isinstance(c, dict) else 0
pay_terms = ekw('account.payment.term', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
journals = ekw('account.journal', 'search_read', [[]], {'fields': ['id', 'name', 'type'], 'limit': 20})
am_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'account.move'], ['name', 'like', 'x_studio%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 60})
nfe_pendente = ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'pendente']]])
nfe_autorizada = ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'autorizada']]])
nfe_erro = ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'erro']]])
nfe_cancelando = ekw('account.move', 'search_count', [[['x_studio_nfe_status', '=', 'cancelando']]])
has_boleto = ekw('account.move', 'search_count', [[['x_studio_itau_nosso_numero', '!=', False]]])
has_pix = ekw('account.move', 'search_count', [[['x_studio_itau_txid_1', '!=', False]]])
# Inbound invoices
in_inv_count = ekw('account.move', 'search_count', [[['move_type', '=', 'in_invoice']]])
results['finance'] = {
    'inv_count': inv_count if not isinstance(inv_count, dict) else 0,
    'inv_states': inv_states,
    'pay_terms': pay_terms if not isinstance(pay_terms, dict) else [],
    'journals': journals if not isinstance(journals, dict) else [],
    'studio_fields': am_fields if not isinstance(am_fields, dict) else [],
    'nfe_pendente': nfe_pendente if not isinstance(nfe_pendente, dict) else 0,
    'nfe_autorizada': nfe_autorizada if not isinstance(nfe_autorizada, dict) else 0,
    'nfe_erro': nfe_erro if not isinstance(nfe_erro, dict) else 0,
    'nfe_cancelando': nfe_cancelando if not isinstance(nfe_cancelando, dict) else 0,
    'has_boleto': has_boleto if not isinstance(has_boleto, dict) else 0,
    'has_pix': has_pix if not isinstance(has_pix, dict) else 0,
    'in_inv_count': in_inv_count if not isinstance(in_inv_count, dict) else 0
}
print(f"  Out Invoices: {results['finance']['inv_count']}")
print(f"  In Invoices: {results['finance']['in_inv_count']}")
print(f"  By state: {inv_states}")
print(f"  NF-e: pendente={results['finance']['nfe_pendente']} autorizada={results['finance']['nfe_autorizada']} erro={results['finance']['nfe_erro']} cancelando={results['finance']['nfe_cancelando']}")
print(f"  Faturas com boleto: {results['finance']['has_boleto']}")
print(f"  Faturas com PIX: {results['finance']['has_pix']}")
if not isinstance(journals, dict):
    print(f"  Journals: {[(j['name'], j['type']) for j in journals]}")
if not isinstance(pay_terms, dict):
    print(f"  Payment Terms: {[p['name'] for p in pay_terms]}")
if not isinstance(am_fields, dict):
    print(f"  Studio fields account.move ({len(am_fields)}):")
    for f in am_fields[:20]:
        print(f"    {f['name']:45s}  {f['ttype']:10s}  ({f['field_description']})")

# === 5. COMPRAS ===
print("\n" + "=" * 60)
print("5. COMPRAS")
print("=" * 60)
po_count = ekw('purchase.order', 'search_count', [[]])
po_states = {}
for state in ['draft', 'sent', 'purchase', 'done', 'cancel']:
    c = ekw('purchase.order', 'search_count', [[['state', '=', state]]])
    po_states[state] = c if not isinstance(c, dict) else 0
vendors = ekw('res.partner', 'search_count', [[['supplier_rank', '>', 0]]])
receptions = ekw('stock.picking', 'search_count', [[['picking_type_code', '=', 'incoming']]])
results['purchase'] = {
    'po_count': po_count if not isinstance(po_count, dict) else 0,
    'po_states': po_states, 'vendors': vendors if not isinstance(vendors, dict) else 0,
    'receptions': receptions if not isinstance(receptions, dict) else 0
}
print(f"  Purchase Orders: {results['purchase']['po_count']}")
print(f"  By state: {po_states}")
print(f"  Vendors: {results['purchase']['vendors']}")
print(f"  Incoming pickings: {results['purchase']['receptions']}")

# === 6. PRODUÇÃO / MRP ===
print("\n" + "=" * 60)
print("6. PRODUÇÃO / MRP")
print("=" * 60)
mo_count = ekw('mrp.production', 'search_count', [[]])
if isinstance(mo_count, dict) and '_error' in mo_count:
    print("  MRP not available or access denied")
    results['mrp'] = 'not_available'
else:
    mo_states = {}
    for state in ['draft', 'confirmed', 'progress', 'done', 'cancel']:
        c = ekw('mrp.production', 'search_count', [[['state', '=', state]]])
        mo_states[state] = c if not isinstance(c, dict) else 0
    bom_count = ekw('mrp.bom', 'search_count', [[]])
    workcenters = ekw('mrp.workcenter', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
    results['mrp'] = {
        'mo_count': mo_count, 'mo_states': mo_states,
        'bom_count': bom_count if not isinstance(bom_count, dict) else 0,
        'workcenters': workcenters if not isinstance(workcenters, dict) else []
    }
    print(f"  Manufacturing Orders: {mo_count}")
    print(f"  By state: {mo_states}")
    print(f"  BOMs: {results['mrp']['bom_count']}")
    if not isinstance(workcenters, dict):
        print(f"  Work Centers: {[w['name'] for w in workcenters]}")

# === 7. ESTOQUE ===
print("\n" + "=" * 60)
print("7. ESTOQUE / INVENTORY")
print("=" * 60)
products = ekw('product.product', 'search_count', [[]])
products_tmpl = ekw('product.template', 'search_count', [[]])
locations = ekw('stock.location', 'search_read', [[['usage', '=', 'internal']]], {'fields': ['id', 'name', 'complete_name'], 'limit': 20})
warehouses = ekw('stock.warehouse', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 10})
picking_count = ekw('stock.picking', 'search_count', [[]])
quants = ekw('stock.quant', 'search_count', [[['quantity', '>', 0], ['location_id.usage', '=', 'internal']]])
categories = ekw('product.category', 'search_read', [[]], {'fields': ['id', 'name'], 'limit': 30})
# Product types
type_counts = {}
for ptype in ['consu', 'service', 'product']:
    c = ekw('product.template', 'search_count', [[['type', '=', ptype]]])
    type_counts[ptype] = c if not isinstance(c, dict) else 0
# Lot/serial tracking
tracking_products = ekw('product.template', 'search_count', [[['tracking', '!=', 'none']]])
results['stock'] = {
    'products': products if not isinstance(products, dict) else 0,
    'products_tmpl': products_tmpl if not isinstance(products_tmpl, dict) else 0,
    'locations': locations if not isinstance(locations, dict) else [],
    'warehouses': warehouses if not isinstance(warehouses, dict) else [],
    'picking_count': picking_count if not isinstance(picking_count, dict) else 0,
    'quants': quants if not isinstance(quants, dict) else 0,
    'categories': categories if not isinstance(categories, dict) else [],
    'type_counts': type_counts,
    'tracking_products': tracking_products if not isinstance(tracking_products, dict) else 0
}
print(f"  Products (variant): {results['stock']['products']}")
print(f"  Products (template): {results['stock']['products_tmpl']}")
print(f"  Product types: {type_counts}")
print(f"  Tracking (lot/serial): {results['stock']['tracking_products']}")
if not isinstance(locations, dict):
    print(f"  Internal Locations: {[l['name'] for l in locations]}")
if not isinstance(warehouses, dict):
    print(f"  Warehouses: {[w['name'] for w in warehouses]}")
print(f"  Pickings: {results['stock']['picking_count']}")
print(f"  Quants with stock: {results['stock']['quants']}")
if not isinstance(categories, dict):
    print(f"  Categories ({len(categories)}): {[c['name'] for c in categories[:15]]}")

# === 8. API INTEGRATIONS ===
print("\n" + "=" * 60)
print("8. API INTEGRATIONS")
print("=" * 60)
server_actions = ekw('ir.actions.server', 'search_read', [[]], {'fields': ['id', 'name', 'state', 'model_id'], 'limit': 50})
crons = ekw('ir.cron', 'search_read', [[]], {'fields': ['id', 'name', 'active', 'interval_number', 'interval_type', 'model_id'], 'limit': 30})
results['integrations'] = {
    'server_actions': server_actions if not isinstance(server_actions, dict) else [],
    'crons': crons if not isinstance(crons, dict) else []
}
if not isinstance(server_actions, dict):
    print(f"  Server Actions ({len(server_actions)}):")
    for a in server_actions:
        mid = a.get('model_id', '')
        print(f"    ID={a['id']}  {a['name']}  model={mid}")
if not isinstance(crons, dict):
    print(f"  Cron Jobs ({len(crons)}):")
    for c in crons:
        print(f"    ID={c['id']}  {c['name']}  active={c['active']}  interval={c['interval_number']}{c['interval_type']}")

# === 9. DELIVERY ===
print("\n" + "=" * 60)
print("9. ENTREGA / DELIVERY")
print("=" * 60)
carriers = ekw('delivery.carrier', 'search_read', [[]], {'fields': ['id', 'name', 'delivery_type'], 'limit': 10})
te_fields = ekw('ir.model.fields', 'search_read', [[['model', '=', 'account.move'], ['name', 'like', 'x_studio_te%']]], {'fields': ['name', 'field_description', 'ttype'], 'limit': 10})
deliveries = ekw('stock.picking', 'search_count', [[['picking_type_code', '=', 'outgoing']]])
results['delivery'] = {
    'carriers': carriers if not isinstance(carriers, dict) else [],
    'te_fields': te_fields if not isinstance(te_fields, dict) else [],
    'deliveries': deliveries if not isinstance(deliveries, dict) else 0
}
if not isinstance(carriers, dict):
    print(f"  Carriers: {[(c['name'], c['delivery_type']) for c in carriers]}")
if not isinstance(te_fields, dict):
    print(f"  TudoEntregue fields: {[f['name'] for f in te_fields]}")
print(f"  Outgoing pickings: {results['delivery']['deliveries']}")

# === 10. USERS ===
print("\n" + "=" * 60)
print("10. USERS")
print("=" * 60)
users = ekw('res.users', 'search_read', [[['active', '=', True]]], {'fields': ['id', 'name', 'login', 'share'], 'limit': 30})
results['users'] = users if not isinstance(users, dict) else []
if not isinstance(users, dict):
    print(f"  Active users ({len(users)}):")
    for u in users:
        print(f"    ID={u['id']}  {u['name']}  login={u['login']}  portal={u.get('share', False)}")

# === 11. COMPANY INFO ===
print("\n" + "=" * 60)
print("11. COMPANY / EMITENTE")
print("=" * 60)
companies = ekw('res.company', 'search_read', [[]], {'fields': ['id', 'name', 'vat', 'street', 'city', 'state_id', 'country_id', 'phone', 'email'], 'limit': 5})
results['company'] = companies if not isinstance(companies, dict) else []
if not isinstance(companies, dict):
    for c in companies:
        print(f"  {c['name']}  CNPJ={c.get('vat','')}  {c.get('street','')} {c.get('city','')}")

# Save
with open('/home/z/my-project/scripts/odoo_investigation.json', 'w') as f:
    json.dump(results, f, ensure_ascii=False, indent=2, default=str)
print("\n\nResults saved to /home/z/my-project/scripts/odoo_investigation.json")
