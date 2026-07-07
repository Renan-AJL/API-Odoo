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
  // POST /api/Entregas/Cadastro
  // -------------------------------------------------------
  async createDeliveries(deliveries) {
    if (!Array.isArray(deliveries)) deliveries = [deliveries];
    if (deliveries.length > API_LIMITS.MAX_ORDERS_PER_REQUEST) {
      throw new Error(`Maximo ${API_LIMITS.MAX_ORDERS_PER_REQUEST} entregas por request. Enviado: ${deliveries.length}`);
    }
    this._validatePayload(deliveries);

    const { data } = await this._request('POST', '/api/Entregas/Cadastro', deliveries);
    console.log(`[TE] Cadastro: ${deliveries.length} entregas enviadas`);
    return data;
  }

  // -------------------------------------------------------
  // PUT /api/Entregas/Edicao
  // -------------------------------------------------------
  async editDeliveries(deliveries) {
    if (!Array.isArray(deliveries)) deliveries = [deliveries];
    if (deliveries.length > API_LIMITS.MAX_ORDERS_PER_REQUEST) {
      throw new Error(`Maximo ${API_LIMITS.MAX_ORDERS_PER_REQUEST} entregas por edicao.`);
    }
    this._validatePayload(deliveries);

    const { data } = await this._request('PUT', '/api/Entregas/Edicao', deliveries);
    console.log(`[TE] Edicao: ${deliveries.length} entregas editadas`);
    return data;
  }

  // -------------------------------------------------------
  // DELETE /api/Entregas/Cancelamento
  // -------------------------------------------------------
  async cancelDeliveries(orders) {
    if (!Array.isArray(orders)) orders = [orders];
    const { data } = await this._request('DELETE', '/api/Entregas/Cancelamento', orders);
    console.log(`[TE] Cancelamento: ${orders.length} entregas canceladas`);
    return data;
  }

  // -------------------------------------------------------
  // GET /api/Entregas
  // -------------------------------------------------------
  async getDeliveries(params = {}) {
    const { data } = await this._request('GET', '/api/Entregas', null, { page: 1, ...params });
    return data;
  }

  // -------------------------------------------------------
  // GET /api/Entregas/Ocorrencia
  // -------------------------------------------------------
  async getDeliveriesWithOccurrence(params = {}) {
    const { data } = await this._request('GET', '/api/Entregas/Ocorrencia', null, { page: 1, ...params });
    return data;
  }

  // -------------------------------------------------------
  // GET /api/Entregas/Situacao
  // -------------------------------------------------------
  async getSituations() {
    const { data } = await this._request('GET', '/api/Entregas/Situacao');
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