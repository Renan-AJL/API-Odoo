// ============================================
// CLIENTE XML-RPC PARA ODOO 19 SAAS v5.0
// ============================================

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

class OdooClient {
  constructor() {
    this.baseUrl = config.odoo.url ? config.odoo.url.replace(/\/$/, '') : null;
    this.db = config.odoo.db;
    this.username = config.odoo.username;
    this.apiKey = config.odoo.apiKey;
    this.uid = null;
  }

  async authenticate() {
    if (!this.baseUrl) throw new Error('URL do Odoo nao configurada (ODOO_URL)');
    try {
      var response = await axios.post(this.baseUrl + '/jsonrpc', {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'common',
          method: 'authenticate',
          args: [this.db, this.username, this.apiKey, {}],
        },
        id: Date.now(),
      });
      if (response.data.error) throw new Error(response.data.error.data?.message || 'Autenticacao Odoo falhou');
      this.uid = response.data.result;
      logger.info('Autenticado no Odoo (UID: ' + this.uid + ')');
      return this.uid;
    } catch (error) {
      logger.error('Falha na autenticacao Odoo: ' + error.message);
      throw new Error('Nao foi possivel conectar ao Odoo: ' + error.message);
    }
  }

  async execute(model, method, args, kwargs) {
    if (!this.baseUrl) throw new Error('URL do Odoo nao configurada');
    args = args || [];
    kwargs = kwargs || {};
    try {
      var response = await axios.post(this.baseUrl + '/jsonrpc', {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [this.db, this.uid || this.username, this.apiKey, model, method, args, kwargs],
        },
        id: Date.now(),
      });
      if (response.data.error) {
        var errMsg = response.data.error.data?.message || JSON.stringify(response.data.error);
        throw new Error(errMsg);
      }
      return response.data.result;
    } catch (error) {
      logger.error('Odoo ' + model + '.' + method + '() falhou: ' + error.message);
      throw error;
    }
  }
}

let odooClient = null;
function getOdooClient() {
  if (!odooClient) odooClient = new OdooClient();
  return odooClient;
}

module.exports = { OdooClient: OdooClient, getOdooClient: getOdooClient };
