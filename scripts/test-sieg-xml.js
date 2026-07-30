/**
 * Teste de geracao XML NF-e e NFS-e com dados reais da AJL
 */
const { gerarXmlNFe } = require('../API-Odoo/services/sieg-nfe-xml');
const { gerarXmlDPS } = require('../API-Odoo/services/sieg-nfse-xml');
const fs = require('fs');

// === Dados NF-e (baseado no XML real Camargo Vidal -> AJL, agora invertido: AJL emite) ===
const dadosNFe = {
  company: {
    cnpj_cpf: '22603750000190',
    legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    name: 'AJL DISTRIBUIDORA',
    street: 'Avenida Juscelino Kubitschek de Oliveira',
    number: '7525',
    street2: 'Cidade Industrial',
    city: 'Curitiba',
    city_ibge_code: '4106902',
    state: 'PR',
    zip: '81450000',
    phone: '4133730076',
    inscr_est: '9069585890',
    crt: '1', // Simples Nacional
    state_ibge: '41',
  },
  partner: {
    cnpj_cpf: '16859095000133',
    legal_name: 'CAMARGO VIDAL e FRANA LTDA ME',
    street: 'Rua Agenor Antonio Rodrigues',
    number: '685',
    street2: 'Sitio Cercado',
    city: 'Curitiba',
    city_ibge_code: '4106902',
    state: 'PR',
    zip: '81920210',
    phone: '4130192616',
    inscr_est: '9060761873',
    email: 'comercial@zardogabbardo.com.br',
  },
  order: {
    name: 'SO045',
    number: '45',
    date_order: '2026-07-30T10:00:00-03:00',
    amount_total: 187.50,
    note: 'Pedido teste integracao SIEG',
  },
  lines: [
    {
      default_code: '123',
      product_name: 'TRINCO 20 CM R/E GV',
      barcode: 'SEM GTIN',
      ncm: '83015000',
      cfop: '5102',
      uom: 'UN',
      qty: 15,
      price_unit: 7.50,
      price_subtotal: 112.50,
      csosn: '103',
      orig: '0',
    },
    {
      default_code: '185',
      product_name: 'ROLDANA 3 FF',
      barcode: 'SEM GTIN',
      ncm: '73259990',
      cfop: '5102',
      uom: 'UN',
      qty: 5,
      price_unit: 15.00,
      price_subtotal: 75.00,
      csosn: '103',
      orig: '0',
    },
  ],
  duplicatas: [
    { dVenc: '2026-08-27', vDup: 187.50 },
  ],
  pagamentos: [
    { tPag: '15', vPag: 187.50 },
  ],
  config: {
    natOp: 'Venda de Mercadoria',
    serie: '100',
    modFrete: '9',
  },
};

// === Dados NFS-e (baseado no XML real Lozano -> AJL, invertido: AJL presta servico) ===
const dadosNFSe = {
  company: {
    cnpj_cpf: '22603750000190',
    legal_name: 'AJL COMERCIO ATACADISTA DE FERRAGENS E FERRAMENTAS LTDA',
    email: 'contato@ajlferro.com.br',
    phone: '4133730076',
    inscr_mun: '0000000', // IM da AJL em Almirante Tamandare
    city_ibge_code: '4106902',
    op_simp_nac: '3',
    reg_ap_trib_sn: '1',
  },
  partner: {
    cnpj_cpf: '11615524000103',
    legal_name: 'LOZANO & LOZANO LTDA.',
    street: 'R VEREADOR ADMAR BERTOLLI',
    number: '2954',
    street2: 'LAMENHA GRANDE',
    city_ibge_code: '4100400',
    zip: '83505730',
  },
  order: {
    name: 'SO046',
    number: '46',
    date_order: '2026-07-30T11:00:00-03:00',
    amount_total: 2500.00,
  },
  service: {
    cTribNac: '140101',
    xDescServ: 'Manutenção preventiva de equipamentos industriais',
    cNBS: '999999999',
    cIntContrib: '33978',
    pAliq: '2.00',
    pTotTribFed: '13.45',
    pTotTribEst: '0.00',
    pTotTribMun: '3.29',
  },
  config: {
    cLocPrestacao: '4100400',
    serie: '1',
  },
};

// === Gerar e salvar ===
try {
  const xmlNFe = gerarXmlNFe(dadosNFe);
  fs.writeFileSync('/home/z/my-project/download/test-nfe-gerado.xml', xmlNFe, 'utf-8');
  console.log('NF-e XML gerado (' + xmlNFe.length + ' bytes) -> /download/test-nfe-gerado.xml');

  const xmlNFSe = gerarXmlDPS(dadosNFSe);
  fs.writeFileSync('/home/z/my-project/download/test-nfse-gerado.xml', xmlNFSe, 'utf-8');
  console.log('NFS-e DPS XML gerado (' + xmlNFSe.length + ' bytes) -> /download/test-nfse-gerado.xml');

  // Validate XML well-formedness
  const { parseString } = require('xml2js');
  parseString(xmlNFe, (err) => {
    if (err) console.error('NF-e XML INVALIDO:', err.message);
    else console.log('NF-e XML: valido (well-formed)');
  });
  parseString(xmlNFSe, (err) => {
    if (err) console.error('NFS-e XML INVALIDO:', err.message);
    else console.log('NFS-e DPS XML: valido (well-formed)');
  });
} catch (e) {
  console.error('ERRO:', e.message);
  process.exit(1);
}
