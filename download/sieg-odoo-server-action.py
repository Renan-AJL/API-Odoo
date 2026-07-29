===================================================================================================
ODOO SERVER ACTION v3 — "Emitir NF" no account.move
LÊ IMPOSTOS DIRETAMENTE DA FATURA (account.move.line com tax_ids / tax_line_id)
===================================================================================================

CRIAR:
  1. Odoo > Configurações > Técnico > Server Actions > Criar novo
  2. Nome: "Emitir NF SIEG"
  3. Modelo: Journal Entry (account.move)
  4. Tipo de Ação: Executar código Python
  5. Colar o código abaixo

CAMPOS CUSTOMIZADOS NO account.move (criar antes):
  x_nfe_chave      | Char    | Chave NF-e (44 dígitos)
  x_nfe_status     | Char    | Status emissão
  x_nfe_protocolo  | Char    | Protocolo SEFAZ
  x_nfse_numero    | Char    | Número NFS-e
  x_nfse_status    | Char    | Status NFS-e

CAMPOS CUSTOMIZADOS NO product.product (para NFS-e):
  x_c_trib_nac     | Char    | Código tributação nacional
  x_c_nbs          | Char    | Código NBS
  x_aliquota_iss   Float   | Alíquota ISSQN (%)

CAMPOS CUSTOMIZADOS NO res.company / res.partner:
  x_ibge_code      | Char    | Código IBGE município (7 dígitos)
  x_c_int_contrib  | Char    | Código intérprete contribuinte (NFS-e)

===================================================================================================

### CÓDIGO ###

import json
import re
import urllib.request
import urllib.error
import datetime

MIDDLEWARE_URL = 'https://odoo-api-tudoentregue.onrender.com'
API_KEY = 'sua-chave-aqui'

# ===================== HELPERS =====================

def only_num(s):
    return re.sub(r'\D', '', s or '')

def safe_float(val, default=0.0):
    try:
        return float(val) if val else default
    except (ValueError, TypeError):
        return default

def safe_str(val):
    return str(val).strip() if val else ''

UF_TABLE = {
    'ACRE':'AC','ALAGOAS':'AL','AMAPÁ':'AP','AMAZONAS':'AM','BAHIA':'BA',
    'CEARÁ':'CE','DISTRITO FEDERAL':'DF','ESPÍRITO SANTO':'ES','GOIÁS':'GO',
    'MARANHÃO':'MA','MATO GROSSO':'MT','MATO GROSSO DO SUL':'MS','MINAS GERAIS':'MG',
    'PARÁ':'PA','PARAÍBA':'PB','PARANÁ':'PR','PERNAMBUCO':'PE','PIAUÍ':'PI',
    'RIO DE JANEIRO':'RJ','RIO GRANDE DO NORTE':'RN','RIO GRANDE DO SUL':'RS',
    'RONDÔNIA':'RO','RORAIMA':'RR','SANTA CATARINA':'SC','SÃO PAULO':'SP',
    'SERGIPE':'SE','TOCANTINS':'TO',
}

def get_uf_code(state_id):
    if not state_id:
        return ''
    name = safe_str(state_id.name).upper()
    # Tenta direto se ja for sigla (2 letras)
    if len(name) == 2 and name.isalpha():
        return name
    return UF_TABLE.get(name, '')

IBGE_UF_TABLE = {
    'AC':'12','AL':'27','AM':'13','AP':'16','BA':'29','CE':'23','DF':'53','ES':'32',
    'GO':'52','MA':'21','MG':'31','MS':'50','MT':'51','PA':'15','PB':'25','PE':'26',
    'PI':'22','PR':'41','RJ':'33','RN':'24','RO':'11','RR':'14','RS':'43','SC':'42',
    'SE':'28','SP':'35','TO':'17',
}

def get_ibge_uf(uf):
    return IBGE_UF_TABLE.get((uf or '').upper(), '')

def get_ibge_city(obj):
    if hasattr(obj, 'x_ibge_code') and obj.x_ibge_code:
        return safe_str(obj.x_ibge_code)
    if getattr(obj, 'city_id', None) and hasattr(obj.city_id, 'ibge_code') and obj.city_id.ibge_code:
        return safe_str(obj.city_id.ibge_code)
    return ''

def get_cnpj(obj):
    c = getattr(obj, 'cnpj_cpf', '') or ''
    if not c:
        c = getattr(obj, 'l10n_br_cnpj_cpf', '') or ''
    if not c and hasattr(obj, 'vat'):
        c = obj.vat or ''
    return only_num(c)

def get_ie(obj):
    ie = getattr(obj, 'inscr_est', '') or ''
    if not ie:
        ie = getattr(obj, 'l10n_br_ie', '') or ''
    return re.sub(r'\D', '', ie)

# ===================== EXTRAÇÃO DE IMPOSTOS DA FATURA =====================

def get_tax_info_from_lines(invoice_lines):
    """
    Extrai informações fiscais DAS LINHAS DA FATURA (account.move.line).
    
    Estratégia (em ordem de prioridade):
    1. fiscal_line_ids (l10n_br_fiscal) — campos completos de ICMS/PIS/COFINS
    2. Campos diretos do account.move.line do l10n_br (sem fiscal_line_ids)
    3. tax_ids nas linhas + tax_line_id nas linhas de imposto agrupadas
    4. Valores calculados a partir das tax_lines agrupadas por tipo
    """
    result = []
    for line in invoice_lines:
        info = extract_line_taxes(line)
        result.append(info)
    return result

def extract_line_taxes(line):
    """Extrai todos os dados fiscais de uma única linha de fatura."""
    tax_data = {
        'csosn': '', 'cst_icms': '', 'orig': '0', 'mod_bc': '',
        'vbc_icms': 0.0, 'vicms': 0.0, 'picms': 0.0,
        'cst_pis': '', 'vbc_pis': 0.0, 'vpis': 0.0, 'pis_aliquota': 0.0,
        'cst_cofins': '', 'vbc_cofins': 0.0, 'vcofins': 0.0, 'cofins_aliquota': 0.0,
        'cfop': '5102',
    }
    
    # === ESTRATÉGIA 1: fiscal_line_ids (l10n_br_fiscal completo) ===
    fl_ids = getattr(line, 'fiscal_line_ids', None)
    if fl_ids:
        fl = fl_ids[0]  # primeira linha fiscal
        
        # --- ICMS / CSOSN ---
        csosn_field = getattr(fl, 'icms_csosn_id', None)
        if csosn_field:
            tax_data['csosn'] = safe_str(getattr(csosn_field, 'code', ''))
        cst_field = getattr(fl, 'icms_cst_id', None)
        if cst_field and not tax_data['csosn']:
            tax_data['cst_icms'] = safe_str(getattr(cst_field, 'code', ''))
        
        # --- Origem e Modalidade BC ---
        tax_data['orig'] = safe_str(getattr(fl, 'icms_origin', '')) or '0'
        tax_data['mod_bc'] = safe_str(getattr(fl, 'icms_base_type', ''))
        
        # --- Valores ICMS ---
        tax_data['vbc_icms'] = safe_float(getattr(fl, 'icms_base', 0))
        tax_data['vicms'] = safe_float(getattr(fl, 'icms_value', 0))
        tax_data['picms'] = safe_float(getattr(fl, 'icms_percent', 0))
        
        # --- PIS ---
        pis_cst = getattr(fl, 'pis_cst_id', None)
        if pis_cst:
            tax_data['cst_pis'] = safe_str(getattr(pis_cst, 'code', ''))
        tax_data['vbc_pis'] = safe_float(getattr(fl, 'pis_base', 0))
        tax_data['vpis'] = safe_float(getattr(fl, 'pis_value', 0))
        tax_data['pis_aliquota'] = safe_float(getattr(fl, 'pis_percent', 0))
        
        # --- COFINS ---
        cof_cst = getattr(fl, 'cofins_cst_id', None)
        if cof_cst:
            tax_data['cst_cofins'] = safe_str(getattr(cof_cst, 'code', ''))
        tax_data['vbc_cofins'] = safe_float(getattr(fl, 'cofins_base', 0))
        tax_data['vcofins'] = safe_float(getattr(fl, 'cofins_value', 0))
        tax_data['cofins_aliquota'] = safe_float(getattr(fl, 'cofins_percent', 0))
        
        # --- CFOP ---
        cfop_field = getattr(fl, 'cfop_id', None)
        if cfop_field:
            tax_data['cfop'] = safe_str(getattr(cfop_field, 'code', ''))
        
        return tax_data
    
    # === ESTRATÉGIA 2: campos diretos no account.move.line (l10n_br) ===
    # Alguns módulos l10n_br gravam ICMS/PIS/COFINS direto na move line
    br_fields_icms = ['icms_base', 'icms_value', 'icms_percent', 'icms_cst',
                      'icms_csosn', 'icms_origin', 'icms_base_type']
    has_br_fields = any(hasattr(line, f) and getattr(line, f, None) for f in br_fields_icms)
    
    if has_br_fields:
        csosn_val = safe_str(getattr(line, 'icms_csosn', ''))
        if csosn_val:
            tax_data['csosn'] = csosn_val
        else:
            tax_data['cst_icms'] = safe_str(getattr(line, 'icms_cst', ''))
        tax_data['orig'] = safe_str(getattr(line, 'icms_origin', '')) or '0'
        tax_data['mod_bc'] = safe_str(getattr(line, 'icms_base_type', ''))
        tax_data['vbc_icms'] = safe_float(getattr(line, 'icms_base', 0))
        tax_data['vicms'] = safe_float(getattr(line, 'icms_value', 0))
        tax_data['picms'] = safe_float(getattr(line, 'icms_percent', 0))
        
        tax_data['cst_pis'] = safe_str(getattr(line, 'pis_cst', '')) or '01'
        tax_data['vbc_pis'] = safe_float(getattr(line, 'pis_base', 0))
        tax_data['vpis'] = safe_float(getattr(line, 'pis_value', 0))
        tax_data['pis_aliquota'] = safe_float(getattr(line, 'pis_percent', 0))
        
        tax_data['cst_cofins'] = safe_str(getattr(line, 'cofins_cst', '')) or '01'
        tax_data['vbc_cofins'] = safe_float(getattr(line, 'cofins_base', 0))
        tax_data['vcofins'] = safe_float(getattr(line, 'cofins_value', 0))
        tax_data['cofins_aliquota'] = safe_float(getattr(line, 'cofins_percent', 0))
        
        cfop_val = safe_str(getattr(line, 'cfop', ''))
        if cfop_val:
            tax_data['cfop'] = cfop_val
        
        return tax_data
    
    # === ESTRATÉGIA 3: tax_ids da linha + tax lines agrupadas ===
    # Pega as taxas aplicadas na linha de produto
    tax_ids = getattr(line, 'tax_ids', None)
    if tax_ids:
        tax_data = _extract_from_tax_ids(tax_ids, tax_data)
    
    # === ESTRATÉGIA 4: buscar tax lines irmãs (linhas tipo 'tax' da mesma fatura) ===
    # As tax lines em Odoo tem display_type='tax' e tax_line_id apontando pra account.tax
    # Mas para ratear por produto, precisamos usar o tax_compute json ou as tags
    # Tentamos encontrar pelo grupo de imposto
    if not any([tax_data['vicms'], tax_data['vpis'], tax_data['vcofins']]):
        tax_data = _extract_from_grouped_tax_lines(line, tax_data)
    
    # Se ainda nao achou nada, aplicar padrao Simples Nacional
    if not tax_data['csosn'] and not tax_data['cst_icms']:
        tax_data['csosn'] = '103'
    if not tax_data['cst_pis']:
        tax_data['cst_pis'] = '01'
    if not tax_data['cst_cofins']:
        tax_data['cst_cofins'] = '01'
    
    return tax_data

def _extract_from_tax_ids(tax_ids, tax_data):
    """
    Lê os account.tax vinculados à linha para extrair alíquotas e classificação.
    O account.tax no Odoo brasileiro tem campos como:
      - name, amount (percentual)
      - tax_group_id (ICMS, PIS, COFINS, ISSQN...)
      - l10n_br_cst_code, domain (icms, pis, cofins...)
    """
    for tax in tax_ids:
        tax_name = safe_str(getattr(tax, 'name', '')).upper()
        amount = safe_float(getattr(tax, 'amount', 0))
        tax_group = getattr(tax, 'tax_group_id', None)
        group_name = safe_str(getattr(tax_group, 'name', '')).upper() if tax_group else ''
        
        # Tenta ler CST/CSOSN do campo l10n_br do tax
        cst_code = safe_str(getattr(tax, 'l10n_br_cst_code', ''))
        domain = safe_str(getattr(tax, 'domain', ''))
        
        # Classificar por grupo/domínio
        if 'ICMS' in group_name or domain == 'icms':
            if cst_code:
                if cst_code.startswith('1') or cst_code.startswith('2') or cst_code.startswith('3'):
                    if len(cst_code) >= 3 and cst_code[0] in ('1','2','3'):
                        tax_data['csosn'] = cst_code
                    else:
                        tax_data['cst_icms'] = cst_code
            tax_data['picms'] = amount
            tax_data['vbc_icms'] = 0  # será calculado depois
            tax_data['vicms'] = 0     # será calculado depois
        elif 'PIS' in group_name or domain == 'pis':
            if cst_code:
                tax_data['cst_pis'] = cst_code
            tax_data['pis_aliquota'] = amount
        elif 'COFINS' in group_name or domain == 'cofins':
            if cst_code:
                tax_data['cst_cofins'] = cst_code
            tax_data['cofins_aliquota'] = amount
    
    return tax_data

def _extract_from_grouped_tax_lines(product_line, tax_data):
    """
    Busca as linhas de imposto (display_type='tax') da mesma fatura
    e tenta ratear os valores por linha de produto usando proporção.
    
    No Odoo padrão, as tax lines são agrupadas por imposto (uma linha PIS total,
    uma linha COFINS total, etc.) — não por linha de produto.
    
    Esta função identifica o imposto pelo tax_group_id e rateia proporcionalmente
    ao price_subtotal da linha de produto vs total da fatura.
    """
    move = product_line.move_id
    if not move:
        return tax_data
    
    # Buscar todas as tax lines da fatura
    all_tax_lines = move.line_ids.filtered(lambda l: l.display_type == 'tax' and l.tax_line_id)
    if not all_tax_lines:
        return tax_data
    
    # Total dos produtos para rateio
    all_product_lines = move.line_ids.filtered(
        lambda l: l.display_type == 'product' and l.product_id
    )
    total_products = sum(safe_float(l.price_subtotal) for l in all_product_lines)
    
    if total_products <= 0:
        return tax_data
    
    line_subtotal = safe_float(product_line.price_subtotal)
    ratio = line_subtotal / total_products if total_products > 0 else 0
    
    # Agrupar tax lines por grupo de imposto
    for tl in all_tax_lines:
        tl_tax = tl.tax_line_id
        if not tl_tax:
            continue
        
        tax_group = getattr(tl_tax, 'tax_group_id', None)
        group_name = safe_str(getattr(tax_group, 'name', '')).upper() if tax_group else ''
        tax_amount = safe_float(tl.credit) - safe_float(tl.debit)  # valor líquido do imposto
        tax_percent = safe_float(getattr(tl_tax, 'amount', 0))
        cst_code = safe_str(getattr(tl_tax, 'l10n_br_cst_code', ''))
        domain = safe_str(getattr(tl_tax, 'domain', ''))
        
        # Ratear por linha de produto
        rated_amount = round(abs(tax_amount) * ratio, 2)
        rated_base = round(line_subtotal, 2)  # base ≈ subtotal da linha
        
        if 'ICMS' in group_name or domain == 'icms':
            if cst_code:
                if len(cst_code) >= 3:
                    tax_data['csosn'] = cst_code
                else:
                    tax_data['cst_icms'] = cst_code
            tax_data['vbc_icms'] = rated_base
            tax_data['vicms'] = rated_amount
            tax_data['picms'] = tax_percent
        elif 'PIS' in group_name or domain == 'pis':
            if cst_code:
                tax_data['cst_pis'] = cst_code
            tax_data['vbc_pis'] = rated_base
            tax_data['vpis'] = rated_amount
            tax_data['pis_aliquota'] = tax_percent
        elif 'COFINS' in group_name or domain == 'cofins':
            if cst_code:
                tax_data['cst_cofins'] = cst_code
            tax_data['vbc_cofins'] = rated_base
            tax_data['vcofins'] = rated_amount
            tax_data['cofins_aliquota'] = tax_percent
    
    return tax_data

# ===================== INÍCIO DA AÇÃO =====================

# === VALIDAÇÕES ===
if record.move_type != 'out_invoice':
    raise UserError('Ação disponível apenas para faturas de cliente (saída)!')
if not record.partner_id:
    raise UserError('Fatura sem cliente definido!')

# Linhas de produto da fatura
invoice_lines = record.line_ids.filtered(
    lambda l: l.display_type == 'product' and l.product_id
)
if not invoice_lines:
    raise UserError('Fatura sem linhas de produto/serviço!')

# === AUTO-DETECT NF-e vs NFS-e ===
all_service = all(
    l.product_id.detailed_type == 'service' or getattr(l.product_id, 'type', '') == 'service'
    for l in invoice_lines
)
tipo_nf = 'nfse' if all_service else 'nfe'

company = record.company_id
partner = record.partner_id
company_uf = get_uf_code(company.state_id)
partner_uf = get_uf_code(partner.state_id)

# === COMPANY (EMITENTE) ===
company_data = {
    'cnpj_cpf': get_cnpj(company),
    'legal_name': (getattr(company, 'legal_name', '') or company.name or '').upper(),
    'name': company.name or '',
    'street': (company.street or '').strip(),
    'number': getattr(company, 'street_number', '') or getattr(company, 'l10n_br_number', '') or 'S/N',
    'street2': (company.street2 or getattr(company, 'district', '') or '').strip(),
    'city': (company.city or '').strip(),
    'city_ibge_code': get_ibge_city(company),
    'state': company_uf,
    'state_ibge': get_ibge_uf(company_uf),
    'zip': only_num(company.zip or ''),
    'phone': only_num(company.phone or company.mobile or ''),
    'inscr_est': get_ie(company),
    'inscr_mun': only_num(getattr(company, 'inscr_mun', '') or ''),
    'email': company.email or '',
    'crt': str(getattr(company, 'tax_framework', '1')),
    'op_simp_nac': '3',
    'reg_ap_trib_sn': '1',
}

# === PARTNER (DESTINATÁRIO) ===
partner_data = {
    'cnpj_cpf': get_cnpj(partner),
    'legal_name': (getattr(partner, 'legal_name', '') or partner.name or '').upper(),
    'street': (partner.street or '').strip(),
    'number': getattr(partner, 'street_number', '') or getattr(partner, 'l10n_br_number', '') or 'S/N',
    'street2': (partner.street2 or getattr(partner, 'district', '') or '').strip(),
    'city': (partner.city or '').strip(),
    'city_ibge_code': get_ibge_city(partner),
    'state': partner_uf,
    'zip': only_num(partner.zip or ''),
    'phone': only_num(partner.phone or partner.mobile or ''),
    'inscr_est': get_ie(partner),
    'email': partner.email or '',
}

# === FORMA DE PAGAMENTO ===
payment_mode = getattr(record, 'payment_mode_id', None)
tPag = '15'
if payment_mode:
    pm_name = safe_str(payment_mode.name).upper()
    if 'PIX' in pm_name:
        tPag = '65'
    elif 'CARTAO' in pm_name or 'CREDIT' in pm_name or 'CARD' in pm_name:
        tPag = '03'
    elif 'DINHEIRO' in pm_name or 'CASH' in pm_name:
        tPag = '01'
    elif 'BOLETO' in pm_name:
        tPag = '15'

# === EXTRAIR IMPOSTOS DE CADA LINHA DA FATURA ===
tax_info_list = get_tax_info_from_lines(invoice_lines)

# === MONTAR LINHAS COM IMPOSTOS ===
lines_data = []
for idx, line in enumerate(invoice_lines):
    p = line.product_id
    is_svc = p.detailed_type == 'service' or getattr(p, 'type', '') == 'service'
    ncm = ''
    if hasattr(p, 'ncm_id') and p.ncm_id:
        ncm = safe_str(p.ncm_id.code)
    elif hasattr(p, 'l10n_br_ncm_id') and p.l10n_br_ncm_id:
        ncm = safe_str(p.l10n_br_ncm_id.code)
    
    tax = tax_info_list[idx] if idx < len(tax_info_list) else {}
    
    lines_data.append({
        'default_code': p.default_code or '',
        'product_name': line.name or p.name or '',
        'barcode': p.barcode or 'SEM GTIN',
        'ncm': ncm,
        'cfop': tax.get('cfop', '5102'),
        'uom': (p.uom_id.name or 'UN').upper()[:3],
        'qty': line.quantity,
        'price_unit': line.price_unit,
        'price_subtotal': line.price_subtotal,
        'detailed_type': 'service' if is_svc else 'product',
        # --- Impostos reais da fatura ---
        'csosn': tax.get('csosn', ''),
        'cst_icms': tax.get('cst_icms', ''),
        'orig': tax.get('orig', '0'),
        'mod_bc': tax.get('mod_bc', ''),
        'vbc_icms': tax.get('vbc_icms', 0),
        'vicms': tax.get('vicms', 0),
        'picms': tax.get('picms', 0),
        'cst_pis': tax.get('cst_pis', '01'),
        'vbc_pis': tax.get('vbc_pis', 0),
        'pis_aliquota': tax.get('pis_aliquota', 0),
        'vpis': tax.get('vpis', 0),
        'cst_cofins': tax.get('cst_cofins', '01'),
        'vbc_cofins': tax.get('vbc_cofins', 0),
        'cofins_aliquota': tax.get('cofins_aliquota', 0),
        'vcofins': tax.get('vcofins', 0),
    })

# === DUPLICATAS E PAGAMENTOS ===
duplicatas = []
pagamentos = []
data_base = record.invoice_date or datetime.date.today()

pt = record.invoice_payment_term_id
if pt and pt.line_ids:
    n_parcelas = len(pt.line_ids)
    valor_parcela = round(record.amount_total / n_parcelas, 2)
    for idx_pt, ptl in enumerate(pt.line_ids):
        dias = ptl.days or 30
        data_venc = data_base + datetime.timedelta(days=dias)
        vDup = valor_parcela if idx_pt < n_parcelas - 1 else round(record.amount_total - valor_parcela * (n_parcelas - 1), 2)
        duplicatas.append({'dVenc': data_venc.strftime('%Y-%m-%d'), 'vDup': vDup})
        pagamentos.append({'tPag': tPag, 'vPag': vDup})
else:
    duplicatas.append({'dVenc': data_base.strftime('%Y-%m-%d'), 'vDup': record.amount_total})
    pagamentos.append({'tPag': tPag, 'vPag': record.amount_total})

# === SERVIÇO (NFS-e) ===
service_data = None
if tipo_nf == 'nfse' and invoice_lines:
    p0 = invoice_lines[0].product_id
    service_data = {
        'cTribNac': getattr(p0, 'x_c_trib_nac', '') or '140101',
        'xDescServ': invoice_lines[0].name or p0.name or '',
        'cNBS': getattr(p0, 'x_c_nbs', '') or '999999999',
        'cIntContrib': getattr(company, 'x_c_int_contrib', '') or '',
        'pAliq': str(getattr(p0, 'x_aliquota_iss', 2.0) or 2.0),
        'pTotTribFed': '13.45',
        'pTotTribEst': '0.00',
        'pTotTribMun': '3.29',
    }

# === MONTAR PAYLOAD ===
dt_invoice = record.invoice_date
if hasattr(dt_invoice, 'strftime'):
    dt_str = dt_invoice.strftime('%Y-%m-%dT%H:%M:%S-03:00')
else:
    dt_str = str(dt_invoice)[:10] + 'T12:00:00-03:00'

payload = {
    'tipo': tipo_nf,
    'company': company_data,
    'partner': partner_data,
    'order': {
        'id': record.id,
        'name': record.name,
        'number': re.sub(r'\D', '', record.name) or str(record.id),
        'date_order': dt_str,
        'amount_total': record.amount_total,
        'note': record.narration or '',
    },
    'lines': lines_data,
    'duplicatas': duplicatas,
    'pagamentos': pagamentos,
    'config': {
        'natOp': 'Venda de Mercadoria' if tipo_nf == 'nfe' else 'Prestação de Serviço',
        'serie': '100' if tipo_nf == 'nfe' else '1',
        'modFrete': '9',
    },
}
if service_data:
    payload['service'] = service_data

# === ENVIAR AO MIDDLEWARE ===
url = MIDDLEWARE_URL + '/api/v1/sieg/emitir'
headers = {'Content-Type': 'application/json', 'X-API-Key': API_KEY}

req = urllib.request.Request(
    url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST',
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    
    if result.get('sucesso'):
        tipo = result.get('tipo', tipo_nf)
        resp_data = result.get('resposta_sieg', {})
        vals = {}
        msg_lines = ['NF %s emitida com sucesso!' % tipo.upper()]
        
        if tipo == 'nfe':
            chave = resp_data.get('chNFe') or resp_data.get('chave') or ''
            protocolo = resp_data.get('nProt') or resp_data.get('protocolo') or ''
            status = resp_data.get('xMotivo') or resp_data.get('motivo') or 'Processado'
            vals['x_nfe_chave'] = chave
            vals['x_nfe_status'] = status
            vals['x_nfe_protocolo'] = protocolo
            msg_lines.append('Chave: %s' % chave)
            msg_lines.append('Protocolo: %s' % protocolo)
            msg_lines.append('Status: %s' % status)
        else:
            numero = resp_data.get('nDFSe') or resp_data.get('numero') or ''
            vals['x_nfse_numero'] = numero
            vals['x_nfse_status'] = 'Autorizada'
            msg_lines.append('Numero: %s' % numero)
        
        pdf_b64 = result.get('pdf_base64')
        if pdf_b64:
            tipo_label = 'DANFE' if tipo == 'nfe' else 'DANFSE'
            env['ir.attachment'].create({
                'name': '%s-%s.pdf' % (tipo_label, record.name),
                'res_model': 'account.move',
                'res_id': record.id,
                'datas': pdf_b64,
                'mimetype': 'application/pdf',
            })
            msg_lines.append('%s anexado a fatura!' % tipo_label)
        
        record.write(vals)
        raise UserError('\n'.join(msg_lines))
    else:
        erro = result.get('erro', 'Erro desconhecido')
        detalhes = result.get('detalhes', '')
        if isinstance(detalhes, dict):
            detalhes = json.dumps(detalhes, ensure_ascii=False)
        raise UserError('Erro na emissão: %s\n%s' % (erro, detalhes))

except urllib.error.HTTPError as e:
    body = ''
    try:
        body = e.read().decode('utf-8')
    except:
        pass
    raise UserError('Erro HTTP %d do middleware:\n%s' % (e.code, body))
except UserError:
    raise
except Exception as e:
    raise UserError('Erro ao emitir NF: %s' % str(e))

### FIM DO CÓDIGO ###
===================================================================================================

BOTÃO NO FORMULÁRIO (XML de view — instalar via módulo customizado):

  <?xml version="1.0" encoding="utf-8"?>
  <odoo>
    <record id="view_move_form_nfe_sieg" model="ir.ui.view">
      <field name="name">account.move.form.nfe.sieg</field>
      <field name="model">account.move</field>
      <field name="inherit_id" ref="account.view_move_form"/>
      <field name="arch" type="xml">
        <xpath expr="//div[@name='button_box']" position="inside">
          <button name="%(action_emitir_nf_sieg)d" string="NF"
                  type="action" class="oe_highlight"
                  icon="fa-file-text-o"
                  invisible="move_type != 'out_invoice'"/>
        </xpath>
      </field>
    </record>
  </odoo>

VISUALIZAR CAMPOS DE NF NO FORMULÁRIO DA FATURA (opcional):

  <?xml version="1.0" encoding="utf-8"?>
  <odoo>
    <record id="view_move_form_nfe_fields" model="ir.ui.view">
      <field name="name">account.move.form.nfe.fields</field>
      <field name="model">account.move</field>
      <field name="inherit_id" ref="account.view_move_form"/>
      <field name="arch" type="xml">
        <xpath expr="//page[@name='other_info']" position="inside">
          <group string="Dados NF-e / NFS-e (SIEG)">
            <field name="x_nfe_chave"/>
            <field name="x_nfe_status"/>
            <field name="x_nfe_protocolo"/>
            <field name="x_nfse_numero"/>
            <field name="x_nfse_status"/>
          </group>
        </xpath>
      </field>
    </record>
  </odoo>

===================================================================================================