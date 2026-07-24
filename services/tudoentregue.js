// ============================================================
// services/tudoentregue.js — Client completo da API TudoEntregue
// Adaptado para usar config/ centralizado do projeto unificado
// ============================================================
const axios = require('axios');
const config = require('../config');
const { retryWithBackoff } = require('../utils/retry');

// Constantes
const API_LIMITS = {
  MAX_PAYLOAD_BYTES: 1 * 1024 * 1024,
  MAX_ORDERS_PER_REQUEST: 50,
};

const SITUATION = {
  AGUARDANDO: 0,
  EM_ROTA: 1,
  ENTREGUE: 3,
  NAO_ENTREGUE: 5,
  PARCIAL: 6,
  CANCELADA: 8,
  ATRASADA: 9,
  EM_SEPARACAO: 10,
  TRANSFERIDA: 11,
  BAIXADA: 12,
};

const SITUATION_LABELS = {
  [SITUATION.AGUARDANDO]: 'Aguardando',
  [SITUATION.EM_ROTA]: 'Em Rota',
  [SITUATION.ENTREGUE]: 'Entregue',
  [SITUATION.NAO_ENTREGUE]: 'Nao Entregue',
  [SITUATION.PARCIAL]: 'Entrega Parcial',
  [SITUATION.CANCELADA]: 'Cancelada',
  [SITUATION.ATRASADA]: 'Atrasada',
  [SITUATION.EM_SEPARACAO]: 'Em Separacao',
  [SITUATION.TRANSFERIDA]: 'Transferida',
  [SITUATION.BAIXADA]: 'Baixada',
};

const SITUATION_TO_ODOO_STATE = {
  [SITUATION.AGUARDANDO]: 'assigned',
  [SITUATION.EM_SEPARACAO]: 'assigned',
  [SITUATION.EM_ROTA]: 'confirmed',
  [SITUATION.ENTREGUE]: 'done',
  [SITUATION.NAO_ENTREGUE]: 'done',
  [SITUATION.PARCIAL]: 'done',
  [SITUATION.CANCELADA]: 'cancel',
  [SITUATION.TRANSFERIDA]: 'assigned',
  [SITUATION.BAIXADA]: 'done',
  [SITUATION.ATRASADA]: 'confirmed',
};

const ORDER_TYPES = {
  ENTREGA: 1,
  COLETA: 2,
  DEVOLUCAO: 3,
  TROCA: 4,
  OUTROS: 5,
};

class TudoEntregueClient {
  constructor() {
    this.baseUrl = config.tudoentregue.baseUrl;
    this.appKey = config.tudoentregue.appKey;
    this.requesterKey = config.tudoentregue.requesterKey;
    this.pageIntervalMs = config.tudoentregue.pageIntervalMs || 5000;
    this.maxEmptyPages = config.tudoentregue.maxEmptyPages || 10;
    this._driverCache = null;  // Cache de motoristas: { nome_normalizado: { PhoneCountry, PhoneNumber } }

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'AppKey': this.appKey,
        'RequesterKey': this.requesterKey,
      },
    });

    this.httpClient.interceptors.request.use((cfg) => {
      console.log(`[TE] ${cfg.method?.toUpperCase()} ${cfg.url}`);
      return cfg;
    });

    this.httpClient.interceptors.response.use(
      (res) => res,
      (err) => {
        const msg = err.response?.data?.Message || err.message;
        console.error(`[TE] Error: ${err.config?.url} — ${msg}`);
        return Promise.reject(err);
      }
    );
  }

  _validatePayload(data) {
    const bytes = Buffer.byteLength(JSON.stringify(data), 'utf-8');
    if (bytes > API_LIMITS.MAX_PAYLOAD_BYTES) {
      throw new Error(`Payload excede 1MB (${(bytes / 1024).toFixed(0)}KB). Divida em lotes menores.`);
    }
  }

  async _request(method, url, data = null, params = null) {
    return retryWithBackoff(
      () => this.httpClient.request({ method, url, data, params }),
      {
        maxRetries: 3,
        shouldRetry: (err) => {
          const status = err.response?.status;
          return !status || status >= 500 || status === 429;
        },
      }
    );
  }

  // -------------------------------------------------------
  // POST /v1/orders — Inclusao/Edicao de Entrega (Swagger v1.0.20)
  // -------------------------------------------------------
  async createDeliveries(deliveries) {
    if (!Array.isArray(deliveries)) deliveries = [deliveries];
    if (deliveries.length > API_LIMITS.MAX_ORDERS_PER_REQUEST) {
      throw new Error(`Maximo ${API_LIMITS.MAX_ORDERS_PER_REQUEST} entregas por request. Enviado: ${deliveries.length}`);
    }
    this._validatePayload(deliveries);

    const { data } = await this._request('POST', '/v1/orders', deliveries);
    console.log(`[TE] Cadastro: ${deliveries.length} entregas enviadas via /v1/orders`);
    return data;
  }

  // -------------------------------------------------------
  // POST /v1/orders — Edicao (mesmo endpoint, mesma estrutura do create)
  // -------------------------------------------------------
  async editDeliveries(deliveries) {
    if (!Array.isArray(deliveries)) deliveries = [deliveries];
    if (deliveries.length > API_LIMITS.MAX_ORDERS_PER_REQUEST) {
      throw new Error(`Maximo ${API_LIMITS.MAX_ORDERS_PER_REQUEST} entregas por edicao.`);
    }
    this._validatePayload(deliveries);

    const { data } = await this._request('POST', '/v1/orders', deliveries);
    console.log(`[TE] Edicao: ${deliveries.length} entregas editadas via /v1/orders`);
    return data;
  }

  // -------------------------------------------------------
  // PUT /v1/orders/cancel — Cancelamento
  // -------------------------------------------------------
  async cancelDeliveries(orders) {
    if (!Array.isArray(orders)) orders = [orders];
    const { data } = await this._request('PUT', '/v1/orders/cancel', orders);
    console.log(`[TE] Cancelamento: ${orders.length} entregas canceladas`);
    return data;
  }

  // -------------------------------------------------------
  // GET /v1/orders/finish — Consulta entregas com ocorrencia
  // -------------------------------------------------------
  async getDeliveries(params = {}) {
    const { data } = await this._request('GET', '/v1/orders/finish', null, params);
    return data;
  }

  // -------------------------------------------------------
  // GET /v1/orders/situation — Consulta situacao detalhada
  // -------------------------------------------------------
  async getDeliveriesWithOccurrence(params = {}) {
    const { data } = await this._request('GET', '/v1/orders/situation', null, params);
    return data;
  }

  // -------------------------------------------------------
  // GET /v1/orders/situation — Situacao detalhada da entrega
  // -------------------------------------------------------
  async getOrderSituation(params = {}) {
    const { data } = await this._request('GET', '/v1/orders/situation', null, params);
    return data;
  }

  // -------------------------------------------------------
  // GET /v1/tracking — Acompanhamento de entrega por tracking code
  // -------------------------------------------------------
  async getTracking(trackingCode) {
    const { data } = await this._request('GET', '/v1/tracking', null, { trackingCode });
    return data;
  }

  // -------------------------------------------------------
  // GET /v1/occurrences — Listar tipos de ocorrencia
  // -------------------------------------------------------
  async getSituations() {
    const { data } = await this._request('GET', '/v1/occurrences');
    return data;
  }

  // -------------------------------------------------------
  // GET /customers?DriverDetail=true — Lista motoristas (com cache 1h)
  // -------------------------------------------------------
  async getDrivers() {
    // Cache por 1 hora
    if (this._driverCache && (Date.now() - this._driverCache._ts) < 3600000) {
      return this._driverCache.list;
    }
    try {
      const { data } = await this._request('GET', '/customers', null, { DriverDetail: true });
      const customers = Array.isArray(data) ? data : (data?.Result || data?.Customers || []);
      const driverMap = {};
      customers.forEach(function(cust) {
        const drivers = cust.Drivers || cust.drivers || [];
        drivers.forEach(function(d) {
          if (d.Name) {
            const key = d.Name.toUpperCase().trim();
            driverMap[key] = {
              Name: d.Name,
              PhoneCountry: d.PhoneCountry || '55',
              PhoneNumber: d.PhoneNumber || '',
            };
          }
        });
      });
      this._driverCache = { _ts: Date.now(), list: driverMap };
      console.log('[TE] ' + Object.keys(driverMap).length + ' motoristas cacheados');
      return driverMap;
    } catch (err) {
      console.warn('[TE] Falha ao buscar motoristas: ' + err.message);
      return this._driverCache ? this._driverCache.list : {};
    }
  }

  /**
   * Busca motorista por nome (fuzzy match). Retorna { PhoneCountry, PhoneNumber } ou null.
   * @param {string} motoristaName - Nome vindo do Odoo (ex: 'ADRIANO' ou key 'adriano')
   */
  async findDriverByName(motoristaName) {
    if (!motoristaName) return null;
    const drivers = await this.getDrivers();
    if (!drivers || !Object.keys(drivers).length) return null;

    const search = motoristaName.toUpperCase().trim();
    // Match exato
    if (drivers[search]) return drivers[search];
    // Match parcial (nome contem ou e contido)
    for (const key of Object.keys(drivers)) {
      if (key.indexOf(search) !== -1 || search.indexOf(key) !== -1) return drivers[key];
    }
    // Match pela primeira palavra
    const firstWord = search.split(/\s+/)[0];
    if (firstWord.length >= 3) {
      for (const key of Object.keys(drivers)) {
        if (key.indexOf(firstWord) !== -1 || firstWord.indexOf(key) !== -1) return drivers[key];
      }
    }
    return null;
  }

  // -------------------------------------------------------
  // POST /customers/addDriver — Cadastrar / editar motorista
  // -------------------------------------------------------
  async addDriver(customerDoc, driverName, driverPhoneCountry, driverPhoneNumber) {
    const payload = {
      Customer: {
        DocumentType: 'CNPJ',
        DocumentNumber: customerDoc.replace(/\D/g, ''),
      },
      Driver: {
        Name: driverName,
        PhoneCountry: driverPhoneCountry,
        PhoneNumber: driverPhoneNumber,
      },
    };
    const { data, status } = await this.httpClient.post('/customers/addDriver', payload);
    console.log(`[TE] addDriver: ${driverName} -> status ${status}`);
    return { data, status };
  }

  // -------------------------------------------------------
  // PUT /drivers/customer/changeSituation — Ativar/Desativar
  // -------------------------------------------------------
  async changeDriverSituation(customerDoc, driverPhoneCountry, driverPhoneNumber, enable) {
    const payload = {
      Customer: {
        DocumentType: 'CNPJ',
        DocumentNumber: customerDoc.replace(/\D/g, ''),
        Enable: enable,
      },
      Driver: {
        PhoneCountry: driverPhoneCountry,
        PhoneNumber: driverPhoneNumber,
      },
    };
    const { data } = await this.httpClient.put('/drivers/customer/changeSituation', payload);
    console.log(`[TE] changeDriverSituation: phone=${driverPhoneNumber} -> ${enable ? 'Ativo' : 'Inativo'}`);
    return data;
  }

  // -------------------------------------------------------
  // Paginacao automatica
  // -------------------------------------------------------
  async fetchAllPages(endpoint, params = {}) {
    const allResults = [];
    let page = 1;
    let emptyCount = 0;

    while (true) {
      const response = await this._request('GET', endpoint, null, { ...params, page });
      const items = response.data?.Result || [];

      if (items.length === 0) {
        emptyCount++;
        if (emptyCount >= this.maxEmptyPages || !response.data?.HasNextPage) break;
      } else {
        emptyCount = 0;
        allResults.push(...items);
      }

      if (!response.data?.HasNextPage) break;
      page++;

      if (page > 1) {
        console.log(`[TE] Paginacao: esperando ${this.pageIntervalMs}ms antes da pagina ${page}`);
        await new Promise((r) => setTimeout(r, this.pageIntervalMs));
      }
    }

    console.log(`[TE] Paginacao finalizada: ${allResults.length} itens em ${page} paginas`);
    return allResults;
  }
}

// Exporta singleton + constantes
const client = new TudoEntregueClient();

module.exports = {
  client,
  SITUATION,
  SITUATION_LABELS,
  SITUATION_TO_ODOO_STATE,
  ORDER_TYPES,
  API_LIMITS,
};