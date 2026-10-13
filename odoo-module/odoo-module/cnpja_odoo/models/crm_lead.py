# -*- coding: utf-8 -*-
from odoo import api, fields, models, _
from odoo.exceptions import UserError
from psycopg2.errors import SerializationFailure
import logging
import requests
import re
import time
import random

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

    # ===================================================================
    # DIFF-GUARD: compara valores propostos com atuais, retorna só mudanças
    # ===================================================================

    @api.model
    def _normalize_cep(self, val):
        """Normaliza CEP: remove não-dígitos."""
        if not val:
            return ''
        return re.sub(r'\D', '', str(val))

    @api.model
    def _normalize_cnpj(self, val):
        """Normaliza CNPJ: remove não-dígitos."""
        if not val:
            return ''
        return re.sub(r'\D', '', str(val))

    @api.model
    def _normalize_str(self, val):
        """Normaliza string: strip + None/False → ''"""
        if val is None or val is False:
            return ''
        return str(val).strip()

    def _diff_guard(self, proposed_vals):
        """
        Diff-guard: compara valores propostos com atuais no registro.
        Retorna dict com apenas os campos que realmente mudaram.
        """
        self.ensure_one()

        if not proposed_vals:
            return {}

        field_names = list(proposed_vals.keys())
        current_data = self.read(field_names, load=False)[0]

        changed = {}
        for field, proposed in proposed_vals.items():
            current = current_data.get(field)

            # many2one: comparar pelo ID
            if field in ('state_id', 'country_id', 'city_id'):
                current_id = current[0] if isinstance(current, (list, tuple)) and current else (current or 0)
                proposed_id = proposed if proposed else 0
                if current_id != proposed_id:
                    changed[field] = proposed
                continue

            # CEP (zip): comparar normalizado
            if field == 'zip':
                if self._normalize_cep(current) != self._normalize_cep(proposed):
                    changed[field] = proposed
                continue

            # CNPJ: comparar normalizado
            if field in ('cnpj_cpf', 'vat'):
                if self._normalize_cnpj(current) != self._normalize_cnpj(proposed):
                    changed[field] = proposed
                continue

            # Boolean
            if isinstance(proposed, bool):
                if bool(current) != proposed:
                    changed[field] = proposed
                continue

            # Number
            if isinstance(proposed, (int, float)) and not isinstance(proposed, bool):
                try:
                    if float(current or 0) != float(proposed):
                        changed[field] = proposed
                except (ValueError, TypeError):
                    changed[field] = proposed
                continue

            # String: comparar com trim
            if self._normalize_str(current) != self._normalize_str(proposed):
                changed[field] = proposed

        if not changed:
            _logger.info(
                f"DIFF-GUARD: crm.lead ID {self.id} - write ignorado (sem mudancas). "
                f"Campos verificados: {', '.join(field_names)}"
            )
        elif len(changed) < len(proposed_vals):
            unchanged = [f for f in field_names if f not in changed]
            _logger.info(
                f"DIFF-GUARD: crm.lead ID {self.id} - "
                f"{len(unchanged)} campo(s) inalterado(s) removido(s): {', '.join(unchanged)}"
            )

        return changed

    # ===================================================================
    # RETRY com backoff + jitter para SerializationFailure
    # ===================================================================

    def _write_with_retry(self, vals, max_retries=3, label='crm.lead'):
        """
        Escreve no registro com diff-guard + retry em colisão.

        Fluxo:
          1. Diff-guard: filtra só campos que mudaram
          2. Se nenhum mudou: retorna sem write
          3. Se há mudanças: write com retry em SerializationFailure
          4. Antes de cada retry: re-executa diff-guard
          5. Backoff: ~0.5s → ~1.5s → ~4s (±30% jitter)

        :param vals: dict com campos e valores a escrever
        :param max_retries: max tentativas extras (default: 3)
        :param label: rótulo para logs
        :returns: dict com { updated, campos_atualizados, motivo }
        """
        self.ensure_one()

        if not vals:
            return {'updated': False, 'campos_atualizados': [], 'motivo': 'sem_valores'}

        # Diff-guard inicial
        changed = self._diff_guard(vals)
        if not changed:
            return {'updated': False, 'campos_atualizados': [], 'motivo': 'sem_mudancas'}

        changed_fields = list(changed.keys())
        last_error = None

        for attempt in range(max_retries + 1):
            try:
                # Re-executar diff-guard antes de cada retry (exceto a primeira)
                if attempt > 0:
                    self.invalidate_cache()
                    changed = self._diff_guard(vals)
                    if not changed:
                        _logger.info(
                            f"RETRY: {label} ID {self.id} - virou no-op após "
                            f"tentativa {attempt}, encerrando com sucesso."
                        )
                        return {'updated': False, 'campos_atualizados': [], 'motivo': 'sem_mudancas'}
                    changed_fields = list(changed.keys())

                self.write(changed)
                _logger.info(
                    f"{label} ID {self.id} escrito com sucesso. "
                    f"Campos: {', '.join(changed_fields)}"
                )
                return {
                    'updated': True,
                    'campos_atualizados': changed_fields,
                    'motivo': None,
                }

            except SerializationFailure as e:
                last_error = e
                if attempt < max_retries:
                    base_delay = 0.5 * (3 ** attempt)
                    jitter = 1 + (random.random() * 0.6 - 0.3)
                    delay = base_delay * jitter
                    _logger.warning(
                        f"RETRY: {label} ID {self.id} - SerializationFailure "
                        f"na tentativa {attempt + 1}/{max_retries + 1}: {str(e)}. "
                        f"Retry em {delay:.2f}s"
                    )
                    time.sleep(delay)
                else:
                    _logger.error(
                        f"RETRY: {label} ID {self.id} - Esgotou {max_retries + 1} "
                        f"tentativas após SerializationFailure: {str(e)}"
                    )

            except Exception as e:
                err_msg = str(e).lower()
                if 'access denied' in err_msg or 'permission' in err_msg:
                    _logger.error(
                        f"WRITE: {label} ID {self.id} - erro de permissão (não retriable): {str(e)}"
                    )
                elif 'validation' in err_msg or 'missing' in err_msg:
                    _logger.error(
                        f"WRITE: {label} ID {self.id} - erro de validação (não retriable): {str(e)}"
                    )
                else:
                    _logger.error(
                        f"WRITE: {label} ID {self.id} - erro não retriable: {str(e)}"
                    )
                raise

        return {
            'updated': False,
            'campos_atualizados': [],
            'motivo': 'erro_escrita',
            'erro': str(last_error),
        }

    # ====== BOTÃO DE CONSULTA NO CRM ======

    def action_consultar_cnpj_crm(self):
        """
        Ação do botão 'Consultar CNPJ' no CRM Lead.
        Consulta o CNP Já e preenche os campos do lead + parceiro associado.
        Os dados no parceiro usam campos nativos l10n_br.

        v2.0: writes independentes (lead e partner separados),
              cada um com diff-guard + retry próprio.
              A falha de um NÃO impede nem reverte o outro.
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

        # ---- Write INDEPENDENTE 1: Lead ----
        vals_lead = {
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
        vals_lead.update({
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
            vals_lead['description'] = comment + regra_msg
        else:
            vals_lead['description'] = regra_msg.strip()

        lead_result = self._write_with_retry(vals_lead, label='CRM.lead')
        _logger.info(
            f"CNPJá CRM: Lead ID {self.id} - updated={lead_result.get('updated')}, "
            f"motivo={lead_result.get('motivo', 'ok')}, "
            f"campos={lead_result.get('campos_atualizados', [])}"
        )

        # ---- Write INDEPENDENTE 2: Parceiro associado ----
        partner_result = {'updated': False, 'campos_atualizados': [], 'motivo': 'sem_partner'}
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

            # Use partner's _write_with_retry (from res_partner.py)
            partner_result = self.partner_id._write_with_retry(partner_vals)
            _logger.info(
                f"CNPJá CRM: Partner ID {self.partner_id.id} - "
                f"updated={partner_result.get('updated')}, "
                f"motivo={partner_result.get('motivo', 'ok')}, "
                f"campos={partner_result.get('campos_atualizados', [])}"
            )

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
