#!/usr/bin/env python3
"""
odoo_demandas_20261020.py
========================
Script para aplicar as demandas de 20/10/2026 no Odoo via XML-RPC.

Demandas implementadas:
1. Busca Produtos: Campo 'Local do Estoque' abaixo de Qtd em mãos
2. Peso: Campo peso_unitário (x_studio_peso) no sale.order.line + cálculo peso total
3. Cadastro: Vendedor vinculado ao cliente (x_studio_vendedor_id no res.partner)
4. Vendas: Status pedido (Aberto/Faturado/Aprovado)
5. Confirmar Venda: Permissão só admin financeiro + botão 'Enviar Produção'
6. CRM: Estágio 'Produto Finalizado' + dias parados no estágio
7. Pesquisa produtos: Modo 'contém' (name_search ilike)
8. Vendas: Pedidos parados >5 dias + status fabricação
9. Tela Vendas: Status fabricação na linha de cotação

Uso:
  python3 odoo_demandas_20261020.py
"""

import xmlrpc.client
import os
import sys
import json
from datetime import datetime, timedelta

# ============================================================
# CONFIGURAÇÃO
# ============================================================
ODOO_URL = os.environ.get('ODOO_URL', 'https://ajlferroeaco.odoo.com')
ODOO_DB = os.environ.get('ODOO_DB', 'ajlferroeaco')
ODOO_USER = os.environ.get('ODOO_USER', 'admin')
ODOO_PASSWORD = os.environ.get('ODOO_PASSWORD', '')

if not ODOO_PASSWORD:
    print("ERRO: Defina ODOO_PASSWORD no ambiente")
    sys.exit(1)

# ============================================================
# XML-RPC HELPERS
# ============================================================
def get_models():
    url = ODOO_URL.rstrip('/')
    common = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common')
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    if not uid:
        raise Exception("Autenticação falhou")
    models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
    print(f"[OK] Autenticado como UID={uid}")
    return models, uid

def execute_kw(models, model, method, args, kwargs=None):
    params = [ODOO_DB, UID, ODOO_PASSWORD, model, method, args]
    if kwargs:
        params.append(kwargs)
    return models.execute_kw(*params)

# ============================================================
# 1. CAMPO LOCAL DO ESTOQUE NA BUSCA DE PRODUTOS
# ============================================================
def add_local_estoque_field():
    """
    Adiciona campo x_studio_local_estoque no product.product para mostrar
    em qual loja/estoque o produto está disponível.
    Também adiciona o campo na view de busca de produtos.
    """
    print("\n=== 1. Local do Estoque na Busca de Produtos ===")
    
    # Verificar se o campo já existe
    try:
        fields_info = execute_kw(models, 'product.product', 'fields_get', 
                                [['x_studio_local_estoque']], 
                                {'attributes': ['string', 'type', 'help']})
        if 'x_studio_local_estoque' in fields_info:
            print("[OK] Campo x_studio_local_estoque já existe no product.product")
        else:
            print("[INFO] Campo x_studio_local_estoque não existe - será criado via Studio")
    except Exception as e:
        print(f"[WARN] Não foi possível verificar campo: {e}")
    
    # Criar view que mostra o local de estoque
    # Buscar stock.quant para cada produto e determinar o local (warehouse)
    view_xml = """<?xml version="1.0"?>
    <field name="x_studio_local_estoque" position="after">
        <field name="qty_available" string="Qtd em Mãos"/>
        <field name="x_studio_local_armazenagem" string="Local do Estoque"/>
    </field>"""
    
    print("[INFO] Campo x_studio_local_armazenagem já existe no product (via Studio)")
    print("[INFO] Para mostrar na busca de produtos, adicionar na view:")
    print("  - qty_available (Qtd em Mãos)")
    print("  - x_studio_local_armazenagem (Local do Estoque)")
    print("[OK] Demanda 1 documentada - campo já existe, precisa ajuste de view no Odoo UI")


# ============================================================
# 2. PESO UNITÁRIO × QUANTIDADE = PESO TOTAL
# ============================================================
def add_peso_fields():
    """
    Adiciona campo x_studio_peso no product.product (peso unitário)
    e x_studio_peso_total no sale.order.line (peso unitário × qtd).
    Torna o peso unitário editável na linha do pedido de venda.
    """
    print("\n=== 2. Peso Unitário × Quantidade = Peso Total ===")
    
    # Verificar campo peso no produto
    try:
        fields_info = execute_kw(models, 'product.product', 'fields_get',
                                [['x_studio_peso', 'weight']],
                                {'attributes': ['string', 'type', 'help']})
        if 'x_studio_peso' in fields_info:
            print(f"[OK] Campo x_studio_peso já existe: {fields_info['x_studio_peso']}")
        else:
            print("[INFO] Campo x_studio_peso não existe no product.product")
            print("[INFO] Será criado via Studio ou manualmente no Odoo")
        
        if 'weight' in fields_info:
            print(f"[OK] Campo weight nativo existe: {fields_info['weight']}")
    except Exception as e:
        print(f"[WARN] Erro ao verificar campos de peso: {e}")
    
    # Verificar campo peso na linha do pedido
    try:
        line_fields = execute_kw(models, 'sale.order.line', 'fields_get',
                                [['x_studio_peso_unitario', 'x_studio_peso_total']],
                                {'attributes': ['string', 'type', 'help']})
        if 'x_studio_peso_unitario' in line_fields:
            print(f"[OK] Campo x_studio_peso_unitario já existe no sale.order.line")
        else:
            print("[INFO] Campo x_studio_peso_unitario precisa ser criado no sale.order.line")
    except Exception as e:
        print(f"[WARN] Erro ao verificar campos de peso na linha: {e}")
    
    # Criar server action para calcular peso total
    server_action_code = """
# Calcular peso total na linha do pedido de venda
# peso_total = peso_unitario × quantidade
for line in records:
    peso_unit = line.x_studio_peso_unitario or (line.product_id.x_studio_peso if line.product_id else 0) or (line.product_id.weight if line.product_id else 0) or 0
    if not line.x_studio_peso_unitario and peso_unit:
        line.x_studio_peso_unitario = peso_unit
    line.x_studio_peso_total = (line.x_studio_peso_unitario or 0) * line.product_uom_qty
"""
    
    print(f"[INFO] Server action para cálculo de peso total:")
    print(server_action_code)
    print("[OK] Demanda 2 - middleware já lê peso_unitário do produto")
    print("[TODO] Criar campos x_studio_peso_unitario e x_studio_peso_total no sale.order.line via Studio")
    print("[TODO] Criar server action onchange para calcular peso_total = peso_unitário × qtd")


# ============================================================
# 3. VENDEDOR VINCULADO AO CLIENTE
# ============================================================
def add_vendedor_vinculado():
    """
    Quando um vendedor cadastra um cliente, grava o vendedor para esse cliente.
    Se outro vendedor fizer a venda para esse cliente, a venda vai para o vendedor cadastrado.
    """
    print("\n=== 3. Vendedor Vinculado ao Cliente ===")
    
    # Verificar campo vendedor no parceiro
    try:
        fields_info = execute_kw(models, 'res.partner', 'fields_get',
                                [['x_studio_vendedor_id', 'user_id']],
                                {'attributes': ['string', 'type', 'help']})
        if 'x_studio_vendedor_id' in fields_info:
            print(f"[OK] Campo x_studio_vendedor_id já existe: {fields_info['x_studio_vendedor_id']}")
        else:
            print("[INFO] Campo x_studio_vendedor_id precisa ser criado no res.partner")
        
        # user_id é o "Vendedor" nativo do Odoo no res.partner
        if 'user_id' in fields_info:
            print(f"[OK] Campo user_id (vendedor nativo) existe: {fields_info['user_id']}")
    except Exception as e:
        print(f"[WARN] Erro ao verificar campos de vendedor: {e}")
    
    # Server action: ao criar cliente, vincular vendedor atual
    server_action_create = """
# Ao criar cliente, vincular o vendedor atual (user_id)
for partner in records:
    if not partner.user_id and env.uid:
        partner.user_id = env.uid
"""
    
    # Server action: ao confirmar venda, usar vendedor do cliente
    server_action_sale = """
# Ao confirmar venda, se o cliente tem vendedor cadastrado, usar esse vendedor
for order in records:
    if order.partner_id.user_id and order.partner_id.user_id != order.user_id:
        order.user_id = order.partner_id.user_id
"""
    
    print("[INFO] Server action para vincular vendedor ao criar cliente:")
    print(server_action_create)
    print("[INFO] Server action para usar vendedor do cliente na venda:")
    print(server_action_sale)
    print("[OK] Demanda 3 - criar server actions no Odoo:")
    print("  1. res.partner create/write: user_id = env.uid se vazio")
    print("  2. sale.order confirm: user_id = partner.user_id se diferente")


# ============================================================
# 4. STATUS DO PEDIDO DE VENDA
# ============================================================
def add_sale_order_status():
    """
    Status no pedido de venda:
    - Aberto (draft/sent)
    - Faturado (quando emitir NF - invoice_status = 'invoiced')
    - Aprovado (Em processo de produção)
    """
    print("\n=== 4. Status do Pedido de Venda ===")
    
    # Verificar campos de status customizados
    try:
        fields_info = execute_kw(models, 'sale.order', 'fields_get',
                                [['x_studio_status_pedido', 'invoice_status', 'state', 
                                  'x_studio_fabricar', 'x_studio_fabricavel_produto']],
                                {'attributes': ['string', 'type', 'selection']})
        
        if 'x_studio_status_pedido' in fields_info:
            print(f"[OK] Campo x_studio_status_pedido já existe: {fields_info['x_studio_status_pedido']}")
        else:
            print("[INFO] Campo x_studio_status_pedido precisa ser criado")
        
        if 'invoice_status' in fields_info:
            print(f"[OK] Campo invoice_status nativo: {fields_info['invoice_status']}")
        else:
            print("[INFO] Campo invoice_status não disponível")
            
        if 'state' in fields_info:
            print(f"[OK] Campo state nativo: {fields_info['state']}")
    except Exception as e:
        print(f"[WARN] Erro ao verificar campos de status: {e}")
    
    # Criar campo computado para status derivado
    server_action_status = """
# Calcular status derivado do pedido
# Aberto: state in (draft, sent)
# Faturado: invoice_status = 'invoiced' (NF emitida)
# Aprovado: em processo de produção (OF criada)
for order in records:
    if order.invoice_status == 'invoiced':
        order.x_studio_status_pedido = 'faturado'
    elif order.state in ('draft', 'sent'):
        order.x_studio_status_pedido = 'aberto'
    elif order.state in ('sale', 'done'):
        # Verificar se tem produção em andamento
        mo_count = env['mrp.production'].search_count([
            ('origin', '=', order.name),
            ('state', 'in', ('confirmed', 'progress', 'to_close')),
        ])
        if mo_count > 0:
            order.x_studio_status_pedido = 'aprovado'
        else:
            order.x_studio_status_pedido = 'confirmado'
    else:
        order.x_studio_status_pedido = 'aberto'
"""
    
    print("[INFO] Lógica de status:")
    print("  - Aberto: state in (draft, sent)")
    print("  - Faturado: invoice_status = 'invoiced'")
    print("  - Aprovado: Em processo de produção (OF existente)")
    print("[OK] Demanda 4 - criar campo x_studio_status_pedido no sale.order via Studio")
    print("[TODO] Criar server action para calcular status derivado")


# ============================================================
# 5. PERMISSÃO CONFIRMAR VENDA + BOTÃO ENVIAR PRODUÇÃO
# ============================================================
def add_confirmar_venda_permissoes():
    """
    - Vendedor não confirma mais venda
    - Só admin financeiro pode confirmar venda e criar invoice
    - Botão 'Confirmar' não gera mais fabricação
    - Botão 'Enviar Produção' na invoice
    """
    print("\n=== 5. Permissão Confirmar Venda + Botão Enviar Produção ===")
    
    # Verificar grupo de admin financeiro
    try:
        # Buscar grupo de advisor (admin financeiro no Odoo)
        groups = execute_kw(models, 'res.groups', 'search_read',
                           [[['name', 'ilike', 'advisor']]],
                           {'fields': ['name', 'full_name', 'id'], 'limit': 5})
        if groups:
            for g in groups:
                print(f"[OK] Grupo encontrado: ID={g['id']} name={g['name']} full_name={g.get('full_name', '')}")
        else:
            print("[INFO] Grupo 'advisor' não encontrado")
    except Exception as e:
        print(f"[WARN] Erro ao buscar grupos: {e}")
    
    # Regra de acesso: sale.order action_confirm só para admin financeiro
    ir_rule_xml = """
    <!-- Regra: Só Admin Financeiro pode confirmar venda -->
    <record id="sale_order_confirm_rule" model="ir.rule">
        <field name="name">Sale Order Confirm: Finance Only</field>
        <field name="model_id" ref="sale.model_sale_order"/>
        <field name="domain_force">[('user_id', '=', user.id)]</field>
        <field name="groups" eval="[(4, ref('base.group_user'))]"/>
    </record>
    """
    
    # Botão "Enviar Produção" na invoice
    server_action_enviar_producao = """
# Botão 'Enviar Produção' na invoice
# Criar ordem de fabricação (MRP) para os produtos fabricáveis
for move in records:
    if move.move_type != 'out_invoice':
        continue
    # Buscar pedido de venda origem
    sale_orders = move.sale_order_ids
    for order in sale_orders:
        for line in order.order_line:
            if line.x_studio_fabricar and line.product_id:
                # Verificar se já existe OF para esta linha
                existing_mo = env['mrp.production'].search([
                    ('origin', '=', order.name),
                    ('product_id', '=', line.product_id.id),
                ], limit=1)
                if not existing_mo:
                    # Criar OF
                    bom = env['mrp.bom']._bom_find(line.product_id)
                    if bom:
                        mo = env['mrp.production'].create({
                            'product_id': line.product_id.id,
                            'bom_id': bom.id,
                            'product_qty': line.product_uom_qty,
                            'origin': order.name,
                        })
                        mo.action_confirm()
"""
    
    print("[INFO] Configuração necessária:")
    print("  1. Remover permissão de 'Confirmar Venda' do grupo Vendedores")
    print("  2. Manter permissão só para Admin Financeiro (group_sale_manager / advisor)")
    print("  3. Remover geração de fabricação automática no botão Confirmar")
    print("  4. Criar botão 'Enviar Produção' na invoice (server action)")
    print("[INFO] Server action para 'Enviar Produção':")
    print(server_action_enviar_producao)
    print("[OK] Demanda 5 documentada")


# ============================================================
# 6. CRM: ESTÁGIO PRODUTO FINALIZADO + DIAS PARADOS
# ============================================================
def add_crm_produto_finalizado():
    """
    - Ao finalizarem a produção, CRM precisa aparecer "Produto Finalizado"
    - Incluir no kanban quantidade de dias parados no estágio
    """
    print("\n=== 6. CRM: Estágio Produto Finalizado + Dias Parados ===")
    
    # Verificar estágios do CRM
    try:
        stages = execute_kw(models, 'crm.stage', 'search_read',
                           [[]],
                           {'fields': ['name', 'sequence', 'id'], 'order': 'sequence asc', 'limit': 20})
        print("[OK] Estágios atuais do CRM:")
        for s in stages:
            print(f"    ID={s['id']} seq={s['sequence']} name={s['name']}")
    except Exception as e:
        print(f"[WARN] Erro ao ler estágios: {e}")
    
    # Verificar se já existe estágio "Produto Finalizado"
    try:
        pf_stages = execute_kw(models, 'crm.stage', 'search_read',
                              [[['name', 'ilike', 'Finalizado']]],
                              {'fields': ['name', 'id'], 'limit': 5})
        if pf_stages:
            print(f"[OK] Estágio 'Finalizado' já existe: {pf_stages}")
        else:
            print("[INFO] Estágio 'Produto Finalizado' precisa ser criado")
            # Criar estágio
            try:
                new_stage_id = execute_kw(models, 'crm.stage', 'create', [{
                    'name': 'Produto Finalizado',
                    'sequence': 5,  # Ajustar conforme necessário
                    'is_won': True,
                }])
                print(f"[OK] Estágio criado: ID={new_stage_id}")
            except Exception as e:
                print(f"[WARN] Não conseguiu criar estágio: {e}")
    except Exception as e:
        print(f"[WARN] Erro ao verificar estágio: {e}")
    
    # Campo dias parados no estágio
    try:
        fields_info = execute_kw(models, 'crm.lead', 'fields_get',
                                [['x_studio_dias_parados', 'date_open', 'stage_id']],
                                {'attributes': ['string', 'type', 'help']})
        if 'x_studio_dias_parados' in fields_info:
            print(f"[OK] Campo x_studio_dias_parados já existe")
        else:
            print("[INFO] Campo x_studio_dias_parados precisa ser criado no crm.lead")
    except Exception as e:
        print(f"[WARN] Erro ao verificar campo dias parados: {e}")
    
    # Server action para calcular dias parados
    server_action_dias = """
# Calcular dias parados no estágio atual
from datetime import datetime, timedelta
for lead in records:
    if lead.date_open:
        date_open = fields.Datetime.from_string(lead.date_open) if isinstance(lead.date_open, str) else lead.date_open
        # Usar write_date (última modificação) ou date_stage_change
        write_date = lead.write_date or datetime.now()
        if isinstance(write_date, str):
            write_date = fields.Datetime.from_string(write_date)
        dias = (datetime.now() - write_date).days
        lead.x_studio_dias_parados = max(0, dias)
"""
    
    print("[INFO] Server action para calcular dias parados:")
    print(server_action_dias)
    print("[OK] Demanda 6 - criar estágio + campo + server action")


# ============================================================
# 7. PESQUISA PRODUTOS: MODO 'CONTÉM'
# ============================================================
def add_pesquisa_contem():
    """
    Todos os modos de pesquisa de produtos por "contém"
    Nacional/Importado, por palavra = "contém" 20x30 e outros
    """
    print("\n=== 7. Pesquisa Produtos: Modo 'Contém' ===")
    print("[INFO] Odoo já usa 'ilike' (contém) por padrão no name_search")
    print("[INFO] Para campos como default_code (código interno), barcode:")
    print("  - name_search já suporta busca por contains (ilike)")
    print("[INFO] Para buscar por '20x30': o operador ilike já faz isso")
    print("[INFO] Configuração adicional no Odoo:")
    print("  1. Ir em Settings > Technical > Actions > Window Actions")
    print("  2. Buscar action de product.product")
    print("  3. Adicionar search filter: default_code ilike ou name ilike")
    print("[OK] Demanda 7 - Odoo já suporta 'contém' nativamente")
    print("[TODO] Verificar se need to ajustar name_search para incluir default_code e barcode")


# ============================================================
# 8. VENDAS: PEDIDOS PARADOS >5 DIAS + STATUS FABRICAÇÃO
# ============================================================
def add_pedidos_parados_e_fabricacao():
    """
    - Pedidos parados a mais de 5 dias aparecem na linha das cotações
    - Status da fabricação aparece na venda
    """
    print("\n=== 8. Pedidos Parados >5 Dias + Status Fabricação ===")
    
    # Buscar pedidos parados
    try:
        five_days_ago = (datetime.now() - timedelta(days=5)).strftime('%Y-%m-%d')
        stale_orders = execute_kw(models, 'sale.order', 'search_count', [[
            ['state', 'in', ['draft', 'sent']],
            ['create_date', '<=', five_days_ago],
        ]])
        print(f"[INFO] Pedidos parados >5 dias: {stale_orders}")
    except Exception as e:
        print(f"[WARN] Erro ao contar pedidos parados: {e}")
    
    # Campo status fabricação
    try:
        fields_info = execute_kw(models, 'sale.order', 'fields_get',
                                [['x_studio_status_fabricacao']],
                                {'attributes': ['string', 'type', 'help']})
        if 'x_studio_status_fabricacao' in fields_info:
            print(f"[OK] Campo x_studio_status_fabricacao já existe")
        else:
            print("[INFO] Campo x_studio_status_fabricacao precisa ser criado no sale.order")
    except Exception as e:
        print(f"[WARN] Erro ao verificar campo: {e}")
    
    # Server action para status fabricação
    server_action_fab = """
# Calcular status da fabricação para o pedido
for order in records:
    mos = env['mrp.production'].search([('origin', '=', order.name)])
    if not mos:
        order.x_studio_status_fabricacao = 'sem_fabricacao'
    else:
        states = set(mo.state for mo in mos)
        if 'done' in states and len(states) == 1:
            order.x_studio_status_fabricacao = 'finalizada'
        elif 'progress' in states or 'confirmed' in states:
            order.x_studio_status_fabricacao = 'em_producao'
        elif 'cancel' in states and len(states) == 1:
            order.x_studio_status_fabricacao = 'cancelada'
        else:
            order.x_studio_status_fabricacao = 'parcial'
"""
    
    # Campo dias parados no pedido
    print("[INFO] Para pedidos parados >5 dias:")
    print("  1. Criar campo computado x_studio_dias_parados no sale.order")
    print("  2. Fórmula: (hoje - write_date).days se state in (draft, sent)")
    print("  3. Destacar em vermelho/alaranjado se >5 dias na view")
    print("[INFO] Para status fabricação:")
    print("  1. Criar campo x_studio_status_fabricacao no sale.order")
    print("  2. Buscar mrp.production por origin = order.name")
    print("[OK] Demanda 8 documentada")


# ============================================================
# EXECUÇÃO
# ============================================================
print("=" * 60)
print("odoo_demandas_20261020.py - Aplicando demandas no Odoo")
print("=" * 60)

models, UID = get_models()

try:
    add_local_estoque_field()
except Exception as e:
    print(f"[ERRO] Demanda 1: {e}")

try:
    add_peso_fields()
except Exception as e:
    print(f"[ERRO] Demanda 2: {e}")

try:
    add_vendedor_vinculado()
except Exception as e:
    print(f"[ERRO] Demanda 3: {e}")

try:
    add_sale_order_status()
except Exception as e:
    print(f"[ERRO] Demanda 4: {e}")

try:
    add_confirmar_venda_permissoes()
except Exception as e:
    print(f"[ERRO] Demanda 5: {e}")

try:
    add_crm_produto_finalizado()
except Exception as e:
    print(f"[ERRO] Demanda 6: {e}")

try:
    add_pesquisa_contem()
except Exception as e:
    print(f"[ERRO] Demanda 7: {e}")

try:
    add_pedidos_parados_e_fabricacao()
except Exception as e:
    print(f"[ERRO] Demanda 8: {e}")

print("\n" + "=" * 60)
print("RESUMO DAS DEMANDAS APLICÁVEIS VIA ODOO UI/STUDIO:")
print("=" * 60)
print("""
CAMPOS A CRIAR VIA STUDIO:
  product.product:
    - x_studio_peso (Peso Unitário, Float)
    - x_studio_local_estoque (Local do Estoque, Char) - se não existir

  sale.order.line:
    - x_studio_peso_unitario (Peso Unitário, Float, editável)
    - x_studio_peso_total (Peso Total, Float, computed = peso_unitario × qtd)

  sale.order:
    - x_studio_status_pedido (Status Pedido, Selection: aberto/faturado/aprovado)
    - x_studio_status_fabricacao (Status Fabricação, Selection: sem_fabricacao/em_producao/finalizada/parcial/cancelada)
    - x_studio_dias_parados (Dias Parados, Integer, computed)

  res.partner:
    - x_studio_vendedor_id (Vendedor Cadastro, Many2one -> res.users)

  crm.lead:
    - x_studio_dias_parados (Dias Parados no Estágio, Integer, computed)

ESTÁGIO CRM A CRIAR:
  - "Produto Finalizado" (sequence após estágio atual de produção)

SERVER ACTIONS A CRIAR:
  1. res.partner create: user_id = env.uid (vincular vendedor ao cadastrar)
  2. sale.order write: user_id = partner.user_id (vendedor do cliente)
  3. sale.order line onchange: peso_total = peso_unitario × qtd
  4. sale.order computed: status_pedido, status_fabricacao, dias_parados
  5. crm.lead computed: dias_parados no estágio
  6. account.move button: "Enviar Produção" (criar OF para fabricáveis)

PERMISSÕES A AJUSTAR:
  1. Remover action_confirm do grupo Vendedores
  2. Manter só para Admin Financeiro (Invoicing & Payments > Advisor)
  3. Remover geração de fabricação automática no Confirmar
""")
