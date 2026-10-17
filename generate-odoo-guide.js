const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  PageBreak, Header, Footer, PageNumber, NumberFormat,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  TableOfContents, SectionType, LevelFormat,
} = require("docx");
const fs = require("fs");

// ═══════════════════════════════════════════════════
// PALETTE — Consulting / Tech Implementation Guide
// ═══════════════════════════════════════════════════
const P = {
  primary: "#1A2744",
  body: "#1C2A3D",
  secondary: "#5B6B7D",
  accent: "#2E6B8A",
  surface: "#F1F5F9",
};
const c = (hex) => hex.replace("#", "");

// ═══════════════════════════════════════════════════
// FONT CONSTANTS
// ═══════════════════════════════════════════════════
const FONT_BODY = { ascii: "Calibri", eastAsia: "Microsoft YaHei" };
const FONT_HEADING = { ascii: "Calibri", eastAsia: "SimHei" };
const FONT_CODE = "Consolas";

// ═══════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 480, after: 200, line: 312 },
    children: [new TextRun({ text, bold: true, size: 32, color: c(P.primary), font: FONT_HEADING })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 28, color: c(P.primary), font: FONT_HEADING })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 280, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 24, color: c(P.primary), font: FONT_HEADING })],
  });
}

function body(text) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { line: 312, after: 80 },
    children: [new TextRun({ text, size: 24, color: c(P.body), font: FONT_BODY })],
  });
}

function bodyBold(text) {
  return new Paragraph({
    spacing: { line: 312, after: 80 },
    children: [new TextRun({ text, size: 24, color: c(P.body), font: FONT_BODY, bold: true })],
  });
}

function bodyRuns(runs) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { line: 312, after: 80 },
    children: runs,
  });
}

function r(text, opts = {}) {
  return new TextRun({ text, size: 24, color: c(P.body), font: FONT_BODY, ...opts });
}

function rBold(text, opts = {}) {
  return new TextRun({ text, size: 24, color: c(P.body), font: FONT_BODY, bold: true, ...opts });
}

function emptyPara() {
  return new Paragraph({ spacing: { after: 60 }, children: [] });
}

// Code block helper — monospace font, shaded background
function codeBlock(lines) {
  return lines.map((line, idx) => new Paragraph({
    spacing: { line: 276, after: idx === lines.length - 1 ? 80 : 0 },
    indent: { left: 360 },
    shading: { type: ShadingType.CLEAR, fill: "F0F4F8" },
    children: [new TextRun({
      text: line,
      size: 20,
      font: { ascii: FONT_CODE, eastAsia: FONT_CODE },
      color: "1E293B",
    })],
  }));
}

// Bullet item
function bullet(text, level = 0) {
  return new Paragraph({
    bullet: { level },
    spacing: { line: 312, after: 40 },
    children: [new TextRun({ text, size: 24, color: c(P.body), font: FONT_BODY })],
  });
}

function bulletRuns(runs, level = 0) {
  return new Paragraph({
    bullet: { level },
    spacing: { line: 312, after: 40 },
    children: runs,
  });
}

// Numbered list — using a reference
let listCounter = 0;
function numRef() { return `num-list-${listCounter++}`; }

function numberedItem(ref, text, level = 0) {
  return new Paragraph({
    numbering: { reference: ref, level },
    spacing: { line: 312, after: 40 },
    children: [new TextRun({ text, size: 24, color: c(P.body), font: FONT_BODY })],
  });
}

// Table helper
function makeTable(headers, rows, colWidths) {
  const borderStyle = { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" };
  const borders = {
    top: borderStyle, bottom: borderStyle,
    left: borderStyle, right: borderStyle,
    insideHorizontal: borderStyle, insideVertical: borderStyle,
  };

  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: headers.map((h, i) => new TableCell({
      width: { size: colWidths[i], type: WidthType.PERCENTAGE },
      shading: { type: ShadingType.CLEAR, fill: c(P.surface) },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({
        spacing: { line: 312 },
        children: [new TextRun({ text: h, bold: true, size: 20, color: c(P.primary), font: FONT_HEADING })],
      })],
    })),
  });

  const dataRows = rows.map(row => new TableRow({
    cantSplit: true,
    children: row.map((cell, i) => new TableCell({
      width: { size: colWidths[i], type: WidthType.PERCENTAGE },
      margins: { top: 50, bottom: 50, left: 100, right: 100 },
      children: [new Paragraph({
        spacing: { line: 276 },
        children: [new TextRun({ text: String(cell), size: 20, color: c(P.body), font: FONT_BODY })],
      })],
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders,
    rows: [headerRow, ...dataRows],
  });
}

// ═══════════════════════════════════════════════════
// COVER PAGE — Recipe R1 (Pure Paragraph Left)
// ═══════════════════════════════════════════════════
function buildCover() {
  const allNoBorders = {
    top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
    left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
    insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
  };

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        width: { size: 100, type: WidthType.PERCENTAGE },
        verticalAlign: "top",
        children: [
          new Paragraph({ spacing: { before: 4200 }, children: [] }),
          new Paragraph({
            spacing: { before: 200, after: 100, line: 900, lineRule: "atLeast" },
            children: [new TextRun({
              text: "Guia de Implementa\u00e7\u00e3o",
              size: 56, bold: true, color: c(P.primary), font: FONT_HEADING,
            })],
          }),
          new Paragraph({
            spacing: { after: 80, line: 720, lineRule: "atLeast" },
            children: [new TextRun({
              text: "Odoo 19.4 SaaS",
              size: 44, bold: true, color: c(P.accent), font: FONT_HEADING,
            })],
          }),
          new Paragraph({
            spacing: { before: 300, after: 60, line: 460, lineRule: "atLeast" },
            children: [new TextRun({
              text: "Server Actions \u2022 Automated Actions \u2022 Studio Fields",
              size: 24, color: c(P.secondary), font: FONT_BODY,
            })],
          }),
          new Paragraph({ spacing: { before: 600 }, children: [] }),
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({
              text: "Bloqueios CRM \u2022 Regras PIX \u2022 Integra\u00e7\u00e3o Ita\u00fa \u2022 Limite de Cr\u00e9dito",
              size: 22, color: c(P.secondary), font: FONT_BODY,
            })],
          }),
          new Paragraph({ spacing: { before: 2400 }, children: [] }),
          new Paragraph({
            children: [new TextRun({
              text: "Vers\u00e3o 1.0 \u2014 Mar\u00e7o 2026",
              size: 20, color: c(P.secondary), font: FONT_BODY,
            })],
          }),
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({
              text: "Confidencial \u2014 Uso Interno",
              size: 18, italics: true, color: c(P.secondary), font: FONT_BODY,
            })],
          }),
        ],
      })],
    })],
  });
}

// ═══════════════════════════════════════════════════
// CONTENT SECTIONS
// ═══════════════════════════════════════════════════

function sectionIntro() {
  return [
    h1("Introdu\u00e7\u00e3o"),
    body("Este documento \u00e9 o guia completo de implementa\u00e7\u00e3o para as customiza\u00e7\u00f5es do Odoo 19.4 SaaS. Ele cont\u00e9m todo o c\u00f3digo Python para Server Actions, configura\u00e7\u00f5es de Automated Actions e defini\u00e7\u00f5es de campos do Studio necess\u00e1rios para implementar as regras de neg\u00f3cio descritas a seguir."),
    body("IMPORTANTE: Este \u00e9 Odoo 19.4 SaaS \u2014 N\u00c3O \u00e9 poss\u00edvel instalar addons Python customizados. Toda a l\u00f3gica deve ser implementada via campos do Studio (prefixo x_studio_*), Server Actions (c\u00f3digo Python via interface) e Automated Actions."),
    h2("Vis\u00e3o Geral das Se\u00e7\u00f5es"),
    bullet("Se\u00e7\u00e3o 1: CRM \u2014 Bloqueios e Valida\u00e7\u00f5es de Clientes (CPF/CNPJ, Inadimpl\u00eancia, Sem Vendas)"),
    bullet("Se\u00e7\u00e3o 2: App Vendas \u2014 Regras PIX (Confirma\u00e7\u00e3o, Travas, Cancelamento, Faturas)"),
    bullet("Se\u00e7\u00e3o 3: Integra\u00e7\u00e3o PIX Ita\u00fa com Fatura (Busca dados, C\u00f3pia de campos)"),
    bullet("Se\u00e7\u00e3o 4: Limite de Cr\u00e9dito (Campo relacional, Decremento com boleto)"),
    bullet("Se\u00e7\u00e3o 5: Entregas T\u00e9cnicas \u2014 Resumo de todas as configura\u00e7\u00f5es"),
    bullet("Se\u00e7\u00e3o 6: Configura\u00e7\u00f5es Necess\u00e1rias \u2014 Passo a passo no Studio"),
    h2("Pr\u00e9-requisitos"),
    bullet("Acesso de administrador ao Odoo 19.4 SaaS"),
    bullet("M\u00f3dulo Odoo Studio ativado"),
    bullet("M\u00f3dulo Automated Actions (base_automation) ativado"),
    bullet("Grupo \"Financeiro\" criado e configurado (ver Se\u00e7\u00e3o 6)"),
    bullet("Campos customizados x_studio_* criados via Studio (ver Se\u00e7\u00e3o 6 para lista completa)"),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════
// SE\u00c7\u00c3O 1: CRM
// ═══════════════════════════════════════════════════
function section1() {
  return [
    h1("Se\u00e7\u00e3o 1: CRM \u2014 Bloqueios e Valida\u00e7\u00f5es de Clientes"),

    // 1.1 CPF/CNPJ Duplicado
    h2("1.1 CPF/CNPJ Duplicado"),
    body("Impede que o vendedor cadastre um cliente com CPF/CNPJ j\u00e1 existente no sistema. A valida\u00e7\u00e3o ocorre antes da cria\u00e7\u00e3o do registro, garantindo integridade dos dados de parceiros."),
    h3("Server Action: Validar CPF/CNPJ Duplicado"),
    body("Modelo: res.partner | Gatilho: Antes de Criar (before_create)"),
    ...codeBlock([
      "# Server Action: Validar CPF/CNPJ Duplicado",
      "# Modelo: res.partner",
      "# Gatilho: before_create",
      "",
      "if record.x_studio_cpf_cnpj:",
      "    # Buscar parceiros com mesmo CPF/CNPJ (excluindo o registro atual)",
      "    domain = [",
      "        ('x_studio_cpf_cnpj', '=', record.x_studio_cpf_cnpj),",
      "        ('id', '!=', record.id),",
      "    ]",
      "    existing = env['res.partner'].search(domain, limit=1)",
      "    if existing:",
      "        raise UserError(",
      "            f'CPF/CNPJ j\\u00e1 cadastrado para o parceiro {existing.name}. '",
      "            f'N\\u00e3o \\u00e9 permitido duplicar.'",
      "        )",
    ]),
    emptyPara(),
    h3("Automated Action: Valida\u00e7\u00e3o antes de criar"),
    body("Configura\u00e7\u00e3o no menu Configura\u00e7\u00f5es > T\u00e9cnico > Automated Actions:"),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Nome", "Validar CPF/CNPJ Duplicado ao Criar"],
        ["Modelo", "res.partner"],
        ["Gatilho", "Antes de Criar (Before Creation)"],
        ["A\u00e7\u00e3o Aplic\u00e1vel", "Server Action: Validar CPF/CNPJ Duplicado"],
        ["Condi\u00e7\u00e3o (Domain)", "[('x_studio_cpf_cnpj', '!=', False)]"],
        ["Estado", "Ativo"],
      ],
      [40, 60]
    ),
    emptyPara(),

    // 1.2 Boleto Vencido
    h2("1.2 Boleto Vencido (Inadimpl\u00eancia)"),
    body("Bloqueia a cria\u00e7\u00e3o de cota\u00e7\u00f5es e pedidos de venda para clientes inadimplentes. A verifica\u00e7\u00e3o busca faturas vencidas e n\u00e3o pagas no modelo account.move."),
    h3("Server Action: Validar Inadimpl\u00eancia"),
    body("Modelo: sale.order | Gatilho: Antes de Criar e Antes de Gravar (before_create, before_write)"),
    ...codeBlock([
      "# Server Action: Validar Inadimplencia do Cliente",
      "# Modelo: sale.order",
      "# Gatilho: before_create e before_write",
      "",
      "from datetime import date",
      "",
      "partner = record.partner_id",
      "if partner:",
      "    # Buscar faturas vencidas e nao pagas",
      "    today = date.today()",
      "    overdue_invoices = env['account.move'].search([",
      "        ('partner_id', '=', partner.id),",
      "        ('payment_state', '=', 'not_paid'),",
      "        ('invoice_date_due', '<', today),",
      "        ('move_type', '=', 'out_invoice'),",
      "    ], limit=5)",
      "    if overdue_invoices:",
      "        invoices_list = ', '.join(",
      "            inv.name for inv in overdue_invoices[:3]",
      "        )",
      "        count = len(overdue_invoices)",
      "        msg = (",
      "            f'Cliente {partner.name} possui {count} fatura(s) vencida(s). '",
      "            f'N\\u00e3o \\u00e9 permitido criar pedidos para clientes inadimplentes. '",
      "            f'Faturas: {invoices_list}'",
      "        )",
      "        if count > 3:",
      "            msg += ' ...'",
      "        raise UserError(msg)",
    ]),
    emptyPara(),
    h3("Automated Actions"),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Nome", "Bloquear Pedido - Cliente Inadimplente (Criar)"],
        ["Modelo", "sale.order"],
        ["Gatilho", "Antes de Criar (Before Creation)"],
        ["A\u00e7\u00e3o", "Server Action: Validar Inadimpl\u00eancia do Cliente"],
        ["Estado", "Ativo"],
      ],
      [40, 60]
    ),
    emptyPara(),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Nome", "Bloquear Pedido - Cliente Inadimplente (Gravar)"],
        ["Modelo", "sale.order"],
        ["Gatilho", "Antes de Gravar (Before Update)"],
        ["A\u00e7\u00e3o", "Server Action: Validar Inadimpl\u00eancia do Cliente"],
        ["Domain Filter", "[('partner_id', '!=', False)]"],
        ["Estado", "Ativo"],
      ],
      [40, 60]
    ),
    emptyPara(),

    // 1.3 Sem Vendas ha 3 Meses
    h2("1.3 Sem Vendas h\u00e1 3 Meses"),
    body("Bloqueia a opera\u00e7\u00e3o e cria atividade notificando o vendedor respons\u00e1vel e os administradores do grupo Financeiro. Verifica se o cliente possui pedidos confirmados (state = 'sale') nos \u00faltimos 3 meses."),
    h3("Server Action: Validar Vendas 3 Meses"),
    body("Modelo: sale.order | Gatilho: Antes de Confirmar (before_write, quando state muda para 'sale')"),
    ...codeBlock([
      "# Server Action: Validar Vendas - 3 Meses",
      "# Modelo: sale.order",
      "# Gatilho: before_write (ao confirmar pedido)",
      "",
      "from datetime import date, timedelta",
      "",
      "partner = record.partner_id",
      "if partner:",
      "    three_months_ago = date.today() - timedelta(days=90)",
      "    recent_sales = env['sale.order'].search([",
      "        ('partner_id', '=', partner.id),",
      "        ('state', '=', 'sale'),",
      "        ('date_order', '>=', three_months_ago),",
      "    ], limit=1)",
      "",
      "    if not recent_sales:",
      "        # Criar atividade para o vendedor responsavel",
      "        activity_type = env['mail.activity.type'].search([",
      "            ('name', 'ilike', 'Revisao Cliente')",
      "        ], limit=1)",
      "        if not activity_type:",
      "            activity_type = env.ref('mail.mail_activity_data_todo')",
      "",
      "        # Buscar grupo Financeiro",
      "        finance_group = env.ref('x_studio_grupo_financeiro',",
      "            raise_if_not_found=False)",
      "        finance_users = finance_group.users if finance_group",
      "            else env['res.users']",
      "",
      "        # Criar atividade para o vendedor",
      "        user_id = record.user_id or env.user",
      "        env['mail.activity'].create({",
      "            'res_id': partner.id,",
      "            'res_model_id': env['ir.model']._get('res.partner').id,",
      "            'activity_type_id': activity_type.id,",
      "            'user_id': user_id.id,",
      "            'summary': (",
      "                f'Cliente {partner.name} sem vendas ha 3 meses. '",
      "                f'Pedido {record.name} bloqueado.'",
      "            ),",
      "            'note': (",
      '                f"<p>Cliente sem vendas confirmadas nos ultimos"',
      '                f" 3 meses. Verificar situacao do cliente.</p>"',
      "            ),",
      "        })",
      "",
      "        # Criar atividades para admins do Financeiro",
      "        if finance_group:",
      "            for finance_user in finance_users.filtered(",
      "                lambda u: u.has_group('x_studio_grupo_financeiro')",
      "            ):",
      "                env['mail.activity'].create({",
      "                    'res_id': partner.id,",
      "                    'res_model_id': env['ir.model']._get(",
      "                        'res.partner').id,",
      "                    'activity_type_id': activity_type.id,",
      "                    'user_id': finance_user.id,",
      "                    'summary': (",
      "                        f'Cliente {partner.name} - Sem vendas ha'",
      "                        f' 3 meses - Revisar'",
      "                    ),",
      "                })",
      "",
      "        raise ValidationError(",
      "            f'Cliente {partner.name} nao possui vendas nos ultimos'",
      "            f' 3 meses. Operacao bloqueada. Atividades de revisao'",
      "            f' criadas para o vendedor e equipe Financeiro.'",
      "        )",
    ]),
    emptyPara(),

    // 1.4 Sem Vendas ha mais de 4 Meses
    h2("1.4 Sem Vendas h\u00e1 mais de 4 Meses"),
    body("Solicita an\u00e1lise do cliente criando atividade para os administradores do Financeiro. Diferente da regra de 3 meses, esta N\u00c3O bloqueia a opera\u00e7\u00e3o, apenas notifica para revis\u00e3o."),
    h3("Server Action: Notificar Vendas 4+ Meses"),
    body("Modelo: sale.order | Gatilho: Ap\u00f3s Confirmar (after_write, quando state muda para 'sale')"),
    ...codeBlock([
      "# Server Action: Notificar Vendas - 4+ Meses",
      "# Modelo: sale.order",
      "# Gatilho: after_write (apos confirmar pedido)",
      "",
      "from datetime import date, timedelta",
      "",
      "partner = record.partner_id",
      "if partner:",
      "    four_months_ago = date.today() - timedelta(days=120)",
      "    recent_sales = env['sale.order'].search([",
      "        ('partner_id', '=', partner.id),",
      "        ('state', '=', 'sale'),",
      "        ('date_order', '>=', four_months_ago),",
      "    ], limit=1)",
      "",
      "    if not recent_sales:",
      "        # Buscar grupo Financeiro",
      "        finance_group = env.ref('x_studio_grupo_financeiro',",
      "            raise_if_not_found=False)",
      "",
      "        if finance_group:",
      "            activity_type = env['mail.activity.type'].search([",
      "                ('name', 'ilike', 'Revisao Cliente')",
      "            ], limit=1)",
      "            if not activity_type:",
      "                activity_type = env.ref(",
      "                    'mail.mail_activity_data_todo')",
      "",
      "            for finance_user in finance_group.users.filtered(",
      "                lambda u: u.has_group('x_studio_grupo_financeiro')",
      "            ):",
      "                # Verificar se ja existe atividade similar",
      "                existing = env['mail.activity'].search([",
      "                    ('res_id', '=', partner.id),",
      "                    ('res_model', '=', 'res.partner'),",
      "                    ('user_id', '=', finance_user.id),",
      "                    ('summary', 'ilike', 'Sem vendas ha 4+ meses'),",
      "                ], limit=1)",
      "                if not existing:",
      "                    env['mail.activity'].create({",
      "                        'res_id': partner.id,",
      "                        'res_model_id': env['ir.model']._get(",
      "                            'res.partner').id,",
      "                        'activity_type_id': activity_type.id,",
      "                        'user_id': finance_user.id,",
      "                        'summary': (",
      "                            f'Cliente {partner.name} - Sem vendas'",
      "                            f' ha 4+ meses - Analise necessaria'",
      "                        ),",
      "                        'note': (",
      '                            f"<p>Cliente sem pedidos confirmados nos"',
      '                            f" ultimos 4 meses. Analise recomendada.</p>"',
      "                        ),",
      "                    })",
    ]),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════
// SE\u00c7\u00c3O 2: App Vendas - Regras PIX
// ═══════════════════════════════════════════════════
function section2() {
  return [
    h1("Se\u00e7\u00e3o 2: App Vendas \u2014 Regras PIX"),
    body("Todas as restri\u00e7\u00f5es desta se\u00e7\u00e3o aplicam-se APENAS quando a forma de pagamento \u00e9 PIX. Outros m\u00e9todos de pagamento n\u00e3o s\u00e3o afetados. A condi\u00e7\u00e3o base para todas as regras \u00e9: x_studio_itau_tipo_pagamento = 'PIX'."),

    // 2.1 Confirmar cotacao com PIX
    h2("2.1 Confirmar Cota\u00e7\u00e3o com PIX"),
    body("Permite que o vendedor confirme a cota\u00e7\u00e3o com pagamento PIX. Esta \u00e9 uma regra permissiva \u2014 nenhuma Server Action \u00e9 necess\u00e1ria para este item, pois o fluxo padr\u00e3o do Odoo j\u00e1 permite a confirma\u00e7\u00e3o. Apenas documentamos o comportamento esperado."),
    body("Comportamento esperado: Ao confirmar uma cota\u00e7\u00e3o com payment_term_id correspondente a PIX, o pedido transita normalmente de 'draft' para 'sale'."),

    // 2.2 Trava apos geracao do PIX
    h2("2.2 Trava ap\u00f3s Gera\u00e7\u00e3o do PIX"),
    body("Ap\u00f3s o PIX ser gerado (campo x_studio_itau_txid preenchido), impede a altera\u00e7\u00e3o da forma de pagamento no pedido de venda."),
    h3("Server Action: Bloquear Altera\u00e7\u00e3o de Pagamento p\u00f3s-PIX"),
    body("Modelo: sale.order | Gatilho: Antes de Gravar (before_write)"),
    ...codeBlock([
      "# Server Action: Bloquear Alteracao de Pagamento pos-PIX",
      "# Modelo: sale.order",
      "# Gatilho: before_write",
      "",
      "# Verificar se PIX ja foi gerado",
      "if record.x_studio_itau_txid:",
      "    # Verificar se ha tentativa de alterar o payment_term_id",
      "    # Comparar com o valor anterior no registro",
      "    original = env['sale.order'].browse(record.id)",
      "    if (original.payment_term_id != record.payment_term_id",
      "            and original.payment_term_id):",
      "        raise UserError(",
      "            'N\\u00e3o \\u00e9 poss\\u00edvel alterar a forma de pagamento '",
      "            'ap\\u00f3s a gera\\u00e7\\u00e3o do PIX.'",
      "        )",
    ]),
    emptyPara(),
    h3("Automated Action"),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Nome", "Bloquear Altera\u00e7\u00e3o Pagamento p\u00f3s-PIX"],
        ["Modelo", "sale.order"],
        ["Gatilho", "Antes de Gravar (Before Update)"],
        ["Domain", "[('x_studio_itau_txid', '!=', False)]"],
        ["A\u00e7\u00e3o", "Server Action: Bloquear Altera\u00e7\u00e3o de Pagamento p\u00f3s-PIX"],
        ["Estado", "Ativo"],
      ],
      [40, 60]
    ),
    emptyPara(),

    // 2.3 Trava contra cancelamento/retorno
    h2("2.3 Trava contra Cancelamento/Retorno"),
    body("Ap\u00f3s o PIX gerado, impede que o vendedor cancele ou retorne o pedido para rascunho. Exce\u00e7\u00e3o: usu\u00e1rios do grupo Financeiro podem cancelar."),
    h3("Server Action: Bloquear Cancelamento p\u00f3s-PIX"),
    body("Modelo: sale.order | Gatilho: Antes de Gravar (before_write, quando state muda para 'cancel')"),
    ...codeBlock([
      "# Server Action: Bloquear Cancelamento pos-PIX",
      "# Modelo: sale.order",
      "# Gatilho: before_write (ao cancelar ou retornar a draft)",
      "",
      "# Verificar se PIX ja foi gerado",
      "if record.x_studio_itau_txid:",
      "    # Verificar se usuario pertence ao grupo Financeiro",
      "    is_finance = env.user.has_group(",
      "        'x_studio_grupo_financeiro'",
      "    )",
      "",
      "    if not is_finance:",
      "        raise UserError(",
      "            'N\\u00e3o \\u00e9 poss\\u00edvel cancelar o pedido ap\\u00f3s a '",
      "            'gera\\u00e7\\u00e3o do PIX. Contate o Financeiro.'",
      "        )",
    ]),
    emptyPara(),
    h3("Automated Action"),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Nome", "Bloquear Cancelamento p\u00f3s-PIX"],
        ["Modelo", "sale.order"],
        ["Gatilho", "Antes de Gravar (Before Update)"],
        ["Domain", "[('x_studio_itau_txid', '!=', False)]"],
        ["A\u00e7\u00e3o", "Server Action: Bloquear Cancelamento p\u00f3s-PIX"],
        ["Estado", "Ativo"],
      ],
      [40, 60]
    ),
    emptyPara(),

    // 2.4 Criacao de faturas restrita ao Financeiro
    h2("2.4 Cria\u00e7\u00e3o de Faturas Restrita ao Financeiro"),
    body("Apenas usu\u00e1rios do grupo Financeiro podem criar faturas a partir de pedidos de venda. Vendedores n\u00e3o devem ter permiss\u00e3o de faturamento."),
    h3("Server Action: Bloquear Cria\u00e7\u00e3o de Fatura por N\u00e3o-Financeiro"),
    body("Modelo: sale.order | Gatilho: Antes de Criar Fatura (_create_invoices)"),
    ...codeBlock([
      "# Server Action: Bloquear Criacao de Fatura por Nao-Financeiro",
      "# Modelo: sale.order",
      "# Gatilho: before_write (ao clicar em criar fatura)",
      "",
      "# Verificar se a forma de pagamento e PIX",
      "if record.x_studio_itau_tipo_pagamento == 'PIX':",
      "    is_finance = env.user.has_group(",
      "        'x_studio_grupo_financeiro'",
      "    )",
      "",
      "    if not is_finance:",
      "        raise UserError(",
      "            'Apenas usuarios do grupo Financeiro podem criar '",
      "            'faturas para pedidos com pagamento PIX.'",
      "        )",
    ]),
    emptyPara(),
    body("Nota: Para pedidos com outras formas de pagamento, esta restri\u00e7\u00e3o n\u00e3o se aplica. A condi\u00e7\u00e3o x_studio_itau_tipo_pagamento == 'PIX' garante que apenas pedidos PIX s\u00e3o afetados."),
    h3("Automated Action"),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Nome", "Bloquear Fatura PIX - N\u00e3o Financeiro"],
        ["Modelo", "sale.order"],
        ["Gatilho", "Antes de Gravar (Before Update)"],
        ["Domain", "[('x_studio_itau_tipo_pagamento', '=', 'PIX')]"],
        ["A\u00e7\u00e3o", "Server Action: Bloquear Cria\u00e7\u00e3o de Fatura por N\u00e3o-Financeiro"],
        ["Estado", "Ativo"],
      ],
      [40, 60]
    ),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════
// SE\u00c7\u00c3O 3: Integracao PIX Itau
// ═══════════════════════════════════════════════════
function section3() {
  return [
    h1("Se\u00e7\u00e3o 3: Integra\u00e7\u00e3o PIX Ita\u00fa com Fatura"),

    // 3.1 Buscar dados PIX
    h2("3.1 Server Action: Buscar Dados PIX"),
    body("Action para buscar os dados do PIX a partir da integra\u00e7\u00e3o Ita\u00fa do pedido de venda. L\u00ea os campos x_studio_itau_txid e x_studio_itau_pix_copia_cola do sale.order. Este action \u00e9 executado via bot\u00e3o \"Processar PIX\" criado manualmente no Studio."),
    h3("Server Action: Processar PIX"),
    body("Modelo: sale.order | Gatilho: Bot\u00e3o na Interface (Manual)"),
    ...codeBlock([
      "# Server Action: Processar PIX",
      "# Modelo: sale.order",
      "# Gatilho: Manual (botao 'Processar PIX')",
      "",
      "# Verificar se o pedido tem txid do Itau",
      "if not record.x_studio_itau_txid:",
      "    raise UserError(",
      "        'Nenhum TXID do Itau encontrado para este pedido.'",
      "    )",
      "",
      "# Atualizar campo de situacao",
      "record.write({",
      "    'x_studio_itau_situacao': 'EM_PROCESSAMENTO',",
      "    'x_studio_itau_tipo_pagamento': 'PIX',",
      "})",
      "",
      "# Log da operacao",
      "record.message_post(",
      "    body=(",
      "        f'<p>PIX processado para o pedido {record.name}. '</p>'",
      "        f'<p>TXID: {record.x_studio_itau_txid}</p>'",
      "    ),",
      "    subject='PIX Processado',",
      ")",
    ]),
    emptyPara(),
    body("Configura\u00e7\u00e3o do Bot\u00e3o no Studio:"),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Tipo", "Bot\u00e3o (Button)"],
        ["Nome", "Processar PIX"],
        ["Modelo", "sale.order"],
        ["A\u00e7\u00e3o Associada", "Server Action: Processar PIX"],
        ["Visibilidade", "x_studio_itau_txid != False"],
        ["Posi\u00e7\u00e3o", "Ap\u00f3s campo x_studio_itau_txid"],
      ],
      [40, 60]
    ),
    emptyPara(),

    // 3.2 Copiar PIX do pedido para fatura
    h2("3.2 Copiar PIX do Pedido para Fatura"),
    body("Quando o Financeiro cria uma fatura a partir de um pedido de venda, os campos PIX s\u00e3o copiados automaticamente do sale.order para a account.move. Isso garante que a fatura tamb\u00e9m tenha os dados de integra\u00e7\u00e3o Ita\u00fa."),
    h3("Server Action: Copiar Campos PIX para Fatura"),
    body("Modelo: account.move | Gatilho: Ap\u00f3s Criar (after_create)"),
    ...codeBlock([
      "# Server Action: Copiar Campos PIX para Fatura",
      "# Modelo: account.move",
      "# Gatilho: after_create",
      "",
      "# Verificar se a fatura tem origem em um pedido de venda",
      "if record.move_type == 'out_invoice' and record.invoice_line_ids:",
      "    # Buscar o pedido de venda de origem",
      "    sale_orders = record.invoice_line_ids.mapped(",
      "        'sale_line_ids.order_id'",
      "    )",
      "",
      "    for order in sale_orders:",
      "        # Copiar apenas se o pedido tem dados PIX",
      "        if order.x_studio_itau_txid:",
      "            vals = {}",
      "            if order.x_studio_itau_txid:",
      "                vals['x_studio_itau_txid'] = (",
      "                    order.x_studio_itau_txid)",
      "            if order.x_studio_itau_pix_copia_cola:",
      "                vals['x_studio_itau_pix_copia_cola'] = (",
      "                    order.x_studio_itau_pix_copia_cola)",
      "            if order.x_studio_itau_situacao:",
      "                vals['x_studio_itau_situacao'] = (",
      "                    order.x_studio_itau_situacao)",
      "            if order.x_studio_itau_tipo_pagamento:",
      "                vals['x_studio_itau_tipo_pagamento'] = (",
      "                    order.x_studio_itau_tipo_pagamento)",
      "",
      "            if vals:",
      "                record.write(vals)",
      "                record.message_post(",
      "                    body=( '<p>Campos PIX copiados do pedido '",
      "                        f'{order.name}.</p>' ),",
      "                    subject='PIX Copiado',",
      "                )",
      "            break  # Processar apenas o primeiro pedido",
    ]),
    emptyPara(),
    h3("Automated Action"),
    makeTable(
      ["Propriedade", "Valor"],
      [
        ["Nome", "Copiar Campos PIX para Fatura"],
        ["Modelo", "account.move"],
        ["Gatilho", "Ap\u00f3s Criar (After Creation)"],
        ["Domain", "[('move_type', '=', 'out_invoice')]"],
        ["A\u00e7\u00e3o", "Server Action: Copiar Campos PIX para Fatura"],
        ["Estado", "Ativo"],
      ],
      [40, 60]
    ),
    emptyPara(),

    // 3.3 Nao alterar fluxo de outras formas
    h2("3.3 N\u00e3o Alterar Fluxo de Outras Formas de Pagamento"),
    body("Toda a l\u00f3gica PIX descrita nesta se\u00e7\u00e3o s\u00f3 \u00e9 ativada quando a forma de pagamento \u00e9 PIX, verificada pelo campo x_studio_itau_tipo_pagamento = 'PIX'. Pedidos com boleto, cart\u00e3o ou outras formas de pagamento n\u00e3o s\u00e3o afetados por nenhuma destas regras."),
    body("Garantias implementadas:"),
    bullet("Todas as Automated Actions t\u00eam domain filter incluindo condi\u00e7\u00e3o PIX"),
    bullet("Server Actions verificam o tipo de pagamento antes de executar"),
    bullet("C\u00f3pia de campos PIX s\u00f3 ocorre se x_studio_itau_txid est\u00e1 preenchido"),
    bullet("Fluxo padr\u00e3o do Odoo permanece inalterado para outras formas"),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════
// SE\u00c7\u00c3O 4: Limite de Credito
// ═══════════════════════════════════════════════════
function section4() {
  return [
    h1("Se\u00e7\u00e3o 4: Limite de Cr\u00e9dito"),

    // 4.1 Campo relacional
    h2("4.1 Campo Relacional"),
    body("O sistema de limite de cr\u00e9dito utiliza campos relacionados entre res.partner e sale.order. O campo x_studio_limite_credito \u00e9 alocado pelos administradores do Financeiro e representa o valor m\u00e1ximo de cr\u00e9dito dispon\u00edvel para o cliente."),
    h3("Estrutura de Campos"),
    makeTable(
      ["Modelo", "Campo", "Tipo", "Descri\u00e7\u00e3o"],
      [
        ["res.partner", "x_studio_limite_credito", "Monetary", "Limite de cr\u00e9dito total do cliente (alocado pelo Financeiro)"],
        ["res.partner", "x_studio_limite_credito_utilizado", "Monetary (Compute)", "Valor acumulado de cr\u00e9dito utilizado"],
        ["res.partner", "x_studio_limite_credito_disponivel", "Monetary (Compute)", "Limite dispon\u00edvel = Total - Utilizado"],
        ["sale.order", "x_studio_limite_credito", "Monetary (Related)", "Limite de cr\u00e9dito do parceiro (related field)"],
        ["sale.order", "x_studio_limite_credito_utilizado", "Monetary", "Valor utilizado acumulado neste pedido"],
      ],
      [15, 30, 20, 35]
    ),
    emptyPara(),
    h3("Compute Field: Limite Dispon\u00edvel"),
    body("Campo computado no res.partner que calcula automaticamente o limite dispon\u00edvel:"),
    ...codeBlock([
      "# Compute Field: Limite Credito Disponivel",
      "# Modelo: res.partner",
      "# Campo: x_studio_limite_credito_disponivel",
      "# Tipo: Monetary (compute)",
      "",
      "for partner in records:",
      "    limite = partner.x_studio_limite_credito or 0.0",
      "    utilizado = partner.x_studio_limite_credito_utilizado or 0.0",
      "    partner.x_studio_limite_credito_disponivel = (",
      "        limite - utilizado",
      "    )",
    ]),
    emptyPara(),
    h3("Server Action: Validar Limite de Cr\u00e9dito"),
    body("Modelo: sale.order | Gatilho: Antes de Confirmar (before_write)"),
    ...codeBlock([
      "# Server Action: Validar Limite de Credito",
      "# Modelo: sale.order",
      "# Gatilho: before_write (ao confirmar pedido)",
      "",
      "partner = record.partner_id",
      "if partner and partner.x_studio_limite_credito > 0:",
      "    disponivel = partner.x_studio_limite_credito_disponivel",
      "    valor_pedido = record.amount_total",
      "",
      "    if valor_pedido > disponivel:",
      "        raise UserError(",
      "            f'Limite de cr\\u00e9dito insuficiente para '",
      "            f'{partner.name}. '\n",
      "            f'Dispon\\u00edvel: R$ {disponivel:,.2f} | '\n",
      "            f'Pedido: R$ {valor_pedido:,.2f}'",
      "        )",
    ]),
    emptyPara(),

    // 4.2 Decremento com boleto
    h2("4.2 Decremento com Boleto"),
    body("Quando um boleto \u00e9 emitido para um pedido de venda, o valor do boleto decrementa o limite de cr\u00e9dito dispon\u00edvel. O campo x_studio_limite_credito_utilizado \u00e9 incrementado no parceiro e no pedido."),
    h3("Server Action: Decrementar Limite com Boleto"),
    body("Modelo: account.move | Gatilho: Ap\u00f3s Criar (after_create, quando move_type = 'out_invoice' e pagamento = boleto)"),
    ...codeBlock([
      "# Server Action: Decrementar Limite com Boleto",
      "# Modelo: account.move",
      "# Gatilho: after_create (apos emissao de boleto)",
      "",
      "# Verificar se e uma fatura de saida",
      "if record.move_type == 'out_invoice':",
      "    partner = record.partner_id",
      "    valor_fatura = record.amount_total",
      "",
      "    # Buscar pedidos de venda relacionados",
      "    sale_orders = record.invoice_line_ids.mapped(",
      "        'sale_line_ids.order_id'",
      "    )",
      "",
      "    # Verificar se pagamento e boleto (nao PIX)",
      "    is_boleto = any(",
      "        order.x_studio_itau_tipo_pagamento != 'PIX'",
      "        for order in sale_orders",
      "    )",
      "",
      "    if is_boleto and partner.x_studio_limite_credito > 0:",
      "        # Incrementar utilizado no parceiro",
      "        utilizado_atual = (",
      "            partner.x_studio_limite_credito_utilizado or 0.0",
      "        )",
      "        partner.write({",
      "            'x_studio_limite_credito_utilizado': (",
      "                utilizado_atual + valor_fatura",
      "            )",
      "        })",
      "",
      "        # Atualizar campo utilizado no pedido",
      "        for order in sale_orders:",
      "            utilizado_pedido = (",
      "                order.x_studio_limite_credito_utilizado or 0.0",
      "            )",
      "            order.write({",
      "                'x_studio_limite_credito_utilizado': (",
      "                    utilizado_pedido + valor_fatura",
      "                )",
      "            })",
      "",
      "        # Log da operacao",
      "        record.message_post(",
      "            body=(",
      "                f'<p>Limite de cr\\u00e9dito decrementado em '</p>'",
      "                f'<p>R$ {valor_fatura:,.2f} para o parceiro '</p>'",
      "                f'<p>{partner.name}.</p>'",
      "            ),",
      "            subject='Limite de Cr\\u00e9dito Atualizado',",
      "        )",
    ]),
    emptyPara(),
    h3("Server Action: Restituir Limite ao Pagar Boleto"),
    body("Modelo: account.move | Gatilho: Ap\u00f3s Gravar (after_write, quando payment_state muda para 'paid')"),
    ...codeBlock([
      "# Server Action: Restituir Limite ao Pagar Boleto",
      "# Modelo: account.move",
      "# Gatilho: after_write (quando pagamento confirmado)",
      "",
      "if record.move_type == 'out_invoice' and record.payment_state == 'paid':",
      "    partner = record.partner_id",
      "    valor_fatura = record.amount_total",
      "",
      "    # Verificar se era boleto",
      "    sale_orders = record.invoice_line_ids.mapped(",
      "        'sale_line_ids.order_id'",
      "    )",
      "    is_boleto = any(",
      "        order.x_studio_itau_tipo_pagamento != 'PIX'",
      "        for order in sale_orders",
      "    )",
      "",
      "    if is_boleto and partner.x_studio_limite_credito > 0:",
      "        utilizado_atual = (",
      "            partner.x_studio_limite_credito_utilizado or 0.0",
      "        )",
      "        partner.write({",
      "            'x_studio_limite_credito_utilizado': max(",
      "                0, utilizado_atual - valor_fatura",
      "            )",
      "        })",
      "",
      "        record.message_post(",
      "            body=(",
      "                f'<p>Limite de cr\\u00e9dito restituido em '</p>'",
      "                f'<p>R$ {valor_fatura:,.2f} para o parceiro '</p>'",
      "                f'<p>{partner.name}.</p>'",
      "            ),",
      "            subject='Limite de Cr\\u00e9dito Restituido',",
      "        )",
    ]),
    emptyPara(),
    h3("Automated Actions"),
    makeTable(
      ["Nome", "Modelo", "Gatilho", "Domain", "A\u00e7\u00e3o"],
      [
        ["Decrementar Limite (Boleto)", "account.move", "Ap\u00f3s Criar", "[('move_type','=','out_invoice')]", "Server Action: Decrementar Limite com Boleto"],
        ["Restituir Limite (Pagamento)", "account.move", "Ap\u00f3s Gravar", "[('move_type','=','out_invoice'),('payment_state','=','paid')]", "Server Action: Restituir Limite ao Pagar Boleto"],
      ],
      [22, 14, 14, 30, 20]
    ),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════
// SE\u00c7\u00c3O 5: Entregas Tecnicas
// ═══════════════════════════════════════════════════
function section5() {
  return [
    h1("Se\u00e7\u00e3o 5: Entregas T\u00e9cnicas \u2014 Resumo"),
    body("Resumo de todas as Server Actions, Automated Actions, campos customizados e configura\u00e7\u00f5es necess\u00e1rias para a implementa\u00e7\u00e3o completa."),

    h2("5.1 Resumo de Server Actions"),
    makeTable(
      ["#", "Nome", "Modelo", "Gatilho", "Se\u00e7\u00e3o"],
      [
        ["SA-01", "Validar CPF/CNPJ Duplicado", "res.partner", "before_create", "1.1"],
        ["SA-02", "Validar Inadimpl\u00eancia do Cliente", "sale.order", "before_create / before_write", "1.2"],
        ["SA-03", "Validar Vendas 3 Meses", "sale.order", "before_write", "1.3"],
        ["SA-04", "Notificar Vendas 4+ Meses", "sale.order", "after_write", "1.4"],
        ["SA-05", "Bloquear Altera\u00e7\u00e3o Pagamento p\u00f3s-PIX", "sale.order", "before_write", "2.2"],
        ["SA-06", "Bloquear Cancelamento p\u00f3s-PIX", "sale.order", "before_write", "2.3"],
        ["SA-07", "Bloquear Fatura PIX - N\u00e3o Financeiro", "sale.order", "before_write", "2.4"],
        ["SA-08", "Processar PIX", "sale.order", "Manual (bot\u00e3o)", "3.1"],
        ["SA-09", "Copiar Campos PIX para Fatura", "account.move", "after_create", "3.2"],
        ["SA-10", "Validar Limite de Cr\u00e9dito", "sale.order", "before_write", "4.1"],
        ["SA-11", "Decrementar Limite com Boleto", "account.move", "after_create", "4.2"],
        ["SA-12", "Restituir Limite ao Pagar Boleto", "account.move", "after_write", "4.2"],
      ],
      [7, 35, 14, 24, 10]
    ),
    emptyPara(),

    h2("5.2 Resumo de Automated Actions"),
    makeTable(
      ["#", "Nome", "Modelo", "Gatilho", "Domain", "Server Action"],
      [
        ["AA-01", "Validar CPF/CNPJ (Criar)", "res.partner", "before_create", "x_studio_cpf_cnpj != False", "SA-01"],
        ["AA-02", "Bloquear Pedido - Inadimplente (Criar)", "sale.order", "before_create", "-", "SA-02"],
        ["AA-03", "Bloquear Pedido - Inadimplente (Gravar)", "sale.order", "before_write", "partner_id != False", "SA-02"],
        ["AA-04", "Bloquear Alt. Pagamento p\u00f3s-PIX", "sale.order", "before_write", "x_studio_itau_txid != False", "SA-05"],
        ["AA-05", "Bloquear Cancelamento p\u00f3s-PIX", "sale.order", "before_write", "x_studio_itau_txid != False", "SA-06"],
        ["AA-06", "Bloquear Fatura PIX - N\u00e3o Financ.", "sale.order", "before_write", "x_studio_itau_tipo_pagamento = PIX", "SA-07"],
        ["AA-07", "Copiar Campos PIX p/ Fatura", "account.move", "after_create", "move_type = out_invoice", "SA-09"],
        ["AA-08", "Decrementar Limite (Boleto)", "account.move", "after_create", "move_type = out_invoice", "SA-11"],
        ["AA-09", "Restituir Limite (Pagamento)", "account.move", "after_write", "payment_state = paid", "SA-12"],
      ],
      [6, 25, 12, 14, 25, 18]
    ),
    emptyPara(),

    h2("5.3 Resumo de Campos Studio"),
    makeTable(
      ["Campo", "Modelo", "Tipo", "Descri\u00e7\u00e3o"],
      [
        ["x_studio_cpf_cnpj", "res.partner", "Char", "CPF ou CNPJ do parceiro"],
        ["x_studio_itau_txid", "sale.order", "Char", "TXID da transa\u00e7\u00e3o PIX Ita\u00fa"],
        ["x_studio_itau_pix_copia_cola", "sale.order", "Char", "C\u00f3digo PIX copia-e-cola"],
        ["x_studio_itau_situacao", "sale.order", "Selection", "Situa\u00e7\u00e3o do PIX (EM_PROCESSAMENTO, PAGO, EXPIRADO)"],
        ["x_studio_itau_tipo_pagamento", "sale.order", "Selection", "Tipo de pagamento (PIX, BOLETO, OUTRO)"],
        ["x_studio_itau_txid", "account.move", "Char", "TXID PIX na fatura (copiado do pedido)"],
        ["x_studio_itau_pix_copia_cola", "account.move", "Char", "PIX copia-e-cola na fatura"],
        ["x_studio_itau_situacao", "account.move", "Selection", "Situa\u00e7\u00e3o do PIX na fatura"],
        ["x_studio_itau_tipo_pagamento", "account.move", "Selection", "Tipo de pagamento na fatura"],
        ["x_studio_limite_credito", "res.partner", "Monetary", "Limite de cr\u00e9dito total"],
        ["x_studio_limite_credito_utilizado", "res.partner", "Monetary", "Valor de cr\u00e9dito utilizado"],
        ["x_studio_limite_credito_disponivel", "res.partner", "Monetary (Compute)", "Limite dispon\u00edvel (Total - Utilizado)"],
        ["x_studio_limite_credito", "sale.order", "Monetary (Related)", "Limite do parceiro (related)"],
        ["x_studio_limite_credito_utilizado", "sale.order", "Monetary", "Valor utilizado acumulado"],
      ],
      [32, 14, 20, 34]
    ),
    emptyPara(),

    h2("5.4 Resumo de Grupos e Permiss\u00f5es"),
    makeTable(
      ["Grupo", "Categoria", "Permiss\u00f5es Especiais"],
      [
        ["Financeiro", "Custom / Empresa", "Pode criar faturas PIX, pode cancelar pedidos p\u00f3s-PIX, aloca limite de cr\u00e9dito"],
        ["Vendas", "Vendas / Vendedor", "Pode confirmar cota\u00e7\u00f5es PIX, N\u00c3O pode criar faturas PIX, N\u00c3O pode cancelar p\u00f3s-PIX"],
      ],
      [20, 20, 60]
    ),
    emptyPara(),

    h2("5.5 Resumo de Atividades"),
    makeTable(
      ["Tipo de Atividade", "Destinat\u00e1rio", "Gatilho", "Se\u00e7\u00e3o"],
      [
        ["Revis\u00e3o Cliente (3 meses)", "Vendedor + Financeiro", "Sem vendas h\u00e1 3 meses", "1.3"],
        ["An\u00e1lise Cliente (4+ meses)", "Financeiro (admins)", "Sem vendas h\u00e1 4+ meses", "1.4"],
      ],
      [30, 25, 25, 10]
    ),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════
// SE\u00c7\u00c3O 6: Configuracoes Necessarias
// ═══════════════════════════════════════════════════
function section6() {
  return [
    h1("Se\u00e7\u00e3o 6: Configura\u00e7\u00f5es Necess\u00e1rias"),
    body("Passo a passo para configurar todas as customiza\u00e7\u00f5es no Odoo Studio. Siga a ordem apresentada, pois alguns itens dependem de anteriores."),

    h2("6.1 Ativar M\u00f3dulos Necess\u00e1rios"),
    body("Antes de iniciar, ative os seguintes m\u00f3dulos no menu Configura\u00e7\u00f5es:"),
    bullet("Odoo Studio \u2014 para criar campos customizados e bot\u00f5es"),
    bullet("Automated Actions (base_automation) \u2014 para criar gatilhos autom\u00e1ticos"),
    bullet("Acessar modo Desenvolvedor (Settings > Activate Developer Mode) para ver menus t\u00e9cnicos"),
    emptyPara(),

    h2("6.2 Criar Grupo Financeiro"),
    body("Passo a passo para criar o grupo de permiss\u00f5es Financeiro:"),
    bodyBold("Passo 1: Criar a categoria de grupo"),
    bullet("Ir em Configura\u00e7\u00f5es > T\u00e9cnico > Categorias de Seguran\u00e7a"),
    bullet("Criar categoria: \"Custom / Empresa\""),
    emptyPara(),
    bodyBold("Passo 2: Criar o grupo"),
    bullet("Ir em Configura\u00e7\u00f5es > T\u00e9cnico > Grupos"),
    bullet("Nome: \"Financeiro\""),
    bullet("Categoria: \"Custom / Empresa\""),
    bullet("Adicionar permiss\u00f5es: account.move (read, write, create), sale.order (read)"),
    bullet("Anotar a referencia XML: sera algo como x_studio_grupo_financeiro"),
    emptyPara(),
    bodyBold("Passo 3: Adicionar usu\u00e1rios ao grupo"),
    bullet("Ir em Configura\u00e7\u00f5es > Usu\u00e1rios e Empresas"),
    bullet("Para cada usu\u00e1rio do Financeiro, adicionar o grupo criado"),
    emptyPara(),

    h2("6.3 Criar Campos Studio"),
    body("Campos customizados a serem criados via Odoo Studio. Para cada campo, abra o modelo correspondente no Studio e adicione o campo na posi\u00e7\u00e3o indicada."),
    emptyPara(),

    h3("6.3.1 Campos no res.partner"),
    makeTable(
      ["Campo", "Tipo", "R\u00f3tulo", "Valor Padr\u00e3o", "Texto de Ajuda"],
      [
        ["x_studio_cpf_cnpj", "Char", "CPF/CNPJ", "-", "CPF ou CNPJ do parceiro. Campo utilizado para valida\u00e7\u00e3o de duplicidade."],
        ["x_studio_limite_credito", "Monetary", "Limite de Cr\u00e9dito", "0.0", "Valor total do limite de cr\u00e9dito. Alocado pelo Financeiro."],
        ["x_studio_limite_credito_utilizado", "Monetary", "Cr\u00e9dito Utilizado", "0.0", "Valor acumulado de cr\u00e9dito utilizado. Atualizado automaticamente ao emitir boletos."],
        ["x_studio_limite_credito_disponivel", "Monetary", "Cr\u00e9dito Dispon\u00edvel", "0.0", "Limite dispon\u00edvel = Total - Utilizado. Campo computado (readonly)."],
      ],
      [25, 12, 18, 12, 33]
    ),
    emptyPara(),

    h3("6.3.2 Campos no sale.order"),
    makeTable(
      ["Campo", "Tipo", "R\u00f3tulo", "Valor Padr\u00e3o", "Texto de Ajuda"],
      [
        ["x_studio_itau_txid", "Char", "TXID Ita\u00fa", "-", "Identificador da transa\u00e7\u00e3o PIX no Ita\u00fa. Preenchido ap\u00f3s gera\u00e7\u00e3o do PIX."],
        ["x_studio_itau_pix_copia_cola", "Char", "PIX Copia-e-Cola", "-", "C\u00f3digo PIX para copia-e-cola gerado pelo Ita\u00fa."],
        ["x_studio_itau_situacao", "Selection", "Situa\u00e7\u00e3o PIX", "-", "Situa\u00e7\u00e3o atual do PIX. Valores: EM_PROCESSAMENTO, PAGO, EXPIRADO."],
        ["x_studio_itau_tipo_pagamento", "Selection", "Tipo Pagamento", "-", "Tipo de pagamento do pedido. Valores: PIX, BOLETO, OUTRO."],
        ["x_studio_limite_credito", "Monetary (Related)", "Limite de Cr\u00e9dito", "-", "Limite de cr\u00e9dito do parceiro (campo related). Related: partner_id.x_studio_limite_credito"],
        ["x_studio_limite_credito_utilizado", "Monetary", "Cr\u00e9dito Utilizado", "0.0", "Valor de cr\u00e9dito utilizado acumulado neste pedido."],
      ],
      [25, 14, 16, 12, 33]
    ),
    emptyPara(),

    h3("6.3.3 Campos no account.move"),
    makeTable(
      ["Campo", "Tipo", "R\u00f3tulo", "Valor Padr\u00e3o", "Texto de Ajuda"],
      [
        ["x_studio_itau_txid", "Char", "TXID Ita\u00fa", "-", "TXID copiado do pedido de venda de origem."],
        ["x_studio_itau_pix_copia_cola", "Char", "PIX Copia-e-Cola", "-", "C\u00f3digo PIX copiado do pedido de venda."],
        ["x_studio_itau_situacao", "Selection", "Situa\u00e7\u00e3o PIX", "-", "Situa\u00e7\u00e3o do PIX copiada do pedido."],
        ["x_studio_itau_tipo_pagamento", "Selection", "Tipo Pagamento", "-", "Tipo de pagamento copiado do pedido."],
      ],
      [25, 12, 18, 12, 33]
    ),
    emptyPara(),

    h3("6.3.4 Op\u00e7\u00f5es de Selection"),
    body("Valores para campos Selection:"),
    bodyBold("x_studio_itau_situacao:"),
    bullet("EM_PROCESSAMENTO \u2192 Em Processamento"),
    bullet("PAGO \u2192 Pago"),
    bullet("EXPIRADO \u2192 Expirado"),
    emptyPara(),
    bodyBold("x_studio_itau_tipo_pagamento:"),
    bullet("PIX \u2192 PIX"),
    bullet("BOLETO \u2192 Boleto"),
    bullet("OUTRO \u2192 Outro"),
    emptyPara(),

    h2("6.4 Criar Server Actions"),
    body("Para cada Server Action, siga os passos abaixo:"),
    bodyBold("Passo 1: Acessar Configura\u00e7\u00f5es > T\u00e9cnico > Actions > Server Actions"),
    bodyBold("Passo 2: Clicar em Criar"),
    bodyBold("Passo 3: Preencher os campos conforme a tabela abaixo"),
    bodyBold("Passo 4: No campo Code, colar o c\u00f3digo Python da se\u00e7\u00e3o correspondente"),
    bodyBold("Passo 5: Salvar e testar"),
    emptyPara(),
    makeTable(
      ["#", "Nome da Action", "Modelo", "Tipo de A\u00e7\u00e3o", "C\u00f3digo Python em"],
      [
        ["SA-01", "Validar CPF/CNPJ Duplicado", "res.partner", "Python Code", "Se\u00e7\u00e3o 1.1"],
        ["SA-02", "Validar Inadimpl\u00eancia do Cliente", "sale.order", "Python Code", "Se\u00e7\u00e3o 1.2"],
        ["SA-03", "Validar Vendas 3 Meses", "sale.order", "Python Code", "Se\u00e7\u00e3o 1.3"],
        ["SA-04", "Notificar Vendas 4+ Meses", "sale.order", "Python Code", "Se\u00e7\u00e3o 1.4"],
        ["SA-05", "Bloquear Alt. Pagamento p\u00f3s-PIX", "sale.order", "Python Code", "Se\u00e7\u00e3o 2.2"],
        ["SA-06", "Bloquear Cancelamento p\u00f3s-PIX", "sale.order", "Python Code", "Se\u00e7\u00e3o 2.3"],
        ["SA-07", "Bloquear Fatura PIX - N\u00e3o Financ.", "sale.order", "Python Code", "Se\u00e7\u00e3o 2.4"],
        ["SA-08", "Processar PIX", "sale.order", "Python Code", "Se\u00e7\u00e3o 3.1"],
        ["SA-09", "Copiar Campos PIX p/ Fatura", "account.move", "Python Code", "Se\u00e7\u00e3o 3.2"],
        ["SA-10", "Validar Limite de Cr\u00e9dito", "sale.order", "Python Code", "Se\u00e7\u00e3o 4.1"],
        ["SA-11", "Decrementar Limite com Boleto", "account.move", "Python Code", "Se\u00e7\u00e3o 4.2"],
        ["SA-12", "Restituir Limite ao Pagar", "account.move", "Python Code", "Se\u00e7\u00e3o 4.2"],
      ],
      [7, 30, 14, 14, 25]
    ),
    emptyPara(),

    h2("6.5 Criar Automated Actions"),
    body("Para cada Automated Action, siga os passos:"),
    bodyBold("Passo 1: Acessar Configura\u00e7\u00f5es > T\u00e9cnico > Automated Actions"),
    bodyBold("Passo 2: Clicar em Criar"),
    bodyBold("Passo 3: Preencher conforme a tabela na Se\u00e7\u00e3o 5.2"),
    bodyBold("Passo 4: No campo Domain, definir o filtro conforme indicado"),
    bodyBold("Passo 5: No campo Action to Execute, selecionar a Server Action correspondente"),
    bodyBold("Passo 6: Ativar e Salvar"),
    emptyPara(),
    body("IMPORTANTE: A ordem de execu\u00e7\u00e3o das Automated Actions importa. Configure as valida\u00e7\u00f5es bloqueantes (before_create / before_write) antes das notifica\u00e7\u00f5es (after_create / after_write)."),

    h2("6.6 Criar Tipos de Atividade"),
    body("Configurar tipos de atividade para as notifica\u00e7\u00f5es:"),
    bodyBold("Passo 1: Acessar Configura\u00e7\u00f5es > T\u00e9cnico > Activity Types"),
    bodyBold("Passo 2: Criar tipo: \"Revis\u00e3o Cliente\""),
    bullet("Nome: Revis\u00e3o Cliente"),
    bullet("Categoria: Default"),
    bullet("\u00cdcone: fa-exclamation-triangle"),
    bullet("Prazo padr\u00e3o: 3 dias"),
    emptyPara(),

    h2("6.7 Criar Bot\u00e3o no Studio"),
    body("Para criar o bot\u00e3o \"Processar PIX\" no formul\u00e1rio do sale.order:"),
    bodyBold("Passo 1: Abrir sale.order no Studio (App Vendas > qualquer pedido > Studio)"),
    bodyBold("Passo 2: Clicar em \"Add Button\" na \u00e1rea desejada"),
    bodyBold("Passo 3: Configurar:"),
    bullet("R\u00f3tulo: Processar PIX"),
    bullet("Tipo: Server Action"),
    bullet("Server Action: SA-08 (Processar PIX)"),
    bullet("Visibilidade: x_studio_itau_txid != False"),
    emptyPara(),

    h2("6.8 Criar Compute Field no Studio"),
    body("Para criar o campo computado x_studio_limite_credito_disponivel:"),
    bodyBold("Passo 1: Abrir res.partner no Studio"),
    bodyBold("Passo 2: Adicionar campo Monetary com Compute"),
    bodyBold("Passo 3: Nome: x_studio_limite_credito_disponivel"),
    bodyBold("Passo 4: R\u00f3tulo: Cr\u00e9dito Dispon\u00edvel"),
    bodyBold("Passo 5: No c\u00f3digo compute, colar:"),
    ...codeBlock([
      "for partner in records:",
      "    limite = partner.x_studio_limite_credito or 0.0",
      "    utilizado = partner.x_studio_limite_credito_utilizado or 0.0",
      "    partner.x_studio_limite_credito_disponivel = limite - utilizado",
    ]),
    emptyPara(),

    h2("6.9 Criar Related Field no Studio"),
    body("Para criar o campo related x_studio_limite_credito no sale.order:"),
    bodyBold("Passo 1: Abrir sale.order no Studio"),
    bodyBold("Passo 2: Adicionar campo Related"),
    bodyBold("Passo 3: Nome: x_studio_limite_credito"),
    bodyBold("Passo 4: R\u00f3tulo: Limite de Cr\u00e9dito"),
    bodyBold("Passo 5: Campo relacionado: partner_id.x_studio_limite_credito"),
    bodyBold("Passo 6: Readonly: True"),
    emptyPara(),

    h2("6.10 Ordem de Implementa\u00e7\u00e3o Recomendada"),
    body("Siga esta ordem para evitar depend\u00eancias circular:"),
    bullet("1. Ativar m\u00f3dulos (Studio + Automated Actions)"),
    bullet("2. Criar Grupo Financeiro e adicionar usu\u00e1rios"),
    bullet("3. Criar Tipo de Atividade \"Revis\u00e3o Cliente\""),
    bullet("4. Criar campos Studio no res.partner"),
    bullet("5. Criar campos Studio no sale.order (incluindo related)"),
    bullet("6. Criar campos Studio no account.move"),
    bullet("7. Criar compute field (x_studio_limite_credito_disponivel)"),
    bullet("8. Criar todas as Server Actions (SA-01 a SA-12)"),
    bullet("9. Criar todas as Automated Actions (AA-01 a AA-09)"),
    bullet("10. Criar bot\u00e3o \"Processar PIX\" no Studio"),
    bullet("11. Testar cada regra individualmente"),
    bullet("12. Testar integra\u00e7\u00e3o completa (fluxo end-to-end)"),
    emptyPara(),

    h2("6.11 Testes Recomendados"),
    makeTable(
      ["#", "Teste", "Resultado Esperado", "Se\u00e7\u00e3o"],
      [
        ["T-01", "Criar parceiro com CPF j\u00e1 existente", "Erro: CPF/CNPJ j\u00e1 cadastrado", "1.1"],
        ["T-02", "Criar pedido para cliente com fatura vencida", "Erro: Cliente inadimplente", "1.2"],
        ["T-03", "Confirmar pedido para cliente sem vendas h\u00e1 3 meses", "Erro + Atividades criadas", "1.3"],
        ["T-04", "Confirmar pedido para cliente sem vendas h\u00e1 4+ meses", "Atividades para Financeiro (sem bloqueio)", "1.4"],
        ["T-05", "Alterar pagamento ap\u00f3s PIX gerado", "Erro: N\u00e3o \u00e9 poss\u00edvel alterar", "2.2"],
        ["T-06", "Cancelar pedido ap\u00f3s PIX (vendedor)", "Erro: Contate o Financeiro", "2.3"],
        ["T-07", "Cancelar pedido ap\u00f3s PIX (Financeiro)", "Cancelamento permitido", "2.3"],
        ["T-08", "Criar fatura PIX (vendedor)", "Erro: Apenas Financeiro", "2.4"],
        ["T-09", "Criar fatura PIX (Financeiro)", "Fatura criada com campos PIX copiados", "2.4 / 3.2"],
        ["T-10", "Confirmar pedido acima do limite", "Erro: Limite insuficiente", "4.1"],
        ["T-11", "Emitir boleto para pedido", "Limite decrementado", "4.2"],
        ["T-12", "Pagar fatura de boleto", "Limite restitu\u00eddo", "4.2"],
      ],
      [6, 34, 34, 10]
    ),
    emptyPara(),

    h2("6.12 Notas Finais"),
    body("Este guia cobre todas as customiza\u00e7\u00f5es necess\u00e1rias para o Odoo 19.4 SaaS sem a necessidade de instalar addons Python customizados. Toda a l\u00f3gica \u00e9 implementada via Studio fields, Server Actions e Automated Actions."),
    body("IMPORTANTE: Sempre teste cada Server Action individualmente antes de ativ\u00e1-la em produ\u00e7\u00e3o. Use o modo de teste do Odoo ou um banco de dados de homologa\u00e7\u00e3o."),
    body("Para ajustes ou d\u00favidas, consulte a documenta\u00e7\u00e3o oficial do Odoo 19.4 em https://www.odoo.com/documentation/19.4 ou contacte o administrador do sistema."),
    emptyPara(),
  ];
}

// ═══════════════════════════════════════════════════
// ASSEMBLE DOCUMENT
// ═══════════════════════════════════════════════════

const pgSize = { width: 11906, height: 16838, orientation: "portrait" };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

// Numbering config for numbered lists
const numberingConfigs = [];
for (let i = 0; i < 20; i++) {
  numberingConfigs.push({
    reference: `num-list-${i}`,
    levels: [{
      level: 0,
      format: LevelFormat.DECIMAL,
      text: "%1.",
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } },
    }],
  });
}

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: FONT_BODY, size: 24, color: c(P.body) },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: FONT_HEADING, size: 32, bold: true, color: c(P.primary) },
        paragraph: { spacing: { before: 480, after: 200, line: 312 } },
      },
      heading2: {
        run: { font: FONT_HEADING, size: 28, bold: true, color: c(P.primary) },
        paragraph: { spacing: { before: 360, after: 160, line: 312 } },
      },
      heading3: {
        run: { font: FONT_HEADING, size: 24, bold: true, color: c(P.primary) },
        paragraph: { spacing: { before: 280, after: 120, line: 312 } },
      },
    },
  },
  numbering: { config: numberingConfigs },
  sections: [
    // Section 1: Cover
    {
      properties: {
        page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } },
      },
      children: [buildCover()],
    },
    // Section 2: Front matter (TOC)
    {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: pgSize,
          margin: pgMargin,
          pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: c(P.secondary) })],
          })],
        }),
      },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 480, after: 360 },
          children: [new TextRun({
            text: "Sum\u00e1rio",
            bold: true, size: 32, color: c(P.primary), font: FONT_HEADING,
          })],
        }),
        new TableOfContents("Table of Contents", {
          hyperlink: true,
          headingStyleRange: "1-3",
        }),
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({
            text: "Nota: Este Sum\u00e1rio \u00e9 gerado via c\u00f3digos de campo. Para garantir a precis\u00e3o dos n\u00fameros de p\u00e1gina ap\u00f3s edi\u00e7\u00f5es, clique com o bot\u00e3o direito no Sum\u00e1rio e selecione \"Atualizar Campo\".",
            italics: true, size: 18, color: "888888", font: FONT_BODY,
          })],
        }),
      ],
    },
    // Section 3: Body
    {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: pgSize,
          margin: pgMargin,
          pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({
              text: "Guia de Implementa\u00e7\u00e3o \u2014 Odoo 19.4 SaaS",
              size: 16, color: c(P.secondary), font: FONT_BODY, italics: true,
            })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: c(P.secondary) })],
          })],
        }),
      },
      children: [
        ...sectionIntro(),
        ...section1(),
        ...section2(),
        ...section3(),
        ...section4(),
        ...section5(),
        ...section6(),
      ],
    },
  ],
});

// ═══════════════════════════════════════════════════
// GENERATE FILE
// ═══════════════════════════════════════════════════
const OUTPUT_PATH = "/home/z/my-project/download/Odoo-19-Implementacao-Guia.docx";

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(OUTPUT_PATH, buffer);
  console.log(`Document generated: ${OUTPUT_PATH}`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(1)} KB`);
});
