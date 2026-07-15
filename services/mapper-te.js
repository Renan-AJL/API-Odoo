/**
 * services/mapper-te.js - Mapeamento Odoo <-> TudoEntregue v3
 * Conforme spec oficial Swagger v1.0.20
 *
 * POST /v1/orders exige (array de):
 *   Customer: { DocumentType, DocumentNumber }  <- CNPJ da empresa
 *   Driver:   { PhoneCountry, PhoneNumber, DefineDriverAfter }
 *   OrderType: 1=Entrega, 2=Coleta
 *   OrderID:   string (id unico do pedido no Odoo)
 *   OrderNumber: string (numero do pedido de venda)
 *   OrderDescription: "NF-e"
 *   SourceAddress: { Name, Address, Address2, ZipCode, City, State, Country, ... }  <- REMETENTE
 *   DestinationAddress: { Name, Address, Address2, ZipCode, City, State, Country,
 *                          Responsibility, PhoneCountry, PhoneNumber, Email, ... }
 *   Documents: [{ DocumentID, DocumentNumber, DocumentDescription,
 *                 Volumes: [{ VolumeID, Count, Unity, Description }] }]
 *   DepartureDate, DeliveryDate, DeliveryStartTime, DeliveryEndTime,
 *   Observation, Volume, Weight, CubicMeters, Sequence
 */
var logger = require('../utils/logger');
var teApi = require('./tudoentregue');

// Dados fixos da matriz AJL (fallback caso res.company nao retorne)
var MATRIX_FALLBACK = {
  name: 'AJL FERRO E ACO LTDA',
  cnpj: '22603750000190',
  street: 'Av. Juscelino Kubitschek de Oliveira',
  number: '7525',
  district: 'Campo Comprido',
  city: 'Curitiba',
  state: 'PR',
  zip: '81020490',
  country: 'Brasil',
  phone: '',
  email: '',
};

/**
 * Extrai sigla UF de um state_id do Odoo
 * state_id vem como [id, "Parana (PR)"] ou [id, "PR"]
 */
function extractState(stateId) {
  if (!stateId) return '';
  var label = typeof stateId === 'object' ? (stateId[1] || '') : String(stateId);
  if (label.length <= 2) return label.toUpperCase();
  var match = label.match(/\(([A-Z]{2})\)/);
  return match ? match[1] : label.substring(0, 2).toUpperCase();
}

/**
 * Extrai estado do res.company (pode ter city+state ou state_id)
 */
function extractCompanyState(company) {
  // Tenta via state_id
  if (company.state_id) return extractState(company.state_id);
  // Fallback: campo l10n_br_state (se existir)
  if (company.l10n_br_state) return company.l10n_br_state;
  return MATRIX_FALLBACK.state;
}

/**
 * Formata telefone: separa country code e limpa
 */
function formatPhone(rawPhone) {
  var phone = (rawPhone || '').replace(/\D/g, '');
  var phoneCountry = '55';
  var phoneNumber = phone;
  if (phone.length > 11 && phone.startsWith('55')) {
    phoneCountry = phone.substring(0, 2);
    phoneNumber = phone.substring(2);
  }
  // Fixo com 10 digitos -> adiciona 9o digito
  if (phoneNumber.length === 10) {
    phoneNumber = phoneNumber.substring(0, 2) + '9' + phoneNumber.substring(2);
  }
  return { phoneCountry: phoneCountry, phoneNumber: phoneNumber };
}

/**
 * Formata data ISO vinda do Odoo para o formato TE (YYYY-MM-DDTHH:MM:SS)
 */
function formatTeDate(dateStr) {
  if (!dateStr) return null;
  // Odoo manda "2026-07-14 03:00:00" ou "2026-07-14T03:00:00"
  return dateStr.replace(' ', 'T');
}

/**
 * Formata data para apenas YYYY-MM-DD
 */
function formatDateOnly(dateStr) {
  if (!dateStr) return null;
  return dateStr.substring(0, 10);
}

/**
 * Extrai hora de uma data ISO
 */
function extractTime(dateStr) {
  if (!dateStr) return null;
  var match = dateStr.match(/(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

/**
 * Monta o SourceAddress (remetente) a partir dos dados da empresa
 */
function buildSourceAddress(company, companyCnpj) {
  var cnpj = companyCnpj || MATRIX_FALLBACK.cnpj;
  var state = company ? extractCompanyState(company) : MATRIX_FALLBACK.state;
  var street = (company && company.street) ? company.street : MATRIX_FALLBACK.street;
  var num = (company && company.number) ? String(company.number) : MATRIX_FALLBACK.number;
  var district = (company && company.district) ? company.district : MATRIX_FALLBACK.district;
  var city = (company && company.city) ? company.city : MATRIX_FALLBACK.city;
  var zip = ((company && company.zip) ? company.zip : MATRIX_FALLBACK.zip).replace(/\D/g, '');
  var name = (company && company.name) ? company.name : MATRIX_FALLBACK.name;

  var address = street;
  if (num) address += ', ' + num;

  return {
    Name: name,
    Address: address,
    AdditionalInformation: company && company.street2 ? company.street2 : '',
    Address2: district,
    ZipCode: zip,
    City: city,
    State: state,
    Country: MATRIX_FALLBACK.country,
    PhoneCountry: '55',
    PhoneNumber: company && company.phone ? company.phone.replace(/\D/g, '') : MATRIX_FALLBACK.phone,
    Email: company && company.email ? company.email : MATRIX_FALLBACK.email,
    DocumentType: 'CNPJ',
    DocumentNumber: cnpj.replace(/\D/g, ''),
  };
}

/**
 * Monta o DestinationAddress (destinatario) a partir do partner
 */
function buildDestinationAddress(partner) {
  var docNumber = (partner.x_studio_te_cnpj_cpf || partner.cnpj_cpf || partner.vat || '').replace(/\D/g, '');
  var docType = docNumber.length > 11 ? 'CNPJ' : 'CPF';

  var phone = formatPhone(partner.x_studio_te_telefone || partner.phone || '');

  var rua = partner.x_studio_te_logradouro || partner.street || '';
  var numero = partner.x_studio_te_numero || (partner.number ? String(partner.number) : '');
  var complemento = partner.x_studio_te_complemento || partner.street2 || '';
  var bairro = partner.x_studio_te_bairro || partner.district || '';
  var cidade = partner.x_studio_te_municipio || partner.city || '';
  var cep = (partner.x_studio_te_cep || partner.zip || '').replace(/\D/g, '');

  var address = rua;
  if (numero) address += ', ' + numero;

  var state = partner.x_studio_te_uf || extractState(partner.state_id);

  return {
    Name: partner.x_studio_te_razao_social || partner.name || '',
    Address: address || '',
    AdditionalInformation: complemento,
    Address2: bairro,
    ZipCode: cep,
    City: cidade,
    State: state,
    Country: 'Brasil',
    Responsibility: partner.name || '',
    PhoneCountry: phone.phoneCountry,
    PhoneNumber: phone.phoneNumber,
    PhoneNumberSms: phone.phoneNumber,
    PhoneCountrySms: phone.phoneCountry,
    Email: partner.x_studio_te_email || partner.email || '',
    DocumentType: docType,
    DocumentNumber: docNumber,
    Latitude: partner.x_studio_te_latitude || null,
    Longitude: partner.x_studio_te_longitude || null,
  };
}

/**
 * Monta o array Documents com NF + Volumes (itens da linha do pedido)
 *
 * @param {Object} invoice - Dados da fatura (account.move)
 * @param {Array} orderLines - sale.order.line do pedido
 * @param {Object} productsMap - Mapa product.id -> product data
 */
function buildDocuments(invoice, orderLines, productsMap) {
  if (!invoice) return [];

  // Numero da NF: usa name da fatura
  var nfNumber = invoice.name || String(invoice.id);

  // DocumentID unico da NF
  var docId = 'NF-' + nfNumber;

  var volumes = [];

  // Se tem linhas do pedido, monta volumes com os itens
  if (orderLines && orderLines.length) {
    orderLines.forEach(function(line) {
      var qty = line.product_uom_qty || 0;
      if (qty <= 0) return;

      var productId = line.product_id ? line.product_id[0] : null;
      var productName = line.name || (line.product_id ? line.product_id[1] : '') || '';

      volumes.push({
        VolumeID: 'VOL-' + line.id,
        Count: Math.round(qty),
        Unity: 'UN',
        Description: productName,
      });
    });

    if (volumes.length) {
      return [{
        DocumentID: docId,
        DocumentNumber: nfNumber,
        DocumentDescription: 'NF-e',
        Volumes: volumes,
      }];
    }
  }

  // Sem linhas: cria um volume generico
  return [{
    DocumentID: docId,
    DocumentNumber: nfNumber,
    DocumentDescription: 'NF-e',
    Volumes: [{
      VolumeID: docId + '-V1',
      Count: 1,
      Unity: 'UN',
      Description: 'Entrega - ' + nfNumber,
    }],
  }];
}

/**
 * Mapeia picking Odoo + partner + saleOrder + invoice + company para OrderViewModel do TE
 *
 * @param {Object} ctx - { picking, partner, saleOrder, invoice, company, companyCnpj, orderLines, productsMap }
 */
function odooToTeDelivery(ctx) {
  var picking = ctx.picking;
  var partner = ctx.partner;
  var saleOrder = ctx.saleOrder;
  var invoice = ctx.invoice;
  var company = ctx.company;
  var companyCnpj = ctx.companyCnpj;
  var orderLines = ctx.orderLines || [];
  var productsMap = ctx.productsMap;

  if (!picking || !partner) return null;

  // OrderNumber: prioriza nome do sale.order (ex: S00176), senao picking.origin, senao picking.name
  var orderNumber = '';
  if (saleOrder) {
    orderNumber = saleOrder.name || '';
  }
  if (!orderNumber && picking.origin) {
    orderNumber = picking.origin;
  }
  if (!orderNumber) {
    orderNumber = picking.name || '';
  }

  // SourceAddress (remetente = empresa)
  var sourceAddress = buildSourceAddress(company, companyCnpj);

  // DestinationAddress (destinatario = cliente)
  var destAddress = buildDestinationAddress(partner);

  // Documents (NF + volumes das linhas do pedido)
  var documents = buildDocuments(invoice, orderLines, productsMap);

  // Calcula peso e volume total a partir das linhas do pedido (sale.order.line)
  var totalWeight = 0;
  var totalVolume = 0;
  var totalQty = 0;
  if (orderLines && orderLines.length) {
    orderLines.forEach(function(line) {
      var qty = line.product_uom_qty || 0;
      if (qty <= 0) return;
      var productId = line.product_id ? line.product_id[0] : null;
      var product = productId ? (productsMap[productId] || {}) : {};
      totalWeight += (parseFloat(product.weight) || 0) * qty;
      totalVolume += (parseFloat(product.volume) || 0) * qty;
      totalQty += qty;
    });
  }

  // Fallback para peso/volume de campos x_studio se nao calculou das linhas
  if (totalWeight <= 0) {
    totalWeight = parseFloat(picking.x_studio_te_peso_total) || (saleOrder && parseFloat(saleOrder.x_studio_te_peso_total)) || 0;
  }
  if (totalQty <= 0) {
    totalQty = parseInt(picking.x_studio_te_qtd_volumes) || (saleOrder && parseInt(saleOrder.x_studio_te_qtd_volumes)) || 1;
  }

  // Valor total do pedido
  var amountTotal = (saleOrder && saleOrder.amount_total) || (invoice && invoice.amount_total) || 0;

  // Data de saida: scheduled_date do picking
  var scheduledDate = picking.scheduled_date || '';

  // Data de entrega: campo x_studio ou scheduled_date + 1 dia
  var deliveryDate = picking.x_studio_te_data_entrega || (saleOrder && saleOrder.x_studio_te_data_entrega) || '';
  if (!deliveryDate && scheduledDate) {
    // Sem data customizada, usa a mesma scheduled_date como previsao
    deliveryDate = scheduledDate;
  }

  // Monta observacao com valor se nao houver nota
  var observation = picking.note || picking.x_studio_te_observacao || '';
  if (amountTotal > 0) {
    observation += (observation ? ' | ' : '') + 'Valor: R$ ' + Number(amountTotal).toFixed(2).replace('.', ',');
  }

  // Driver: TE define o motorista automaticamente
  var driver = {
    PhoneCountry: '55',
    PhoneNumber: '99999999999',
    DefineDriverAfter: 1,
  };

  var delivery = {
    Customer: {
      DocumentType: 'CNPJ',
      DocumentNumber: (companyCnpj || '').replace(/\D/g, ''),
    },
    Driver: driver,
    OrderType: teApi.ORDER_TYPE.ENTREGA,
    OrderID: String(picking.id),
    OrderNumber: orderNumber,
    OrderDescription: 'NF-e',
    OrderDescriptionDocuments: 'NF-e',
    SourceAddress: sourceAddress,
    DestinationAddress: destAddress,
    Documents: documents,
    Observation: observation,
  };

  // Data de saida
  if (scheduledDate) {
    delivery.DepartureDate = formatTeDate(scheduledDate);
  }

  // Previsao de entrega + janela de horario
  if (deliveryDate) {
    delivery.DeliveryDate = formatDateOnly(deliveryDate);
    var startTime = extractTime(deliveryDate);
    delivery.DeliveryStartTime = startTime || '08:00';
    delivery.DeliveryEndTime = '18:00';
  }

  // Peso, volume, cubagem
  if (totalWeight > 0) delivery.Weight = Math.round(totalWeight * 100) / 100;
  if (totalQty > 0) delivery.Volume = totalQty;
  if (totalVolume > 0) delivery.CubicMeters = Math.round(totalVolume * 100) / 100;

  // Sequencia (0 por padrao, TE pode ajustar na separacao de carga)
  delivery.Sequence = 0;

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
 */
function teWebhookToOdoo(webhookData) {
  if (!webhookData) return {};
  var data = {};
  if (webhookData.OrderID) data.x_studio_te_order_id = String(webhookData.OrderID);

  if (webhookData.Status && webhookData.Status.length) {
    var lastStatus = webhookData.Status[webhookData.Status.length - 1];
    if (lastStatus.Status !== undefined && lastStatus.Status !== null) {
      data.x_studio_te_situacao = lastStatus.Status;
    }
    if (lastStatus.StatusDescription) {
      data.x_studio_te_situacao_desc = lastStatus.StatusDescription;
    }
  }

  if (webhookData.Occurrences && webhookData.Occurrences.length) {
    var lastOcc = webhookData.Occurrences[webhookData.Occurrences.length - 1];
    if (lastOcc.Observation) {
      data.x_studio_te_observacao = lastOcc.Observation;
    }
    if (lastOcc.OccurrenceName) {
      data.x_studio_te_observacao = (data.x_studio_te_observacao ? data.x_studio_te_observacao + ' - ' : '') + lastOcc.OccurrenceName;
    }
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
    msg += 'CEP: ' + (delivery.DestinationAddress.ZipCode || '') + '<br/>';
  }
  if (delivery.Documents && delivery.Documents.length) {
    msg += 'NF: ' + (delivery.Documents[0].DocumentNumber || '') + '<br/>';
    if (delivery.Documents[0].Volumes && delivery.Documents[0].Volumes.length) {
      msg += 'Itens: ' + delivery.Documents[0].Volumes.length + '<br/>';
    }
  }
  if (delivery.Weight) msg += 'Peso: ' + delivery.Weight + ' kg<br/>';
  if (delivery.Volume) msg += 'Volumes: ' + delivery.Volume;
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