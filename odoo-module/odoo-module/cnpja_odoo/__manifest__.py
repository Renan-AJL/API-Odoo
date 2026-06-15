# -*- coding: utf-8 -*-
{
    "name": "CNPJá Odoo Integração",
    "version": "16.0.2.0.0",
    "summary": "Integração com CNP Já API para auto-preenchimento de parceiros via CNPJ no CRM",
    "description": """
        Este módulo integra o Odoo com a API do CNP Já para consulta automática
        de dados de empresas quando um CNPJ é adicionado no CRM.

        Usa campos nativos do l10n_br:
        - vat (CNPJ)
        - l10n_br_ie_code (Inscrição Estadual)
        - l10n_br_tax_regime (Regime tributário)
        - l10n_br_taxpayer (Tipo de contribuinte)
        - state_id, city_id, country_id, zip, street

        Funcionalidades:
        - Auto-preenchimento ao digitar CNPJ (campo VAT) no parceiro
        - Botão "Consultar CNPJ" no formulário do parceiro e do lead CRM
        - Regra de imposto automática: IE = 12%, Sem IE = 19%
        - Sempre cadastra como PJ (empresa), incluindo MEI
        - Preenche endereço, contatos, CNAE, quadro societário

        REGRA DE IMPOSTO (EXTREMA IMPORTÂNCIA):
        - Se tem IE (l10n_br_ie_code preenchido) → 12%
        - Se não tem IE → 19%
    """,
    "author": "CNPJá Odoo",
    "website": "https://github.com/seu-usuario/cnpja-odoo",
    "category": "Sales/CRM",
    "depends": [
        "base",
        "sale",
        "crm",
        "l10n_br_base",
    ],
    "data": [
        "security/ir.model.access.csv",
        "data/cnpja_data.xml",
        "views/res_partner_views.xml",
        "views/crm_lead_views.xml",
    ],
    "installable": True,
    "application": True,
    "license": "MIT",
    "external_dependencies": {
        "python": ["requests"],
    },
}
