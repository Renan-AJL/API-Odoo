/**
 * routes/cep.js - Rotas de consulta de CEP (namespaced: /api/v1/cep/*)
 * ============================================================
 * Endpoints:
 *   POST /api/v1/cep/cep
 *     Consulta CEP direta (body: { "cep": "83323-000" })
 *     Auth: X-API-Key
 *
 *   POST /api/v1/cep/consultar-odoo/:partnerId
 *     Webhook Odoo — le o CEP do res.partner, consulta,
 *     e grava rua/bairro/cidade/estado/ibge de volta no partner
 *     Auth: X-API-Key
 *
 *   POST /api/v1/cep/odoo-webhook
 *     Webhook dedicado para automacao Python do Odoo SaaS 19.3
 *     Body: { "id": 133217, "cep": "83323-000" }
 *     Auth: X-CEP-Webhook-Secret (segredo exclusivo CEP_WEBHOOK_SECRET)
 *
 *   GET /api/v1/cep/fontes
 *     Lista fontes disponiveis
 *     Auth: X-API-Key
 *
 * Adaptado de Api-CEP-Odoo-AJL-main/main.py (Python/FastAPI)
 * para o padrao Node.js/Express do middleware AJL.
 */
var express = require('express');
var { apiKeyAuth } = require('../middleware/auth');
var { consultarCEP } = require('../services/cep.service');
var config = require('../config');
var xmlrpc = require('xmlrpc');

var router = express.Router();

// ============================================================
// Helpers: Odoo XML-RPC (mesmo padrao de consultflex.js)
// ============================================================

function odooAuth(oc) {
  return new Promise(function(ok, fail) {
    var base = oc.url.replace(/\/+$/, '');
    var host = base.replace('https://', '');
    var commonCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/common', port: 443 });
    commonCli.methodCall('authenticate', [oc.db, oc.user, oc.password, {}], function(e, r) {
      if (e || !r) return fail(e || new Error('Odoo auth failed'));
      ok({ uid: r, host: host });
    });
  });
}

function odooExec(oc, host, uid, model, method, args, kwargs) {
  return new Promise(function(ok, fail) {
    var modelsCli = xmlrpc.createSecureClient({ host: host, path: '/xmlrpc/2/object', port: 443 });
    var params = [oc.db, uid, oc.password, model, method, args];
    if (kwargs) params.push(kwargs);
    modelsCli.methodCall('execute_kw', params, function(e, r) {
      if (e) return fail(e);
      ok(r);
    });
  });
}

// ============================================================
// POST /api/v1/cep/cep
// Consulta CEP direta com fallback multi-fonte
// ============================================================
router.post('/cep', apiKeyAuth, async function(req, res) {
  try {
    var cep = req.body.cep;

    if (!cep) {
      return res.status(400).json({
        sucesso: false,
        erro: 'CEP e obrigatorio no corpo da requisicao. Envie: { "cep": "83323-000" }',
      });
    }

    var resultado = await consultarCEP(cep);

    if (!resultado.sucesso) {
      var status = (resultado.erro && resultado.erro.indexOf('invalido') !== -1) ? 400 : 502;
      return res.status(status).json(resultado);
    }

    return res.json(resultado);
  } catch (error) {
    console.error('[CEP] Erro na rota /cep:', error.message);
    return res.status(500).json({
      sucesso: false,
      erro: 'Erro interno ao consultar CEP.',
    });
  }
});

// ============================================================
// POST /api/v1/cep/consultar-odoo/:partnerId
// Webhook Odoo — consulta CEP do partner e grava resultado
//
// Fluxo:
//   1. Le o CEP do res.partner (campo 'zip')
//   2. Consulta CEP via fallback multi-fonte
//   3. Grava rua/bairro/cidade/estado/ibge de volta no partner
//   4. Retorna o resultado
//
// Body (opcional):
//   { "cep": "83323-000" }  — se nao informado, le do Odoo
//   { "write_back": true }  — gravar resultado no partner (default: true)
// ============================================================
router.post('/consultar-odoo/:partnerId', apiKeyAuth, async function(req, res) {
  try {
    var partnerId = parseInt(req.params.partnerId);
    var cepFromBody = req.body.cep || '';
    var writeBack = req.body.write_back !== false; // default: true

    if (!partnerId) {
      return res.status(400).json({ sucesso: false, erro: 'partnerId e obrigatorio na URL.' });
    }

    var oc = config.odoo;
    var odooHost = null;
    var odooUid = null;

    // 1. Authenticate to Odoo
    if (oc && oc.enabled && oc.url) {
      try {
        var authResult = await odooAuth(oc);
        odooUid = authResult.uid;
        odooHost = authResult.host;
      } catch (authErr) {
        console.error('[CEP] Erro auth Odoo:', authErr.message);
      }
    }

    // 2. Se CEP nao informado no body, le do res.partner
    var cepToConsult = cepFromBody;
    var partnerData = null;

    if (!cepToConsult && odooUid) {
      try {
        var fields = await odooExec(oc, odooHost, odooUid, 'res.partner', 'read', [
          [partnerId],
          ['zip', 'street', 'street2', 'city', 'state_id', 'country_id', 'name']
        ]);

        if (fields && fields.length > 0) {
          partnerData = fields[0];
          cepToConsult = partnerData.zip || '';
        }
      } catch (readErr) {
        console.error('[CEP] Erro ao ler res.partner:', readErr.message);
      }
    }

    if (!cepToConsult) {
      return res.status(400).json({
        sucesso: false,
        erro: 'CEP nao informado no body e nao encontrado no res.partner (campo zip vazio).',
        partner_id: partnerId,
      });
    }

    // 3. Consulta CEP
    var resultado = await consultarCEP(cepToConsult);

    // 4. Grava resultado de volta no Odoo
    var odooUpdated = false;
    if (resultado.sucesso && writeBack && odooUid) {
      try {
        var writeVals = {};

        // Rua (logradouro)
        if (resultado.rua) writeVals['street'] = resultado.rua;

        // Bairro (street2 no Odoo)
        if (resultado.bairro) writeVals['street2'] = resultado.bairro;

        // Cidade
        if (resultado.cidade) writeVals['city'] = resultado.cidade;

        // Estado — buscar res.country.state pelo codigo UF
        if (resultado.estado) {
          try {
            var stateIds = await odooExec(oc, odooHost, odooUid, 'res.country.state', 'search', [
              [['code', '=', resultado.estado], ['country_id.code', '=', 'BR']]
            ]);
            if (stateIds && stateIds.length > 0) {
              writeVals['state_id'] = stateIds[0];
            }
          } catch (stateErr) {
            console.error('[CEP] Erro ao buscar state_id:', stateErr.message);
          }
        }

        // IBGE da cidade — gravar no campo x_studio_ibge se existir
        if (resultado.ibge_cidade) {
          try {
            var ibgeField = await odooExec(oc, odooHost, odooUid, 'ir.model.fields', 'search_read', [
              [['model_id.model', '=', 'res.partner'], ['name', '=', 'x_studio_ibge']],
              ['name']
            ]);
            if (ibgeField && ibgeField.length > 0) {
              writeVals['x_studio_ibge'] = resultado.ibge_cidade;
            }
          } catch (ibgeErr) { /* campo nao existe, ignora */ }
        }

        // CEP formatado
        if (resultado.cep) writeVals['zip'] = resultado.cep;

        // Pais
        if (!partnerData || !partnerData.country_id) {
          try {
            var brIds = await odooExec(oc, odooHost, odooUid, 'res.country', 'search', [
              [['code', '=', 'BR']]
            ]);
            if (brIds && brIds.length > 0) writeVals['country_id'] = brIds[0];
          } catch (countryErr) { /* ignore */ }
        }

        if (Object.keys(writeVals).length > 0) {
          await odooExec(oc, odooHost, odooUid, 'res.partner', 'write', [
            [partnerId],
            writeVals
          ]);
          odooUpdated = true;
          console.log('[CEP] Resultado gravado no res.partner ID:', partnerId, JSON.stringify(writeVals));
        }
      } catch (odooErr) {
        console.error('[CEP] Erro ao gravar no Odoo:', odooErr.message);
      }
    }

    return res.json({
      sucesso: resultado.sucesso,
      data: resultado,
      partner_id: partnerId,
      odoo_updated: odooUpdated,
    });
  } catch (err) {
    console.error('[CEP] Erro webhook Odoo:', err.message);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// ============================================================
// POST /api/v1/cep/odoo-webhook
// Webhook dedicado para automacao Python do Odoo SaaS 19.3
//
// Body (obrigatorio):
//   { "id": 133217, "cep": "83323-000" }
//
// Autenticacao: header X-CEP-Webhook-Secret ou query param webhook_secret
//   (segredo exclusivo CEP_WEBHOOK_SECRET, separado do X-API-Key,
//    pois a automacao Python do Odoo pode nao conseguir enviar X-API-Key)
//
// Fluxo:
//   1. Valida autenticacao por segredo exclusivo
//   2. Valida id (partner ID) e cep no body
//   3. Consulta CEP via fallback multi-fonte
//   4. Verifica se o partner existe no Odoo
//   5. Grava SOMENTE campos com valores nao vazios (street, street2, city, state_id, zip, country_id)
//   6. Retorna resultado + status de atualizacao
//
// Garantias:
//   - Nunca sobrescreve campos com valores vazios
//   - Nunca atualiza em massa (somente o partner do ID recebido)
//   - Diferencia consulta bem-sucedida de atualizacao efetiva
//   - Nao revela segredos em logs ou respostas
// ============================================================
router.post('/odoo-webhook', async function(req, res) {
  try {
    // --- 1. Autenticacao por segredo exclusivo ---
    var receivedSecret = req.headers['x-cep-webhook-secret']
      || req.query.webhook_secret
      || '';
    var expectedSecret = config.cepWebhookSecret;

    if (!expectedSecret) {
      console.error('[CEP-WEBHOOK] CEP_WEBHOOK_SECRET nao configurado no servidor');
      return res.status(503).json({ sucesso: false, erro: 'Webhook nao configurado no servidor.' });
    }

    if (!receivedSecret || receivedSecret !== expectedSecret) {
      console.log('[CEP-WEBHOOK] Tentativa de acesso com segredo invalido');
      return res.status(401).json({ sucesso: false, erro: 'Autenticacao invalida.' });
    }

    // --- 2. Validar id e cep no body ---
    var partnerId = req.body.id;
    var cepRaw = req.body.cep;

    if (!partnerId || !Number.isInteger(Number(partnerId)) || Number(partnerId) <= 0) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Campo "id" obrigatorio no body. Deve ser um inteiro positivo (res.partner ID).',
      });
    }
    partnerId = Number(partnerId);

    if (!cepRaw || typeof cepRaw !== 'string') {
      return res.status(400).json({
        sucesso: false,
        erro: 'Campo "cep" obrigatorio no body. Deve ser uma string com 8 digitos.',
        id: partnerId,
      });
    }

    // Validar CEP antes de qualquer alteracao
    var cepClean = cepRaw.replace(/\D/g, '');
    if (cepClean.length !== 8) {
      return res.status(400).json({
        sucesso: false,
        erro: 'CEP invalido. Deve conter 8 digitos.',
        id: partnerId,
        cep_recebido: cepRaw,
      });
    }

    // --- 3. Consulta CEP ---
    var resultado = await consultarCEP(cepRaw);

    if (!resultado.sucesso) {
      return res.status(502).json({
        sucesso: false,
        erro: resultado.erro || 'Falha ao consultar CEP nas fontes disponiveis.',
        id: partnerId,
        cep: cepRaw,
        fontes_consultadas: resultado.fontes_consultadas,
      });
    }

    // --- 4. Conectar ao Odoo e verificar partner ---
    var oc = config.odoo;
    if (!oc || !oc.enabled || !oc.url) {
      return res.status(503).json({
        sucesso: true,
        consulta: resultado,
        id: partnerId,
        odoo_updated: false,
        aviso: 'Odoo nao configurado. CEP consultado mas contato nao atualizado.',
      });
    }

    var odooHost = null;
    var odooUid = null;

    try {
      var authResult = await odooAuth(oc);
      odooUid = authResult.uid;
      odooHost = authResult.host;
    } catch (authErr) {
      console.error('[CEP-WEBHOOK] Erro auth Odoo:', authErr.message);
      return res.status(502).json({
        sucesso: true,
        consulta: resultado,
        id: partnerId,
        odoo_updated: false,
        erro_odoo: 'Falha ao autenticar no Odoo.',
      });
    }

    // Verificar se o partner existe
    var partnerExists = false;
    try {
      var partners = await odooExec(oc, odooHost, odooUid, 'res.partner', 'search_count', [
        [['id', '=', partnerId]]
      ]);
      partnerExists = partners > 0;
    } catch (searchErr) {
      console.error('[CEP-WEBHOOK] Erro ao verificar partner:', searchErr.message);
    }

    if (!partnerExists) {
      return res.status(404).json({
        sucesso: true,
        consulta: resultado,
        id: partnerId,
        odoo_updated: false,
        erro: 'Contato res.partner ID ' + partnerId + ' nao encontrado no Odoo.',
      });
    }

    // --- 5. Gravar SOMENTE campos com valores nao vazios ---
    var writeVals = {};
    var camposAtualizados = [];

    if (resultado.rua) {
      writeVals['street'] = resultado.rua;
      camposAtualizados.push('street');
    }
    if (resultado.bairro) {
      writeVals['street2'] = resultado.bairro;
      camposAtualizados.push('street2');
    }
    if (resultado.cidade) {
      writeVals['city'] = resultado.cidade;
      camposAtualizados.push('city');
    }
    if (resultado.cep) {
      writeVals['zip'] = resultado.cep;
      camposAtualizados.push('zip');
    }

    // Estado — resolver res.country.state pelo codigo UF
    if (resultado.estado) {
      try {
        var stateIds = await odooExec(oc, odooHost, odooUid, 'res.country.state', 'search', [
          [['code', '=', resultado.estado], ['country_id.code', '=', 'BR']]
        ]);
        if (stateIds && stateIds.length > 0) {
          writeVals['state_id'] = stateIds[0];
          camposAtualizados.push('state_id');
        }
      } catch (stateErr) {
        console.error('[CEP-WEBHOOK] Erro ao resolver state_id:', stateErr.message);
      }
    }

    // Pais — resolver res.country pelo codigo BR (se o partner nao tem pais)
    try {
      var partnerData = await odooExec(oc, odooHost, odooUid, 'res.partner', 'read', [
        [partnerId], ['country_id']
      ]);
      if (partnerData && partnerData.length > 0 && (!partnerData[0].country_id || !partnerData[0].country_id[0])) {
        var brIds = await odooExec(oc, odooHost, odooUid, 'res.country', 'search', [
          [['code', '=', 'BR']]
        ]);
        if (brIds && brIds.length > 0) {
          writeVals['country_id'] = brIds[0];
          camposAtualizados.push('country_id');
        }
      }
    } catch (countryErr) {
      // Ignora — pais nao e critico
    }

    // IBGE — gravar no campo x_studio_ibge se existir
    if (resultado.ibge_cidade) {
      try {
        var ibgeField = await odooExec(oc, odooHost, odooUid, 'ir.model.fields', 'search_read', [
          [['model_id.model', '=', 'res.partner'], ['name', '=', 'x_studio_ibge']],
          ['name']
        ]);
        if (ibgeField && ibgeField.length > 0) {
          writeVals['x_studio_ibge'] = resultado.ibge_cidade;
          camposAtualizados.push('x_studio_ibge');
        }
      } catch (ibgeErr) { /* campo nao existe, ignora */ }
    }

    var odooUpdated = false;
    if (Object.keys(writeVals).length > 0) {
      try {
        await odooExec(oc, odooHost, odooUid, 'res.partner', 'write', [
          [partnerId],
          writeVals
        ]);
        odooUpdated = true;
        console.log('[CEP-WEBHOOK] Partner ID ' + partnerId + ' atualizado: ' + camposAtualizados.join(', '));
      } catch (writeErr) {
        console.error('[CEP-WEBHOOK] Erro ao gravar no Odoo:', writeErr.message);
        return res.status(502).json({
          sucesso: true,
          consulta: resultado,
          id: partnerId,
          odoo_updated: false,
          erro_odoo: 'Falha ao atualizar contato no Odoo: ' + writeErr.message,
        });
      }
    }

    // --- 6. Retornar resultado ---
    return res.json({
      sucesso: true,
      consulta: {
        cep: resultado.cep,
        rua: resultado.rua,
        bairro: resultado.bairro,
        cidade: resultado.cidade,
        estado: resultado.estado,
        fonte: resultado.fonte,
        ibge_cidade: resultado.ibge_cidade,
      },
      id: partnerId,
      odoo_updated: odooUpdated,
      campos_atualizados: odooUpdated ? camposAtualizados : [],
    });
  } catch (err) {
    console.error('[CEP-WEBHOOK] Erro interno:', err.message);
    return res.status(500).json({ sucesso: false, erro: 'Erro interno no servidor.' });
  }
});

// ============================================================
// GET /api/v1/cep/fontes
// Lista as fontes de consulta disponiveis
// ============================================================
router.get('/fontes', apiKeyAuth, function(_req, res) {
  res.json({
    sucesso: true,
    fontes: [
      { nome: 'OpenCEP',   ordem: 1, tipo: 'principal',  url: 'https://opencep.com' },
      { nome: 'Cepify',    ordem: 2, tipo: 'fallback',   url: 'https://cepify.com.br' },
      { nome: 'ViaCEP',    ordem: 3, tipo: 'fallback',   url: 'https://viacep.com.br' },
      { nome: 'BrasilAPI', ordem: 4, tipo: 'fallback',   url: 'https://brasilapi.com.br' },
    ],
  });
});

module.exports = router;
