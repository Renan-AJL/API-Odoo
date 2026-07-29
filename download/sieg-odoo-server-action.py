===================================================================================================
ODOO SERVER ACTION — "Emitir NF" (NF-e / NFS-e via SIEG)
===================================================================================================

ONDE COLOCAR:
  1. Odoo > Configurações > Técnico > Server Actions > Criar novo
  2. Nome: "Emitir NF SIEG"
  3. Modelo: Sale Order (sale.order)
  4. Tipo de Ação: Executar código Python
  5. Colar o CÓDIGO abaixo (apenas a seção marcada)

BOTÃO NO FORMULÁRIO:
  Opção A — Marcar "Adicionar no Sidebar" na Server Action
  Opção B — XML na view (ver seção no final deste arquivo)

CAMPOS CUSTOMIZADOS (criar antes no sale.order):
  x_nfe_chave (Char), x_nfe_status (Char), x_nfe_protocolo (Char)
  x_nfse_numero (Char), x_nfse_status (Char)

===================================================================================================

### INÍCIO DO CÓDIGO — colar apenas este bloco no Server Action ###

import json
import re
import urllib.request
import urllib.error
import datetime
import base64

MIDDLEWARE_URL = 'https://odoo-api-tudoentregue.onrender.com'
API_KEY = 'sua-chave-aqui'

def only_num(s):
    return re.sub(r'\D', '', s or '')

def get_uf_code(state_id):
    if not state_id:
        return ''
    name = str(state_id.name or '').strip().upper()
    uf_table = {
        'ACRE':'AC','ALAGOAS':'AL','AMAPÁ':'AP','AMAZONAS':'AM','BAHIA':'BA',
        'CEARÁ':'CE','DISTRITO FEDERAL':'DF','ESPÍRITO SANTO':'ES','GOIÁS':'GO',
        'MARANHÃO':'MA','MATO GROSSO':'MT','MATO GROSSO DO SUL':'MS','MINAS GERAIS':'MG',
        'PARÁ':'PA','PARAÍBA':'PB','PARANÁ':'PR','PERNAMBUCO':'PE','PIAUÍ':'PI',
        'RIO DE JANEIRO':'RJ','RIO GRANDE DO NORTE':'RN','RIO GRANDE DO SUL':'RS',
        'RONDÔNIA':'RO','RORAIMA':'RR','SANTA CATARINA':'SC','SÃO PAULO':'SP',
        'SERGIPE':'SE','TOCANTINS':'TO',
    }
    return uf_table.get(name, '')

def get_ibge_uf(uf):
    table = {
        'AC':'12','AL':'27','AM':'13','AP':'16','BA':'29','CE':'23','DF':'53','ES':'32',
        'GO':'52','MA':'21','MG':'31','MS':'50','MT':'51','PA':'15','PB':'25','PE':'26',
        'PI':'22','PR':'41','RJ':'33','RN':'24','RO':'11','RR':'14','RS':'43','SC':'42',
        'SE':'28','SP':'35','TO':'17',
    }
    return table.get(uf.upper(), '')

def get_ibge_city(partner):
    if hasattr(partner, 'x_ibge_code') and partner.x_ibge_code:
        return str(partner.x_ibge_code)
    if partner.city_id and hasattr(partner.city_id, 'ibge_code') and partner.city_id.ibge_code:
        return str(partner.city_id.ibge_code)
    return ''

def get_partner_cnpj(partner):
    c = getattr(partner, 'cnpj_cpf', '') or ''
    if not c:
        c = getattr(partner, 'l10n_br_cnpj_cpf', '') or ''
    if not c:
        c = partner.vat or ''
    return only_num(c)

def get_partner_ie(partner):
    ie = getattr(partner, 'inscr_est', '') or ''
    if not ie:
        ie = getattr(partner, 'l10n_br_ie', '') or ''
    return re.sub(r'\D', '', ie)

# === VALIDAÇÕES ===
if not record.partner_id:
    raise UserError('Pedido sem cliente definido!')
if record.state not in ('sale', 'done'):
    raise UserError('Pedido deve estar confirmado para emitir NF!')

lines = record.order_line.filtered(lambda l: l.product_id)
if not lines:
    raise UserError('Pedido sem linhas de produto/serviço!')

# === AUTO-DETECT NF-e vs NFS-e ===
all_service = all(
    l.product_id.detailed_type == 'service' or getattr(l.product_id, 'type', '') == 'service'
    for l in lines
)
tipo_nf = 'nfse' if all_service else 'nfe'

company = record.company_id
partner = record.partner_id
company_uf = get_uf_code(company.state_id)

# === COMPANY (EMITENTE) ===
company_data = {
    'cnpj_cpf': get_partner_cnpj(company),
    'legal_name': (getattr(company, 'legal_name', '') or company.name or '').upper(),
    'name': company.name or '',
    'street': (company.street or '').strip(),
    'number': getattr(company, 'street_number', '') or getattr(company, 'l10n_br_number', '') or 'S/N',
    'street2': (company.street2 or getattr(company, 'district', '') or '').strip(),
    'city': (company.city or '').strip(),
    'city_ibge_code': get_ibge_city(company) or getattr(company, 'x_ibge_code', ''),
    'state': company_uf,
    'state_ibge': get_ibge_uf(company_uf),
    'zip': only_num(company.zip or ''),
    'phone': only_num(company.phone or company.mobile or ''),
    'inscr_est': get_partner_ie(company),
    'inscr_mun': only_num(getattr(company, 'inscr_mun', '') or ''),
    'email': company.email or '',
    'crt': str(getattr(company, 'tax_framework', '1')),
    'op_simp_nac': '3',
    'reg_ap_trib_sn': '1',
}

# === PARTNER (DESTINATÁRIO) ===
partner_uf = get_uf_code(partner.state_id)
partner_data = {
    'cnpj_cpf': get_partner_cnpj(partner),
    'legal_name': (getattr(partner, 'legal_name', '') or partner.name or '').upper(),
    'street': (partner.street or '').strip(),
    'number': getattr(partner, 'street_number', '') or getattr(partner, 'l10n_br_number', '') or 'S/N',
    'street2': (partner.street2 or getattr(partner, 'district', '') or '').strip(),
    'city': (partner.city or '').strip(),
    'city_ibge_code': get_ibge_city(partner) or getattr(partner, 'x_ibge_code', ''),
    'state': partner_uf,
    'zip': only_num(partner.zip or ''),
    'phone': only_num(partner.phone or partner.mobile or ''),
    'inscr_est': get_partner_ie(partner),
    'email': partner.email or '',
}

# === LINHAS ===
lines_data = []
for line in lines:
    p = line.product_id
    is_svc = p.detailed_type == 'service' or getattr(p, 'type', '') == 'service'
    ncm = ''
    if hasattr(p, 'ncm_id') and p.ncm_id:
        ncm = p.ncm_id.code or ''
    elif hasattr(p, 'l10n_br_ncm_id') and p.l10n_br_ncm_id:
        ncm = p.l10n_br_ncm_id.code or ''
    
    lines_data.append({
        'default_code': p.default_code or '',
        'product_name': line.name or p.name or '',
        'barcode': p.barcode or 'SEM GTIN',
        'ncm': ncm,
        'cfop': '5102' if not is_svc else '',
        'uom': (p.uom_id.name or 'UN').upper()[:3],
        'qty': line.product_uom_qty,
        'price_unit': line.price_unit,
        'price_subtotal': line.price_subtotal,
        'detailed_type': 'service' if is_svc else 'product',
        'csosn': '103',
        'orig': '0',
    })

# === DUPLICATAS E PAGAMENTOS ===
duplicatas = []
pagamentos = []
data_base = datetime.date.today()

if record.payment_term_id and record.payment_term_id.line_ids:
    pt_lines = record.payment_term_id.line_ids
    n_parcelas = len(pt_lines)
    valor_parcela = round(record.amount_total / n_parcelas, 2)
    
    for idx, ptl in enumerate(pt_lines):
        dias = ptl.days or 30
        data_venc = data_base + datetime.timedelta(days=dias)
        vDup = valor_parcela if idx < n_parcelas - 1 else round(record.amount_total - valor_parcela * (n_parcelas - 1), 2)
        duplicatas.append({'dVenc': data_venc.strftime('%Y-%m-%d'), 'vDup': vDup})
        pagamentos.append({'tPag': '15', 'vPag': vDup})
else:
    duplicatas.append({'dVenc': data_base.strftime('%Y-%m-%d'), 'vDup': record.amount_total})
    pagamentos.append({'tPag': '15', 'vPag': record.amount_total})

# === SERVIÇO (NFS-e) ===
service_data = None
if tipo_nf == 'nfse' and lines:
    p0 = lines[0].product_id
    service_data = {
        'cTribNac': getattr(p0, 'x_c_trib_nac', '') or '140101',
        'xDescServ': lines[0].name or p0.name or '',
        'cNBS': getattr(p0, 'x_c_nbs', '') or '999999999',
        'cIntContrib': getattr(company, 'x_c_int_contrib', '') or '',
        'pAliq': str(getattr(p0, 'x_aliquota_iss', 2.0) or 2.0),
        'pTotTribFed': '13.45',
        'pTotTribEst': '0.00',
        'pTotTribMun': '3.29',
    }

# === MONTAR PAYLOAD ===
dt_order = record.date_order
if hasattr(dt_order, 'strftime'):
    dt_str = dt_order.strftime('%Y-%m-%dT%H:%M:%S-03:00')
else:
    dt_str = str(dt_order)[:19].replace(' ', 'T') + '-03:00'

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
        'note': record.note or '',
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
    url,
    data=json.dumps(payload).encode('utf-8'),
    headers=headers,
    method='POST',
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode('utf-8'))
    
    if result.get('sucesso'):
        tipo = result.get('tipo', tipo_nf)
        resp_data = result.get('resposta_sieg', {})
        vals = {}
        msg = 'NF %s emitida com sucesso!' % tipo.upper()
        
        if tipo == 'nfe':
            chave = resp_data.get('chNFe') or resp_data.get('chave') or ''
            protocolo = resp_data.get('nProt') or resp_data.get('protocolo') or ''
            status = resp_data.get('xMotivo') or resp_data.get('motivo') or 'Processado'
            vals['x_nfe_chave'] = chave
            vals['x_nfe_status'] = status
            vals['x_nfe_protocolo'] = protocolo
            msg += '\nChave: %s\nProtocolo: %s\nStatus: %s' % (chave, protocolo, status)
        else:
            numero = resp_data.get('nDFSe') or resp_data.get('numero') or ''
            vals['x_nfse_numero'] = numero
            vals['x_nfse_status'] = 'Autorizada'
            msg += '\nNumero: %s' % numero
        
        pdf_b64 = result.get('pdf_base64')
        if pdf_b64:
            vals['x_nfe_xml'] = 'PDF gerado (%d bytes)' % len(pdf_b64)
            attach = env['ir.attachment'].create({
                'name': '%s-%s.pdf' % (tipo.upper(), record.name),
                'res_model': 'sale.order',
                'res_id': record.id,
                'datas': pdf_b64,
                'mimetype': 'application/pdf',
            })
            msg += '\nPDF anexado ao pedido!'
        
        record.write(vals)
        raise UserError(msg)
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

BOTÃO NO FORMULÁRIO (Opção C — XML de view):

  <?xml version="1.0" encoding="utf-8"?>
  <odoo>
    <record id="view_order_form_nfe_sieg" model="ir.ui.view">
      <field name="name">sale.order.form.nfe.sieg</field>
      <field name="model">sale.order</field>
      <field name="inherit_id" ref="sale.view_order_form"/>
      <field name="arch" type="xml">
        <xpath expr="//div[@name='button_box']" position="inside">
          <button name="%(action_emitir_nf_sieg)d" string="NF"
                  type="action" class="oe_highlight"
                  icon="fa-file-text-o"
                  invisible="state not in ('sale','done')"/>
        </xpath>
      </field>
    </record>
  </odoo>

CAMPOS CUSTOMIZADOS NECESSÁRIOS:

  Modelo: sale.order
  - x_nfe_chave      Char    Chave NF-e (44 dígitos)
  - x_nfe_status     Char    Status emissão NF-e
  - x_nfe_protocolo  Char    Protocolo SEFAZ
  - x_nfse_numero    Char    Número NFS-e
  - x_nfse_status    Char    Status emissão NFS-e

  Modelo: product.product (recomendado para NFS-e)
  - x_c_trib_nac     Char    Código tributação nacional
  - x_c_nbs          Char    Código NBS
  - x_aliquota_iss   Float   Alíquota ISSQN (%)

  Modelo: res.partner / res.company
  - x_ibge_code      Char    Código IBGE município (7 dígitos)
  - cnpj_cpf         Char    CNPJ/CPF
  - legal_name       Char    Razão social
  - inscr_mun        Char    Inscrição municipal
===================================================================================================
