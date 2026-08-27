# -*- coding: utf-8 -*-
from odoo import api, fields, models, _
from odoo.exceptions import UserError
import logging
import requests
import re

_logger = logging.getLogger(__name__)


class CrmLead(models.Model):
    _inherit = 'crm.lead'

    # ===================================================================
    # CAMPOS CUSTOMIZADOS (o CRM Lead não tem os campos l10n_br nativos,
    # então criamos apenas os que precisamos para controle visual no lead.
    # Ao converter o lead, os dados vão para o res.partner com os campos
    # l10n_br nativos: vat, l10n_br_ie_code, l10n_br_tax_regime, etc.)
    # ===================================================================

    aliquota_icms = fields.Selection(
        selection=[
            ('12', '12% - Possui IE'),
            ('19', '19% - Sem IE (Não contribuinte)'),
        ],
        string='Alíquota ICMS-ST',
        default='19',
        tracking=True,
    )
    has_ie = fields.Boolean(
        string='Possui IE Ativa',
        default=False,
        tracking=True,
    )
    cnpj_cpf = fields.Char(
        string='CNPJ/CPF',
        size=18,
        help='CNPJ do lead. Digite apenas números para auto-consulta.',
    )
    l10n_br_ie_code = fields.Char(
        string='Inscrição Estadual',
        size=20,
    )
    l10n_br_tax_regime = fields.Selection(
        selection=[
            ('1', 'Lucro real'),
            ('2', 'Lucro presumido'),
            ('3', 'Optante do SIMPLES'),
            ('4', 'Optante do SIMPLES com limite de faturamento bruto'),
            ('5', 'Empreendedor do Simples Nacional'),
            ('6', 'Não aplicável'),
            ('7', 'Indivíduo'),
            ('8', 'Variável'),
        ],
        string='Regime Tributário',
    )
    l10n_br_taxpayer = fields.Selection(
        selection=[
            ('1', 'Contribuinte do ICMS'),
            ('2', 'Contribuinte isento'),
            ('3', 'Não contribuinte'),
        ],
        string='Tipo de Contribuinte',
    )
    is_mei = fields.Boolean(string='MEI', default=False)
    cnae = fields.Char(string='CNAE Principal')
    natureza_juridica = fields.Char(string='Natureza Jurídica')
    cnpja_consulted = fields.Boolean(string='Consultado via CNP Já', default=False)

    # ====== CONFIGURAÇÃO DO MIDDLEWARE ======

    def _get_middleware_url(self):
        return self.env['ir.config_parameter'].sudo().get_param(
            'cnpja.middleware.url', 'http://localhost:3000'
        ).rstrip('/')

    def _get_middleware_api_key(self):
        return self.env['ir.config_parameter'].sudo().get_param(
            'cnpja.middleware.api_key', 'cnpja-odoo-secret-key-change-me'
        )

    # ====== BOTÃO DE CONSULTA NO CRM ======

    def action_consultar_cnpj_crm(self):
        """
        Ação do botão 'Consultar CNPJ' no CRM Lead.
        Consulta o CNP Já e preenche os campos do lead + parceiro associado.
        Os dados no parceiro usam campos nativos l10n_br.
        """
        self.ensure_one()

        if not self.cnpj_cpf:
            raise UserError(_('Informe o CNPJ antes de consultar.'))

        cnpj = re.sub(r'\D', '', str(self.cnpj_cpf))
        if len(cnpj) != 14:
            raise UserError(_('CNPJ deve conter 14 dígitos numéricos.'))

        # Consulta o middleware
        try:
            url = f"{self._get_middleware_url()}/api/v1/consultar/{cnpj}"
            headers = {'X-API-Key': self._get_middleware_api_key()}

            _logger.info(f"CNPJá CRM: Consultando CNPJ {cnpj}")
            response = requests.get(url, headers=headers, timeout=15)
            response.raise_for_status()
            data = response.json()

            if not data.get('success'):
                raise UserError(data.get('error', 'Erro na consulta'))

            cnpja_data = data.get('data', {})

        except requests.exceptions.ConnectionError:
            raise UserError(_('Erro de conexão com o middleware CNP Já.'))
        except requests.exceptions.Timeout:
            raise UserError(_('Timeout ao consultar CNP Já.'))
        except UserError:
            raise
        except Exception as e:
            raise UserError(_('Erro ao consultar CNP Já: %s') % str(e))

        # ---- Preenche os dados do Lead (campos visuais) ----
        vals = {
            'partner_name': cnpja_data.get('name', ''),
            'cnpj_cpf': cnpja_data.get('vat', ''),
            'l10n_br_ie_code': cnpja_data.get('l10n_br_ie_code', ''),
            'has_ie': cnpja_data.get('has_ie', False),
            'aliquota_icms': str(cnpja_data.get('aliquota_icms', 19)),
            'l10n_br_tax_regime': cnpja_data.get('l10n_br_tax_regime', '1'),
            'l10n_br_taxpayer': cnpja_data.get('l10n_br_taxpayer', '3'),
            'natureza_juridica': cnpja_data.get('natureza_juridica', ''),
            'is_mei': cnpja_data.get('is_mei', False),
            'cnae': cnpja_data.get('cnae', ''),
            'cnpja_consulted': True,
        }

        # Endereço do lead
        vals.update({
            'street': cnpja_data.get('street', '') or False,
            'street2': cnpja_data.get('street2', '') or False,
            'city': cnpja_data.get('city', '') or False,
            'state_id': self._get_state_id(cnpja_data.get('state', '')),
            'country_id': self._get_country_id(),
            'zip': cnpja_data.get('zip', '') or False,
            'phone': cnpja_data.get('phone', '') or False,
            'mobile': cnpja_data.get('mobile', '') or False,
            'email_from': cnpja_data.get('email', '') or False,
        })

        # Comentário com regra de imposto
        aliquota = cnpja_data.get('aliquota_icms', 19)
        has_ie = cnpja_data.get('has_ie', False)
        comment = cnpja_data.get('comment', '')
        regra_msg = (
            f"\n\nREGRA DE IMPOSTO APLICADA:\n"
            f"- Aliquota ICMS-ST: {aliquota}%\n"
            f"- Motivo: {'Possui IE ativa' if has_ie else 'Nao possui IE (Nao contribuinte / Isento)'}\n"
            f"- Tipo de pessoa: PJ (Empresa)"
        )
        if comment:
            vals['description'] = comment + regra_msg
        else:
            vals['description'] = regra_msg.strip()

        self.write(vals)

        # ---- Se o lead tem parceiro associado, preenche com campos l10n_br ----
        if self.partner_id:
            partner_vals = {
                'name': cnpja_data.get('name', ''),
                'is_company': True,
                'company_type': 'company',
                'vat': cnpja_data.get('vat', ''),                   # vat (CNPJ formatado)
                'l10n_br_ie_code': cnpja_data.get('l10n_br_ie_code', ''),  # l10n_br_ie_code
                'l10n_br_tax_regime': cnpja_data.get('l10n_br_tax_regime', '1'),
                'l10n_br_taxpayer': cnpja_data.get('l10n_br_taxpayer', '3'),
                'has_ie': cnpja_data.get('has_ie', False),
                'aliquota_icms': str(cnpja_data.get('aliquota_icms', 19)),
                'natureza_juridica': cnpja_data.get('natureza_juridica', ''),
                'is_mei': cnpja_data.get('is_mei', False),
                'cnae': cnpja_data.get('cnae', ''),
                'situacao_cadastral': cnpja_data.get('situacao_cadastral', ''),
                'suframa': cnpja_data.get('suframa', ''),
                'cnpja_consulted': True,
                'cnpja_consulted_at': fields.Datetime.now(),
            }

            # Endereço do parceiro com relações
            country_id = self.partner_id._get_country_id('BR')
            state_id = self.partner_id._get_state_id(
                cnpja_data.get('state', ''), country_id
            )
            city_id = self.partner_id._get_city_id(
                cnpja_data.get('city', ''), state_id
            )
            partner_vals.update({
                'street': cnpja_data.get('street', '') or False,
                'street2': cnpja_data.get('street2', '') or False,
                'city_id': city_id,
                'state_id': state_id,
                'country_id': country_id,
                'zip': cnpja_data.get('zip', '') or False,
                'phone': cnpja_data.get('phone', '') or False,
                'email': cnpja_data.get('email', '') or False,
            })

            self.partner_id.write(partner_vals)

        # Retorna notificação
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('CNPJá - CRM Consulta OK'),
                'message': _(
                    'Dados atualizados com sucesso!\n'
                    'Empresa: %(name)s\n'
                    'CNPJ: %(vat)s\n'
                    'IE: %(ie)s | ICMS-ST: %(aliq)s%%\n'
                    'Regime: %(regime)s | Contribuinte: %(taxpayer)s\n'
                    'Salvo como PJ (Empresa)'
                ) % {
                    'name': self.partner_name,
                    'vat': self.cnpj_cpf or '',
                    'ie': self.l10n_br_ie_code or 'ISENTO',
                    'aliq': aliquota,
                    'regime': self.l10n_br_tax_regime or '',
                    'taxpayer': self.l10n_br_taxpayer or '',
                },
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.act_view_reload'},
            },
        }

    # ====== ONCHANGE NO CNPJ DO CRM ======

    @api.onchange('cnpj_cpf')
    def _onchange_cnpj_cnpj(self):
        """Auto-consulta quando CNPJ é preenchido no CRM."""
        if not self.cnpj_cpf or self.cnpja_consulted:
            return

        cnpj = re.sub(r'\D', '', str(self.cnpj_cpf))
        if len(cnpj) != 14:
            return

        try:
            url = f"{self._get_middleware_url()}/api/v1/consultar/{cnpj}"
            headers = {'X-API-Key': self._get_middleware_api_key()}

            response = requests.get(url, headers=headers, timeout=15)
            response.raise_for_status()
            data = response.json()

            if not data.get('success'):
                return

            cnpja_data = data.get('data', {})

            # Preenche campos do lead
            self.partner_name = cnpja_data.get('name', '')
            self.cnpj_cpf = cnpja_data.get('vat', '')
            self.l10n_br_ie_code = cnpja_data.get('l10n_br_ie_code', '')
            self.has_ie = cnpja_data.get('has_ie', False)
            self.aliquota_icms = str(cnpja_data.get('aliquota_icms', 19))
            self.l10n_br_tax_regime = cnpja_data.get('l10n_br_tax_regime', '1')
            self.l10n_br_taxpayer = cnpja_data.get('l10n_br_taxpayer', '3')
            self.natureza_juridica = cnpja_data.get('natureza_juridica', '')
            self.is_mei = cnpja_data.get('is_mei', False)
            self.cnae = cnpja_data.get('cnae', '')

            self.street = cnpja_data.get('street', '') or False
            self.street2 = cnpja_data.get('street2', '') or False
            self.city = cnpja_data.get('city', '') or False
            self.zip = cnpja_data.get('zip', '') or False
            self.phone = cnpja_data.get('phone', '') or False
            self.email_from = cnpja_data.get('email', '') or False

            aliquota = cnpja_data.get('aliquota_icms', 19)
            return {
                'warning': {
                    'title': _('CNPJá - Dados Encontrados'),
                    'message': _(
                        'Empresa "%(name)s" carregada.\n'
                        'CNPJ: %(vat)s\n'
                        'IE: %(ie)s\n'
                        'Regime: %(regime)s | Contribuinte: %(taxpayer)s\n'
                        'ICMS-ST: %(aliq)s%% (%(motivo)s).\n'
                        'Clique em "Salvar" para confirmar.'
                    ) % {
                        'name': self.partner_name,
                        'vat': self.cnpj_cpf or '',
                        'ie': self.l10n_br_ie_code or 'ISENTO',
                        'regime': self.l10n_br_tax_regime or '',
                        'taxpayer': self.l10n_br_taxpayer or '',
                        'aliq': aliquota,
                        'motivo': 'Possui IE' if self.has_ie else 'Sem IE',
                    },
                },
            }
        except Exception as e:
            _logger.warning(f"CNPJá CRM: Auto-consulta falhou para {cnpj}: {e}")

    # ====== AUXILIARES ======

    @api.model
    def _get_country_id(self):
        country = self.env['res.country'].search([('code', '=', 'BR')], limit=1)
        return country.id if country else False

    @api.model
    def _get_state_id(self, state_code):
        if not state_code or len(state_code) != 2:
            return False
        state = self.env['res.country.state'].search(
            [('code', '=', state_code.upper())], limit=1
        )
        return state.id if state else False
