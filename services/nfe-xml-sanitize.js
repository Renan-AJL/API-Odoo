/**
 * services/nfe-xml-sanitize.js — AJL 21/10/2026 (pedido Renan/AJL):
 *   "Ao finalizar a montagem do XML, o middleware abre o XML, troca pelo cod
 *    correto e continua."
 *
 * Rede de seguranca POS-MONTAGEM: recebe o XML NF-e pronto (saida de
 * gerarXmlNFe) e corrige TODO <cMun> pela tabela IBGE 2026
 * (services/ibge-municipios.js), usando o <xMun> + <UF> do PROPRIO bloco.
 * Cobre enderEmit, enderDest e qualquer bloco de endereco do schema
 * (entrega/retirada/enderEntrega/enderRetirada). O <cMunFG>/<cMunFGIBS>
 * do <ide> (municipio de fato gerador do ICMS) segue o emitente corrigido.
 *
 * Roda ANTES da assinatura A1 (sefaz-client.js) — trocar cMun depois da
 * assinatura quebraria o digest. Se a tabela nao conhecer a cidade, o
 * codigo original segue intocado (nao inventamos codigo).
 */

var ibge = require('./ibge-municipios');

function unesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Corrige o <cMun> dentro do corpo de um bloco de endereco que contenha
 * xMun/UF. Retorna o corpo (inalterado se nada a corrigir).
 */
function corrigirBloco(nomeTag, corpo, correcoes) {
  var mUF = corpo.match(/<UF>\s*([^<]*?)\s*<\/UF>/);
  var mMun = corpo.match(/<xMun>\s*([^<]*?)\s*<\/xMun>/);
  var mCmun = corpo.match(/<cMun>\s*(\d*?)\s*<\/cMun>/);
  var temCmunSelfClosed = !mCmun && /<cMun\s*\/>/.test(corpo); // 30/10: gerador pode sair <cMun/> (self-closed)
  var uf = unesc(mUF ? mUF[1] : '');
  var mun = unesc(mMun ? mMun[1] : '');
  var atual = mCmun ? mCmun[1] : '';
  if (!uf || !mun) return corpo; // sem dados suficientes p/ validar
  var correto = ibge.lookup(uf, mun);
  if (!correto || correto === atual) return corpo;
  correcoes.push({
    tag: nomeTag,
    xMun: mun,
    UF: String(uf).toUpperCase(),
    de: atual || '(vazio)',
    para: correto,
  });
  if (temCmunSelfClosed) return corpo.replace(/<cMun\s*\/>/, '<cMun>' + correto + '</cMun>');
  return corpo.replace(/(<cMun>\s*)\d*?(\s*<\/cMun>)/, '$1' + correto + '$2');
}

/**
 * Abre o XML montado, troca cMuns errados pelo codigo oficial e devolve.
 * @param {string} xml XML NF-e completo (pre-assinatura)
 * @returns {{ xml: string, correcoes: Array<{tag,xMun,UF,de,para}> }}
 */
function corrigirCmunNoXml(xml) {
  var correcoes = [];
  try {
    // 1) Blocos de endereco com xMun/UF/cMun
    xml = String(xml).replace(
      /<(enderEmit|enderDest|enderEntrega|enderRetirada|entrega|retirada)>([\s\S]*?)<\/\1>/g,
      function (todo, tag, corpo) {
        return '<' + tag + '>' + corrigirBloco(tag, corpo, correcoes) + '</' + tag + '>';
      }
    );

    // 2) cMunFG / cMunFGIBS (ide) — municipio gerador = municipio do emitente
    var mEmit = xml.match(/<enderEmit>([\s\S]*?)<\/enderEmit>/);
    if (mEmit) {
      var mCmunEmit = mEmit[1].match(/<cMun>\s*(\d*?)\s*<\/cMun>/);
      if (mCmunEmit && mCmunEmit[1]) {
        ['cMunFG', 'cMunFGIBS'].forEach(function (tag) {
          var re = new RegExp('<' + tag + '>\\s*(\\d*?)\\s*</' + tag + '>');
          var m = xml.match(re);
          if (m && m[1] && m[1] !== mCmunEmit[1]) {
            correcoes.push({
              tag: 'ide/' + tag,
              xMun: '(emitente)',
              UF: '',
              de: m[1],
              para: mCmunEmit[1],
            });
            xml = xml.replace(re, '<' + tag + '>' + mCmunEmit[1] + '</' + tag + '>');
          }
        });
      }
    }
  } catch (e) {
    console.error('[NFE-SANITIZE] Falha ao corrigir cMun no XML (seguindo original): ' + e.message);
  }
  return { xml: xml, correcoes: correcoes };
}

module.exports = { corrigirCmunNoXml: corrigirCmunNoXml };
