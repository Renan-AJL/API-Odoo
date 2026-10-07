#!/usr/bin/env python3
"""
Generate Odoo Validation Checklist Excel for AJL
"""
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, numbers
from openpyxl.utils import get_column_letter
import json
from datetime import datetime

# Load investigation data
with open('/home/z/my-project/scripts/odoo_investigation.json', 'r') as f:
    data = json.load(f)

wb = openpyxl.Workbook()

# === STYLES ===
DARK_BLUE = "1F3864"
MED_BLUE = "2E75B6"
LIGHT_BLUE = "D6E4F0"
LIGHT_GREEN = "E2EFDA"
LIGHT_YELLOW = "FFF2CC"
LIGHT_RED = "FCE4EC"
LIGHT_GRAY = "F2F2F2"
WHITE = "FFFFFF"
GREEN = "548235"
RED = "C00000"
ORANGE = "ED7D31"

title_font = Font(name='Calibri', size=14, bold=True, color=WHITE)
title_fill = PatternFill(start_color=DARK_BLUE, end_color=DARK_BLUE, fill_type='solid')
header_font = Font(name='Calibri', size=11, bold=True, color=WHITE)
header_fill = PatternFill(start_color=MED_BLUE, end_color=MED_BLUE, fill_type='solid')
section_font = Font(name='Calibri', size=11, bold=True, color=DARK_BLUE)
section_fill = PatternFill(start_color=LIGHT_BLUE, end_color=LIGHT_BLUE, fill_type='solid')
normal_font = Font(name='Calibri', size=10)
bold_font = Font(name='Calibri', size=10, bold=True)
check_font = Font(name='Calibri', size=12, bold=True, color=GREEN)
center_align = Alignment(horizontal='center', vertical='center', wrap_text=True)
left_align = Alignment(horizontal='left', vertical='center', wrap_text=True)
thin_border = Border(
    left=Side(style='thin', color='B4B4B4'),
    right=Side(style='thin', color='B4B4B4'),
    top=Side(style='thin', color='B4B4B4'),
    bottom=Side(style='thin', color='B4B4B4')
)

green_fill = PatternFill(start_color=LIGHT_GREEN, end_color=LIGHT_GREEN, fill_type='solid')
yellow_fill = PatternFill(start_color=LIGHT_YELLOW, end_color=LIGHT_YELLOW, fill_type='solid')
red_fill = PatternFill(start_color=LIGHT_RED, end_color=LIGHT_RED, fill_type='solid')
gray_fill = PatternFill(start_color=LIGHT_GRAY, end_color=LIGHT_GRAY, fill_type='solid')
white_fill = PatternFill(start_color=WHITE, end_color=WHITE, fill_type='solid')

def style_cell(ws, row, col, value, font=normal_font, fill=white_fill, align=left_align):
    cell = ws.cell(row=row, column=col, value=value)
    cell.font = font
    cell.fill = fill
    cell.alignment = align
    cell.border = thin_border
    return cell

def add_section_row(ws, row, title, cols=7):
    for c in range(1, cols+1):
        style_cell(ws, row, c, title if c == 1 else '', section_font, section_fill)
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=cols)

def add_data_row(ws, row, processo, configurado, detalhes, prioridade='', check='', obs='', fill=white_fill):
    style_cell(ws, row, 1, processo, bold_font, fill)
    # Configurado with color
    cfg_fill = green_fill if 'Sim' in str(configurado) else (yellow_fill if 'Parcial' in str(configurado) else (red_fill if 'Não' in str(configurado) else fill))
    style_cell(ws, row, 2, configurado, bold_font, cfg_fill, center_align)
    style_cell(ws, row, 3, detalhes, normal_font, fill)
    prio_fill = red_fill if prioridade == 'Alta' else (yellow_fill if prioridade == 'Média' else fill)
    style_cell(ws, row, 4, prioridade, bold_font, prio_fill, center_align)
    style_cell(ws, row, 5, check, check_font, fill, center_align)
    style_cell(ws, row, 6, obs, normal_font, fill)
    style_cell(ws, row, 7, '', normal_font, fill)  # Responsável

# ============================================================
# SHEET 1: Visão Geral
# ============================================================
ws1 = wb.active
ws1.title = "Visão Geral"
ws1.sheet_properties.tabColor = DARK_BLUE

# Title
ws1.merge_cells('A1:G1')
style_cell(ws1, 1, 1, 'AJL FERRO E ACO — Levantamento e Validação dos Processos Odoo', title_font, title_fill, center_align)
ws1.row_dimensions[1].height = 40
ws1.merge_cells('A2:G2')
style_cell(ws1, 2, 1, f'Gerado em: {datetime.now().strftime("%d/%m/%Y %H:%M")} | Odoo SaaS 19.3 | Empresa: AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA (22.603.750/0001-90)', 
    Font(name='Calibri', size=9, italic=True, color="666666"), gray_fill, center_align)

# Headers
row = 4
headers = ['Processo / Item', 'Configurado?', 'Detalhes / Dados Odoo', 'Prioridade', '✓ Check Renan', 'Observações', 'Responsável']
for i, h in enumerate(headers, 1):
    style_cell(ws1, row, i, h, header_font, header_fill, center_align)
ws1.row_dimensions[row].height = 28

# Column widths
ws1.column_dimensions['A'].width = 42
ws1.column_dimensions['B'].width = 14
ws1.column_dimensions['C'].width = 55
ws1.column_dimensions['D'].width = 12
ws1.column_dimensions['E'].width = 14
ws1.column_dimensions['F'].width = 30
ws1.column_dimensions['G'].width = 18

row = 5

# === CRM ===
add_section_row(ws1, row, '1. CRM — Gestão de Leads e Oportunidades'); row += 1
crm = data.get('crm', {})
stages_list = [s['name'] for s in crm.get('stages', [])] if not isinstance(crm.get('stages'), dict) else []
add_data_row(ws1, row, 'Pipeline CRM (Estágios)', 'Sim', f'10 estágios: {", ".join(stages_list)}', '', '', ''); row += 1
add_data_row(ws1, row, 'Equipes de Venda', 'Sim', f'{len(crm.get("teams",[]))} equipes: {", ".join([t["name"] for t in crm.get("teams",[])])}', '', '', ''); row += 1
add_data_row(ws1, row, 'Leads cadastrados', 'Sim', f'{crm.get("leads_count",0)} leads no sistema', '', '', ''); row += 1
add_data_row(ws1, row, 'Oportunidades', 'Sim', f'{crm.get("opps_count",0)} oportunidades ativas', '', '', ''); row += 1
add_data_row(ws1, row, 'Motivos de Perda', 'Parcial' if not crm.get('lost_reasons') else 'Sim', f'{len(crm.get("lost_reasons",[]))} motivos cadastrados', 'Média', '', 'Verificar se motivos de perda estão completos'); row += 1
add_data_row(ws1, row, 'Campos Studio (custom)', 'Sim', f'{len(crm.get("studio_fields",[]))} campos custom (anexos, CNPJ, etc.)', '', '', ''); row += 1
add_data_row(ws1, row, 'Fluxo CRM → Cotação → Venda', 'Parcial', 'Estágios mapeados, verificar se transições automáticas funcionam', 'Alta', '', 'Testar fluxo completo'); row += 1

# === VENDAS ===
add_section_row(ws1, row, '2. Vendas / Pedidos (integrados ao estoque)'); row += 1
sales = data.get('sales', {})
so_states = sales.get('so_states', {})
add_data_row(ws1, row, 'Pedidos de Venda', 'Sim', f'{sales.get("so_count",0)} pedidos (Rascunho: {so_states.get("draft",0)}, Enviado: {so_states.get("sent",0)}, Confirmado: {so_states.get("sale",0)}, Cancelado: {so_states.get("cancel",0)})', '', '', ''); row += 1
add_data_row(ws1, row, 'Listas de Preço', 'Sim', f'{len(sales.get("pricelists",[]))} listas: {", ".join([p["name"] for p in sales.get("pricelists",[])])}', '', '', ''); row += 1
add_data_row(ws1, row, 'Condições de Pagamento', 'Sim', '10 condições (Imediato, 15d, 21d, 30d, 45d, 90d, etc.)', '', '', ''); row += 1
add_data_row(ws1, row, 'Aprovação de Pedidos (senha)', 'Sim', 'Server actions: liberação com OC/assinatura + senha Fabricar', '', '', ''); row += 1
add_data_row(ws1, row, 'Cálculo de Margem (%)', 'Sim', 'Campo x_studio_margem_ + botão Calcular Margem (server action)', '', '', 'Restringir visibilidade por usuário'); row += 1
add_data_row(ws1, row, 'Margem — Restrição de visibilidade', 'Não', 'Campo visível para todos. Restringir para IDs: 2, 6, 716, 7, 5', 'Alta', '', ''); row += 1
add_data_row(ws1, row, 'Local de Armazenagem (linha)', 'Sim', 'Campo x_studio_local_armazenagem na sale.order.line', '', '', ''); row += 1
add_data_row(ws1, row, 'Integração Venda → Estoque', 'Parcial', 'Produtos tipo="consu" (2141), sem tipo="product" (0). Verificar reserva de estoque', 'Alta', '', 'Produtos precisam ser tipo storable?'); row += 1
add_data_row(ws1, row, 'Detector alt/preços', 'Sim', 'x_studio_detector_altprecos (booleano no pedido)', '', '', ''); row += 1
add_data_row(ws1, row, 'Auto-marca Fabricar', 'Sim', 'Server action: marca Fabricar em item fabricável', '', '', ''); row += 1
add_data_row(ws1, row, 'Template de Cotação', 'Parcial', f'{len(sales.get("quot_templates",[]))} templates cadastrados', '', '', ''); row += 1

# === FINANCEIRO ===
add_section_row(ws1, row, '3. Financeiro / Pagamentos / Cotações / Remessa e Faturamento'); row += 1
fin = data.get('finance', {})
add_data_row(ws1, row, 'Faturas de Saída', 'Sim', f'{fin.get("inv_out",0)} faturas (Draft: {fin.get("inv_states",{}).get("draft",0)}, Posted: {fin.get("inv_states",{}).get("posted",0)}, Cancel: {fin.get("inv_states",{}).get("cancel",0)})', '', '', ''); row += 1
add_data_row(ws1, row, 'Faturas de Entrada', 'Sim', f'{fin.get("inv_in",0)} fatura de entrada cadastrada', '', '', ''); row += 1
add_data_row(ws1, row, 'Notas de Crédito', 'Parcial', f'{fin.get("credit_notes",0)} notas de crédito — verificar se fluxo de devolução funciona', 'Média', '', ''); row += 1
add_data_row(ws1, row, 'Pagamentos', 'Sim', f'{fin.get("payments",0)} pagamento registrado', '', '', ''); row += 1
add_data_row(ws1, row, 'Diários Contábeis', 'Sim', f'{len(fin.get("journals",[]))} diários: Vendas, Compras, Banco Itaú', '', '', ''); row += 1
add_data_row(ws1, row, 'Emissão NF-e (SIEG)', 'Sim', f'Pendente: {fin.get("nfe_pend",0)} | Autorizada: {fin.get("nfe_auth",0)} | Erro: {fin.get("nfe_err",0)}', '', '', 'Testar emissão end-to-end'); row += 1
add_data_row(ws1, row, 'NF-e — IPI no DANFE/PDF', 'Sim', 'DANFE local inclui colunas CST IPI, V.IPI, PIPI%', '', '', ''); row += 1
add_data_row(ws1, row, 'NF-e — Nº Pedido no DANFE/PDF', 'Sim', 'Numero do pedido de venda incluído nos dados adicionais', '', '', ''); row += 1
add_data_row(ws1, row, 'NF-e — Boleto (cod barras) no DANFE', 'Sim', 'Código de barras + linha digitável do boleto no DANFE', '', '', ''); row += 1
add_data_row(ws1, row, 'Cancelamento de NF-e', 'Parcial', 'Status "cancelando" mapeado, verificar fluxo completo', 'Alta', '', ''); row += 1
add_data_row(ws1, row, 'Boleto Itaú (emissão)', 'Sim', f'{fin.get("has_boleto",0)} faturas com boleto. Campos: nosso_numero, cod_barras, linha_digitavel', '', '', ''); row += 1
add_data_row(ws1, row, 'Boleto — Cancelar', 'Parcial', 'Botão + server action existem, campo boleto_cancelado criado. Testar!', 'Alta', '', 'Bug reportado pelo usuário'); row += 1
add_data_row(ws1, row, 'PIX Itaú (emissão)', 'Sim', f'{fin.get("has_pix",0)} faturas com PIX. Campo txid + copia_e_cola', '', '', ''); row += 1
add_data_row(ws1, row, 'Forma de Pagamento', 'Sim', 'Campo x_studio_forma_de_pagamento (selection) na fatura', '', '', ''); row += 1
add_data_row(ws1, row, 'Motorista', 'Sim', 'Campo x_studio_motorista na fatura', '', '', ''); row += 1
add_data_row(ws1, row, 'NFSe (Serviços)', 'Parcial', f'Campos nfse_numero/nfse_status existem. Verificar emissão NFS-e via SIEG', 'Média', '', ''); row += 1

# === COMPRAS ===
add_section_row(ws1, row, '4. Compras (produtos e bobinas)'); row += 1
purch = data.get('purchase', {})
add_data_row(ws1, row, 'Pedidos de Compra', 'Sim', f'{purch.get("po_count",0)} PC (Draft: {purch.get("po_states",{}).get("draft",0)})', '', '', ''); row += 1
add_data_row(ws1, row, 'Fornecedores cadastrados', 'Sim', f'{purch.get("vendors",0)} fornecedores ativos', '', '', ''); row += 1
add_data_row(ws1, row, 'Recebimento (incoming picking)', 'Sim', f'{purch.get("receptions",0)} recebimentos registrados', '', '', ''); row += 1
add_data_row(ws1, row, 'Compra → Estoque (integration)', 'Parcial', 'Verificar se PC confirmação gera picking de entrada', 'Alta', '', 'Testar fluxo completo'); row += 1
add_data_row(ws1, row, 'Grupo Bobinas (categoria)', 'Sim', 'Categoria "Grupo Bobinas / Bobinas" existe', '', '', ''); row += 1
add_data_row(ws1, row, 'TudoEntregue (rastreamento compra)', 'Parcial', f'{len(purch.get("studio_fields",[]))} campos TE. Verificar sync automático', 'Média', '', ''); row += 1

# === PRODUÇÃO ===
add_section_row(ws1, row, '5. Produção / Fabricação e Agendamento/Acompanhamento de Entrega'); row += 1
mrp = data.get('mrp', {})
if isinstance(mrp, dict) and 'error' not in mrp:
    add_data_row(ws1, row, 'Ordens de Fabricação (MO)', 'Sim', f'{mrp.get("mo_count",0)} OFs (Draft: {mrp.get("mo_states",{}).get("draft",0)}, Confirmada: {mrp.get("mo_states",{}).get("confirmed",0)}, Done: {mrp.get("mo_states",{}).get("done",0)}, Cancel: {mrp.get("mo_states",{}).get("cancel",0)})', '', '', ''); row += 1
    add_data_row(ws1, row, 'BOMs (Estruturas de Produto)', 'Sim', f'{mrp.get("bom_count",0)} BOMs cadastrados', '', '', ''); row += 1
    add_data_row(ws1, row, 'Centros de Trabalho', 'Parcial', f'{len(mrp.get("workcenters",[]))} centros. Verificar se estão configurados', 'Alta', '', 'Sem centros = sem roteiro de produção'); row += 1
else:
    add_data_row(ws1, row, 'MRP', 'Não', 'Módulo não disponível ou sem acesso', 'Alta', '', ''); row += 1
add_data_row(ws1, row, 'Campo Fabricar (linha do pedido)', 'Sim', 'x_studio_fabricar + x_studio_fabricavel_produto na sale.order.line', '', '', ''); row += 1
add_data_row(ws1, row, 'Auto-criação de OF ao confirmar', 'Sim', 'Server actions: cria OF rascunho, recria ao voltar p/ cotação', '', '', ''); row += 1
add_data_row(ws1, row, 'Bloqueio cancelamento c/ OF em andamento', 'Sim', 'Server action: impede cancelar pedido com OF ativa', '', '', ''); row += 1
add_data_row(ws1, row, 'Assinatura digital (fabricação)', 'Sim', 'Campo x_studio_arquivo_assinado no pedido + server action de guarda', '', '', ''); row += 1
add_data_row(ws1, row, 'Agendamento de Entrega', 'Parcial', 'Verificar se picking de saída é agendado corretamente', 'Média', '', ''); row += 1
add_data_row(ws1, row, 'Acompanhamento de Entrega (TudoEntregue)', 'Parcial', '4 campos TE na fatura. Verificar sync e tracking', 'Média', '', ''); row += 1

# === ESTOQUE ===
add_section_row(ws1, row, '6. Estoque / Inventário'); row += 1
stock = data.get('stock', {})
add_data_row(ws1, row, 'Produtos cadastrados', 'Sim', f'{stock.get("products",0)} variantes / {stock.get("products_tmpl",0)} templates', '', '', ''); row += 1
add_data_row(ws1, row, 'Tipos de produto', 'Parcial', f'Consumível: {stock.get("type_counts",{}).get("consu",0)} | Serviço: {stock.get("type_counts",{}).get("service",0)} | Estocável: {stock.get("type_counts",{}).get("product",0)}', 'Alta', '', 'Nenhum produto estocável! Verificar'); row += 1
add_data_row(ws1, row, 'Rastreamento (Lote/Série)', 'Sim', f'{stock.get("tracking",0)} produtos com tracking', '', '', ''); row += 1
add_data_row(ws1, row, 'Almoxarifados', 'Sim', f'{len(stock.get("warehouses",[]))} almoxarifados: {", ".join([w["name"] for w in stock.get("warehouses",[])])}', '', '', ''); row += 1
add_data_row(ws1, row, 'Localizações internas', 'Sim', f'{len(stock.get("locations",[]))} locais: {", ".join([l["name"] for l in stock.get("locations",[])])}', '', '', ''); row += 1
add_data_row(ws1, row, 'Categorias de Produto', 'Sim', f'{len(stock.get("categories",[]))} categorias (Chapas, Bobinas, Telhas, Perfis, Tubos, Laminados, Acessórios)', '', '', ''); row += 1
add_data_row(ws1, row, 'Quantidades em estoque', 'Parcial', f'{stock.get("quants",0)} quants com saldo. Pickings: {stock.get("pickings",0)} | Moves: {stock.get("stock_moves",0)}', 'Alta', '', 'Poucos quants com saldo — verificar'); row += 1
add_data_row(ws1, row, 'Ajustes de inventário', 'Não', f'{stock.get("inv_adj",0)} ajustes registrados', '', '', ''); row += 1
# CONTAGEM DE ESTOQUE
add_data_row(ws1, row, '🔴 CONTAGEM DE ESTOQUE 16-17/10', 'Não', 'Contagem física programada para 16 e 17 de outubro. Preparar inventário no Odoo!', 'Alta', '', 'Criar stock.inventory para as 4 filiais'); row += 1

# === API ===
add_section_row(ws1, row, '7. Integração de API (Middleware)'); row += 1
add_data_row(ws1, row, 'Middleware API (Render)', 'Sim', 'https://api-odoo-rhzf.onrender.com — Node.js + Express', '', '', ''); row += 1
add_data_row(ws1, row, 'Itaú — Boleto (emissão/cancelamento)', 'Sim', 'mTLS + OAuth2. Bolecode API. Rota /api/v1/itau/cancelar', '', '', ''); row += 1
add_data_row(ws1, row, 'Itaú — PIX (cobrança)', 'Sim', 'PIX API v2. TXID + QR Code + Copia e Cola', '', '', ''); row += 1
add_data_row(ws1, row, 'SIEG — Emissão NF-e/NFS-e', 'Sim', 'OAuth + API Key. Polling automático a cada 30s', '', '', ''); row += 1
add_data_row(ws1, row, 'CNPJá — Consulta IE/CNPJ', 'Sim', 'API Comercial (token configurado). Consulta SINTEGRA', '', '', ''); row += 1
add_data_row(ws1, row, 'Serasa — Verificação CNPJ', 'Parcial', 'Não encontrado no middleware. Verificar integração', 'Alta', '', 'Demandado pelo usuário'); row += 1
add_data_row(ws1, row, 'TudoEntregue — Rastreamento', 'Sim', 'AppKey configurado. Sync manual via botão', '', '', ''); row += 1
add_data_row(ws1, row, 'Aprovação de Boleto via API', 'Parcial', 'Rota /api/v1/itau/cancelar existe. Verificar endpoint de aprovação', 'Alta', '', ''); row += 1
add_data_row(ws1, row, 'DANFE/PDF local (sem SIEG)', 'Sim', 'pdfkit + bwip-js. Layout retrato A4 com IPI, pedido, boleto', '', '', ''); row += 1
add_data_row(ws1, row, 'Odoo Push (webhook retorno)', 'Sim', 'Middleware grava status/chave/protocolo direto no Odoo via XML-RPC', '', '', ''); row += 1

# === ENTREGA ===
add_section_row(ws1, row, '8. Entrega / Logística'); row += 1
deliv = data.get('delivery', {})
add_data_row(ws1, row, 'Carriers (transportadoras)', 'Parcial', f'{len(deliv.get("carriers",[]))} carrier: Standard delivery (fixed). Verificar se TE está como carrier', 'Média', '', ''); row += 1
add_data_row(ws1, row, 'Expedições (outgoing picking)', 'Sim', f'{deliv.get("deliveries",0)} expedições registradas', '', '', ''); row += 1
add_data_row(ws1, row, 'TudoEntregue — Sync e Tracking', 'Parcial', f'{len(deliv.get("te_fields",[]))} campos TE. Verificar automação', 'Média', '', ''); row += 1

# === USUARIOS ===
add_section_row(ws1, row, '9. Usuários e Permissões'); row += 1
users = data.get('users', [])
add_data_row(ws1, row, 'Usuários ativos', 'Sim', f'{len(users)} usuários ativos no sistema', '', '', ''); row += 1
add_data_row(ws1, row, 'Permissões por módulo', 'Parcial', 'Verificar se cada usuário tem acesso correto aos módulos', 'Média', '', 'Auditar permissões'); row += 1

# Freeze pane
ws1.freeze_panes = 'A5'

# ============================================================
# SHEET 2: Contagem Estoque
# ============================================================
ws2 = wb.create_sheet("Contagem Estoque 16-17 Out")
ws2.sheet_properties.tabColor = "548235"

ws2.merge_cells('A1:H1')
style_cell(ws2, 1, 1, 'CONTAGEM DE ESTOQUE — 16 e 17 de Outubro de 2026', title_font, title_fill, center_align)
ws2.row_dimensions[1].height = 40
ws2.merge_cells('A2:H2')
style_cell(ws2, 2, 1, 'AJL Ferro e Aço — Levantamento físico por filial', Font(name='Calibri', size=9, italic=True, color="666666"), gray_fill, center_align)

row2 = 4
h2 = ['Filial', 'CNPJ', 'Localização', 'Produto', 'Código', 'Qtd Sistema', 'Qtd Contagem', 'Diferença']
for i, h in enumerate(h2, 1):
    style_cell(ws2, row2, i, h, header_font, header_fill, center_align)

warehouses_info = [
    ('AJL - Pinhais', '02391982000115', 'Rua Euclides Bandeira 96 - Pinhais'),
    ('AJL - Ponta Grossa', '22603750000352', 'Rua Tijucas do Sul 355 - Ponta Grossa'),
    ('AJL - Ivaiporã', '36524335000156', 'Av Natalino Faust, 302 - Ivaiporã'),
    ('ajlferroeaco (Matriz)', '22603750000190', 'Av Juscelino Kubitschek, 7525 - Curitiba'),
]
for w_name, w_cnpj, w_addr in warehouses_info:
    row2 += 1
    add_section_row(ws2, row2, f'{w_name} — CNPJ: {w_cnpj[:2]}.{w_cnpj[2:5]}.{w_cnpj[5:8]}/{w_cnpj[8:12]}-{w_cnpj[12:14]}', 8)
    row2 += 1
    # Placeholder rows
    for _ in range(3):
        style_cell(ws2, row2, 1, w_name, normal_font)
        style_cell(ws2, row2, 2, w_cnpj, normal_font, fill=white_fill, align=center_align)
        style_cell(ws2, row2, 3, w_addr, normal_font)
        for c in range(4, 9):
            style_cell(ws2, row2, c, '', normal_font)
        row2 += 1

ws2.column_dimensions['A'].width = 22
ws2.column_dimensions['B'].width = 18
ws2.column_dimensions['C'].width = 35
ws2.column_dimensions['D'].width = 30
ws2.column_dimensions['E'].width = 15
ws2.column_dimensions['F'].width = 14
ws2.column_dimensions['G'].width = 14
ws2.column_dimensions['H'].width = 14

# ============================================================
# SHEET 3: Server Actions Detalhe
# ============================================================
ws3 = wb.create_sheet("Server Actions AJL")
ws3.sheet_properties.tabColor = "ED7D31"

ws3.merge_cells('A1:F1')
style_cell(ws3, 1, 1, 'Server Actions Custom AJL — Detalhamento', title_font, title_fill, center_align)
ws3.row_dimensions[1].height = 35

row3 = 3
h3 = ['ID', 'Nome', 'Modelo', 'Status', '✓ Testado?', 'Observações']
for i, h in enumerate(h3, 1):
    style_cell(ws3, row3, i, h, header_font, header_fill, center_align)

ajl_actions = [
    (1410, 'Apaga OF rascunho órfã ao excluir linha (Cotação)', 'sale.order.line'),
    (1412, 'Aprovação: grava Senha de Liberação no pedido', 'approver'),
    (1426, 'Assinatura portal (ação)', 'ir.attachment'),
    (1414, 'Auto-envio Solicitação de Senha', 'approval.request'),
    (1439, 'Auto-marca Fabricar em item fabricável', 'sale.order.line'),
    (1407, 'Base44: libera cancelamento do pedido', 'sale.order'),
    (1406, 'Bloqueio cancelamento c/ OF em andamento', 'sale.order'),
    (1417, 'Detector OC upload', 'crm.lead'),
    (1416, 'Detector assinatura upload', 'sale.order'),
    (1440, 'Guarda Fabricar: fabricável sem estoque não desmarca', 'sale.order.line'),
    (1404, 'Guarda assinatura', 'sale.order'),
    (1413, 'Guarda senha de liberação (só aprovador/admin)', 'sale.order'),
    (1403, 'Liberação da confirmação: OC/assinatura + senha Fabricar', 'sale.order'),
    (1408, 'Recria OFs rascunho ao voltar p/ cotação', 'sale.order'),
    (1415, 'Recusa senha: avisa vendedor', 'approver'),
    (1281, 'Cancelar Boleto (redirect)', 'account.move'),
    (1380, 'Calcular Margem %', 'sale.order'),
]

row3 = 4
for aid, aname, amodel in ajl_actions:
    style_cell(ws3, row3, 1, aid, normal_font, fill=white_fill, align=center_align)
    style_cell(ws3, row3, 2, aname, bold_font)
    style_cell(ws3, row3, 3, amodel, normal_font, fill=white_fill, align=center_align)
    style_cell(ws3, row3, 4, 'Configurado', bold_font, green_fill, center_align)
    style_cell(ws3, row3, 5, '', check_font, fill=white_fill, align=center_align)
    style_cell(ws3, row3, 6, '', normal_font)
    row3 += 1

ws3.column_dimensions['A'].width = 8
ws3.column_dimensions['B'].width = 55
ws3.column_dimensions['C'].width = 20
ws3.column_dimensions['D'].width = 14
ws3.column_dimensions['E'].width = 14
ws3.column_dimensions['F'].width = 35

# ============================================================
# SHEET 4: Campos Custom (Studio)
# ============================================================
ws4 = wb.create_sheet("Campos Studio (Custom)")
ws4.sheet_properties.tabColor = "7030A0"

ws4.merge_cells('A1:F1')
style_cell(ws4, 1, 1, 'Campos Custom (Odoo Studio) — Mapeamento Completo', title_font, title_fill, center_align)
ws4.row_dimensions[1].height = 35

row4 = 3
h4 = ['Modelo', 'Campo', 'Tipo', 'Descrição', 'Em uso?', 'Observações']
for i, h in enumerate(h4, 1):
    style_cell(ws4, row4, i, h, header_font, header_fill, center_align)

studio_models = {
    'account.move': data.get('finance', {}).get('studio_fields', []),
    'sale.order': data.get('sales', {}).get('studio_fields_so', []),
    'sale.order.line': data.get('sales', {}).get('studio_fields_sol', []),
    'crm.lead': data.get('crm', {}).get('studio_fields', []),
    'product.product': data.get('stock', {}).get('studio_fields', []),
    'purchase.order': data.get('purchase', {}).get('studio_fields', []),
}

row4 = 4
for model_name, fields in studio_models.items():
    if not fields or isinstance(fields, dict):
        continue
    add_section_row(ws4, row4, model_name, 6); row4 += 1
    for f in fields:
        style_cell(ws4, row4, 1, model_name, normal_font, gray_fill)
        style_cell(ws4, row4, 2, f['name'], bold_font)
        style_cell(ws4, row4, 3, f['ttype'], normal_font, fill=white_fill, align=center_align)
        style_cell(ws4, row4, 4, f['field_description'], normal_font)
        style_cell(ws4, row4, 5, '', check_font, fill=white_fill, align=center_align)
        style_cell(ws4, row4, 6, '', normal_font)
        row4 += 1

ws4.column_dimensions['A'].width = 20
ws4.column_dimensions['B'].width = 45
ws4.column_dimensions['C'].width = 12
ws4.column_dimensions['D'].width = 35
ws4.column_dimensions['E'].width = 10
ws4.column_dimensions['F'].width = 30

# ============================================================
# SHEET 5: Resumo Executivo
# ============================================================
ws5 = wb.create_sheet("Resumo Executivo")
ws5.sheet_properties.tabColor = "C00000"

ws5.merge_cells('A1:D1')
style_cell(ws5, 1, 1, 'RESUMO EXECUTIVO — Status da Implementação Odoo AJL', title_font, title_fill, center_align)
ws5.row_dimensions[1].height = 40

row5 = 3
# Count statuses
total_items = 0
sim_count = 0
parcial_count = 0
nao_count = 0
for row_obj in ws1.iter_rows(min_row=5, max_row=ws1.max_row, min_col=1, max_col=2):
    val = row_obj[1].value
    if val and val in ('Sim', 'Parcial', 'Não'):
        total_items += 1
        if val == 'Sim': sim_count += 1
        elif val == 'Parcial': parcial_count += 1
        elif val == 'Não': nao_count += 1

items = [
    ('Total de itens validados', total_items, ''),
    ('✅ Configurado (Sim)', sim_count, f'{sim_count/total_items*100:.0f}%' if total_items else ''),
    ('⚠️ Parcial', parcial_count, f'{parcial_count/total_items*100:.0f}%' if total_items else ''),
    ('❌ Não configurado', nao_count, f'{nao_count/total_items*100:.0f}%' if total_items else ''),
    ('', '', ''),
    ('Pedidos de Venda', data.get('sales', {}).get('so_count', 0), ''),
    ('Oportunidades CRM', data.get('crm', {}).get('opps_count', 0), ''),
    ('Produtos', data.get('stock', {}).get('products', 0), ''),
    ('Ordens de Fabricação', data.get('mrp', {}).get('mo_count', 0) if isinstance(data.get('mrp'), dict) else 0, ''),
    ('Faturas Emitidas', data.get('finance', {}).get('inv_out', 0), ''),
    ('Clientes', data.get('partners', {}).get('customers', 0), ''),
    ('Usuários Ativos', len(data.get('users', [])), ''),
    ('Filiais', len(data.get('company', [])), ''),
    ('', '', ''),
    ('PRIORIDADES ALTAS', '', ''),
    ('Contagem de estoque 16-17/10', 'Preparar inventário', ''),
    ('Produtos tipo estocável = 0', 'Verificar se devem ser consu ou product', ''),
    ('Integração Serasa', 'Não encontrado no middleware', ''),
    ('Cancelar Boleto', 'Bug reportado, campo criado, testar', ''),
    ('Margem — restrição de visibilidade', 'Restringir para IDs 2,6,716,7,5', ''),
]

for label, value, pct in items:
    if label == 'PRIORIDADES ALTAS':
        add_section_row(ws5, row5, label, 4); row5 += 1
        continue
    if not label and not value:
        row5 += 1
        continue
    style_cell(ws5, row5, 1, label, bold_font if not pct else normal_font)
    style_cell(ws5, row5, 2, value, bold_font, fill=green_fill if '✅' in str(label) else (yellow_fill if '⚠' in str(label) else (red_fill if '❌' in str(label) else white_fill)), align=center_align)
    style_cell(ws5, row5, 3, pct, bold_font, fill=white_fill, align=center_align)
    row5 += 1

ws5.column_dimensions['A'].width = 40
ws5.column_dimensions['B'].width = 20
ws5.column_dimensions['C'].width = 12
ws5.column_dimensions['D'].width = 20

# Move Resumo to first position
wb.move_sheet(ws5, offset=-4)

# Save
output = '/home/z/my-project/download/AJL_Odoo_Validacao_Processos.xlsx'
wb.save(output)
print(f"Excel saved to: {output}")
