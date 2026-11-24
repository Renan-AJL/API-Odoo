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
      var qty = line.product_uom_qty || line.quantity || 0;
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
 * @param {Object} ctx - { picking, partner, saleOrder, invoice, company, companyCnpj, orderLines, productsMap, driverPhone }
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
  var teDriver = ctx.teDriver || null;  // Dados do motorista encontrado no TE
  var motoristaName = ctx.motoristaName || null;  // Nome do motorista selecionado

  if (!partner) return null;

  // Se nao tem picking (fluxo via fatura sem sale.order), cria picking sintetico a partir da invoice
  if (!picking) {
    if (invoice) {
      picking = {
        id: invoice.id,
        name: invoice.name || String(invoice.id),
        origin: invoice.name || '',
        scheduled_date: invoice.invoice_date || invoice.create_date || '',
        note: '',
      };
      logger.info('[MAPPER] Picking sintetico a partir da fatura ' + (invoice.name || invoice.id));
    } else {
      return null;
    }
  }

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
      var qty = line.product_uom_qty || line.quantity || 0;
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

  // Driver: se teDriver fornecido (motorista real), usa dados reais; senao TE atribui automaticamente
  var driver;
  if (teDriver && teDriver.PhoneNumber) {
    driver = {
      PhoneCountry: teDriver.PhoneCountry || '55',
      PhoneNumber: teDriver.PhoneNumber,
      DefineDriverAfter: 0,
    };
    logger.info('[MAPPER] Driver -> REAL: ' + motoristaName + ' (Phone=' + teDriver.PhoneNumber + ', DefineDriverAfter=0)');
  } else {
    driver = {
      PhoneCountry: '55',
      PhoneNumber: '',
      DefineDriverAfter: 1,
    };
    logger.info('[MAPPER] Driver -> AUTO (TE atribui): DefineDriverAfter=1');
  }

  var delivery = {
    Customer: {
      DocumentType: 'CNPJ',
      DocumentNumber: (companyCnpj || '').replace(/\D/g, ''),
    },
    Driver: driver,
    OrderType: (teApi.ORDER_TYPES || teApi.ORDER_TYPE || {}).ENTREGA || 1,
    OrderID: String(picking.id),
    OrderNumber: orderNumber,
    OrderDescription: 'NF-e',
    OrderDescriptionDocuments: 'NF-e',
    SourceAddress: sourceAddress,
    DestinationAddress: destAddress,
    Documents: documents,
    Observation: observation,
  };

  // Data de saida (D+1 — sempre dia seguinte ao da criacao)
  var departureDate = scheduledDate ? new Date(scheduledDate) : new Date();
  departureDate.setDate(departureDate.getDate() + 1);
  delivery.DepartureDate = formatTeDate(departureDate.toISOString());
  logger.info('[MAPPER] DepartureDate (D+1): ' + delivery.DepartureDate);

  // Previsao de entrega (D+1 — sempre dia seguinte ao da criacao)
  var dDate = deliveryDate ? new Date(deliveryDate) : departureDate;
  dDate.setDate(dDate.getDate() + 1);
  delivery.DeliveryDate = formatDateOnly(dDate.toISOString());
  delivery.DeliveryStartTime = '08:00';
  delivery.DeliveryEndTime = '18:00';
  logger.info('[MAPPER] DeliveryDate (D+1): ' + delivery.DeliveryDate);

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
  // AJL 24/11/2026: x_studio_te_rastreio nao existe no Odoo; o campo real de
  // tracking é x_studio_te_tracking_code (sale.order e stock.picking)
  if (teResponse.TrackingCode) data.x_studio_te_tracking_code = teResponse.TrackingCode;
  return data;
}

/**
 * Mapeia webhook TE para campos do picking Odoo
 *
 * AJL 24/11/2026 — CORRECAO: o campo real do Odoo é x_studio_te_situation
 * (selection com os CODIGOS do TE: 0 Aguardando, 1 Em Rota, 3 Entregue,
 * 5 Nao Entregue, 6 Entrega Parcial, 8 Cancelada, 9 Atrasada, 10 Em Separacao,
 * 11 Transferida, 12 Baixada). Antes gravava x_studio_te_situacao e
 * x_studio_te_situacao_desc — campos que NAO EXISTEM — e o write inteiro
 * falhava em silencio (safeWriteCustom engolia Invalid field), de modo que
 * nenhuma atualizacao de status chegava ao Odoo. O codigo gravado alimenta
 * as automacoes AJL do "Status da fabricação" (260/261/263).
 * A descricao legivel continua indo para o chatter (chatterWebhookMessage).
 */
var TE_SITUATION_CODES = ['0', '1', '3', '5', '6', '8', '9', '10', '11', '12'];

/**
 * AJL 24/11/2026 (v1.2.39) — catálogo do campo STATUS do TE descoberto ao vivo
 * na entrega 2917/S02983 (o app deles marcava Entregue e nós gravávamos '5'
 * "Não Entregue"). O Status do TE tem VOCABULÁRIO PRÓPRIO, NÃO é a nossa
 * selection x_studio_te_situation:
 *   1 Recepcionada no Active TudoEntregue
 *   2 Enviada ao Motorista e Aguardando Aceite
 *   3 Enviada ao Motorista e Aceita
 *   5 Finalizada pelo Motorista
 * Antes o número cru ia direto p/ nossa selection — colisão: TE 3 virava
 * "Entregue" (era só aceite do motorista), TE 5 virava "Não Entregue" (era
 * finalização — com ocorrência 01 é Entregue) e TE 1 virava "Em Rota"
 * (era só recebimento). Tradução conservadora abaixo; o que não está no mapa
 * NÃO grava código (fica no chatter).
 */
var TE_STATUS_TO_SITUATION = {
  '1': '0',  // Recepcionada no Active -> Aguardando
  '2': '1',  // Enviada ao Motorista (aguardando aceite) -> Em Rota
  '3': '1',  // Enviada ao Motorista e Aceita -> Em Rota (NÃO "Entregue"!)
  // '5' Finalizada pelo Motorista: NÃO traduz sozinho — ambíguo sem a
  // ocorrência (finalização com 01 = Entregue; sem 01 pode ser finalização
  // sem sucesso). Quem resolve é a ocorrência, que é a fonte autoritativa.
};

/**
 * Última ocorrência de um registro/payload TE, normalizada.
 * A ocorrência é a FONTE AUTORITATIVA do desfecho (descrição inequívoca),
 * diferente do Status numérico (vocabulário interno do TE).
 */
function ultimaOcorrencia(d) {
  var occs = (d && d.Occurrences) || [];
  if (!occs.length) return null;
  var last = occs[occs.length - 1];
  return {
    code: String((last && last.OccurrenceCode) || ''),
    finisher: !!(last && last.Finisher === true),
    name: (last && last.OccurrenceName) || '',
    observation: (last && last.Observation) || '',
  };
}

/**
 * Decide x_studio_te_situation pela ÚLTIMA OCORRÊNCIA (autoritativa):
 *   '01' + Finisher  -> '3' Entregue
 *   '102'            -> '8' Entrega Cancelada
 *   '03' + Finisher  -> '5' Não Entregue (recusa que encerrou a entrega)
 *   '03'/'09' sem Finisher -> null (pode continuar — só texto no chatter)
 * Catálogo real extraído dos dados 24/11 (v1.2.35): 01=ENTREGUE,
 * 03=CLIENTE RECUSOU, 09=MERCADORIA EM DESACORDO, 102=ENTREGA CANCELADA.
 */
function situationPorOcorrencia(occ) {
  if (!occ) return null;
  if (occ.code === '01' && occ.finisher) return '3';
  if (occ.code === '102') return '8';
  if (occ.code === '03' && occ.finisher) return '5';
  return null;
}

function teWebhookToOdoo(webhookData) {
  if (!webhookData) return {};
  var data = {};
  if (webhookData.OrderID) data.x_studio_te_order_id = String(webhookData.OrderID);

  // 1) OCORRÊNCIA primeiro (autoritativa) — v1.2.39
  var occ = ultimaOcorrencia(webhookData);
  var porOcc = situationPorOcorrencia(occ);
  if (porOcc) {
    data.x_studio_te_situation = porOcc;
  }

  // 2) STATUS só como fallback TRADUZIDO (catálogo do TE != nossa selection)
  if (!data.x_studio_te_situation && webhookData.Status && webhookData.Status.length) {
    var lastStatus = webhookData.Status[webhookData.Status.length - 1];
    var st = (lastStatus && lastStatus.Status !== undefined && lastStatus.Status !== null)
      ? String(lastStatus.Status) : '';
    var trad = TE_STATUS_TO_SITUATION[st];
    if (trad) {
      data.x_studio_te_situation = trad;
    } else if (st) {
      logger.warn('[MAPPER] Status TE ' + st + ' sem traducao (fora do mapa ou '
        + 'ambiguo, ex. 5 Finalizada sem ocorrência) — x_studio_te_situation nao gravado; '
        + 'descricao segue no chatter.');
    }
  }

  // 3) texto da ocorrência -> x_studio_te_ocorrencias
  if (occ && (occ.observation || occ.name)) {
    var occTxt = occ.observation;
    if (occ.name) {
      occTxt = (occTxt ? occTxt + ' - ' : '') + occ.name;
    }
    data.x_studio_te_ocorrencias = occTxt;
  }

  return data;
}

/**
 * TE -> Odoo a partir de um REGISTRO de entrega (listagem /api/Entregas ou
 * /v1/orders/finish) — usado pelo pull e pelas rotas de consulta.
 * Igual ao webhook, mas NAO sobrescreve o x_studio_te_order_id gravado no envio.
 * Fonte de situação (v1.2.39): ÚLTIMA OCORRÊNCIA primeiro (01+Finisher->3,
 * 102->8, 03+Finisher->5); Status do TE entra só como fallback TRADUZIDO
 * (1->0, 2/3->1) — antes o número cru ia p/ nossa selection e entregas
 * finalizadas viravam "Não Entregue" (bug real na entrega 2917/S02983).
 * Entregas do painel com Status [] continuam funcionando (caem na ocorrência).
 */
var TE_OCC_TO_SITUATION = { '01': '3', '102': '8', '03': '5' };

function teToOdooPicking(delivery) {
  var data = teWebhookToOdoo(delivery);
  delete data.x_studio_te_order_id;
  return data;
}

function teToOdooSaleOrder(delivery) {
  var data = teToOdooPicking(delivery);
  // sale.order nao tem campo de ocorrencias; safeWriteCustom descartaria, mas
  // aqui a exclusao é explicita para o payload já sair limpo.
  delete data.x_studio_te_ocorrencias;
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
    var sitCode = (last.Status !== undefined && last.Status !== null) ? String(last.Status) : '';
    var sitLabel = (teApi.SITUATION_LABELS || {})[sitCode] || '';
    var sitTxt = last.StatusDescription || sitLabel;
    msg += 'Situacao: ' + sitTxt + (sitCode ? ' (codigo ' + sitCode + ')' : '') + '<br/>';
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
  teToOdooPicking: teToOdooPicking,
  teToOdooSaleOrder: teToOdooSaleOrder,
  normalizeWebhookPayload: normalizeWebhookPayload,
  chatterCreateMessage: chatterCreateMessage,
  chatterWebhookMessage: chatterWebhookMessage,
};