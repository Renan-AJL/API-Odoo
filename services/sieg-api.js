/**
 * services/sieg-api.js — Comunicacao com API SIEG (engine)
 * 
 * - Enviar NF-e XML  -> POST /api/v1/send-xml
 * - Emitir NFS-e     -> POST /api/v1/emitir-nfse
 * - Gerar DANFE      -> POST /api/v1/gerarDanfeViaXml
 * - Gerar DANFSE     -> POST /api/v1/gerarDanfseViaXml
 */
const axios = require('axios');
const { getAuthHeaders } = require('./sieg-auth');
const { gerarXmlNFe } = require('./sieg-nfe-xml');
const { gerarXmlDPS } = require('./sieg-nfse-xml');

const SIEG_BASE = 'https://api.sieg.com';

/**
 * Enviar NF-e XML ao SIEG
 * SIEG assina o XML, envia à SEFAZ, retorna nfeProc autorizado
 */
async function enviarNFe(dadosOdoo) {
  const xml = gerarXmlNFe(dadosOdoo);
  console.log('[SIEG-API] Enviando NF-e XML (' + xml.length + ' chars)');

  const headers = await getAuthHeaders();
  const resp = await axios.post(`${SIEG_BASE}/api/v1/send-xml`, {
    Xml: Buffer.from(xml, 'utf-8').toString('base64'),
  }, { headers, timeout: 60000 });

  const result = resp.data;
  console.log('[SIEG-API] Resposta send-xml:', JSON.stringify(result).slice(0, 500));

  return {
    sucesso: true,
    xmlEnviado: xml,
    resposta: result,
  };
}

/**
 * Emitir NFS-e via SIEG
 * Envia DPS XML, SIEG processa e retorna NFSe autorizada
 */
async function emitirNFSe(dadosOdoo) {
  const xml = gerarXmlDPS(dadosOdoo);
  console.log('[SIEG-API] Emitindo NFS-e DPS (' + xml.length + ' chars)');

  const headers = await getAuthHeaders();
  const resp = await axios.post(`${SIEG_BASE}/api/v1/emitir-nfse`, {
    NFSeXml: Buffer.from(xml, 'utf-8').toString('base64'),
    // CertificadoBase64 e CertificadoSenha OPCIONAIS — SIEG ja tem o certificado
  }, { headers, timeout: 60000 });

  const result = resp.data;
  console.log('[SIEG-API] Resposta emitir-nfse:', JSON.stringify(result).slice(0, 500));

  return {
    sucesso: true,
    xmlEnviado: xml,
    resposta: result,
  };
}

/**
 * Gerar DANFE (PDF) a partir do XML autorizado
 * @param {string} xmlAutorizado - XML completo (nfeProc) retornado pela SEFAZ
 * @returns {string} PDF em base64
 */
async function gerarDanfe(xmlAutorizado) {
  console.log('[SIEG-API] Gerando DANFE via XML (' + xmlAutorizado.length + ' chars)');

  const headers = await getAuthHeaders();
  const resp = await axios.post(`${SIEG_BASE}/api/v1/gerarDanfeViaXml`, {
    ArquivoXml: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
  }, { headers, timeout: 30000 });

  return resp.data;
}

/**
 * Gerar DANFSE (PDF) a partir do XML autorizado
 * @param {string} xmlAutorizado - XML completo (NFSe) retornado pela prefeitura
 * @returns {string} PDF em base64
 */
async function gerarDanfse(xmlAutorizado) {
  console.log('[SIEG-API] Gerando DANFSE via XML (' + xmlAutorizado.length + ' chars)');

  const headers = await getAuthHeaders();
  const resp = await axios.post(`${SIEG_BASE}/api/v1/gerarDanfseViaXml`, {
    XmlNFSe: Buffer.from(xmlAutorizado, 'utf-8').toString('base64'),
  }, { headers, timeout: 30000 });

  return resp.data;
}

/**
 * Emitir nota fiscal (auto-detect NF-e ou NFS-e)
 * Esta é a funcao principal que a rota chama
 * 
 * @param {Object} dadosOdoo - Todos os dados extraidos do Odoo
 * @param {string} dadosOdoo.tipo - 'nfe' ou 'nfse' (se null, auto-detect)
 * @returns {Object} { tipo, sucesso, xmlEnviado, resposta, pdfBase64? }
 */
async function emitirNota(dadosOdoo) {
  // Auto-detect: se tem service config e linhas sao servico -> nfse
  let tipo = dadosOdoo.tipo;
  if (!tipo) {
    tipo = (dadosOdoo.service && dadosOdoo.lines?.every(l => l.detailed_type === 'service')) ? 'nfse' : 'nfe';
  }

  let resultado;
  if (tipo === 'nfse') {
    resultado = await emitirNFSe(dadosOdoo);
  } else {
    resultado = await enviarNFe(dadosOdoo);
  }

  resultado.tipo = tipo;

  // Se autorizado, gerar PDF
  if (resultado.sucesso) {
    try {
      // O XML autorizado pode vir no campo Xml ou xmlBase64 da resposta
      const xmlAutorizado = resultado.resposta?.Xml || resultado.resposta?.xml || resultado.resposta?.xmlBase64;
      if (xmlAutorizado) {
        const decoded = typeof xmlAutorizado === 'string' && xmlAutorizado.length > 200 ? xmlAutorizado : Buffer.from(xmlAutorizado, 'base64').toString('utf-8');
        
        if (tipo === 'nfse') {
          resultado.pdfBase64 = (await gerarDanfse(decoded));
        } else {
          resultado.pdfBase64 = (await gerarDanfe(decoded));
        }
        resultado.pdfGerado = true;
      }
    } catch (errPdf) {
      console.error('[SIEG-API] Erro ao gerar PDF (nota ainda autorizada):', errPdf.message);
      resultado.pdfGerado = false;
      resultado.pdfErro = errPdf.message;
    }
  }

  return resultado;
}

module.exports = {
  enviarNFe,
  emitirNFSe,
  gerarDanfe,
  gerarDanfse,
  emitirNota,
};
