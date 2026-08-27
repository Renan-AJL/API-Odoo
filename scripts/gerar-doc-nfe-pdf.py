#!/usr/bin/env python3
"""
Gera PDF de documentacao completa da parte de emissao de NF-e do sistema AJL.
"""
import os, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    Preformatted, KeepTogether, HRFlowable
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus.tableofcontents import TableOfContents

# ── Fonts ──
FONT_DIR = '/usr/share/fonts'
pdfmetrics.registerFont(TTFont('DejaVu', f'{FONT_DIR}/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuBd', f'{FONT_DIR}/truetype/dejavu/DejaVuSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuMono', f'{FONT_DIR}/truetype/dejavu/DejaVuSansMono.ttf'))

# ── Colors ──
C_PRIMARY = HexColor('#1a3a5c')
C_ACCENT = HexColor('#2d7d9a')
C_LIGHT  = HexColor('#f0f4f8')
C_CODE_BG = HexColor('#f5f7fa')
C_BORDER  = HexColor('#d0d7de')
C_TEXT   = HexColor('#1c2430')
C_MUTED  = HexColor('#5b6875')

# ── Styles ──
styles = getSampleStyleSheet()

s_title = ParagraphStyle('DocTitle', parent=styles['Title'],
    fontName='DejaVuBd', fontSize=28, leading=34, textColor=C_PRIMARY,
    spaceAfter=6, alignment=TA_CENTER)

s_subtitle = ParagraphStyle('DocSubtitle', parent=styles['Normal'],
    fontName='DejaVu', fontSize=14, leading=18, textColor=C_ACCENT,
    spaceAfter=4, alignment=TA_CENTER)

s_h1 = ParagraphStyle('H1', fontName='DejaVuBd', fontSize=18, leading=24,
    textColor=C_PRIMARY, spaceBefore=24, spaceAfter=8)

s_h2 = ParagraphStyle('H2', fontName='DejaVuBd', fontSize=14, leading=18,
    textColor=C_ACCENT, spaceBefore=16, spaceAfter=6)

s_h3 = ParagraphStyle('H3', fontName='DejaVuBd', fontSize=11, leading=15,
    textColor=C_PRIMARY, spaceBefore=10, spaceAfter=4)

s_body = ParagraphStyle('Body', fontName='DejaVu', fontSize=9, leading=13,
    textColor=C_TEXT, spaceAfter=6, alignment=TA_JUSTIFY)

s_code = ParagraphStyle('Code', fontName='DejaVuMono', fontSize=6.5, leading=8.5,
    textColor=HexColor('#1e293b'), backColor=C_CODE_BG, leftIndent=6, rightIndent=6,
    spaceBefore=2, spaceAfter=2, borderPadding=4)

s_bullet = ParagraphStyle('Bullet', parent=s_body, leftIndent=18, bulletIndent=6,
    spaceBefore=1, spaceAfter=1)

s_toc_h1 = ParagraphStyle('TOCH1', fontName='DejaVuBd', fontSize=11, leading=18, leftIndent=0)
s_toc_h2 = ParagraphStyle('TOCH2', fontName='DejaVu', fontSize=9, leading=14, leftIndent=14)

s_meta = ParagraphStyle('Meta', fontName='DejaVu', fontSize=8, leading=11,
    textColor=C_MUTED, alignment=TA_CENTER)

# ── Helpers ──
def hr():
    return HRFlowable(width='100%', thickness=0.5, color=C_BORDER, spaceBefore=4, spaceAfter=4)

def code_block(filepath):
    """Read file and return list of Preformatted paragraphs."""
    elements = []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        content = f'// Arquivo nao encontrado: {e}'
    
    # Escape HTML entities for Paragraph
    content_escaped = (content
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;'))
    
    # Split into lines and create paragraphs in chunks for better pagination
    lines = content_escaped.split('\n')
    chunk_size = 80
    for i in range(0, len(lines), chunk_size):
        chunk = '\n'.join(lines[i:i+chunk_size])
        elements.append(Paragraph(chunk, s_code))
        if i + chunk_size < len(lines):
            elements.append(Spacer(1, 2))
    return elements

def file_section(title, filepath, description):
    """Create a section for one source file."""
    elems = []
    elems.append(Paragraph(title, s_h2))
    elems.append(Paragraph(description, s_body))
    elems.append(Spacer(1, 4))
    # Code header
    short = filepath.split('/')[-1]
    elems.append(Paragraph(
        f'<font color="{C_ACCENT.hexval()}"><b>{short}</b></font> '
        f'<font color="{C_MUTED.hexval()}">({filepath})</font>',
        ParagraphStyle('CodeHeader', fontName='DejaVuMono', fontSize=7, leading=10,
            textColor=C_TEXT, spaceBefore=4, spaceAfter=2, backColor=HexColor('#e8edf2'),
            borderPadding=4, leftIndent=4, rightIndent=4)))
    elems.extend(code_block(filepath))
    elems.append(Spacer(1, 10))
    return elems

# ── Base path ──
BASE = '/home/z/my-project/API-Odoo'

def build_doc():
    output = '/home/z/my-project/download/AJL-Doc-Emissao-NFe.pdf'
    doc = SimpleDocTemplate(output, pagesize=A4,
        leftMargin=2*cm, rightMargin=2*cm, topMargin=2.2*cm, bottomMargin=2.2*cm,
        title='AJL - Documentacao Emissao de NF-e',
        author='AJL Ferro e Aco', subject='Modulo de emissao propria de NF-e com certificado A1')
    
    story = []
    
    # ════════════════════════════════════════════════════════
    # COVER
    # ════════════════════════════════════════════════════════
    story.append(Spacer(1, 5*cm))
    story.append(Paragraph('AJL Ferro e Aco LTDA', s_meta))
    story.append(Spacer(1, 1*cm))
    story.append(Paragraph('Documentacao Tecnica', s_title))
    story.append(Paragraph('Modulo de Emissao Propria de NF-e', ParagraphStyle(
        'SubBig', fontName='DejaVuBd', fontSize=16, leading=20, textColor=C_ACCENT,
        alignment=TA_CENTER, spaceAfter=8)))
    story.append(Spacer(1, 0.5*cm))
    story.append(hr())
    story.append(Spacer(1, 0.5*cm))
    story.append(Paragraph('Certificado A1 | SEFAZ-PR | NF-e 4.00 | DANFE PDF', s_meta))
    story.append(Spacer(1, 1.5*cm))
    
    # Info table
    info_data = [
        ['Middleware', 'api-odoo-rhzf.onrender.com'],
        ['Odoo', 'ajlferroeaco.odoo.com (SaaS 19.2)'],
        ['Ambiente', 'Homologacao (tpAmb=2)'],
        ['UF Emitente', 'PR (cUF=41)'],
    ]
    info_table = Table(info_data, colWidths=[4*cm, 10*cm])
    info_table.setStyle(TableStyle([
        ('FONT', (0, 0), (0, -1), 'DejaVuBd', 8),
        ('FONT', (1, 0), (1, -1), 'DejaVu', 8),
        ('TEXTCOLOR', (0, 0), (-1, -1), C_TEXT),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('LINEBELOW', (0, 0), (-1, -2), 0.3, C_BORDER),
    ]))
    story.append(info_table)
    
    story.append(Spacer(1, 3*cm))
    story.append(Paragraph('Documento gerado automaticamente a partir do repositorio GitHub.', s_meta))
    story.append(Paragraph('Contem codigo-fonte atualizado de todos os arquivos do modulo de NF-e.', s_meta))
    story.append(PageBreak())
    
    # ════════════════════════════════════════════════════════
    # TOC
    # ════════════════════════════════════════════════════════
    story.append(Paragraph('Sumario', s_h1))
    story.append(Spacer(1, 8))
    
    toc_entries = [
        (1, '1. Visao Geral do Modulo NF-e'),
        (2, '1.1 Fluxo de Emissao'),
        (2, '1.2 Arquitetura dos Arquivos'),
        (2, '1.3 Variaveis de Ambiente'),
        (2, '1.4 Endpoints da API'),
        (1, '2. Certificado Digital A1 (nfe-cert.js + pfx-openssl.js)'),
        (2, '2.1 services/nfe-cert.js'),
        (2, '2.2 services/pfx-openssl.js'),
        (1, '3. Gerador de XML NF-e 4.00 (sieg-nfe-xml.js)'),
        (1, '4. Assinatura Digital XMLDSig (nfe-signer.js)'),
        (1, '5. Comunicacao com a SEFAZ (sefaz-client.js)'),
        (1, '6. Orquestracao da Emissao (sieg-api.js)'),
        (1, '7. Processamento de Faturas Pendentes (sieg-odoo-emit.js)'),
        (1, '8. Cancelamento de NF-e'),
        (2, '8.1 services/nfe-cancelamento.js'),
        (2, '8.2 services/nfe-cancelar-odoo.js'),
        (1, '9. DANFE - PDF (danfe-pdf.js)'),
        (1, '10. Rotas da API (routes/)'),
        (2, '10.1 routes/nfe-cert.js'),
        (2, '10.2 routes/sieg.js'),
        (1, '11. Script Odoo - Botao Cancelar NF-e'),
        (1, '12. Documentacao de Referencia'),
    ]
    
    for level, title in toc_entries:
        style = s_toc_h1 if level == 1 else s_toc_h2
        prefix = '<b>' if level == 1 else ''
        suffix = '</b>' if level == 1 else ''
        story.append(Paragraph(f'{prefix}{title}{suffix}', style))
    
    story.append(PageBreak())
    
    # ════════════════════════════════════════════════════════
    # 1. VISAO GERAL
    # ════════════════════════════════════════════════════════
    story.append(Paragraph('1. Visao Geral do Modulo NF-e', s_h1))
    
    story.append(Paragraph(
        'O modulo de emissao propria de NF-e do sistema AJL permite a emissao direta de Notas Fiscais ' +
        'Eletronicas (NF-e modelo 55, versao 4.00) com certificado digital A1, sem dependencia da SIEG ' +
        'para a emissao propriamente dita. O XML e gerado no middleware, assinado com o certificado A1 ' +
        'da empresa e enviado diretamente a SEFAZ do Parana via SOAP 1.2 com mTLS. Apos a autorizacao ' +
        '(cStat 100), o DANFE em PDF e gerado localmente usando PDFKit + bwip-js e anexado a fatura no Odoo ' +
        'junto com o XML do nfeProc.', s_body))
    
    story.append(Paragraph(
        'O fluxo e acionado automaticamente: quando uma fatura no Odoo recebe o status ' +
        '"pendente" no campo x_studio_nfe_status, o sistema de polling do middleware detecta a ' +
        'fatura, extrai todos os dados necessarios via XML-RPC (empresa, parceiro, linhas, impostos), ' +
        'monta o XML da NF-e, assina, envia a SEFAZ e atualiza o Odoo com o resultado. Tudo ' +
        'acontece de forma assincrona e o usuario final ve o resultado no chatter da fatura.', s_body))
    
    # 1.1 Fluxo
    story.append(Paragraph('1.1 Fluxo de Emissao', s_h2))
    story.append(Paragraph(
        'O fluxo completo de emissao de uma NF-e no sistema AJL segue as etapas abaixo, ' +
        'desde a marcacao da fatura no Odoo ate a disponibilizacao do DANFE e XML no chatter:', s_body))
    
    fluxo_steps = [
        'Odoo: Fatura (account.move) e marcada com x_studio_nfe_status = "pendente"',
        'sieg-odoo-emit.js: Polling detecta faturas pendentes via XML-RPC search',
        'sieg-odoo-emit.js: Leitura completa da fatura, empresa, parceiro, linhas e produtos',
        'sieg-nfe-xml.js: Geracao do XML NF-e 4.00 (NFe + infNFe + det + impostos + pag)',
        'nfe-signer.js: Assinatura digital XMLDSig RSA-SHA1 do grupo infNFe',
        'sefaz-client.js: Envia lote via SOAP 1.2 + mTLS para NFeAutorizacao4',
        'sefaz-client.js: Se cStat 103/105, faz polling via NFeRetAutorizacao4',
        'sefaz-client.js: cStat 100 = autorizada; monta o nfeProc (NF-e + protNFe)',
        'danfe-pdf.js: Gera o DANFE em PDF (A4 retrato, code128, layout padrao)',
        'sieg-odoo-emit.js: Atualiza fatura no Odoo (chave, protocolo, status)',
        'sieg-odoo-emit.js: Anexa XML + PDF no chatter da fatura',
    ]
    for step in fluxo_steps:
        story.append(Paragraph(f'  {step}', s_bullet, bulletText='-'))
    
    # 1.2 Arquitetura
    story.append(Paragraph('1.2 Arquitetura dos Arquivos', s_h2))
    story.append(Paragraph(
        'O modulo de NF-e e composto por 11 arquivos de codigo fonte organizados em tres camadas: ' +
        'servicos (logica de negocio), rotas (API REST) e scripts Odoo (automacao). A tabela abaixo ' +
        'resume cada arquivo e sua responsabilidade dentro do sistema:', s_body))
    
    arch_data = [
        ['Arquivo', 'Camada', 'Responsabilidade'],
        ['sieg-nfe-xml.js', 'Servico', 'Gerador de XML NF-e 4.00 completo'],
        ['nfe-signer.js', 'Servico', 'Assinatura digital XMLDSig RSA-SHA1'],
        ['nfe-cert.js', 'Servico', 'Cofre do certificado A1 (.pfx/.p12)'],
        ['pfx-openssl.js', 'Servico', 'Fallback de leitura PFX via OpenSSL CLI'],
        ['sefaz-client.js', 'Servico', 'Comunicacao mTLS + SOAP com a SEFAZ'],
        ['nfe-cancelamento.js', 'Servico', 'Evento de cancelamento (evCancNFe)'],
        ['nfe-cancelar-odoo.js', 'Servico', 'Integracao cancelamento + Odoo'],
        ['danfe-pdf.js', 'Servico', 'Geracao do DANFE em PDF (PDFKit + bwip-js)'],
        ['sieg-api.js', 'Servico', 'Orquestracao: modo proprio vs SIEG'],
        ['sieg-odoo-emit.js', 'Servico', 'Polling de faturas pendentes + Odoo integration'],
        ['routes/nfe-cert.js', 'Rota', 'Endpoints de certificado + DANFE'],
        ['routes/sieg.js', 'Rota', 'Endpoints de emissao + cancelamento'],
        ['criar-botao-cancelar-nfe.py', 'Script', 'Cria botao "Cancelar NF-e" no Odoo'],
    ]
    arch_table = Table(arch_data, colWidths=[4.5*cm, 2*cm, 9.5*cm])
    arch_table.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, 0), 'DejaVuBd', 7),
        ('FONT', (0, 1), (-1, -1), 'DejaVu', 7),
        ('BACKGROUND', (0, 0), (-1, 0), C_LIGHT),
        ('GRID', (0, 0), (-1, -1), 0.3, C_BORDER),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    story.append(Spacer(1, 4))
    story.append(arch_table)
    
    # 1.3 Variaveis de Ambiente
    story.append(Paragraph('1.3 Variaveis de Ambiente', s_h2))
    story.append(Paragraph(
        'O comportamento do modulo de NF-e e controlado por variaveis de ambiente configuradas ' +
        'no servidor (Render). As variaveis principais determinam o modo de emissao, a UF do emitente, ' +
        'o ambiente (producao/homologacao) e as credenciais do certificado digital:', s_body))
    
    env_data = [
        ['Variavel', 'Default', 'Descricao'],
        ['NFE_EMISSAO_MODO', 'proprio', 'proprio = assina e autoriza na SEFAZ direto; sieg = importa XML autorizado'],
        ['NFE_UF', 'PR', 'UF do emitente; define qual webservice da SEFAZ usar'],
        ['SIEG_TP_AMB', '2', '1 = producao, 2 = homologacao'],
        ['NFE_CERT_PFX_BASE64', '-', 'Conteudo do .pfx em base64 (sobrevive deploys)'],
        ['NFE_CERT_SENHA', '-', 'Senha do certificado A1'],
        ['NFE_CERT_DIR', '/var/data', 'Diretorio do certificado em disco'],
        ['NFE_CERT_KEK', '-', 'Chave para cifrar a senha em disco (AES-256-GCM)'],
        ['NFE_DANFE_PROVIDER', 'local', 'local = PDFKit; sieg = via API SIEG'],
        ['SIEG_IMPORT_XML', '0', '1 = importa XML autorizado no cofre SIEG apos emissao'],
        ['NFE_TLS_INSECURE', '0', '1 = desativa validacao TLS (debug apenas)'],
    ]
    env_table = Table(env_data, colWidths=[4*cm, 2*cm, 10*cm])
    env_table.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, 0), 'DejaVuBd', 7),
        ('FONT', (0, 1), (-1, -1), 'DejaVuMono', 6.5),
        ('BACKGROUND', (0, 0), (-1, 0), C_LIGHT),
        ('GRID', (0, 0), (-1, -1), 0.3, C_BORDER),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    story.append(Spacer(1, 4))
    story.append(env_table)
    
    # 1.4 Endpoints
    story.append(Paragraph('1.4 Endpoints da API', s_h2))
    story.append(Paragraph(
        'Os endpoints relacionados a NF-e estao divididos em dois grupos: os endpoints de certificado ' +
        '(montados em routes/nfe-cert.js) e os endpoints de emissao/cancelamento (montados em routes/sieg.js). ' +
        'Todos exigem o header x-api-key para autenticacao:', s_body))
    
    ep_data = [
        ['Metodo', 'Rota', 'Funcao'],
        ['POST', '/api/v1/nfe/certificado', 'Upload do .pfx (base64 + senha)'],
        ['GET', '/api/v1/nfe/certificado', 'Status/validade do certificado carregado'],
        ['DELETE', '/api/v1/nfe/certificado', 'Remove o certificado do servidor'],
        ['GET', '/api/v1/nfe/sefaz/status', 'Status do servico da SEFAZ (testa mTLS)'],
        ['POST', '/api/v1/nfe/danfe', 'Gera DANFE PDF a partir de XML autorizado'],
        ['POST', '/api/v1/sieg/emitir', 'Emitir NF (auto-detect NF-e ou NFS-e)'],
        ['POST', '/api/v1/sieg/emitir-nfe', 'Emitir NF-e (forcar produto)'],
        ['POST', '/api/v1/sieg/process-pending', 'Processar emissoes pendentes (polling)'],
        ['POST', '/api/v1/sieg/cancelar', 'Cancelar NF-e (chave + protocolo)'],
    ]
    ep_table = Table(ep_data, colWidths=[2*cm, 6.5*cm, 7.5*cm])
    ep_table.setStyle(TableStyle([
        ('FONT', (0, 0), (-1, 0), 'DejaVuBd', 7),
        ('FONT', (0, 1), (-1, -1), 'DejaVu', 7),
        ('BACKGROUND', (0, 0), (-1, 0), C_LIGHT),
        ('GRID', (0, 0), (-1, -1), 0.3, C_BORDER),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(Spacer(1, 4))
    story.append(ep_table)
    
    story.append(PageBreak())
    
    # ════════════════════════════════════════════════════════
    # 2-11: FILE SECTIONS
    # ════════════════════════════════════════════════════════
    
    # 2. Certificado Digital
    story.append(Paragraph('2. Certificado Digital A1', s_h1))
    story.append(Paragraph(
        'O certificado digital A1 e o componente central da emissao propria de NF-e. Ele e utilizado ' +
        'para assinar o XML da nota (XMLDSig RSA-SHA1) e estabelecer a conexao mTLS com os webservices ' +
        'da SEFAZ. O sistema suporta tres fontes de carregamento: variaveis de ambiente (prioridade, ' +
        'sobrevive deploys), disco persistente (fallback), e upload via endpoint REST. A senha do ' +
        'certificado e cifrada em disco usando AES-256-GCM com uma chave derivada do ambiente.', s_body))
    story.append(Paragraph(
        'A abertura do arquivo PFX tenta primeiro o node-forge (compativel com algoritmos classicos 3DES/RC2). ' +
        'Se falhar com "Unsupported PKCS12 PFX data" (comum em certificados ICP-Brasil recentes que usam ' +
        'PBES2/AES-256), o sistema faz fallback para o OpenSSL do sistema operacional via CLI, tentando ' +
        'o modo moderno e, se necessario, o modo -legacy para algoritmos antigos. A senha nunca e ' +
        'escrita em logs ou retornada nas respostas da API.', s_body))
    
    story.extend(file_section(
        '2.1 services/nfe-cert.js',
        f'{BASE}/services/nfe-cert.js',
        'Cofre do certificado digital A1 (.pfx/.p12). Gerencia carregamento, cache, persistencia ' +
        'em disco (com senha cifrada), extracao de chave privada/chain em PEM, e validacao ' +
        'de validade. Tenta node-forge primeiro, depois OpenSSL como fallback.'))
    
    story.extend(file_section(
        '2.2 services/pfx-openssl.js',
        f'{BASE}/services/pfx-openssl.js',
        'Fallback de leitura de PKCS#12 via OpenSSL CLI. Necessario quando o node-forge nao suporta ' +
        'o algoritmo do PFX (PBES2/AES-256 dos certificados ICP-Brasil recentes). Usa env:VAR para a senha ' +
        '(nunca na linha de comando), apaga o .pfx temporario apos o uso, e tenta modo -legacy se o moderno falhar.'))
    
    # 3. Gerador de XML
    story.append(Paragraph('3. Gerador de XML NF-e 4.00', s_h1))
    story.append(Paragraph(
        'O arquivo sieg-nfe-xml.js e o coracao da geracao do XML da NF-e. Ele recebe os dados extraidos ' +
        'do Odoo (empresa, parceiro, linhas de fatura, impostos, pagamentos) e monta o XML completo no ' +
        'formato NF-e 4.00, incluindo os grupos ide (identificacao), emit (emitente), dest (destinatario), ' +
        'det (itens com prod + impostos), total (ICMSTot), transp (transporte), pag (pagamentos - PIX) e ' +
        'infAdic (informacoes complementares). O XML gerado segue o padrao exigido pela SEFAZ e inclui ' +
        'tratamentos especificos como CSOSN 103 (simples nacional sem ICMS), CFOP 6102 (venda fora do estado) ' +
        'e formatacao de enderecos do Odoo (que frequentemente inclui o numero no campo street).', s_body))
    
    story.extend(file_section(
        'services/sieg-nfe-xml.js',
        f'{BASE}/services/sieg-nfe-xml.js',
        'Gerador de XML NF-e v4.00 a partir de dados Odoo. Monta <NFe><infNFe> com todos os grupos ' +
        'obrigatorios (ide, emit, dest, det, total, transp, pag, infAdic). Inclui CSOSN 103, CFOP 6102, ' +
        'ICMS-ST com MVA, e pagamentos via PIX (tPag=15).'))
    
    # 4. Assinatura Digital
    story.append(Paragraph('4. Assinatura Digital XMLDSig', s_h1))
    story.append(Paragraph(
        'A assinatura digital da NF-e segue o padrao XMLDSig definido no Manual de Orientacao do Contribuinte ' +
        'da SEFAZ. O grupo infNFe e assinado com RSA-SHA1, utilizando canonicalizacao C14N ' +
        '(REC-xml-c14n-20010315) e transformacoes enveloped-signature + C14N. A referencia (Reference URI) ' +
        'aponta para o atributo Id="NFe<chave de 44 digitos>" do infNFe. O elemento Signature e inserido ' +
        'imediatamente apos o fechamento de infNFe, dentro de NFe, conforme exigido pela SEFAZ.', s_body))
    
    story.extend(file_section(
        'services/nfe-signer.js',
        f'{BASE}/services/nfe-signer.js',
        'Assinatura digital XMLDSig da NF-e (A1). Usa xml-crypto para assinar o grupo infNFe com ' +
        'RSA-SHA1 + C14N. Valida a presenca de X509Certificate no resultado (rejeicao 297 da SEFAZ).'))
    
    # 5. SEFAZ Client
    story.append(Paragraph('5. Comunicacao com a SEFAZ', s_h1))
    story.append(Paragraph(
        'O sefaz-client.js implementa toda a comunicacao direta com os webservices da SEFAZ para NF-e 4.00. ' +
        'Ele cria um agente HTTPS com mTLS (mutual TLS) usando o certificado A1, monta envelopes SOAP 1.2, ' +
        'envia lotes via NFeAutorizacao4 com indSinc=1 (sincrono), e trata os cenarios de processamento ' +
        'assincrono (cStat 103/105) com polling via NFeRetAutorizacao4. Suporta os autorizadores PR, SP e SVRS ' +
        '(fallback para UFs nao mapeadas). O bundle de CAs da ICP-Brasil esta embutido no codigo para ' +
        'resolver "self-signed certificate in certificate chain" em containers Linux sem o bundle instalado.', s_body))
    
    story.extend(file_section(
        'services/sefaz-client.js',
        f'{BASE}/services/sefaz-client.js',
        'Comunicacao direta com a SEFAZ (NF-e 4.00) via mTLS + SOAP 1.2. Inclui: criacao do agente mTLS ' +
        'com PEM, envelope SOAP, NFeAutorizacao4, NFeRetAutorizacao4 (polling), NFeConsultaProtocolo4, ' +
        'NFeStatusServico4, e montagem do nfeProc. Webservices mapeados: PR, SP, SVRS (fallback).'))
    
    # 6. SIEG API
    story.append(Paragraph('6. Orquestracao da Emissao (sieg-api.js)', s_h1))
    story.append(Paragraph(
        'O sieg-api.js e o orquestrador que decide como emitir a NF-e. Ele suporta dois modos: modo proprio ' +
        '(default) onde o XML e assinado com o certificado A1 e enviado direto a SEFAZ, e modo SIEG onde o ' +
        'XML ja assinado e autorizado e importado no cofre da SIEG. Apos a autorizacao, o DANFE e gerado ' +
        'localmente (PDFKit) ou via SIEG, conforme a configuracao. O sistema tambem suporta emissao de ' +
        'NFS-e via SIEG (DPS) e importacao opcional do XML autorizado no cofre SIEG.', s_body))
    
    story.extend(file_section(
        'services/sieg-api.js',
        f'{BASE}/services/sieg-api.js',
        'Orquestracao da emissao fiscal. decide entre emissao propria (SEFAZ direta) ou via SIEG. ' +
        'Gera DANFE local ou via SIEG. Suporta NF-e e NFS-e. Importa XML no cofre SIEG se configurado.'))
    
    # 7. SIEG Odoo Emit
    story.append(Paragraph('7. Processamento de Faturas Pendentes', s_h1))
    story.append(Paragraph(
        'O sieg-odoo-emit.js e o motor de integracao com o Odoo. Ele faz polling periodico das faturas ' +
        'com status "pendente" no campo x_studio_nfe_status (NF-e) ou x_studio_nfse_status (NFS-e), ' +
        'extrai todos os dados necessarios via XML-RPC (empresa com campos l10n_br opcionais, parceiro com ' +
        'fallback de codigo IBGE, linhas com NCM/CST/CFOP/impostos, produtos com campos x_studio_), ' +
        'monta o payload de emissao, chama a API e atualiza o Odoo com o resultado. O sistema e tolerante ' +
        'a campos ausentes no Odoo SaaS (l10n_br) e faz fallback para lookup de cidades por nome/UF.', s_body))
    
    story.extend(file_section(
        'services/sieg-odoo-emit.js',
        f'{BASE}/services/sieg-odoo-emit.js',
        'Processamento de emissoes pendentes via polling Odoo XML-RPC. Le faturas, empresa, parceiro, ' +
        'linhas, produtos. Monta payload, chama sieg-api.js, atualiza Odoo, anexa XML+PDF no chatter. ' +
        'Tolerante a campos ausentes no Odoo 19 SaaS.'))
    
    # 8. Cancelamento
    story.append(Paragraph('8. Cancelamento de NF-e', s_h1))
    story.append(Paragraph(
        'O cancelamento de NF-e implementa o evento de cancelamento conforme a NT2011.002 da SEFAZ. ' +
        'O fluxo monta o XML do evento evCancNFe (tpEvento 110111) com a justificativa, assina com o ' +
        'certificado A1, envia via SOAP para NFeRecepcaoEvento4 e verifica o cStat 135 (evento registrado) ' +
        'ou 155 (cancelamento homologado). Apos o cancelamento na SEFAZ, o sistema reverte a fatura para ' +
        'rascunho no Odoo (button_draft + button_cancel) e posta o resultado no chatter.', s_body))
    
    story.extend(file_section(
        '8.1 services/nfe-cancelamento.js',
        f'{BASE}/services/nfe-cancelamento.js',
        'Cancelamento de NF-e na SEFAZ (NT2011.002). Monta evCancNFe, assina com A1, envia via SOAP ' +
        'para NFeRecepcaoEvento4. Verifica cStat 135/155.'))
    
    story.extend(file_section(
        '8.2 services/nfe-cancelar-odoo.js',
        f'{BASE}/services/nfe-cancelar-odoo.js',
        'Cancelamento de NF-e integrado ao Odoo. Le fatura (chave + protocolo), envia cancelamento ' +
        'a SEFAZ, atualiza status, reverte fatura para rascunho e posta no chatter.'))
    
    # 9. DANFE
    story.append(Paragraph('9. DANFE - PDF', s_h1))
    story.append(Paragraph(
        'O DANFE (Documento Auxiliar da Nota Fiscal Eletronica) e gerado localmente usando PDFKit e bwip-js ' +
        '(codigo de barras Code128C da chave de acesso). O layout segue o padrao simplificado em A4 retrato: ' +
        'canhoto, cabecalho com emitente e chave de acesso com barcode, dados do destinatario, calculo de ' +
        'impostos, dados do transportador, tabela de itens e dados adicionais. Em ambiente de homologacao, ' +
        'inclui marca dagua "SEM VALOR FISCAL".', s_body))
    
    story.extend(file_section(
        'services/danfe-pdf.js',
        f'{BASE}/services/danfe-pdf.js',
        'Geracao local do DANFE em PDF (PDFKit + bwip-js). Layout A4 retrato com canhoto, emitente, ' +
        'destinatario, impostos, transportador, itens e dados adicionais. Barcode Code128C da chave.'))
    
    # 10. Rotas
    story.append(Paragraph('10. Rotas da API', s_h1))
    story.append(Paragraph(
        'As rotas da API de NF-e estao organizadas em dois arquivos de rota Express. O routes/nfe-cert.js ' +
        'concentra os endpoints de gerenciamento do certificado digital e geracao de DANFE, incluindo um ' +
        'painel HTML para upload do certificado via navegador. O routes/sieg.js concentra os endpoints de ' +
        'emissao (auto-detect NF-e/NFS-e, emissao forcada, processamento de pendentes, cancelamento) e o ' +
        'callback OAuth da SIEG.', s_body))
    
    story.extend(file_section(
        '10.1 routes/nfe-cert.js',
        f'{BASE}/routes/nfe-cert.js',
        'Rotas: POST/GET/DELETE /api/v1/nfe/certificado, GET /api/v1/nfe/sefaz/status, ' +
        'POST /api/v1/nfe/danfe, GET /api/v1/nfe/painel (HTML de upload de certificado).'))
    
    story.extend(file_section(
        '10.2 routes/sieg.js',
        f'{BASE}/routes/sieg.js',
        'Rotas: GET /api/v1/sieg/status, GET /api/v1/sieg/oauth-url, POST /api/v1/sieg/emitir, ' +
        'POST /api/v1/sieg/emitir-nfe, POST /api/v1/sieg/emitir-nfse, POST /api/v1/sieg/danfe, ' +
        'POST /api/v1/sieg/process-pending, POST /api/v1/sieg/cancelar, GET /callback/sieg.'))
    
    # 11. Script Odoo
    story.append(Paragraph('11. Script Odoo - Botao Cancelar NF-e', s_h1))
    story.append(Paragraph(
        'O script criar-botao-cancelar-nfe.py e um utilitario que cria via XML-RPC um Server Action no Odoo, ' +
        'visivel como botao no menu Acao (engrenagem) do formulario de faturas (account.move). O botao ' +
        'verifica se a NF-e esta com status "autorizada" antes de chamar o middleware para o cancelamento, ' +
        'e exibe o resultado (protocolo ou erro) via UserError para o usuario.', s_body))
    
    story.extend(file_section(
        'criar-botao-cancelar-nfe.py',
        f'{BASE}/odoo-scripts/criar-botao-cancelar-nfe.py',
        'Script Python que cria o botao "Cancelar NF-e" no Odoo via XML-RPC. O botao chama ' +
        'POST /api/v1/sieg/cancelar no middleware e exibe resultado ao usuario.'))
    
    # 12. Documentacao de referencia
    story.append(Paragraph('12. Documentacao de Referencia', s_h1))
    story.append(Paragraph(
        'O repositorio inclui tambem o arquivo docs-emissao-propria-nfe.md com documentacao adicional ' +
        'sobre a configuracao do disco persistente no Render, instrucoes para envio do certificado, teste ' +
        'da conexao com a SEFAZ e procedimentos de emissao. Este arquivo serve como guia rapido de ' +
        'referencia para a operacao do modulo de NF-e em producao.', s_body))
    
    story.extend(file_section(
        'docs-emissao-propria-nfe.md',
        f'{BASE}/docs-emissao-propria-nfe.md',
        'Documentacao de referencia: fluxo, variaveis de ambiente, envio de certificado, teste SEFAZ e endpoints.'))
    
    # Build
    print('Gerando PDF...')
    doc.build(story)
    print(f'PDF gerado: {output}')
    size = os.path.getsize(output)
    print(f'Tamanho: {size/1024:.0f} KB')

if __name__ == '__main__':
    build_doc()
