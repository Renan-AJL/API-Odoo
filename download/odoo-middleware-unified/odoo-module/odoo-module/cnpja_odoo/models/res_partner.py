# -*- coding: utf-8 -*-

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError
import logging
import requests
import json
import re

_logger = logging.getLogger(__name__)


class ResPartner(models.Model):
    _inherit = 'res.partner'

    # ===================================================================
    # CAMPOS CUSTOMIZADOS (apenas o que não existe nativamente no l10n_br)
    # ===================================================================
    # Campos nativos l10n_br já existentes que USAMOS:
    #   vat              → CNPJ/CPF
    #   l10n_br_ie_code  → Inscrição Estadual
    #   l10n_br_tax_regime → Regime tributário (selection)
    #   l10n_br_taxpayer → Tipo de contribuinte (selection)
    #   name, street, street2, zip, city_id, state_id, country_id
    #   phone, mobile, email

    ie_details = fields.Text(
        string='Detalhes das IEs',
        help='JSON com detalhes de todas as inscrições estaduais',
    )
    natureza_juridica = fields.Char(
        string='Natureza Jurídica',
    )
    porte_empresa = fields.Char(
        string='Porte da Empresa',
    )
    data_abertura = fields.Date(
        string='Data de Abertura',
    )
    data_situacao = fields.Date(
        string='Data da Situação',
    )
    situacao_cadastral = fields.Char(
        string='Situação Cadastral',
    )
    cnae = fields.Char(
        string='CNAE Principal',
    )
    cnaes_secundarios = fields.Text(
        string='CNAEs Secundários',
    )
    suframa = fields.Char(
        string='SUFRAMA',
    )

    # ---- REGRA DE IMPOSTO (EXTREMA IMPORTÂNCIA) ----
    aliquota_icms = fields.Selection(
        selection=[
            ('12', '12% - Possui IE'),
            ('19', '19% - Sem IE (Não contribuinte)'),
        ],
        string='Alíquota ICMS-ST',
        default='19',
        help='EXTREMA IMPORTÂNCIA: Se tem IE = 12%, Se não tem IE = 19%. '
             'Definido automaticamente pela consulta CNP Já.',
        tracking=True,
    )
    has_ie = fields.Boolean(
        string='Possui IE Ativa',
        default=False,
        tracking=True,
    )
    is_mei = fields.Boolean(
        string='MEI',
        default=False,
    )
    cnpja_consulted = fields.Boolean(
        string='Consultado via CNP Já',
        default=False,
    )
    cnpja_consulted_at = fields.Datetime(
        string='Data Consulta CNP Já',
    )

    # Sócios
    socio_ids = fields.One2many(
        'res.partner.socio',
        'partner_id',
        string='Quadro Societário',
    )

    # ====== CONFIGURAÇÃO DO MIDDLEWARE ======

    @api.model
    def _get_middleware_url(self):
        """Retorna a URL base do middleware."""
        return self.env['ir.config_parameter'].sudo().get_param(
            'cnpja.middleware.url', 'http://localhost:3000'
        ).rstrip('/')

    @api.model
    def _get_middleware_api_key(self):
        """Retorna a API Key para autenticar no middleware."""
        return self.env['ir.config_parameter'].sudo().get_param(
            'cnpja.middleware.api_key', 'cnpja-odoo-secret-key-change-me'
        )

    # ====== MÉTODOS DE CONSULTA ======

    def _consultar_cnpja(self, cnpj):
        """
        Consulta o middleware CNP Já e retorna os dados da empresa.
        :param cnpj: CNPJ (apenas números)
        :return: dict com dados da empresa (campos l10n_br)
        """
        cnpj = re.sub(r'\D', '', str(cnpj))

        if len(cnpj) != 14:
            raise ValidationError(_('CNPJ deve conter 14 dígitos numéricos.'))

        middleware_url = self._get_middleware_url()
        api_key = self._get_middleware_api_key()

        try:
            url = f"{middleware_url}/api/v1/consultar/{cnpj}"
            headers = {
                'X-API-Key': api_key,
                'Content-Type': 'application/json',
            }

            _logger.info(f"CNPJá: Consultando CNPJ {cnpj} via middleware {url}")

            response = requests.get(url, headers=headers, timeout=15)
            response.raise_for_status()

            data = response.json()

            if not data.get('success'):
                raise UserError(_(
                    "Erro na consulta CNP Já: %s"
                ) % data.get('error', 'Erro desconhecido'))

            _logger.info(f"CNPJá: Consulta realizada com sucesso para CNPJ {cnpj}")
            return data.get('data', {})

        except requests.exceptions.Timeout:
            raise UserError(_('Timeout ao consultar CNP Já. Verifique a conexão com o middleware.'))
        except requests.exceptions.ConnectionError:
            raise UserError(_(
                'Erro de conexão com o middleware CNP Já. '
                'Verifique se o serviço está rodando em: %s'
            ) % middleware_url)
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 404:
                raise UserError(_('CNPJ %s não encontrado na base do CNP Já.') % cnpj)
            if e.response.status_code in (401, 403):
                raise UserError(_('Erro de autenticação com o middleware. Verifique a API Key.'))
            raise UserError(_('Erro HTTP %s ao consultar CNP Já.') % str(e.response.status_code))
        except Exception as e:
            _logger.exception("Erro inesperado ao consultar CNP Já")
            raise UserError(_('Erro inesperado ao consultar CNP Já: %s') % str(e))

    # ===================================================================
    # PRENCHIMENTO DOS CAMPOS l10n_br DO PARCEIRO
    # ===================================================================

    def _preencher_dados_cnpja(self, cnpja_data):
        """
        Preenche os campos do res.partner com os dados do CNP Já.
        Usa campos nativos do l10n_br:
          vat, l10n_br_ie_code, l10n_br_tax_regime, l10n_br_taxpayer,
          name, street, zip, city_id, state_id, country_id
        """
        self.ensure_one()

        # ---- DADOS PRINCIPAIS (campos nativos Odoo + l10n_br) ----
        vals = {
            'name': cnpja_data.get('name', ''),
            'is_company': True,                     # SEMPRE PJ
            'company_type': 'company',
            'vat': cnpja_data.get('vat', ''),        # CNPJ formatado → vat
            'l10n_br_ie_code': cnpja_data.get('l10n_br_ie_code', ''),  # → l10n_br_ie_code
            'l10n_br_tax_regime': cnpja_data.get('l10n_br_tax_regime', '1'),  # → l10n_br_tax_regime
            'l10n_br_taxpayer': cnpja_data.get('l10n_br_taxpayer', '3'),      # → l10n_br_taxpayer
            'has_ie': cnpja_data.get('has_ie', False),
        }

        # ---- REGRA DE IMPOSTO (EXTREMA IMPORTÂNCIA) ----
        aliquota = cnpja_data.get('aliquota_icms', 19)
        vals['aliquota_icms'] = str(aliquota)

        # ---- DADOS COMPLEMENTARES ----
        vals.update({
            'natureza_juridica': cnpja_data.get('natureza_juridica', ''),
            'porte_empresa': cnpja_data.get('porte_empresa', ''),
            'is_mei': cnpja_data.get('is_mei', False),
            'cnae': cnpja_data.get('cnae', ''),
            'cnaes_secundarios': '\n'.join(cnpja_data.get('cnaes_secundarios', [])),
            'suframa': cnpja_data.get('suframa', ''),
            'situacao_cadastral': cnpja_data.get('situacao_cadastral', ''),
        })

        # Datas
        if cnpja_data.get('data_abertura'):
            vals['data_abertura'] = cnpja_data['data_abertura']
        if cnpja_data.get('data_situacao'):
            vals['data_situacao'] = cnpja_data['data_situacao']

        # IE detalhes
        if cnpja_data.get('ie_details'):
            vals['ie_details'] = json.dumps(
                cnpja_data['ie_details'], ensure_ascii=False, indent=2
            )

        # ---- ENDEREÇO (campos nativos Odoo) ----
        country_id = self._get_country_id('BR')
        state_id = self._get_state_id(cnpja_data.get('state', ''), country_id)
        city_id = self._get_city_id(cnpja_data.get('city', ''), state_id)

        vals.update({
            'street': cnpja_data.get('street', '') or False,
            'street2': cnpja_data.get('street2', '') or False,
            'city_id': city_id,
            'state_id': state_id,
            'country_id': country_id,
            'zip': cnpja_data.get('zip', '') or False,
        })

        # ---- CONTATO ----
        vals.update({
            'phone': cnpja_data.get('phone', '') or False,
            'mobile': cnpja_data.get('mobile', '') or False,
            'email': cnpja_data.get('email', '') or False,
        })

        # ---- COMENTÁRIO ----
        existing_comment = self.comment or ''
        new_comment = cnpja_data.get('comment', '')
        if new_comment:
            if existing_comment:
                vals['comment'] = f"{new_comment}\n\n--- Dados anteriores ---\n{existing_comment}"
            else:
                vals['comment'] = new_comment

        # ---- METADADOS ----
        vals.update({
            'cnpja_consulted': True,
            'cnpja_consulted_at': fields.Datetime.now(),
        })

        # ---- ATUALIZA O PARCEIRO ----
        self.write(vals)

        # ---- SÓCIOS ----
        self._salvar_socios(cnpja_data.get('members', []))

        _logger.info(
            f"CNPJá: Parceiro {self.name} atualizado com sucesso. "
            f"VAT={self.vat}, IE={self.l10n_br_ie_code or 'ISENTO'}, "
            f"Aliquota={aliquota}%, TaxRegime={vals.get('l10n_br_tax_regime')}, "
            f"Taxpayer={vals.get('l10n_br_taxpayer')}"
        )

    # ====== BOTÃO DE AÇÃO ======

    def action_consultar_cnpj(self):
        """
        Ação do botão 'Consultar CNPJ' no formulário do parceiro.
        Consulta o CNP Já e preenche todos os campos l10n_br automaticamente.
        """
        self.ensure_one()

        # Lê CNPJ do campo vat (pode ter formatação)
        cnpj = self.vat or ''
        if not cnpj:
            raise UserError(_('Informe o CNPJ (campo VAT) antes de consultar.'))

        cnpj = re.sub(r'\D', '', str(cnpj))

        if len(cnpj) != 14:
            raise UserError(_('CNPJ deve conter 14 dígitos numéricos.'))

        # Consulta o middleware
        cnpja_data = self._consultar_cnpja(cnpj)

        # Preenche os dados no parceiro
        self._preencher_dados_cnpja(cnpja_data)

        # Retorna notificação
        aliquota = cnpja_data.get('aliquota_icms', 19)
        has_ie = cnpja_data.get('has_ie', False)

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': _('CNPJá - Consulta Realizada'),
                'message': _(
                    'Dados atualizados com sucesso!\n'
                    'Empresa: %(name)s\n'
                    'CNPJ: %(vat)s\n'
                    'IE: %(ie)s\n'
                    'Regime: %(regime)s\n'
                    'Contribuinte: %(taxpayer)s\n'
                    'Alíquota ICMS: %(aliq)s%% (%(motivo)s)\n'
                    'Tipo: PJ (Empresa)'
                ) % {
                    'name': self.name,
                    'vat': self.vat or '',
                    'ie': self.l10n_br_ie_code or 'ISENTO',
                    'regime': dict(
                        self._fields['l10n_br_tax_regime'].get_description(self.env)
                    ).get(self.l10n_br_tax_regime, self.l10n_br_tax_regime) if self.l10n_br_tax_regime else '',
                    'taxpayer': dict(
                        self._fields['l10n_br_taxpayer'].get_description(self.env)
                    ).get(self.l10n_br_taxpayer, self.l10n_br_taxpayer) if self.l10n_br_taxpayer else '',
                    'aliq': aliquota,
                    'motivo': 'Possui IE' if has_ie else 'Sem IE - Não contribuinte',
                },
                'type': 'success',
                'sticky': False,
                'next': {'type': 'ir.actions.act_view_reload'},
            },
        }

    # ====== MÉTODOS AUXILIARES ======

    @api.model
    def _get_country_id(self, code='BR'):
        """Busca o país pela sigla."""
        country = self.env['res.country'].search([('code', '=', code)], limit=1)
        return country.id if country else False

    @api.model
    def _get_state_id(self, state_code, country_id=False):
        """Busca o estado pela sigla (UF)."""
        if not state_code or len(state_code) != 2:
            return False
        domain = [('code', '=', state_code.upper())]
        if country_id:
            domain.append(('country_id', '=', country_id))
        state = self.env['res.country.state'].search(domain, limit=1)
        return state.id if state else False

    @api.model
    def _get_city_id(self, city_name, state_id=False):
        """Busca a cidade pelo nome."""
        if not city_name or not state_id:
            return False
        city = self.env['res.city'].search([
            ('name', 'ilike', city_name),
            ('state_id', '=', state_id),
        ], limit=1)
        return city.id if city else False

    def _salvar_socios(self, members):
        """Salva os sócios no quadro societário."""
        if not members:
            return
        self.socio_ids.unlink()
        Socio = self.env['res.partner.socio']
        for member in members:
            if member.get('name'):
                Socio.create({
                    'partner_id': self.id,
                    'name': member.get('name', ''),
                    'role': member.get('role', ''),
                    'since': member.get('since', ''),
                })

    # ====== ONCHANGE NO VAT (CNPJ) ======

    @api.onchange('vat')
    def _onchange_vat_cnpja(self):
        """
        Quando o VAT (CNPJ) é preenchido no formulário, tenta auto-consultar.
        Chamado automaticamente pelo Odoo quando o campo muda.
        Usa campos nativos l10n_br para preencher.
        """
        if not self.vat:
            return

        cnpj = re.sub(r'\D', '', str(self.vat))

        # Só auto-consulta se tiver 14 dígitos (CNPJ)
        if len(cnpj) != 14:
            return

        # Se já consultou, não sobrescreve automaticamente
        if self.cnpja_consulted:
            return

        try:
            cnpja_data = self._consultar_cnpja(cnpj)

            # Preenche campos via onchange (sugestão visual, sem write)
            self.name = cnpja_data.get('name', '')
            self.is_company = True
            self.company_type = 'company'
            self.l10n_br_ie_code = cnpja_data.get('l10n_br_ie_code', '')
            self.l10n_br_tax_regime = cnpja_data.get('l10n_br_tax_regime', '1')
            self.l10n_br_taxpayer = cnpja_data.get('l10n_br_taxpayer', '3')
            self.has_ie = cnpja_data.get('has_ie', False)

            # Regra de imposto
            aliquota = cnpja_data.get('aliquota_icms', 19)
            self.aliquota_icms = str(aliquota)

            # Endereço (campos nativos Odoo)
            self.street = cnpja_data.get('street', '')
            self.street2 = cnpja_data.get('street2', '')
            self.zip = cnpja_data.get('zip', '')
            self.email = cnpja_data.get('email', '')
            self.phone = cnpja_data.get('phone', '')
            self.mobile = cnpja_data.get('mobile', '')

            # city_id e state_id via onchange (busca relacional)
            state_id = self._get_state_id(cnpja_data.get('state', ''))
            if state_id:
                self.state_id = state_id
                city_id = self._get_city_id(cnpja_data.get('city', ''), state_id)
                if city_id:
                    self.city_id = city_id

            country_id = self._get_country_id('BR')
            if country_id:
                self.country_id = country_id

            # Dados complementares
            self.natureza_juridica = cnpja_data.get('natureza_juridica', '')
            self.is_mei = cnpja_data.get('is_mei', False)
            self.cnae = cnpja_data.get('cnae', '')
            self.situacao_cadastral = cnpja_data.get('situacao_cadastral', '')
            self.suframa = cnpja_data.get('suframa', '')

            if cnpja_data.get('comment'):
                self.comment = cnpja_data['comment']

            # Mostra notificação
            regime = cnpja_data.get('l10n_br_tax_regime', '1')
            taxpayer = cnpja_data.get('l10n_br_taxpayer', '3')
            return {
                'warning': {
                    'title': _('CNPJá - Dados Encontrados'),
                    'message': _(
                        'Dados da empresa "%(name)s" foram carregados.\n'
                        'CNPJ: %(vat)s\n'
                        'IE: %(ie)s\n'
                        'Regime: %(regime)s | Contribuinte: %(taxpayer)s\n'
                        'Alíquota ICMS: %(aliq)s%% (%(motivo)s).\n'
                        'Clique em "Salvar" para confirmar ou use o botão '
                        '"Consultar CNPJ" para recarregar os dados.'
                    ) % {
                        'name': self.name,
                        'vat': self.vat or '',
                        'ie': self.l10n_br_ie_code or 'ISENTO',
                        'regime': regime,
                        'taxpayer': taxpayer,
                        'aliq': aliquota,
                        'motivo': 'Possui IE' if self.has_ie else 'Sem IE',
                    },
                },
            }

        except Exception as e:
            _logger.warning(f"CNPJá: Auto-consulta falhou para CNPJ {cnpj}: {str(e)}")
            # Silencioso no onchange - não bloqueia o formulário


class ResPartnerSocio(models.Model):
    """Modelo para Quadro Societário dos parceiros."""
    _name = 'res.partner.socio'
    _description = 'Sócios do Parceiro'
    _order = 'since asc'

    partner_id = fields.Many2one(
        'res.partner', string='Empresa', ondelete='cascade', required=True,
    )
    name = fields.Char(string='Nome do Sócio', required=True)
    role = fields.Char(string='Cargo')
    since = fields.Char(string='Desde')
