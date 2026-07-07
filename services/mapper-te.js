/**
 * services/mapper-te.js - Mapeamento Odoo <-> TudoEntregue v2
 * Conforme spec oficial Swagger v1.0.20
 *
 * POST /v1/orders exige (array de):
 *   Customer: { DocumentType, DocumentNumber }  <- CNPJ da empresa
 *   Driver:   { PhoneCountry, PhoneNumber, DefineDriverAfter }
 *   OrderType: 1=Entrega, 2=Coleta
 *   OrderID:   string (id unico do pedido no Odoo)
 *   OrderNumber: string (numero do pedido)
 *   OrderDescription: "NF-e" / "CT-e" etc
 *   DestinationAddress: { Name, Address, Address2, ZipCode, City, State, Country,
 *                          Responsibility, PhoneCountry, PhoneNumber, Email,
 *                          DocumentType, DocumentNumber, Latitude, Longitude }
 *   Documents: [{ DocumentID, DocumentNumber, DocumentDescription, Volumes: [] }]
 *   Observation, Volume, Weight, DeliveryDate, DeliveryStartTime, DeliveryEndTime
 */
var logger = require('../utils/logger');
var teApi = require('./tudoentregue');

/**
 * Mapeia picking Odoo + partner para OrderViewModel do TE
 */
function odooToTeDelivery(picking, partner, saleOrder, companyCnpj) {
  if (!picking || !partner) return null;

  // CNPJ do destinatario
  var docNumber = (partner.x_studio_te_cnpj_cpf || partner.cnpj_cpf || partner.vat || '').replace(/\D/g, '');
  var docType = docNumber.length > 11 ? 'CNPJ' : 'CPF';

  // Telefone destino
  var phone = (partner.x_studio_te_telefone || partner.phone || partner.mobile || '').replace(/\D/g, '');
  var phoneCountry = '+55';
  var phoneNumber = phone;
  if (phone.length > 11 && phone.startsWith('55')) {
    phoneCountry = '+' + phone.substring(0, 2);
    phoneNumber = phone.substring(2);
  }

  // Endereco destino
  var rua = partner.x_studio_te_logradouro || '';
  var numero = partner.x_studio_te_numero || '';
  // TE quer "Rua X, 71" no campo Address
  var address = rua;
  if (numero) address += ', ' + numero;

  var state = partner.x_studio_te_uf || '';
  if (!state && partner.state_id) {
    state = typeof partner.state_id === 'object' ? (partner.state_id[1] || '') : '';
    // Pega só a sigla
    if (state.length > 2) {
      var match = state.match(/\(([A-Z]{2})\)/);
      state = match ? match[1] : state.substring(0, 2);
    }
  }

  var delivery = {
    Customer: {
      DocumentType: 'CNPJ',
      DocumentNumber: (companyCnpj || '').replace(/\D/g, ''),
    },
    Driver: {
      PhoneCountry: '55',
      PhoneNumber: '99999999999',
      DefineDriverAfter: 1,  // 1 = definir motorista depois
    },
    OrderType: teApi.ORDER_TYPE.ENTREGA,  // 1 = Entrega
    OrderID: String(picking.id),
    OrderNumber: picking.name || '',
    OrderDescription: 'NF-e',
    DestinationAddress: {
      Name: partner.x_studio_te_razao_social || partner.name || '',
      Address: address || '',
      AdditionalInformation: partner.x_studio_te_complemento || '',
      Address2: partner.x_studio_te_bairro || '',
      ZipCode: (partner.x_studio_te_cep || partner.zip || '').replace(/\D/g, ''),
      City: partner.x_studio_te_municipio || partner.city || '',
      State: state,
      Country: 'Brasil',
      Responsibility: '',
      PhoneCountry: phoneCountry,
      PhoneNumber: phoneNumber,
      Email: partner.x_studio_te_email || partner.email || '',
      DocumentType: docType,
      DocumentNumber: docNumber,
      Latitude: partner.x_studio_te_latitude || null,
      Longitude: partner.x_studio_te_longitude || null,
    },
    Observation: picking.x_studio_te_observacao || picking.note || '',
  };

  // Peso e volumes
  var peso = picking.x_studio_te_peso_total || (saleOrder && saleOrder.x_studio_te_peso_total) || null;
  var volumes = picking.x_studio_te_qtd_volumes || (saleOrder && saleOrder.x_studio_te_qtd_volumes) || null;
  if (peso) delivery.Weight = parseFloat(peso) || 0;
  if (volumes) delivery.Volume = parseInt(volumes) || 0;

  // Data de entrega
  var dataEntrega = picking.x_studio_te_data_entrega || (saleOrder && saleOrder.x_studio_te_data_entrega) || '';
  if (dataEntrega) {
    delivery.DeliveryDate = dataEntrega.replace(' ', 'T');
  }

  return delivery;
}

/**
 * Mapeia resposta de criacao do TE para campos do picking Odoo
 * Response: OrderInsertUpdateReturn { OrderID, Received, TrackingCode, TrackingUrl }
 */
function teCreateToOdoo(teResponse) {
  if (!teResponse) return {};
  var data = {};
  if (teResponse.OrderID) data.x_studio_te_order_id = String(teResponse.OrderID);
  if (teResponse.TrackingCode) data.x_studio_te_rastreio = teResponse.TrackingCode;
  return data;
}

/**
 * Mapeia webhook TE para campos do picking Odoo
 * Webhook: "WebHook Padra Ocorrencia" {
 *   OrderID, OrderNumber, OrderDescription,
 *   Status: [{ Status, StatusDescription, Date }],
 *   Occurrences: [{ OccurrenceCode, OccurrenceName, OccurrenceDate, Observation, Latitude, Longitude }],
 *   Documents: [...]
 * }
 */
function teWebhookToOdoo(webhookData) {
  if (!webhookData) return {};
  var data = {};
  if (webhookData.OrderID) data.x_studio_te_order_id = String(webhookData.OrderID);

  // Pegar ultima situacao do array Status
  if (webhookData.Status && webhookData.Status.length) {
    var lastStatus = webhookData.Status[webhookData.Status.length - 1];
    if (lastStatus.Status !== undefined && lastStatus.Status !== null) {
      data.x_studio_te_situacao = lastStatus.Status;
    }
    if (lastStatus.StatusDescription) {
      data.x_studio_te_situacao_desc = lastStatus.StatusDescription;
    }
  }

  // Pegar ultima ocorrencia
  if (webhookData.Occurrences && webhookData.Occurrences.length) {
    var lastOcc = webhookData.Occurrences[webhookData.Occurrences.length - 1];
    if (lastOcc.Observation) {
      data.x_studio_te_observacao = lastOcc.Observation;
    }
    if (lastOcc.OccurrenceName) {
      data.x_studio_te_observacao = (data.x_studio_te_observacao ? data.x_studio_te_observacao + ' - ' : '') + lastOcc.OccurrenceName;
    }
  }

  // Motorista
  if (webhookData.Driver && webhookData.Driver.PhoneNumber && webhookData.Driver.PhoneNumber !== '99999999999') {
    data.x_studio_te_placa_veiculo = ''; // TE nao envia placa no webhook padrao
  }

  return data;
}

/**
 * Normaliza payload do webhook TE (pode ser array ou objeto)
 */
function normalizeWebhookPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && payload.OrderID) return [payload];
  return [];
}

/**
 * Gera mensagem de chatter para o resultado da criacao
 */
function chatterCreateMessage(teResponse, delivery) {
  var msg = '<b>TudoEntregue - Entrega criada!</b><br/>';
  msg += 'OrderID: ' + (teResponse.OrderID || 'N/A') + '<br/>';
  if (teResponse.TrackingCode) {
    msg += 'Codigo Rastreio: ' + teResponse.TrackingCode + '<br/>';
  }
  if (teResponse.TrackingUrl) {
    msg += '<a href="' + teResponse.TrackingUrl + '" target="_blank">Link de Acompanhamento</a><br/>';
  }
  msg += 'Pedido: ' + (delivery.OrderNumber || '') + '<br/>';
  if (delivery.DestinationAddress) {
    msg += 'Destinatario: ' + (delivery.DestinationAddress.Name || '') + '<br/>';
    msg += 'Cidade/UF: ' + (delivery.DestinationAddress.City || '') + '/' + (delivery.DestinationAddress.State || '') + '<br/>';
    msg += 'CEP: ' + (delivery.DestinationAddress.ZipCode || '');
  }
  return msg;
}

/**
 * Gera mensagem de chatter para webhook de atualizacao
 */
function chatterWebhookMessage(webhookData) {
  var msg = '<b>TudoEntregue - Atualizacao via Webhook</b><br/>';
  msg += 'OrderID: ' + (webhookData.OrderID || '') + '<br/>';
  msg += 'Pedido: ' + (webhookData.OrderNumber || '') + '<br/>';

  if (webhookData.Status && webhookData.Status.length) {
    var last = webhookData.Status[webhookData.Status.length - 1];
    msg += 'Situacao: ' + (last.StatusDescription || '') + '<br/>';
    if (last.Date) msg += 'Data: ' + last.Date;
  }

  if (webhookData.Occurrences && webhookData.Occurrences.length) {
    var lastOcc = webhookData.Occurrences[webhookData.Occurrences.length - 1];
    if (lastOcc.OccurrenceName) msg += '<br/>Ocorrencia: ' + lastOcc.OccurrenceName;
    if (lastOcc.Observation) msg += '<br/>Observacao: ' + lastOcc.Observation;
  }

  return msg;
}

module.exports = {
  odooToTeDelivery: odooToTeDelivery,
  teCreateToOdoo: teCreateToOdoo,
  teWebhookToOdoo: teWebhookToOdoo,
  normalizeWebhookPayload: normalizeWebhookPayload,
  chatterCreateMessage: chatterCreateMessage,
  chatterWebhookMessage: chatterWebhookMessage,
};