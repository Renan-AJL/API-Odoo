/**
 * services/cep.service.js - Consulta de CEP com fallback multi-fonte
 * ============================================================
 * Fontes (em ordem de prioridade):
 *   1. OpenCEP   (principal)  - https://opencep.com
 *   2. Cepify    (fallback 1) - https://cepify.com.br
 *   3. ViaCEP    (fallback 2) - https://viacep.com.br
 *   4. BrasilAPI (fallback 3) - https://brasilapi.com.br
 *
 * Adaptado de Api-CEP-Odoo-AJL-main/main.py (Python/FastAPI)
 * para o padrao Node.js/Express do middleware AJL.
 */
const axios = require('axios');

const USER_AGENT = 'API-CEP-Odoo-AJL/3.0';
const TIMEOUT_MS = 10000;

const FONTES = [
  { nome: 'OpenCEP',   consultar: consultarOpenCEP },
  { nome: 'Cepify',    consultar: consultarCepify },
  { nome: 'ViaCEP',    consultar: consultarViaCEP },
  { nome: 'BrasilAPI', consultar: consultarBrasilAPI },
];

// ============================================================
// FUNCAO PRINCIPAL
// ============================================================

/**
 * Consulta CEP tentando cada fonte em sequencia.
 * Retorna na primeira que responder com sucesso.
 *
 * @param {string} cepRaw - CEP com ou sem mascara (ex: "83323-000" ou "83323000")
 * @returns {object} Resultado padronizado
 */
async function consultarCEP(cepRaw) {
  // --- Limpa o CEP ---
  const cep = String(cepRaw || '').replace(/\D/g, '');

  if (cep.length !== 8) {
    return {
      sucesso: false,
      erro: 'CEP invalido. Deve conter 8 digitos.',
      cep_recebido: cepRaw,
    };
  }

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
  };

  // --- Tenta cada fonte em sequencia ---
  for (const fonte of FONTES) {
    try {
      const resultado = await fonte.consultar(cep, headers);
      if (resultado) {
        return resultado;
      }
    } catch (err) {
      // Log silencioso — fallback para a proxima fonte
      console.log('[CEP] ' + fonte.nome + ' falhou para ' + cep + ': ' + err.message);
    }
  }

  // --- Nenhuma fonte respondeu ---
  return {
    sucesso: false,
    erro: 'Nao foi possivel consultar o CEP nas fontes disponiveis.',
    cep: cep,
    fontes_consultadas: FONTES.map(f => f.nome),
  };
}

// ============================================================
// FONTES DE CONSULTA
// ============================================================

/**
 * 1. OpenCEP (principal)
 * Endpoint: GET https://opencep.com/v1/{cep}.json
 * Campos: cep, logradouro, bairro, localidade, uf, ibge
 */
async function consultarOpenCEP(cep, headers) {
  const url = 'https://opencep.com/v1/' + cep + '.json';
  const resp = await axios.get(url, { timeout: TIMEOUT_MS, headers });

  if (resp.status === 200 && resp.data && !resp.data.erro) {
    const d = resp.data;
    return {
      sucesso: true,
      fonte: 'OpenCEP',
      cep: d.cep || cep,
      rua: d.logradouro || null,
      bairro: d.bairro || null,
      cidade: d.localidade || null,
      estado: d.uf || null,
      pais: 'Brasil',
      ibge_cidade: d.ibge || null,
      ibge_estado: null,
    };
  }
  return null;
}

/**
 * 2. Cepify (fallback 1)
 * Endpoint: GET https://cepify.com.br/ws/{cep}/json
 * Campos: cep, logradouro, bairro, localidade, uf, ibge
 */
async function consultarCepify(cep, headers) {
  const url = 'https://cepify.com.br/ws/' + cep + '/json';
  const resp = await axios.get(url, { timeout: TIMEOUT_MS, headers });

  if (resp.status === 200 && resp.data && !resp.data.erro) {
    const d = resp.data;
    return {
      sucesso: true,
      fonte: 'Cepify',
      cep: d.cep || cep,
      rua: d.logradouro || null,
      bairro: d.bairro || null,
      cidade: d.localidade || null,
      estado: d.uf || null,
      pais: 'Brasil',
      ibge_cidade: d.ibge || null,
      ibge_estado: null,
    };
  }
  return null;
}

/**
 * 3. ViaCEP (fallback 2)
 * Endpoint: GET https://viacep.com.br/ws/{cep}/json/
 * Campos: cep, logradouro, bairro, localidade, uf, ibge
 */
async function consultarViaCEP(cep, headers) {
  const url = 'https://viacep.com.br/ws/' + cep + '/json/';
  const resp = await axios.get(url, { timeout: TIMEOUT_MS, headers });

  if (resp.status === 200 && resp.data && !resp.data.erro) {
    const d = resp.data;
    return {
      sucesso: true,
      fonte: 'ViaCEP',
      cep: d.cep || cep,
      rua: d.logradouro || null,
      bairro: d.bairro || null,
      cidade: d.localidade || null,
      estado: d.uf || null,
      pais: 'Brasil',
      ibge_cidade: d.ibge || null,
      ibge_estado: null,
    };
  }
  return null;
}

/**
 * 4. BrasilAPI (fallback 3)
 * Endpoint: GET https://brasilapi.com.br/cep/v1/{cep}
 * Campos: cep, street, neighborhood, city, state, ibge{city, state}
 */
async function consultarBrasilAPI(cep, headers) {
  const url = 'https://brasilapi.com.br/cep/v1/' + cep;
  const resp = await axios.get(url, { timeout: TIMEOUT_MS, headers });

  if (resp.status === 200 && resp.data && !resp.data.erro) {
    const d = resp.data;
    const ibge = d.ibge || {};
    return {
      sucesso: true,
      fonte: 'BrasilAPI',
      cep: d.cep || cep,
      rua: d.street || null,
      bairro: d.neighborhood || null,
      cidade: d.city || null,
      estado: d.state || null,
      pais: 'Brasil',
      ibge_cidade: (typeof ibge === 'object' && ibge.city) ? ibge.city : null,
      ibge_estado: (typeof ibge === 'object' && ibge.state) ? ibge.state : null,
    };
  }
  return null;
}

module.exports = { consultarCEP, FONTES: FONTES.map(f => f.nome) };
