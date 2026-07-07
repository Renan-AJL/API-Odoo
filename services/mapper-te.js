/**
 * services/mapper-te.js - Mapeamento Odoo <-> TudoEntregue
 */
var logger = require('../utils/logger');
var ORDER_TYPES = require('./tudoentregue').ORDER_TYPES;

/**
 * Mapeia picking Odoo + partner para o formato TE
 */
function odooToTeDelivery(picking, partner, saleOrder) {
  if (!picking || !partner) return null;

  // Monta endereco de entrega
  var rua = (partner.x_studio_te_logradouro || '') + (partner.x_studio_te_numero ? ', ' + partner.x_studio_te_numero : '');
  var complemento = partner.x_studio_te_complemento || '';
  var bairro = partner.x_studio_te_bairro || '';
  var cidade = partner.x_studio_te_municipio || (partner.city || '');
  var uf = partner.x_studio_te_uf || (partner.state_id ? partner.state_id[1] : '');
  if (uf && uf.length > 2) uf = uf.substring(0, 2);
  var cep = partner.x_studio_te_cep || (partner.zip || '').replace(/\D/g, '');

  var telefone = partner.x_studio_te_telefone || partner.phone || partner.mobile || '';
  telefone = String(telefone).replace(/\D/g, '');

  var cnpjCpf = partner.x_studio_te_cnpj_cpf || (partner.cnpj_cpf || '').replace(/\D/g, '') || (partner.vat || '').replace(/\D/g, '');

  var delivery = {
    CodigoPedido: picking.name || '',
    TipoPedido: ORDER_TYPES.VENDA,
    CnpjCpfDestinatario: cnpjCpf,
    NomeDestinatario: partner.x_studio_te_razao_social || partner.name || '',
    InscricaoEstadual: partner.x_studio_te_inscricao_estadual || '',
    Telefone: telefone,
    Email: partner.x_studio_te_email || partner.email || '',
    Logradouro: rua,
    Numero: partner.x_studio_te_numero || '',
    Complemento: complemento,
    Bairro: bairro,
    Municipio: cidade,
    Uf: uf,
    Cep: cep,
    Latitude: partner.x_studio_te_latitude || '',
    Longitude: partner.x_studio_te_longitude || '',
    Observacao: picking.x_studio_te_observacao || picking.note || '',
  };

  // Dados do sale order se disponivel
  if (saleOrder) {
    delivery.PesoTotal = saleOrder.x_studio_te_peso_total || '';
    delivery.QtdVolumes = saleOrder.x_studio_te_qtd_volumes || '';
    delivery.ValorFrete = saleOrder.x_studio_te_valor_frete || '';
    delivery.DataEntrega = saleOrder.x_studio_te_data_entrega || '';
  }

  // Se o picking tem campos TE preenchidos, usa-os
  if (picking.x_studio_te_peso_total) delivery.PesoTotal = picking.x_studio_te_peso_total;
  if (picking.x_studio_te_qtd_volumes) delivery.QtdVolumes = picking.x_studio_te_qtd_volumes;
  if (picking.x_studio_te_valor_frete) delivery.ValorFrete = picking.x_studio_te_valor_frete;
  if (picking.x_studio_te_data_entrega) delivery.DataEntrega = picking.x_studio_te_data_entrega;

  return delivery;
}

/**
 * Mapeia resposta do TE para campos do picking Odoo
 */
function teToOdooPicking(teDelivery) {
  if (!teDelivery) return {};
  var data = {};
  if (teDelivery.Id) data.x_studio_te_order_id = String(teDelivery.Id);
  if (teDelivery.Situacao !== undefined && teDelivery.Situacao !== null) {
    data.x_studio_te_situacao = teDelivery.Situacao;
  }
  if (teDelivery.SituacaoDescricao) data.x_studio_te_situacao_desc = teDelivery.SituacaoDescricao;
  if (teDelivery.DataEntrega) data.x_studio_te_data_entrega = teDelivery.DataEntrega;
  if (teDelivery.ValorFrete !== undefined) data.x_studio_te_valor_frete = teDelivery.ValorFrete;
  if (teDelivery.PesoTotal !== undefined) data.x_studio_te_peso_total = teDelivery.PesoTotal;
  if (teDelivery.QtdVolumes !== undefined) data.x_studio_te_qtd_volumes = teDelivery.QtdVolumes;
  if (teDelivery.ProtocoloColeta) data.x_studio_te_protocolo_coleta = teDelivery.ProtocoloColeta;
  if (teDelivery.DataColeta) data.x_studio_te_data_coleta = teDelivery.DataColeta;
  if (teDelivery.NomeMotorista) data.x_studio_te_nome_motorista = teDelivery.NomeMotorista;
  if (teDelivery.PlacaVeiculo) data.x_studio_te_placa_veiculo = teDelivery.PlacaVeiculo;
  if (teDelivery.Rastreio) data.x_studio_te_rastreio = teDelivery.Rastreio;
  if (teDelivery.Ocorrencia) data.x_studio_te_observacao = teDelivery.Ocorrencia;
  return data;
}

/**
 * Mapeia resposta do TE para campos do sale.order Odoo
 */
function teToOdooSaleOrder(teDelivery) {
  if (!teDelivery) return {};
  var data = {};
  if (teDelivery.Id) data.x_studio_te_order_id = String(teDelivery.Id);
  if (teDelivery.Situacao !== undefined && teDelivery.Situacao !== null) {
    data.x_studio_te_situacao = teDelivery.Situacao;
  }
  if (teDelivery.SituacaoDescricao) data.x_studio_te_situacao_desc = teDelivery.SituacaoDescricao;
  if (teDelivery.DataEntrega) data.x_studio_te_data_entrega = teDelivery.DataEntrega;
  if (teDelivery.ValorFrete !== undefined) data.x_studio_te_valor_frete = teDelivery.ValorFrete;
  if (teDelivery.PesoTotal !== undefined) data.x_studio_te_peso_total = teDelivery.PesoTotal;
  if (teDelivery.QtdVolumes !== undefined) data.x_studio_te_qtd_volumes = teDelivery.QtdVolumes;
  if (teDelivery.ProtocoloColeta) data.x_studio_te_protocolo_coleta = teDelivery.ProtocoloColeta;
  if (teDelivery.DataColeta) data.x_studio_te_data_coleta = teDelivery.DataColeta;
  if (teDelivery.NomeMotorista) data.x_studio_te_nome_motorista = teDelivery.NomeMotorista;
  if (teDelivery.PlacaVeiculo) data.x_studio_te_placa_veiculo = teDelivery.PlacaVeiculo;
  if (teDelivery.Rastreio) data.x_studio_te_rastreio = teDelivery.Rastreio;
  return data;
}

/**
 * Normaliza payload do webhook TE
 */
function normalizeWebhookPayload(payload) {
  // TE pode enviar array ou objeto unico
  if (Array.isArray(payload)) return payload;
  if (payload && payload.entregas) return payload.entregas;
  if (payload && payload.Id) return [payload];
  return [];
}

module.exports = {
  odooToTeDelivery: odooToTeDelivery,
  teToOdooPicking: teToOdooPicking,
  teToOdooSaleOrder: teToOdooSaleOrder,
  normalizeWebhookPayload: normalizeWebhookPayload,
};