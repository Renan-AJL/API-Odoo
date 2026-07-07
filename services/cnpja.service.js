const axios = require('axios');
const config = require('../config');

// Logger simples
const log = {
  info: (msg, data) => {
    if (config.debug) console.log(`[INFO] ${msg}`, data || '');
    else console.log(`[INFO] ${msg}`);
  },
  error: (msg, data) => {
    console.error(`[ERROR] ${msg}`, data || '');
  },
  warn: (msg, data) => {
    if (config.debug) console.warn(`[WARN] ${msg}`, data || '');
    else console.warn(`[WARN] ${msg}`);
  },
};

class CnpjaService {
  constructor() {
    this.baseUrl = config.cnpjaApiBase;
    this.token = config.cnpjaApiToken;
    this.timeout = config.cnpjaTimeout;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'cnpja-odoo-middleware/3.1',
      },
    });

    // Se tiver token comercial, adiciona header de autenticação
    if (this.token) {
      // CNP Já usa apiKey direto (SEM prefixo "Bearer")
      // Ref: https://api.cnpja.com/docs - securitySchemes: apiKey in header
      this.httpClient.defaults.headers.common['Authorization'] = this.token;
      console.log(`[CONFIG] Usando API COMERCIAL do CNP Já: ${this.baseUrl}`);
    } else {
      console.warn(`[CONFIG] Usando API PUBLICA do CNP Já: ${this.baseUrl} (SEM IE/registrations)`);
    }
  }

  /**
   * Consulta dados de uma empresa pelo CNPJ na API do CNP Já.
   * 
   * Ref: https://cnpja.com/api (Guia Rápido da API Comercial)
   * 
   * Parâmetros documentados para IE:
   *   - registrations=ALL    → Insc. Estaduais de TODOS os UFs
   *   - registrations=ORIGIN → Insc. Estadual do estado de origem
   *   - registrations=SP,RJ  → Insc. Estaduais de UFs específicas
   *   - simples=true          → Dados do Simples Nacional / MEI
   *   - suframa=true          → Dados SUFRAMA
   *   - geocoding=true        → Latitude/Longitude
   *
   * @param {string} cnpj - CNPJ apenas números (14 dígitos)
   * @returns {Object} Dados completos da empresa
   */
  async consultarCNPJ(cnpj) {
    // Remove qualquer formatação do CNPJ
    const cnpjLimpo = cnpj.replace(/\D/g, '');

    if (cnpjLimpo.length !== 14) {
      throw new Error('CNPJ deve conter 14 dígitos numéricos');
    }

    log.info(`Consultando CNPJ: ${cnpjLimpo}`);
    log.info(`API Base: ${this.baseUrl} | Token: ${this.token ? 'SIM' : 'NAO'} | Comercial: ${config.cnpjaUsingCommercial}`);

    try {
      // ============================================================
      // PARAMETROS DA QUERY - Somente os documentados na API Comercial
      // Ref: https://cnpja.com/api
      // ============================================================
      // Parametros validos: registrations, simples, suframa, geocoding,
      // strategy, maxAge, maxStale
      // NAO existe: members (quadro societario ja vem por padrao)
      // ============================================================
      const params = {};

      if (config.cnpjaUsingCommercial) {
        // registrations=ALL → Inscricoes Estaduais de TODOS os UFs
        // Isso é OBRIGATÓRIO para obter a IE no plano pago
        params.registrations = 'ALL';

        // simples=true → Dados do Simples Nacional e MEI
        // Necessário para determinar regime tributário correto
        params.simples = 'true';

        log.info(`Query params: registrations=ALL, simples=true`);
      }

      const response = await this.httpClient.get(`/office/${cnpjLimpo}`, { params });

      const data = response.data;

      // Log detalhado da resposta para debug
      log.info(`CNPJ ${cnpjLimpo} consultado com sucesso`);
      log.info(`  Campos na resposta: ${Object.keys(data).join(', ')}`);

      // Avisa se não veio registrations (IE)
      if (!data.registrations || !Array.isArray(data.registrations) || data.registrations.length === 0) {
        log.warn(`CNPJ ${cnpjLimpo}: SEM dados de IE (registrations vazio ou ausente).`);
        if (!config.cnpjaUsingCommercial) {
          log.warn(`  Motivo: API publica (open.cnpja.com) nao retorna registrations.`);
          log.warn(`  Solucao: Configure CNPJA_API_TOKEN com a chave do plano pago.`);
        } else {
          log.warn(`  Motivo: A empresa pode nao ter IE cadastrada, ou o token pode ser invalido.`);
        }
      } else {
        log.info(`CNPJ ${cnpjLimpo}: registrations encontrados (${data.registrations.length} inscricao(oes))`);
        data.registrations.forEach((r, i) => {
          log.info(`  IE[${i}]: number=${r.number}, state=${r.state}, type=${r.type?.id || '?'}, status=${r.status?.id || '?'}, enabled=${r.enabled}`);
        });
      }

      // Log Simples/MEI
      if (data.company) {
        log.info(`  Simples: optant=${data.company.simples?.optant || false}`);
        log.info(`  SIMEI: optant=${data.company.simei?.optant || false}`);
      }

      return data;
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        const body = error.response.data;

        if (status === 401) {
          throw new Error(`Token CNP Já invalido ou expirado (HTTP 401). Verifique CNPJA_API_TOKEN no Render.`);
        }
        if (status === 403) {
          throw new Error(`Acesso negado (HTTP 403). Verifique se o plano do CNP Já inclui este endpoint.`);
        }
        if (status === 404) {
          throw new Error(`CNPJ ${cnpjLimpo} não encontrado na base do CNP Já`);
        }
        if (status === 429) {
          throw new Error('Limite de consultas atingido. Aguarde um momento e tente novamente.');
        }

        log.error(`Erro API CNP Já: HTTP ${status}`, body);
        throw new Error(`Erro na API CNP Já: HTTP ${status} - ${JSON.stringify(body)}`);
      }
      if (error.code === 'ECONNABORTED') {
        throw new Error('Timeout na consulta ao CNP Já. Tente novamente.');
      }
      throw new Error(`Erro ao consultar CNP Já: ${error.message}`);
    }
  }
}

module.exports = { CnpjaService, log };
