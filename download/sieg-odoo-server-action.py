===================================================================================================
ODOO SERVER ACTION v3 — "Emitir NF" no account.move
LÊ IMPOSTOS DA FATURA + SEQUÊNCIA AUTO-INCREMENTO VIA res.company
Todos os campos usam prefixo x_studio_
===================================================================================================

ONDE COLOCAR:
  1. Odoo > Configurações > Técnico > Server Actions > Criar novo
  2. Nome: "Emitir NF SIEG"
  3. Modelo: Journal Entry (account.move)
  4. Tipo de Ação: Executar código Python
  5. Colar o CÓDIGO abaixo (apenas a seção marcada)

===================================================================================================

### INÍCIO DO CÓDIGO ###

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

IBGE_UF = {
    'AC':'12','AL':'27','AM':'13','AP':'16','BA':'29','CE':'23','DF':'53','ES':'32',
    'GO':'52','MA':'21','MG':'31','MS':'50','MT':'51','PA':'15','PB':'25','PE':'26',
    'PI':'22','PR':'41','RJ':'33','RN':'24','RO':'11','RR':'14','RS':'43','SC':'42',
    'SE':'28','SP':'35','TO':'17',
}

def get_uf(state_id):
    if not state_id:
        return ''
    n = safe_str(state_id.name).upper()
    if len(n) == 2 and n.isalpha():
        return n
    return UF_TABLE.get(n, '')

def get_ibge_city(obj):
    if hasattr(obj, 'x_studio_ibge_code') and obj.x_studio_ibge_code:
        return safe_str(obj.x_studio_ibge_code)
    if hasattr(obj, 'x_ibge_code') and obj.x_ibge_code:
        return safe_str(obj.x_ibge_code)
    cid = getattr(obj, 'city_id', None)
    if cid and hasattr(cid, 'ibge_code') and cid.ibge_code:
        return safe_str(cid.ibge_code)
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

def extract_line_taxes(line):
    """Extrai impostos de uma account.move.line com 3 estratégias."""
    td = {
        'csosn': '', 'cst_icms': '', 'orig': '0', 'mod_bc': '',
        'vbc_icms': 0.0, 'vicms': 0.0, 'picms': 0.0,
        'cst_pis': '', 'vbc_pis': 0.0, 'vpis': 0.0, 'pis_aliquota': 0.0,
        'cst_cofins': '', 'vbc_cofins': 0.0, 'vcofins': 0.0, 'cofins_aliquota': 0.0,
        'cfop': '5102',
    }

    # ESTRATÉGIA 1: fiscal_line_ids (l10n_br_fiscal)
    fl = getattr(line, 'fiscal_line_ids', None)
    if fl:
        f = fl[0]
        cs = getattr(f, 'icms_csosn_id', None)
        if cs:
            td['csosn'] = safe_str(getattr(cs, 'code', ''))
        cst = getattr(f, 'icms_cst_id', None)
        if cst and not td['csosn']:
            td['cst_icms'] = safe_str(getattr(cst, 'code', ''))
        td['orig'] = safe_str(getattr(f, 'icms_origin', '')) or '0'
        td['mod_bc'] = safe_str(getattr(f, 'icms_base_type', ''))
        td['vbc_icms'] = safe_float(getattr(f, 'icms_base', 0))
        td['vicms'] = safe_float(getattr(f, 'icms_value', 0))
        td['picms'] = safe_float(getattr(f, 'icms_percent', 0))
        pc = getattr(f, 'pis_cst_id', None)
        if pc:
            td['cst_pis'] = safe_str(getattr(pc, 'code', ''))
        td['vbc_pis'] = safe_float(getattr(f, 'pis_base', 0))
        td['vpis'] = safe_float(getattr(f, 'pis_value', 0))
        td['pis_aliquota'] = safe_float(getattr(f, 'pis_percent', 0))
        cc = getattr(f, 'cofins_cst_id', None)
        if cc:
            td['cst_cofins'] = safe_str(getattr(cc, 'code', ''))
        td['vbc_cofins'] = safe_float(getattr(f, 'cofins_base', 0))
        td['vcofins'] = safe_float(getattr(f, 'cofins_value', 0))
        td['cofins_aliquota'] = safe_float(getattr(f, 'cofins_percent', 0))
        cfo = getattr(f, 'cfop_id', None)
        if cfo:
            td['cfop'] = safe_str(getattr(cfo, 'code', ''))
        return td

    # ESTRATÉGIA 2: campos diretos na move line (l10n_br)
    br = ['icms_base', 'icms_value', 'icms_percent', 'icms_cst', 'icms_csosn']
    if any(hasattr(line, x) and getattr(line, x, None) for x in br):
        td['csosn'] = safe_str(getattr(line, 'icms_csosn', ''))
        if not td['csosn']:
            td['cst_icms'] = safe_str(getattr(line, 'icms_cst', ''))
        td['orig'] = safe_str(getattr(line, 'icms_origin', '')) or '0'
        td['mod_bc'] = safe_str(getattr(line, 'icms_base_type', ''))
        td['vbc_icms'] = safe_float(getattr(line, 'icms_base', 0))
        td['vicms'] = safe_float(getattr(line, 'icms_value', 0))
        td['picms'] = safe_float(getattr(line, 'icms_percent', 0))
        td['cst_pis'] = safe_str(getattr(line, 'pis_cst', '')) or '01'
        td['vbc_pis'] = safe_float(getattr(line, 'pis_base', 0))
        td['vpis'] = safe_float(getattr(line, 'pis_value', 0))
        td['pis_aliquota'] = safe_float(getattr(line, 'pis_percent', 0))
        td['cst_cofins'] = safe_str(getattr(line, 'cofins_cst', '')) or '01'
        td['vbc_cofins'] = safe_float(getattr(line, 'cofins_base', 0))
        td['vcofins'] = safe_float(getattr(line, 'cofins_value', 0))
        td['cofins_aliquota'] = safe_float(getattr(line, 'cofins_percent', 0))
        cfv = safe_str(getattr(line, 'cfop', ''))
        if cfv:
            td['cfop'] = cfv
        return td

    # ESTRATÉGIA 3: tax_ids + tax lines agrupadas
    tax_ids = getattr(line, 'tax_ids', None)
    if tax_ids:
        for tax in tax_ids:
            gn = getattr(tax, 'tax_group_id', None)
            gname = safe_str(getattr(gn, 'name', '')).upper() if gn else ''
            amt = safe_float(getattr(tax, 'amount', 0))
            ccode = safe_str(getattr(tax, 'l10n_br_cst_code', ''))
            dom = safe_str(getattr(tax, 'domain', ''))
            if 'ICMS' in gname or dom == 'icms':
                if ccode:
                    td['csosn'] = ccode if len(ccode) >= 3 else ''
                    if not td['csosn']:
                        td['cst_icms'] = ccode
                td['picms'] = amt
            elif 'PIS' in gname or dom == 'pis':
                if ccode:
                    td['cst_pis'] = ccode
                td['pis_aliquota'] = amt
            elif 'COFINS' in gname or dom == 'cofins':
                if ccode:
                    td['cst_cofins'] = ccode
                td['cofins_aliquota'] = amt

    # ESTRATÉGIA 4: ratear tax lines da fatura por proporção
    if not any([td['vicms'], td['vpis'], td['vcofins']]):
        move = getattr(line, 'move_id', None)
        if move:
            all_prod = move.line_ids.filtered(lambda l: l.display_type == 'product' and l.product_id)
            all_tax = move.line_ids.filtered(lambda l: l.display_type == 'tax' and l.tax_line_id)
            if all_prod and all_tax:
                total_sub = sum(safe_float(l.price_subtotal) for l in all_prod)
                if total_sub > 0:
                    ratio = safe_float(line.price_subtotal) / total_sub
                    for tl in all_tax:
                        tt = tl.tax_line_id
                        if not tt:
                            continue
                        gn = getattr(tt, 'tax_group_id', None)
                        gname = safe_str(getattr(gn, 'name', '')).upper() if gn else ''
                        tval = abs(safe_float(tl.credit) - safe_float(tl.debit))
                        tpct = safe_float(getattr(tt, 'amount', 0))
                        ccode = safe_str(getattr(tt, 'l10n_br_cst_code', ''))
                        dom = safe_str(getattr(tt, 'domain', ''))
                        ra = round(tval * ratio, 2)
                        rb = round(safe_float(line.price_subtotal), 2)
                        if 'ICMS' in gname or dom == 'icms':
                            if ccode:
                                td['csosn'] = ccode if len(ccode) >= 3 else ''
                                if not td['csosn']:
                                    td['cst_icms'] = ccode
                            td['vbc_icms'] = rb
                            td['vicms'] = ra
                            td['picms'] = tpct
                        elif 'PIS' in gname or dom == 'pis':
                            if ccode:
                                td['cst_pis'] = ccode
                            td['vbc_pis'] = rb
                            td['vpis'] = ra
                            td['pis_aliquota'] = tpct
                        elif 'COFINS' in gname or dom == 'cofins':
                            if ccode:
                                td['cst_cofins'] = ccode
                            td['vbc_cofins'] = rb
                            td['vcofins'] = ra
                            td['cofins_aliquota'] = tpct

    # Padrões se nada encontrado
    if not td['csosn'] and not td['cst_icms']:
        td['csosn'] = '103'
    if not td['cst_pis']:
        td['cst_pis'] = '01'
    if not td['cst_cofins']:
        td['cst_cofins'] = '01'
    return td

# ===================== INÍCIO =====================

def safe_int(val):
    try:
        return int(float(val)) if val else 0
    except (ValueError, TypeError):
        return 0

# VALIDAÇÕES
if record.move_type != 'out_invoice':
    raise UserError('Ação disponível apenas para faturas de cliente (saída)!')
if not record.partner_id:
    raise UserError('Fatura sem cliente definido!')

invoice_lines = record.line_ids.filtered(
    lambda l: l.display_type == 'product' and l.product_id
)
if not invoice_lines:
    raise UserError('Fatura sem linhas de produto/serviço!')

# AUTO-DETECT
all_service = all(
    l.product_id.detailed_type == 'service' or getattr(l.product_id, 'type', '') == 'service'
    for l in invoice_lines
)
tipo_nf = 'nfse' if all_service else 'nfe'

company = record.company_id
partner = record.partner_id
company_uf = get_uf(company.state_id)
partner_uf = get_uf(partner.state_id)

# SEQUÊNCIA: ler da empresa e auto-incrementar
if tipo_nf == 'nfe':
    serie = safe_str(getattr(company, 'x_studio_sieg_serie_nfe', '')) or '100'
    ultimo = safe_int(getattr(company, 'x_studio_sieg_ultimo_nfe', 0))
    n_nf = ultimo + 1
else:
    serie = safe_str(getattr(company, 'x_studio_sieg_serie_nfse', '')) or '1'
    ultimo = safe_int(getattr(company, 'x_studio_sieg_ultimo_nfse', 0))
    n_nf = ultimo + 1

# COMPANY
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
    'state_ibge': IBGE_UF.get(company_uf, ''),
    'zip': only_num(company.zip or ''),
    'phone': only_num(company.phone or company.mobile or ''),
    'inscr_est': get_ie(company),
    'inscr_mun': only_num(getattr(company, 'inscr_mun', '') or ''),
    'email': company.email or '',
    'crt': str(getattr(company, 'tax_framework', '1')),
    'op_simp_nac': '3',
    'reg_ap_trib_sn': '1',
}

# PARTNER
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

# FORMA DE PAGAMENTO
payment_mode = getattr(record, 'payment_mode_id', None)
tPag = '15'
if payment_mode:
    pmn = safe_str(payment_mode.name).upper()
    if 'PIX' in pmn:
        tPag = '65'
    elif 'CARTAO' in pmn or 'CREDIT' in pmn or 'CARD' in pmn:
        tPag = '03'
    elif 'DINHEIRO' in pmn or 'CASH' in pmn:
        tPag = '01'
    elif 'BOLETO' in pmn:
        tPag = '15'

# EXTRAIR IMPOSTOS DE CADA LINHA
tax_info_list = [extract_line_taxes(l) for l in invoice_lines]

# LINHAS
lines_data = []
for idx, line in enumerate(invoice_lines):
    p = line.product_id
    is_svc = p.detailed_type == 'service' or getattr(p, 'type', '') == 'service'
    ncm = ''
    if hasattr(p, 'ncm_id') and p.ncm_id:
        ncm = safe_str(p.ncm_id.code)
    elif hasattr(p, 'l10n_br_ncm_id') and p.l10n_br_ncm_id:
        ncm = safe_str(p.l10n_br_ncm_id.code)
    t = tax_info_list[idx] if idx < len(tax_info_list) else {}
    lines_data.append({
        'default_code': p.default_code or '',
        'product_name': line.name or p.name or '',
        'barcode': p.barcode or 'SEM GTIN',
        'ncm': ncm,
        'cfop': t.get('cfop', '5102'),
        'uom': (p.uom_id.name or 'UN').upper()[:3],
        'qty': line.quantity,
        'price_unit': line.price_unit,
        'price_subtotal': line.price_subtotal,
        'detailed_type': 'service' if is_svc else 'product',
        'csosn': t.get('csosn', ''),
        'cst_icms': t.get('cst_icms', ''),
        'orig': t.get('orig', '0'),
        'mod_bc': t.get('mod_bc', ''),
        'vbc_icms': t.get('vbc_icms', 0),
        'vicms': t.get('vicms', 0),
        'picms': t.get('picms', 0),
        'cst_pis': t.get('cst_pis', '01'),
        'vbc_pis': t.get('vbc_pis', 0),
        'pis_aliquota': t.get('pis_aliquota', 0),
        'vpis': t.get('vpis', 0),
        'cst_cofins': t.get('cst_cofins', '01'),
        'vbc_cofins': t.get('vbc_cofins', 0),
        'cofins_aliquota': t.get('cofins_aliquota', 0),
        'vcofins': t.get('vcofins', 0),
    })

# DUPLICATAS
duplicatas = []
pagamentos = []
data_base = record.invoice_date or datetime.date.today()
pt = record.invoice_payment_term_id
if pt and pt.line_ids:
    np_ = len(pt.line_ids)
    vp = round(record.amount_total / np_, 2)
    for i, ptl in enumerate(pt.line_ids):
        dv = data_base + datetime.timedelta(days=ptl.days or 30)
        vd = vp if i < np_ - 1 else round(record.amount_total - vp * (np_ - 1), 2)
        duplicatas.append({'dVenc': dv.strftime('%Y-%m-%d'), 'vDup': vd})
        pagamentos.append({'tPag': tPag, 'vPag': vd})
else:
    duplicatas.append({'dVenc': data_base.strftime('%Y-%m-%d'), 'vDup': record.amount_total})
    pagamentos.append({'tPag': tPag, 'vPag': record.amount_total})

# SERVIÇO (NFS-e)
service_data = None
if tipo_nf == 'nfse' and invoice_lines:
    p0 = invoice_lines[0].product_id
    service_data = {
        'cTribNac': getattr(p0, 'x_studio_c_trib_nac', '') or '140101',
        'xDescServ': invoice_lines[0].name or p0.name or '',
        'cNBS': getattr(p0, 'x_studio_c_nbs', '') or '999999999',
        'cIntContrib': getattr(company, 'x_c_int_contrib', '') or '',
        'pAliq': str(getattr(p0, 'x_studio_aliquota_iss', 2.0) or 2.0),
        'pTotTribFed': '13.45',
        'pTotTribEst': '0.00',
        'pTotTribMun': '3.29',
    }

# DATA
inv_date = record.invoice_date
if hasattr(inv_date, 'strftime'):
    dt_str = inv_date.strftime('%Y-%m-%dT%H:%M:%S-03:00')
else:
    dt_str = str(inv_date)[:10] + 'T12:00:00-03:00'

# PAYLOAD
payload = {
    'tipo': tipo_nf,
    'company': company_data,
    'partner': partner_data,
    'order': {
        'id': record.id,
        'name': record.name,
        'number': str(n_nf),
        'date_order': dt_str,
        'amount_total': record.amount_total,
        'note': record.narration or '',
    },
    'lines': lines_data,
    'duplicatas': duplicatas,
    'pagamentos': pagamentos,
    'config': {
        'natOp': 'Venda de Mercadoria' if tipo_nf == 'nfe' else 'Prestação de Serviço',
        'serie': serie,
        'modFrete': '9',
    },
}
if service_data:
    payload['service'] = service_data

# ENVIAR
url = MIDDLEWARE_URL + '/api/v1/sieg/emitir'
headers = {'Content-Type': 'application/json', 'X-API-Key': API_KEY}
req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode('utf-8'))

    if result.get('sucesso'):
        tipo = result.get('tipo', tipo_nf)
        rd = result.get('resposta_sieg', {})
        vals = {}
        msg = ['NF %s emitida com sucesso!' % tipo.upper()]

        if tipo == 'nfe':
            chave = rd.get('chNFe') or rd.get('chave') or ''
            protocolo = rd.get('nProt') or rd.get('protocolo') or ''
            status = rd.get('xMotivo') or rd.get('motivo') or 'Processado'
            vals['x_studio_nfe_chave'] = chave
            vals['x_studio_nfe_status'] = status
            vals['x_studio_nfe_protocolo'] = protocolo
            msg.append('Chave: %s' % chave)
            msg.append('Protocolo: %s' % protocolo)
            msg.append('Status: %s' % status)
            # ATUALIZAR SEQUÊNCIA NA EMPRESA (só em caso de sucesso)
            company.write({'x_studio_sieg_ultimo_nfe': n_nf})
        else:
            numero = rd.get('nDFSe') or rd.get('numero') or ''
            vals['x_studio_nfse_numero'] = numero
            vals['x_studio_nfse_status'] = 'Autorizada'
            msg.append('Numero: %s' % numero)
            company.write({'x_studio_sieg_ultimo_nfse': n_nf})

        pdf_b64 = result.get('pdf_base64')
        if pdf_b64:
            label = 'DANFE' if tipo == 'nfe' else 'DANFSE'
            env['ir.attachment'].create({
                'name': '%s-%s.pdf' % (label, record.name),
                'res_model': 'account.move',
                'res_id': record.id,
                'datas': pdf_b64,
                'mimetype': 'application/pdf',
            })
            msg.append('%s anexado a fatura!' % label)

        record.write(vals)
        raise UserError('\n'.join(msg))
    else:
        erro = result.get('erro', 'Erro desconhecido')
        det = result.get('detalhes', '')
        if isinstance(det, dict):
            det = json.dumps(det, ensure_ascii=False)
        raise UserError('Erro na emissão: %s\n%s' % (erro, det))

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