#!/usr/bin/env python3
"""
Processar consulta ConsultFlex pendente diretamente.
Busca sale.orders com x_studio_cf_status='pendente', consulta a API e grava resultado.
"""
import xmlrpc.client
import json
import urllib.request
import urllib.error
from datetime import datetime

# ============================================================
# CONFIG
# ============================================================
ODOO_URL = 'https://ajlferroeaco.odoo.com/'
ODOO_DB = 'ajlferroeaco'
ODOO_USER = 'marcus@nytro.com.br'
ODOO_API_KEY = '5d50bc0616508c0a167218116d53199f710bca9b'

CONSULTFLEX_API_URL = 'https://api.consultflex.com.br/json/service.aspx'
CONSULTFLEX_API_KEY = 'dmnoMxDfE6JvZ8aMVNnhRpKeYvg87KjePjDKB7fhEslvZHHf/zZiDskkj7yqaLFq'
PRODUTO_PJ = '1761'
PRODUTO_PF = '1760'
VERSAO = '20180521'

def get_models():
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/common', allow_none=True)
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
    if not uid:
        raise Exception('Falha na autenticacao Odoo')
    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}xmlrpc/2/object', allow_none=True)
    return uid, models

def kw(models, uid, model, method, args, kwargs=None):
    if kwargs:
        return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs)
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args)

def consultar_consultflex(cpfcnpj, tipo_pessoa):
    """Consulta a API ConsultFlex"""
    cpfcnpj_clean = ''.join(c for c in str(cpfcnpj) if c.isdigit())
    if not cpfcnpj_clean:
        raise ValueError('CPF/CNPJ vazio')
    
    if not tipo_pessoa:
        tipo_pessoa = 'J' if len(cpfcnpj_clean) > 11 else 'F'
    
    codigo_produto = PRODUTO_PF if tipo_pessoa == 'F' else PRODUTO_PJ
    
    payload = json.dumps({
        "CodigoProduto": codigo_produto,
        "Versao": VERSAO,
        "ChaveAcesso": CONSULTFLEX_API_KEY,
        "Info": {"Solicitante": ""},
        "Parametros": {"TipoPessoa": tipo_pessoa, "CPFCNPJ": cpfcnpj_clean},
        "WebHook": {"UrlCallBack": ""}
    }).encode('utf-8')
    
    req = urllib.request.Request(
        CONSULTFLEX_API_URL,
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'User-Agent': 'AJL-Middleware/1.0 (CNPJ Consulta)',
        }
    )
    
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))

def formatar_html(resp):
    """Formata resposta ConsultFlex em HTML para o Odoo"""
    if not resp:
        return '<p style="color:red">Sem resposta da ConsultFlex</p>'
    
    header = (resp.get('HEADER', {}).get('INFORMACOES_RETORNO', {}))
    status = header.get('STATUS_RETORNO', {})
    html = ''
    
    if status.get('CODIGO') == '1':
        html += '<div style="background:#d4edda;padding:8px;border-radius:4px;margin-bottom:8px"><b>Consulta concluida com sucesso</b>'
        html += ' — ' + (header.get('DATA_HORA_CONSULTA', '')) + '</div>'
    else:
        html += '<div style="background:#f8d7da;padding:8px;border-radius:4px;margin-bottom:8px"><b>Erro:</b> ' + (status.get('DESCRICAO', 'Desconhecido') or 'Desconhecido') + '</div>'
        return html
    
    # PDF link
    pdf_url = header.get('PDF', '')
    if pdf_url:
        html += '<div style="margin-bottom:8px"><a href="' + pdf_url + '" target="_blank" style="color:#2E75B6;font-weight:bold">📄 Ver PDF Completo</a></div>'
    
    cred = resp.get('CREDCADASTRAL', {})
    
    # Dados Receita Federal
    rf = cred.get('DADOS_RECEITA_FEDERAL', {})
    if rf and (rf.get('NOME') or rf.get('RAZAO_SOCIAL')):
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Dados Receita Federal</th></tr>'
        html += tr('Nome/Razao Social', rf.get('NOME') or rf.get('RAZAO_SOCIAL') or '-')
        html += tr('Situacao', rf.get('SITUACAO_RECEITA') or '-')
        html += tr('Data Nascimento/Fundacao', rf.get('DATA_NASCIMENTO_FUNDACAO') or '-')
        html += tr('Nome Mae', rf.get('NOME_MAE') or '-')
        html += tr('Atividade Principal', rf.get('ATIVIDADE_ECONOMICA_PRINCIPAL') or '-')
        html += tr('Natureza Juridica', rf.get('NATUREZA_JURIDICA') or '-')
        html += '</table>'
    
    # Endereco
    end = cred.get('ENDERECO', {})
    if end and end.get('ENDERECO'):
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Endereco</th></tr>'
        html += tr('Endereco', end.get('ENDERECO') or '-')
        html += tr('Bairro', end.get('BAIRRO') or '-')
        html += tr('Cidade/UF', (end.get('CIDADE') or '-') + '/' + (end.get('UF') or '-'))
        html += tr('CEP', end.get('CEP') or '-')
        html += '</table>'
    
    # Pendencias Financeiras
    pf = cred.get('PEND_FINANCEIRAS', {})
    if pf and pf.get('OCORRENCIAS') and len(pf['OCORRENCIAS']) > 0:
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">'
        html += '<tr style="background:#C00000;color:white"><th colspan="4" style="padding:6px">Pendencias Financeiras (' + str(pf.get('QUANTIDADE_OCORRENCIA', len(pf['OCORRENCIAS']))) + ')</th></tr>'
        html += '<tr style="background:#f2f2f2"><th style="padding:4px">Vencimento</th><th style="padding:4px">Credor</th><th style="padding:4px">Valor</th><th style="padding:4px">Modalidade</th></tr>'
        for o in pf['OCORRENCIAS'][:20]:
            html += '<tr><td style="padding:4px">' + (o.get('DATA_VENCIMENTO') or '-') + '</td><td style="padding:4px">' + (o.get('CREDOR') or '-') + '</td><td style="padding:4px">' + (o.get('MOEDA') or '') + ' ' + (o.get('VALOR') or '-') + '</td><td style="padding:4px">' + (o.get('MODALIDADE') or '-') + '</td></tr>'
        html += '</table>'
    
    # Quadro Societario
    qs = cred.get('QUADRO_SOCIETARIO', {})
    if qs and qs.get('OCORRENCIAS') and len(qs['OCORRENCIAS']) > 0:
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">'
        html += '<tr style="background:#2E75B6;color:white"><th colspan="4" style="padding:6px">Quadro Societario</th></tr>'
        html += '<tr style="background:#f2f2f2"><th style="padding:4px">Nome</th><th style="padding:4px">CPF/CNPJ</th><th style="padding:4px">Participacao</th><th style="padding:4px">Cargo</th></tr>'
        for s in qs['OCORRENCIAS']:
            html += '<tr><td style="padding:4px">' + (s.get('NOME') or '-') + '</td><td style="padding:4px">' + (s.get('CPF_CNPJ') or '-') + '</td><td style="padding:4px">' + str(s.get('PERCENTUAL_PARTICIPACAO') or '-') + '%</td><td style="padding:4px">' + (s.get('CARGO') or '-') + '</td></tr>'
        html += '</table>'
    
    # Protestos
    prot = cred.get('PROTESTO') or cred.get('PROTESTOS') or {}
    if prot and prot.get('OCORRENCIAS') and len(prot['OCORRENCIAS']) > 0:
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">'
        html += '<tr style="background:#C00000;color:white"><th colspan="3" style="padding:6px">Protestos</th></tr>'
        for p in prot['OCORRENCIAS']:
            html += '<tr><td style="padding:4px">' + (p.get('DATA_PROTESTO') or p.get('DATA') or '-') + '</td><td style="padding:4px">' + str(p.get('VALOR') or '-') + '</td><td style="padding:4px">' + (p.get('CARTORIO') or p.get('ORIGEM') or '-') + '</td></tr>'
        html += '</table>'
    
    # Informacoes/Alertas/Restricoes
    info = cred.get('INFORMACOES_ALERTAS_RESTRICOES', {})
    if info and info.get('OCORRENCIAS') and len(info['OCORRENCIAS']) > 0:
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px">'
        html += '<tr style="background:#ED7D31;color:white"><th colspan="3" style="padding:6px">Informacoes / Alertas / Restricoes</th></tr>'
        for a in info['OCORRENCIAS']:
            html += '<tr><td style="padding:4px"><b>' + (a.get('TITULO') or '-') + '</b></td><td style="padding:4px">' + (a.get('DESCRICAO_TIPO_INFORMACAO') or '-') + '</td><td style="padding:4px">' + (a.get('OBSERVACOES') or '-') + '</td></tr>'
        html += '</table>'
    
    # Cheques sem fundos (CCF/BACEN)
    ccf = cred.get('CH_SEM_FUNDOS_BACEN') or cred.get('CHEQUES_SEM_FUNDO') or {}
    if ccf:
        qtd = ccf.get('QUANTIDADE') or ccf.get('QUANTIDADE_OCORRENCIA') or '0'
        if qtd and qtd != '0':
            html += '<div style="background:#f8d7da;padding:8px;border-radius:4px;margin-bottom:8px"><b>Cheques sem fundo:</b> ' + str(qtd) + '</div>'
    
    # Contumacia
    cont = cred.get('CONTUMACIA', {})
    if cont:
        qtd = cont.get('QUANTIDADE_OCORRENCIA') or '0'
        if qtd and qtd != '0':
            html += '<div style="background:#fff3cd;padding:8px;border-radius:4px;margin-bottom:8px"><b>Contumacia:</b> ' + str(qtd) + ' ocorrencia(s)</div>'
    
    # Score
    score = cred.get('SCORE', {})
    if score and score.get('VALOR'):
        html += '<div style="background:#d4edda;padding:8px;border-radius:4px;margin-bottom:8px"><b>Score:</b> ' + str(score.get('VALOR')) + ' - ' + str(score.get('DESCRICAO') or '') + '</div>'
    
    return html

def tr(label, value):
    return '<tr><td style="padding:4px;width:30%;font-weight:bold">' + label + '</td><td style="padding:4px" colspan="3">' + str(value) + '</td></tr>'

def main():
    print('=' * 60)
    print('ConsultFlex - Processar Consultas Pendentes')
    print('=' * 60)
    
    uid, models = get_models()
    print(f'UID: {uid}')
    
    # Buscar sale.orders com cf_status = 'pendente' via search_read
    orders = kw(models, uid, 'sale.order', 'search_read', [
        [['x_studio_cf_status', '=', 'pendente']]
    ], {'limit': 10, 'fields': ['name', 'x_studio_cf_cpfcnpj', 'x_studio_cf_tipo_pessoa', 'partner_id']})
    
    print(f'Encontrados {len(orders)} pedido(s) pendente(s)')
    
    if not orders:
        print('Nenhum pedido pendente. Saindo.')
        return
    
    for order in orders:
        print(f'\n--- Processando {order["name"]} (ID: {order["id"]}) ---')
        
        cpfcnpj = (order.get('x_studio_cf_cpfcnpj') or '').replace('-', '').replace('.', '').replace('/', '')
        tipo_pessoa = order.get('x_studio_cf_tipo_pessoa') or ''
        
        # Fallback: partner
        if not cpfcnpj and order.get('partner_id') and len(order['partner_id']) > 0:
            partner = kw(models, uid, 'res.partner', 'read', [
                [order['partner_id'][0]], ['vat', 'is_company']
            ])
            if partner and partner[0].get('vat'):
                cpfcnpj = partner[0]['vat'].replace('-', '').replace('.', '').replace('/', '')
                tipo_pessoa = 'J' if partner[0].get('is_company') else 'F'
        
        if not cpfcnpj:
            print(f'  ERRO: CPF/CNPJ nao encontrado')
            kw(models, uid, 'sale.order', 'write', [[order['id']], {
                'x_studio_cf_status': 'erro',
                'x_studio_resposta_consultflex': '<p style="color:red;font-weight:bold">Erro: CPF/CNPJ nao encontrado</p>'
            }])
            continue
        
        print(f'  Consultando: {tipo_pessoa or "auto"} - {cpfcnpj[:3]}***')
        
        try:
            resultado = consultar_consultflex(cpfcnpj, tipo_pessoa)
            html = formatar_html(resultado)
            
            now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            write_vals = {
                'x_studio_cf_status': 'concluido',
                'x_studio_resposta_consultflex': html,
                'x_studio_cf_data_consulta': now_str,
            }
            
            kw(models, uid, 'sale.order', 'write', [[order['id']], write_vals])
            print(f'  OK! Resultado gravado no Odoo ({len(html)} chars HTML)')
            
            # Verificar status
            status_desc = resultado.get('HEADER', {}).get('INFORMACOES_RETORNO', {}).get('STATUS_RETORNO', {}).get('DESCRICAO', '')
            print(f'  Status ConsultFlex: {status_desc}')
            
        except Exception as e:
            print(f'  ERRO: {e}')
            kw(models, uid, 'sale.order', 'write', [[order['id']], {
                'x_studio_cf_status': 'erro',
                'x_studio_resposta_consultflex': f'<p style="color:red;font-weight:bold">Erro: {str(e)}</p>'
            }])
    
    print('\n' + '=' * 60)
    print('Processamento concluido!')

if __name__ == '__main__':
    main()
