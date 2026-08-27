#!/usr/bin/env python3
"""
Gera PDF de documentacao completa da emissao de NF-e da AJL.
"""
import os, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    KeepTogether, Preformatted, HRFlowable
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors

# ── Fonts ──
FONT_DIR = '/usr/share/fonts'
pdfmetrics.registerFont(TTFont('NotoSerifSC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSC-Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('NotoSansSC', f'{FONT_DIR}/truetype/lxgw-wenkai/LXGWWenKai-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSansSC-Bold', f'{FONT_DIR}/truetype/lxgw-wenkai/LXGWWenKai-Regular.ttf'))
pdfmetrics.registerFont(TTFont('LiberationMono', f'{FONT_DIR}/truetype/liberation/LiberationMono-Regular.ttf'))

# ── Colors ──
C_PRIMARY = HexColor('#1a365d')
C_ACCENT = HexColor('#2a5298')
C_LIGHT = HexColor('#dce6f5')
C_BG = HexColor('#f5f8fc')
C_CODE_BG = HexColor('#f0f2f5')
C_CODE_BORDER = HexColor('#d1d5db')
C_TEXT = HexColor('#1c2430')
C_MUTED = HexColor('#5b6875')
C_BORDER = HexColor('#dde3ea')
C_SUCCESS = HexColor('#16a34a')
C_ERROR = HexColor('#dc2626')
C_WHITE = colors.white

# ── Styles ──
styles = getSampleStyleSheet()

s_title = ParagraphStyle('DocTitle', parent=styles['Title'], fontName='NotoSansSC-Bold', fontSize=26, leading=32, textColor=C_WHITE, alignment=TA_LEFT, spaceAfter=6*mm)
s_subtitle = ParagraphStyle('DocSubtitle', parent=styles['Normal'], fontName='NotoSansSC', fontSize=14, leading=20, textColor=HexColor('#a0b4d0'), alignment=TA_LEFT, spaceAfter=4*mm)
s_h1 = ParagraphStyle('H1', parent=styles['Heading1'], fontName='NotoSansSC-Bold', fontSize=20, leading=26, textColor=C_PRIMARY, spaceBefore=10*mm, spaceAfter=5*mm, keepWithNext=True)
s_h2 = ParagraphStyle('H2', parent=styles['Heading2'], fontName='NotoSansSC-Bold', fontSize=15, leading=20, textColor=C_ACCENT, spaceBefore=7*mm, spaceAfter=3*mm, keepWithNext=True)
s_h3 = ParagraphStyle('H3', parent=styles['Heading3'], fontName='NotoSansSC-Bold', fontSize=12, leading=16, textColor=C_TEXT, spaceBefore=4*mm, spaceAfter=2*mm, keepWithNext=True)
s_body = ParagraphStyle('Body', parent=styles['Normal'], fontName='NotoSansSC', fontSize=9.5, leading=15, textColor=C_TEXT, alignment=TA_JUSTIFY, spaceAfter=3*mm)
s_body_sm = ParagraphStyle('BodySm', parent=s_body, fontSize=8.5, leading=13, spaceAfter=2*mm)
s_code_title = ParagraphStyle('CodeTitle', parent=styles['Normal'], fontName='LiberationMono', fontSize=8, leading=11, textColor=C_MUTED, spaceBefore=3*mm, spaceAfter=1*mm)
s_bullet = ParagraphStyle('Bullet', parent=s_body, leftIndent=12*mm, bulletIndent=6*mm, spaceBefore=1*mm, spaceAfter=1*mm)
s_code = ParagraphStyle('Code', parent=styles['Code'], fontName='LiberationMono', fontSize=6.8, leading=9.5, textColor=HexColor('#1e293b'), backColor=C_CODE_BG, borderColor=C_CODE_BORDER, borderWidth=0.5, borderPadding=4, leftIndent=4*mm, rightIndent=4*mm, spaceBefore=1*mm, spaceAfter=3*mm)
s_toc_entry = ParagraphStyle('TOCEntry', parent=styles['Normal'], fontName='NotoSansSC', fontSize=10, leading=18, textColor=C_TEXT)
s_toc_h1 = ParagraphStyle('TOCH1', parent=s_toc_entry, fontName='NotoSansSC-Bold', fontSize=11, leading=22, leftIndent=0)
s_toc_h2 = ParagraphStyle('TOCH2', parent=s_toc_entry, leftIndent=10*mm, textColor=C_MUTED)
s_footer = ParagraphStyle('Footer', parent=styles['Normal'], fontName='NotoSansSC', fontSize=7, leading=9, textColor=C_MUTED, alignment=TA_CENTER)
s_cover_info = ParagraphStyle('CoverInfo', parent=styles['Normal'], fontName='NotoSansSC', fontSize=10, leading=15, textColor=HexColor('#8899aa'), alignment=TA_LEFT)
s_table_header = ParagraphStyle('TH', fontName='NotoSansSC-Bold', fontSize=8, leading=11, textColor=C_WHITE, alignment=TA_LEFT)
s_table_cell = ParagraphStyle('TC', fontName='NotoSansSC', fontSize=8, leading=11, textColor=C_TEXT, alignment=TA_LEFT)

PAGE_W, PAGE_H = A4
MARGIN = 20*mm
CONTENT_W = PAGE_W - 2*MARGIN

OUTPUT = '/home/z/my-project/download/AJL-Emissao-NFe-Documentacao-Completa.pdf'
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

# ── Helpers ──
def esc(t):
    return str(t).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def code_block(code, title=None):
    elems = []
    if title:
        elems.append(Paragraph(f'<b>{esc(title)}</b>', s_code_title))
    lines = code.strip().split('\n')
    for line in lines:
        elems.append(Paragraph(esc(line) if line.strip() else '&nbsp;', s_code))
    return elems

def hr():
    return HRFlowable(width='100%', thickness=0.5, color=C_BORDER, spaceBefore=4*mm, spaceAfter=4*mm)

def bullet(text):
    return Paragraph(f'<bullet>&bull;</bullet> {text}', s_bullet)

def body(text):
    return Paragraph(text, s_body)

# ── Page Number ──
page_count = [0]
def on_first_page(canvas, doc):
    pass  # cover page handled by flowables

def on_later_pages(canvas, doc):
    page_count[0] += 1
    canvas.saveState()
    canvas.setFont('NotoSansSC', 7)
    canvas.setFillColor(C_MUTED)
    canvas.drawRightString(PAGE_W - MARGIN, 12*mm, f'AJL Ferro e Aco - Documentacao NF-e')
    canvas.drawString(MARGIN, 12*mm, f'Pagina {doc.page - 1}')
    # thin line
    canvas.setStrokeColor(C_BORDER)
    canvas.setLineWidth(0.3)
    canvas.line(MARGIN, 15*mm, PAGE_W - MARGIN, 15*mm)
    canvas.restoreState()

# ── Build ──
doc = SimpleDocTemplate(OUTPUT, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=20*mm, title='Documentacao Emissao NF-e - AJL Ferro e Aco', author='AJL Middleware')

story = []

# ═══════════════════════ COVER ═══════════════════════
story.append(Spacer(1, 40*mm))
story.append(Paragraph('Documentacao Tecnica', ParagraphStyle('ct1', parent=s_title, fontSize=14, textColor=HexColor('#a0b4d0'))))
story.append(Spacer(1, 3*mm))
story.append(Paragraph('Emissao Propria de NF-e', s_title))
story.append(Paragraph('Middleware AJL Ferro e Aco LTDA', s_subtitle))
story.append(Spacer(1, 8*mm))
story.append(HRFlowable(width='60%', thickness=2, color=C_ACCENT, spaceBefore=0, spaceAfter=0))
story.append(Spacer(1, 8*mm))
story.append(Paragraph('Certificado A1 | SEFAZ-PR | DANFE Local', ParagraphStyle('tags', parent=s_cover_info, fontSize=11, textColor=C_ACCENT)))
story.append(Spacer(1, 15*mm))
story.append(Paragraph('Versao do Middleware: 1.1.0', s_cover_info))
story.append(Paragraph('Data: Agosto 2025', s_cover_info))
story.append(Paragraph('Ambiente: Homologacao / Producao', s_cover_info))
story.append(PageBreak())

# ═══════════════════════ TOC ═══════════════════════
story.append(Paragraph('Sumario', s_h1))
story.append(hr())
toc_items = [
    ('1', 'Visao Geral da Arquitetura', True),
    ('1.1', 'Fluxo de Emissao', False),
    ('1.2', 'Variaveis de Ambiente', False),
    ('1.3', 'Endpoints da API', False),
    ('2', 'services/nfe-cert.js - Cofre do Certificado A1', True),
    ('3', 'services/pfx-openssl.js - Fallback OpenSSL', True),
    ('4', 'services/nfe-signer.js - Assinatura XMLDSig', True),
    ('5', 'services/sefaz-client.js - Cliente SEFAZ (mTLS)', True),
    ('6', 'services/sieg-nfe-xml.js - Gerador XML NF-e 4.00', True),
    ('7', 'services/danfe-pdf.js - Geracao DANFE PDF', True),
    ('8', 'services/sieg-api.js - Orquestrador de Emissao', True),
    ('9', 'services/sieg-odoo-emit.js - Polling Odoo', True),
    ('10', 'services/sieg-auth.js - Autenticacao SIEG', True),
    ('11', 'services/nfe-cancelamento.js - Cancelamento SEFAZ', True),
    ('12', 'services/nfe-cancelar-odoo.js - Cancelamento Integrado', True),
    ('13', 'routes/nfe-cert.js - Rotas do Certificado', True),
    ('14', 'routes/sieg.js - Rotas de Emissao', True),
    ('15', 'server.js - Servidor e Polling', True),
    ('16', 'config/index.js - Configuracao', True),
    ('17', 'odoo-scripts/criar-botao-cancelar-nfe.py', True),
]
for num, title, is_h1 in toc_items:
    style = s_toc_h1 if is_h1 else s_toc_h2
    prefix = f'<b>{num}</b>  ' if is_h1 else f'{num}  '
    story.append(Paragraph(f'{prefix}{title}', style))

story.append(PageBreak())

# ═══════════════════════ SECTION 1: OVERVIEW ═══════════════════════
story.append(Paragraph('1. Visao Geral da Arquitetura', s_h1))
story.append(hr())

story.append(body('A emissao de NF-e da AJL Ferro e Aco LTDA e realizada de forma <b>propria</b>: o middleware assina o XML com o certificado digital A1 da empresa e envia diretamente para a SEFAZ do Parana, sem depender da SIEG para a autorizacao. A SIEG permanece opcional apenas como cofre de XMLs e para NFS-e (emissao de servicos). O sistema completo inclui geracao do XML NF-e v4.00, assinatura digital XMLDSig (RSA-SHA1 + C14N), comunicacao mTLS com a SEFAZ, geracao local do DANFE em PDF, e integracao bidirecional com o Odoo via XML-RPC.'))

story.append(body('O middleware e implantado no Render.com como um servidor Node.js/Express unificado que tambem gerencia integracoes com Itau (boletos, PIX), CNP Ja (consultas de CNPJ/IE) e TudoEntregue (entregas). A emissao fiscal opera via polling automatico a cada 30 segundos, buscando faturas do Odoo com status <b>x_studio_nfe_status = pendente</b>, processando-as automaticamente.'))

story.append(Paragraph('1.1 Fluxo de Emissao', s_h2))
story.append(body('O fluxo completo de emissao de uma NF-e pela AJL segue a sequencia abaixo, desde a criacao da fatura no Odoo ate a disponibilidade do XML autorizado e do DANFE PDF no chatter da fatura:'))

story.append(bullet('O usuario cria/confirma uma fatura no Odoo (account.move, move_type=out_invoice) com x_studio_nfe_status = "pendente"'))
story.append(bullet('O polling do middleware (sieg-odoo-emit.js) busca faturas pendentes a cada 30s via XML-RPC'))
story.append(bullet('Os dados da fatura (emitente, destinatario, linhas, impostos) sao lidos do Odoo'))
story.append(bullet('<b>sieg-nfe-xml.js</b> monta o XML completo da NF-e v4.00 (infNFe com ide, emit, dest, det, total, transp, infAdic)'))
story.append(bullet('<b>nfe-signer.js</b> assina o grupo &lt;infNFe&gt; com XMLDSig (RSA-SHA1, C14N, Reference URI #NFe&lt;chave&gt;)'))
story.append(bullet('<b>sefaz-client.js</b> envia o lote via SOAP 1.2 + mTLS para NFeAutorizacao4 (indSinc=1, sincrono)'))
story.append(bullet('Se cStat 100/150 (autorizada): monta o nfeProc (NF-e assinada + protocolo de autorizacao)'))
story.append(bullet('Se cStat 103/105 (lote em processamento): consulta recibo via NFeRetAutorizacao4 (ate 8 tentativas)'))
story.append(bullet('<b>danfe-pdf.js</b> gera o DANFE em PDF localmente (PDFKit + bwip-js para codigo de barras)'))
story.append(bullet('O XML (.xml) e o PDF (DANFE-.pdf) sao anexados ao chatter da fatura no Odoo'))
story.append(bullet('O campo x_studio_nfe_status e atualizado para "autorizada" e a chave/protocolo gravados'))

story.append(Paragraph('1.2 Variaveis de Ambiente', s_h2))

var_table_data = [
    [Paragraph('<b>Variavel</b>', s_table_header), Paragraph('<b>Valor</b>', s_table_header), Paragraph('<b>Descricao</b>', s_table_header)],
    [Paragraph('NFE_EMISSAO_MODO', s_table_cell), Paragraph('proprio', s_table_cell), Paragraph('proprio = assina e autoriza na SEFAZ; sieg = so importa XML autorizado', s_table_cell)],
    [Paragraph('NFE_UF', s_table_cell), Paragraph('PR', s_table_cell), Paragraph('UF do emitente; define o webservice SEFAZ', s_table_cell)],
    [Paragraph('SIEG_TP_AMB', s_table_cell), Paragraph('2', s_table_cell), Paragraph('1 = producao, 2 = homologacao', s_table_cell)],
    [Paragraph('NFE_CERT_DIR', s_table_cell), Paragraph('/var/data', s_table_cell), Paragraph('Onde o .pfx fica guardado (persistente no Render Disk)', s_table_cell)],
    [Paragraph('NFE_CERT_KEK', s_table_cell), Paragraph('(string forte)', s_table_cell), Paragraph('Cifra a senha do certificado em disco (AES-256-GCM)', s_table_cell)],
    [Paragraph('NFE_CERT_PFX_BASE64', s_table_cell), Paragraph('(base64)', s_table_cell), Paragraph('Conteudo do .pfx em base64 (alternativa ao upload)', s_table_cell)],
    [Paragraph('NFE_CERT_SENHA', s_table_cell), Paragraph('(senha)', s_table_cell), Paragraph('Senha do certificado (usada com NFE_CERT_PFX_BASE64)', s_table_cell)],
    [Paragraph('NFE_DANFE_PROVIDER', s_table_cell), Paragraph('local', s_table_cell), Paragraph('local (padrao) ou sieg', s_table_cell)],
    [Paragraph('SIEG_IMPORT_XML', s_table_cell), Paragraph('0', s_table_cell), Paragraph('1 = importa o XML autorizado no cofre SIEG (opcional)', s_table_cell)],
    [Paragraph('ODOO_PUSH_ENABLED', s_table_cell), Paragraph('true', s_table_cell), Paragraph('Ativa o polling de emissoes pendentes', s_table_cell)],
    [Paragraph('ODOO_URL', s_table_cell), Paragraph('(url)', s_table_cell), Paragraph('URL do Odoo (ex: ajlferroeaco.odoo.com)', s_table_cell)],
    [Paragraph('SIEG_POLL_INTERVAL_MS', s_table_cell), Paragraph('30000', s_table_cell), Paragraph('Intervalo do polling em milissegundos', s_table_cell)],
]
t = Table(var_table_data, colWidths=[38*mm, 28*mm, CONTENT_W - 66*mm])
t.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), C_PRIMARY),
    ('TEXTCOLOR', (0,0), (-1,0), C_WHITE),
    ('BACKGROUND', (0,1), (-1,-1), C_WHITE),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [C_WHITE, C_BG]),
    ('GRID', (0,0), (-1,-1), 0.3, C_BORDER),
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('TOPPADDING', (0,0), (-1,-1), 3),
    ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ('LEFTPADDING', (0,0), (-1,-1), 4),
    ('RIGHTPADDING', (0,0), (-1,-1), 4),
]))
story.append(t)

story.append(Paragraph('1.3 Endpoints da API', s_h2))

ep_table_data = [
    [Paragraph('<b>Metodo</b>', s_table_header), Paragraph('<b>Rota</b>', s_table_header), Paragraph('<b>Funcao</b>', s_table_header)],
    [Paragraph('POST', s_table_cell), Paragraph('/api/v1/nfe/certificado', s_table_cell), Paragraph('Upload do .pfx (base64 + senha)', s_table_cell)],
    [Paragraph('GET', s_table_cell), Paragraph('/api/v1/nfe/certificado', s_table_cell), Paragraph('Status/validade do certificado', s_table_cell)],
    [Paragraph('DELETE', s_table_cell), Paragraph('/api/v1/nfe/certificado', s_table_cell), Paragraph('Remove o certificado', s_table_cell)],
    [Paragraph('GET', s_table_cell), Paragraph('/api/v1/nfe/sefaz/status', s_table_cell), Paragraph('Status do servico SEFAZ (testa mTLS)', s_table_cell)],
    [Paragraph('POST', s_table_cell), Paragraph('/api/v1/nfe/danfe', s_table_cell), Paragraph('Gera DANFE PDF a partir de XML autorizado', s_table_cell)],
    [Paragraph('POST', s_table_cell), Paragraph('/api/v1/sieg/emitir', s_table_cell), Paragraph('Emitir NF-e ou NFS-e (auto-detect)', s_table_cell)],
    [Paragraph('POST', s_table_cell), Paragraph('/api/v1/sieg/emitir-nfe', s_table_cell), Paragraph('Emitir NF-e (forcar produto)', s_table_cell)],
    [Paragraph('POST', s_table_cell), Paragraph('/api/v1/sieg/emitir-nfse', s_table_cell), Paragraph('Emitir NFS-e (forcar servico)', s_table_cell)],
    [Paragraph('POST', s_table_cell), Paragraph('/api/v1/sieg/process-pending', s_table_cell), Paragraph('Processar emissoes pendentes (polling/cron)', s_table_cell)],
    [Paragraph('POST', s_table_cell), Paragraph('/api/v1/sieg/cancelar', s_table_cell), Paragraph('Cancelar NF-e na SEFAZ', s_table_cell)],
    [Paragraph('GET', s_table_cell), Paragraph('/api/v1/sieg/status', s_table_cell), Paragraph('Status dos tokens SIEG', s_table_cell)],
    [Paragraph('GET', s_table_cell), Paragraph('/api/v1/nfe/painel', s_table_cell), Paragraph('Painel HTML para enviar certificado', s_table_cell)],
]
t2 = Table(ep_table_data, colWidths=[18*mm, 52*mm, CONTENT_W - 70*mm])
t2.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), C_PRIMARY),
    ('TEXTCOLOR', (0,0), (-1,0), C_WHITE),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [C_WHITE, C_BG]),
    ('GRID', (0,0), (-1,-1), 0.3, C_BORDER),
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('TOPPADDING', (0,0), (-1,-1), 3),
    ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ('LEFTPADDING', (0,0), (-1,-1), 4),
    ('RIGHTPADDING', (0,0), (-1,-1), 4),
]))
story.append(t2)
story.append(PageBreak())

# ═══════════════════════ CODE SECTIONS ═══════════════════════
BASE = '/home/z/my-project/API-Odoo'

code_files = [
    ('2', 'services/nfe-cert.js', 'Cofre do Certificado Digital A1 (.pfx/.p12)',
     'Gerencia o certificado digital A1 usado para assinar NF-e. Suporta tres fontes: variaveis de ambiente (NFE_CERT_PFX_BASE64), upload via endpoint (POST /api/v1/nfe/certificado), ou disco persistente (/var/data). A senha e cifrada com AES-256-GCM. Tenta abrir o PFX com node-forge e, se falhar (PBES2/AES-256 dos certificados ICP-Brasil recentes), usa OpenSSL do sistema como fallback.'),
    ('3', 'services/pfx-openssl.js', 'Fallback de Leitura de PKCS#12 via OpenSSL CLI',
     'O node-forge nao suporta PFX gerados com PBES2/AES-256 (padrao das ACs ICP-Brasil desde OpenSSL 3). Este modulo usa o binario openssl do sistema para extrair chave privada e certificados em PEM. Tenta primeiro o modo moderno e, se falhar, com -legacy. A senha NUNCA vai na linha de comando (usamos env:VAR).'),
    ('4', 'services/nfe-signer.js', 'Assinatura Digital XMLDSig da NF-e (A1)',
     'Assina o grupo &lt;infNFe&gt; conforme o Manual de Orientacao do Contribuinte: Canonicalizacao C14N (REC-xml-c14n-20010315), Transformacoes enveloped-signature + C14N, Digest SHA-1, Assinatura RSA-SHA1. A &lt;Signature&gt; fica logo apos &lt;/infNFe&gt;, dentro de &lt;NFe&gt;. Usa a biblioteca xml-crypto.'),
    ('5', 'services/sefaz-client.js', 'Comunicacao Direta com a SEFAZ (NF-e 4.00)',
     'Autorizacao propria com certificado A1 (mTLS + SOAP 1.2). Suporta PR (webservice proprio), SP e SVRS (demais UFs). Inclui bundle de CAs da ICP-Brasil (AC SOLUTI SSL EV G4 + AC Raiz Brasileira v10) para validacao TLS. Implementa NFeAutorizacao4 (envio sincrono, indSinc=1), NFeRetAutorizacao4 (consulta recibo), NFeConsultaProtocolo4 e NFeStatusServico4.'),
    ('6', 'services/sieg-nfe-xml.js', 'Gerador de XML NF-e v4.00 a Partir de Dados Odoo',
     'Gera o &lt;NFe&gt; completo com todos os blocos obrigatórios: ide (identificacao), emit (emitente), dest (destinatario), det (itens com prod + impostos ICMS/ICMS-ST/PIS/COFINS/IBS/CBS), total (ICMSTot), transp (transportadora, modFrete=9 sem frete), infAdic (informacoes complementares). Inclui parser de endereco para extrair numero do logradouro quando Odoo armazena tudo no campo street.'),
    ('7', 'services/danfe-pdf.js', 'Geracao Local do DANFE (PDF)',
     'Gera o DANFE em PDF localmente usando PDFKit + bwip-js (codigo de barras Code128C da chave de acesso). Layout retrato A4 no padrao simplificado com: canhoto, cabecalho com emitente e chave de acesso com codigo de barras, protocolo de autorizacao, dados do destinatario, calculo de impostos, transportador/volumes, tabela de itens, e dados adicionais. Marca d\'agua de homologacao quando tpAmb=2.'),
    ('8', 'services/sieg-api.js', 'Orquestrador de Emissao Fiscal',
     'Coordena a emissao de NF-e e NFS-e. Para NF-e no modo proprio: gerar XML (sieg-nfe-xml.js), assinar (nfe-signer.js), autorizar na SEFAZ (sefaz-client.js), gerar DANFE (danfe-pdf.js), e opcionalmente importar no cofre SIEG. Para NFS-e: envia via SIEG. Auto-detecta o tipo (NF-e ou NFS-e) baseado nas linhas da fatura. Gerencia os dois modos: NFE_EMISSAO_MODO=proprio (default) ou sieg.'),
    ('9', 'services/sieg-odoo-emit.js', 'Processamento de Emissões Pendentes via Polling Odoo',
     'Busca faturas com x_studio_nfe_status ou x_studio_nfse_status = "pendente" no Odoo via XML-RPC, le todos os dados necessarios (empresa, parceiro, linhas, impostos, produtos), monta o payload de emissao, chama sieg-api.js, e atualiza o Odoo com o resultado (status, chave, protocolo, anexos XML+PDF no chatter). Tenta re-leitura de campos l10n_br com fallback para campos core do Odoo SaaS.'),
    ('10', 'services/sieg-auth.js', 'Autenticacao SIEG (JWT + OAuth 2.0)',
     'Implementa autenticacao em dois niveis com a SIEG: Nivel 1 JWT (POST /api/v1/create-jwt com X-Client-Id + X-Secret-Key) e Nivel 2 OAuth 2.0 (autorizacao do usuario na SIEG, troca de token temporario por definitivo, refresh a cada 30 dias). Cache em memoria do JWT (24h) e do OAuth token (30 dias). Auto-inicializa o OAuth token da configuracao na startup.'),
    ('11', 'services/nfe-cancelamento.js', 'Cancelamento de NF-e na SEFAZ (NT2011.002)',
     'Implementa o cancelamento de NF-e conforme NT2011.002: monta o evento de cancelamento (evCancNFe, tpEvento=110111) com justificativa, assina com XMLDSig RSA-SHA1, envia via SOAP para NFeRecepcaoEvento4, e retorna cStat 135 (cancelada) ou erro. Converte timestamp UTC para BRT (UTC-3) para o campo dhEvento.'),
    ('12', 'services/nfe-cancelar-odoo.js', 'Cancelamento de NF-e Integrado ao Odoo',
     'Integra o cancelamento da SEFAZ com o Odoo: le a fatura (chave + protocolo), envia o cancelamento, atualiza x_studio_nfe_status para "cancelada" ou "erro", reverte a fatura para rascunho (button_draft + button_cancel) se a SEFAZ confirmou, e posta mensagem no chatter com o resultado.'),
    ('13', 'routes/nfe-cert.js', 'Rotas do Certificado A1 e Emissao Propria',
     'Endpoints Express para gerenciamento do certificado (upload, status, remocao), teste de conexao com a SEFAZ (mTLS), geracao de DANFE PDF, e um painel HTML simples para enviar o certificado pelo navegador sem usar terminal.'),
    ('14', 'routes/sieg.js', 'Rotas de Emissao Fiscal SIEG',
     'Endpoints para emissao de NF-e/NFS-e (auto-detect, forcar tipo), geracao de DANFE, processamento de pendentes (polling/cron), webhook do Odoo, cancelamento de NF-e, e callback OAuth da SIEG.'),
    ('15', 'server.js', 'Servidor Principal e Polling Automatico',
     'Servidor Express unificado que combina todas as rotas (Itau, CNP Ja, TudoEntregue, NF-e, SIEG). Inclui o polling automatico SIEG que roda a cada 30s buscando faturas pendentes e cancelamentos pendentes. Mostra status de configuracao na inicializacao.'),
    ('16', 'config/index.js', 'Configuracao Unificada',
     'Arquivo de configuracao centralizado com todas as variaveis de ambiente organizadas por modulo: geral, Itau (boletos/PIX), banco, empresa, mTLS, SISPAG, Rede (cartao), Odoo, TudoEntregue, SIEG (NF-e/NFS-e), CNP Ja. Inclui auto-deteccao inteligente da URL do CNP Ja.'),
    ('17', 'odoo-scripts/criar-botao-cancelar-nfe.py', 'Script para Criar Botao Cancelar NF-e no Odoo',
     'Script Python que cria via XML-RPC um Server Action "Cancelar NF-e" visivel como botao no menu Acao do formulario de faturas. O botao envia POST para o middleware com move_id e justificativa.'),
]

for num, filepath_rel, title, desc in code_files:
    full_path = os.path.join(BASE, filepath_rel)
    story.append(Paragraph(f'{num}. {title}', s_h1))
    story.append(Paragraph(f'<b>Arquivo:</b> {filepath_rel}', s_body_sm))
    story.append(hr())
    story.append(body(desc))
    
    if os.path.exists(full_path):
        with open(full_path, 'r', encoding='utf-8') as f:
            code = f.read()
        story.extend(code_block(code, filepath_rel))
    else:
        story.append(Paragraph(f'<i>Arquivo nao encontrado: {full_path}</i>', s_body_sm))
    
    story.append(PageBreak())

doc.build(story, onFirstPage=on_first_page, onLaterPages=on_later_pages)
print(f'PDF gerado: {OUTPUT}')
print(f'Tamanho: {os.path.getsize(OUTPUT):,} bytes')
