/**
 * Serviço de consulta de Inscrição Estadual (IE) - v3.0
 *
 * A API pública do CNP Já (open.cnpja.com) NÃO retorna IE.
 * Este serviço tenta obter IE de fontes alternativas:
 *
 * FONTES DE IE (em ordem de prioridade):
 *
 * 1. CNP Já API Comercial (api.cnpja.com)
 *    - Dados vêm no campo "registrations" da resposta padrão
 *    - Requer: CNPJA_API_TOKEN
 *    - Custo: a partir de R$ 24,99/mês
 *
 * 2. Consultar.IO (SINTEGRA)
 *    - Consulta IE em todas as UFs via SINTEGRA
 *    - Requer: CONSULTAR_IO_TOKEN
 *    - Custo: a partir de R$ 25,00/mês
 *    - Tem teste grátis
 *
 * 3. NFeConsultaCadastro (SOAP oficial SEFAZ)
 *    - Serviço público gratuito do governo
 *    - ATENÇÃO: Pode não funcionar de servidores cloud (bloqueio geográfico)
 *    - Sem custo, mas sem garantia de funcionamento
 *
 * OBS: Scraping direto do SINTEGRA PR NÃO é viável de servidores cloud
 * porque o site tem captcha + bloqueio de IPs de datacenter.
 */

const axios = require('axios');
const config = require('../config');

class IeService {
  constructor() {
    this.consultarIoToken = process.env.CONSULTAR_IO_TOKEN || '';
    this.consultarIoBaseUrl = 'https://consultar.io/api/v2';

    // Log de configuração
    console.log('========================================');
    console.log('[IE] Fontes de IE configuradas:');
    if (config.cnpjaUsingCommercial) {
      console.log('[IE]   ✅ CNP Já Comercial (token configurado)');
    } else {
      console.log('[IE]   ❌ CNP Já Comercial (sem token - CNPJA_API_TOKEN)');
    }
    if (this.consultarIoToken) {
      console.log('[IE]   ✅ Consultar.IO SINTEGRA (token configurado)');
    } else {
      console.log('[IE]   ❌ Consultar.IO SINTEGRA (sem token - CONSULTAR_IO_TOKEN)');
    }
    console.log('[IE]   ⚠️  NFeConsultaCadastro (grátis, pode ser bloqueado em cloud)');
    console.log('========================================');

    if (!config.cnpjaUsingCommercial && !this.consultarIoToken) {
      console.warn('');
      console.warn('⚠️  ATENÇÃO: Nenhuma fonte de IE configurada!');
      console.warn('   - Sem IE: TODAS as empresas ficarão com alíquota 19%');
      console.warn('   - Para resolver: configure CNPJA_API_TOKEN ou CONSULTAR_IO_TOKEN');
      console.warn('   - CNP Já: https://www.cnpja.com/pricing (a partir de R$ 24,99/mês)');
      console.warn('   - Consultar.IO: https://consultar.io (tem teste grátis)');
      console.warn('');
    }
  }

  // ============================================================
  // FONTE 1: Consultar.IO (SINTEGRA)
  // ============================================================

  /**
   * Consulta IE de uma empresa pelo CNPJ usando o Consultar.IO (SINTEGRA).
   * @param {string} cnpj - CNPJ apenas números (14 dígitos)
   * @returns {Object} { found, ie, uf, ieDetails, source }
   */
  async consultarConsultarIO(cnpj) {
    if (!this.consultarIoToken) {
      return { found: false, ie: null, uf: null, ieDetails: [], source: null };
    }

    const cnpjLimpo = cnpj.replace(/\D/g, '');
    if (cnpjLimpo.length !== 14) {
      return { found: false, ie: null, uf: null, ieDetails: [], source: null };
    }

    try {
      // Consulta IE em todas as UFs de uma vez
      const response = await axios.get(`${this.consultarIoBaseUrl}/ie/consultar/todas`, {
        params: { cnpj: cnpjLimpo },
        headers: {
          'Authorization': `Token ${this.consultarIoToken}`,
          'Accept': 'application/json',
        },
        timeout: 15000,
      });

      const data = response.data;

      if (!Array.isArray(data) || data.length === 0) {
        console.log(`[IE] CNPJ ${cnpjLimpo}: nenhuma IE via Consultar.IO`);
        return { found: false, ie: null, uf: null, ieDetails: [], source: 'consultar.io' };
      }

      // Filtra IEs ativas
      const ieAtivas = data.filter(item => {
        const situacao = (item.situacao || '').toUpperCase();
        return !['BAIXADA', 'CANCELADA', 'SUSPENSA'].some(s => situacao.includes(s));
      });

      if (ieAtivas.length === 0) {
        console.log(`[IE] CNPJ ${cnpjLimpo}: IE inativa via Consultar.IO`);
        return { found: false, ie: null, uf: null, ieDetails: [], source: 'consultar.io' };
      }

      const iePrincipal = ieAtivas[0];
      console.log(`[IE] CNPJ ${cnpjLimpo}: IE ${iePrincipal.ie} (${iePrincipal.uf}) via Consultar.IO`);

      return {
        found: true,
        ie: iePrincipal.ie,
        uf: iePrincipal.uf,
        ieDetails: ieAtivas.map(item => ({
          number: item.ie,
          state: item.uf,
          type: 'IE - SINTEGRA',
          status: item.situacao || 'Ativa',
          statusDate: item.data_situacao || null,
          cnpj: item.cnpj,
          razao_social: item.razao_social || '',
        })),
        source: 'consultar.io',
      };
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        if (status === 404) {
          return { found: false, ie: null, uf: null, ieDetails: [], source: 'consultar.io' };
        }
        if (status === 401) {
          console.error('[IE] Token Consultar.IO invalido');
          return { found: false, ie: null, uf: null, ieDetails: [], source: 'consultar.io', error: 'Token invalido' };
        }
        if (status === 402) {
          console.error('[IE] Sem creditos no Consultar.IO');
          return { found: false, ie: null, uf: null, ieDetails: [], source: 'consultar.io', error: 'Sem creditos' };
        }
      }
      console.error(`[IE] Erro Consultar.IO: ${error.message}`);
      return { found: false, ie: null, uf: null, ieDetails: [], source: 'consultar.io', error: error.message };
    }
  }

  // ============================================================
  // FONTE 2: NFeConsultaCadastro (SOAP oficial SEFAZ)
  // ============================================================

  /**
   * Monta o XML SOAP para consulta de cadastro via NFe
   * @param {string} cnpj - CNPJ 14 dígitos
   * @param {string} uf - UF do estado (2 letras)
   * @returns {string} XML SOAP
   */
  _buildSoapXml(cnpj, uf) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                   xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaCadastro">
   <soapenv:Header/>
   <soapenv:Body>
      <nfe:nfeDadosMsg>
         <consCad versao="2.00" xmlns="http://www.portalfiscal.inf.br/nfe">
            <infCons>
               <xServ>CONS-CAD</xServ>
               <UF>${uf}</UF>
               <CNPJ>${cnpj}</CNPJ>
            </infCons>
         </consCad>
      </nfe:nfeDadosMsg>
   </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * Extrai IE da resposta SOAP do NFeConsultaCadastro
   * @param {string} xml - Resposta SOAP
   * @returns {Object|null} Dados da IE ou null
   */
  _parseSoapResponse(xml) {
    try {
      // Expressões para extrair dados da resposta XML
      const ieMatch = xml.match(/<IE[^>]*>([^<]+)<\/IE>/i);
      const cnpjMatch = xml.match(/<CNPJ[^>]*>([^<]+)<\/CNPJ>/i);
      const nomeMatch = xml.match(/<xNome[^>]*>([^<]+)<\/xNome>/i);
      const ufMatch = xml.match(/<UF[^>]*>([^<]+)<\/UF>/i);
      const situacaoMatch = xml.match(/<cSit[^>]*>([^<]+)<\/cSit>/i);

      if (!ieMatch || !ieMatch[1] || ieMatch[1].trim() === '') {
        return null;
      }

      return {
        ie: ieMatch[1].trim(),
        cnpj: cnpjMatch ? cnpjMatch[1].trim() : '',
        nome: nomeMatch ? nomeMatch[1].trim() : '',
        uf: ufMatch ? ufMatch[1].trim() : '',
        situacao: situacaoMatch ? situacaoMatch[1].trim() : '',
      };
    } catch (e) {
      console.error('[IE] Erro ao parsear resposta SOAP:', e.message);
      return null;
    }
  }

  /**
   * Endpoints NFeConsultaCadastro por UF
   * Alguns estados usam SVRS, SVAN ou AN como serviço compartilhado
   */
  _getNfeEndpoint(uf) {
    const endpoints = {
      // Estados com serviço próprio
      'PR': 'https://nfe.sefaz.pr.gov.br/nfe/NFeConsultaCadastro',
      'SP': 'https://nfe.fazenda.sp.gov.br/ws/nfeconsultacadastro.asmx',
      'MG': 'https://nfe.fazenda.mg.gov.br/nfe/services/NFeConsultaCadastro',
      'RS': 'https://sefaz.rs.gov.br/ws/NfeConsultaCadastro/NfeConsultaCadastro2.asmx',
      'SC': 'https://nfe.sefaz.sc.gov.br/ws/NfeConsultaCadastro/NfeConsultaCadastro2.asmx',
      'RJ': 'https://nfe.fazenda.rj.gov.br/WS/NFeConsultaCadastro/NFeConsultaCadastro.asmx',
      'BA': 'https://nfe.sefaz.ba.gov.br/ws/NfeConsultaCadastro/NfeConsultaCadastro.asmx',
      'PE': 'https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaCadastro',
      'CE': 'https://nfe.sefaz.ce.gov.br/nfe2/services/NFeConsultaCadastro?wsdl',
      'GO': 'https://nfe.sefaz.go.gov.br/nfe/services/v2/NFeConsultaCadastro?wsdl',
      'MT': 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsultaCadastro?wsdl',
      'MS': 'https://nfe.fazenda.ms.gov.br/ws/NFeConsultaCadastro',
      'AM': 'https://nfe.sefaz.am.gov.br/services2/services/NfeConsultaCadastro?wsdl',
      'AP': 'https://nfe.sefaz.ap.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'MA': 'https://nfe.sefaz.ma.gov.br/ws/NfeConsultaCadastro?wsdl',
      'PA': 'https://nfe.sefaz.pa.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'PI': 'https://nfe.sefaz.pi.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'RO': 'https://nfe.sefaz.ro.gov.br/nfe2/services/NfeConsultaCadastro?wsdl',
      'RR': 'https://nfe.sefaz.rr.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'TO': 'https://nfe.sefaz.to.gov.br/nfe2/services/NfeConsultaCadastro?wsdl',
      'AL': 'https://nfe.sefaz.al.gov.br/ws/NfeConsultaCadastro?wsdl',
      'PB': 'https://nfe.sefaz.pb.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'ES': 'https://nfe.sefaz.es.gov.br/ws/NfeConsultaCadastro?wsdl',
      'RN': 'https://nfe.sefaz.rn.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'SE': 'https://nfe.sefaz.se.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'DF': 'https://nfe.sefaz.df.gov.br/nfe/services/NfeConsultaCadastro?wsdl',
      'AC': 'https://nfe.sefaz.ac.gov.br/nfe2/services/NfeConsultaCadastro?wsdl',
      // Estados que usam SVRS (Serviço Virtual RS)
      'SVRS': 'https://cadastro.svrs.rs.gov.br/ws/cadconsultacadastro/CadConsultaCadastro2.asmx',
      // Ambiente Nacional (para alguns casos)
      'AN': 'https://nfe.an.gov.br/nfe/NFeConsultaCadastro',
    };

    return endpoints[uf] || null;
  }

  /**
   * Consulta IE via NFeConsultaCadastro (SOAP oficial do governo).
   * Tenta a UF da empresa primeiro, depois SVRS como fallback.
   * ATENÇÃO: Pode não funcionar de IPs de datacenter/cloud.
   *
   * @param {string} cnpj - CNPJ 14 dígitos
   * @param {string} uf - UF da empresa
   * @returns {Object} { found, ie, uf, ieDetails, source }
   */
  async consultarNFeCadastro(cnpj, uf) {
    const cnpjLimpo = cnpj.replace(/\D/g, '');
    if (cnpjLimpo.length !== 14 || !uf) {
      return { found: false, ie: null, uf: null, ieDetails: [], source: null };
    }

    // Tenta a UF da empresa primeiro
    const endpoints = [
      this._getNfeEndpoint(uf),
      this._getNfeEndpoint('SVRS'),  // Fallback SVRS
    ].filter(Boolean);

    for (const endpoint of endpoints) {
      try {
        const xml = this._buildSoapXml(cnpjLimpo, uf);
        const response = await axios.post(endpoint, xml, {
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': '""',
          },
          timeout: 10000,
        });

        const result = this._parseSoapResponse(response.data);
        if (result && result.ie) {
          console.log(`[IE] CNPJ ${cnpjLimpo}: IE ${result.ie} (${result.uf}) via NFeConsultaCadastro (${endpoint})`);
          return {
            found: true,
            ie: result.ie,
            uf: result.uf || uf,
            ieDetails: [{
              number: result.ie,
              state: result.uf || uf,
              type: 'IE - NFe Cadastro',
              status: result.situacao || 'Ativa',
              statusDate: null,
              cnpj: result.cnpj,
              razao_social: result.nome || '',
            }],
            source: 'nfe-cadastro',
            endpoint: endpoint,
          };
        }
      } catch (error) {
        // Tenta próximo endpoint
        console.log(`[IE] NFeConsultaCadastro falhou (${endpoint}): ${error.code || error.message}`);
        continue;
      }
    }

    console.log(`[IE] CNPJ ${cnpjLimpo}: NFeConsultaCadastro nao retornou IE (provavelmente bloqueio de IP cloud)`);
    return { found: false, ie: null, uf: null, ieDetails: [], source: 'nfe-cadastro' };
  }

  // ============================================================
  // ORQUESTRADOR: Tenta todas as fontes em ordem
  // ============================================================

  /**
   * Tenta obter IE de qualquer fonte disponível.
   * Ordem de prioridade:
   *   1. IE já extraída do CNP Já comercial (registrations)
   *   2. Consultar.IO (SINTEGRA) - precisa token
   *   3. NFeConsultaCadastro (SOAP governo) - grátis mas pode falhar em cloud
   *
   * @param {string} cnpj - CNPJ
   * @param {Object} cnpjaIeInfo - IE já extraída do CNP Já
   * @param {string} uf - UF da empresa (para NFeConsultaCadastro)
   * @returns {Object} { hasIE, ie, ieState, ieDetails, source }
   */
  async obterIE(cnpj, cnpjaIeInfo, uf) {
    // 1. Se o CNP Já comercial já trouxe IE, usa ela
    if (cnpjaIeInfo && cnpjaIeInfo.hasIE) {
      return {
        hasIE: true,
        ie: cnpjaIeInfo.ie,
        ieState: cnpjaIeInfo.ieState,
        ieDetails: cnpjaIeInfo.ieDetails,
        source: 'cnpja-comercial',
      };
    }

    // 2. Tenta Consultar.IO (SINTEGRA)
    if (this.consultarIoToken) {
      try {
        const sintegraResult = await this.consultarConsultarIO(cnpj);
        if (sintegraResult.found) {
          return {
            hasIE: true,
            ie: sintegraResult.ie,
            ieState: sintegraResult.uf,
            ieDetails: sintegraResult.ieDetails,
            source: 'consultar.io',
          };
        }
      } catch (e) {
        console.error('[IE] Erro Consultar.IO:', e.message);
      }
    }

    // 3. Tenta NFeConsultaCadastro (SOAP governo) - grátis
    if (uf) {
      try {
        const nfeResult = await this.consultarNFeCadastro(cnpj, uf);
        if (nfeResult.found) {
          return {
            hasIE: true,
            ie: nfeResult.ie,
            ieState: nfeResult.uf,
            ieDetails: nfeResult.ieDetails,
            source: 'nfe-cadastro',
          };
        }
      } catch (e) {
        console.error('[IE] Erro NFeConsultaCadastro:', e.message);
      }
    }

    // Nenhuma fonte encontrou IE
    return {
      hasIE: false,
      ie: null,
      ieState: null,
      ieDetails: [],
      source: 'nenhuma',
      reasons: [
        !config.cnpjaUsingCommercial ? 'CNP Já: sem token comercial' : null,
        !this.consultarIoToken ? 'Consultar.IO: sem token' : null,
        'NFe Cadastro: pode estar bloqueado em servidores cloud',
      ].filter(Boolean),
    };
  }
}

module.exports = { IeService };
