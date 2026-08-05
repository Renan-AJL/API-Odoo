# Emissao propria de NF-e com certificado A1 (SEFAZ-PR)

A partir desta versao a API **emite a NF-e sozinha**: assina o XML com o
certificado digital A1 da AJL e envia direto para a SEFAZ do Parana.
A SIEG deixa de ser obrigatoria para emitir — continua util apenas como
cofre de XMLs (opcional) e para NFS-e.

## Fluxo

```text
Odoo (fatura pendente)
   -> sieg-nfe-xml.js      monta o XML da NF-e 4.00
   -> nfe-signer.js        assina infNFe com o A1 (RSA-SHA1 + C14N)
   -> sefaz-client.js      NFeAutorizacao4 (SOAP 1.2 + mTLS, indSinc=1)
                           cStat 100 -> monta o nfeProc
   -> danfe-pdf.js         gera o DANFE em PDF localmente
   -> sieg-odoo-emit.js    anexa .xml e .pdf e posta no chatter
```

## 1. Disco persistente no Render

Crie um **Disk** no servico, montado em `/var/data` (1 GB basta).
Sem ele o certificado precisa ser reenviado a cada deploy — ou informado
pelas variaveis `NFE_CERT_PFX_BASE64` / `NFE_CERT_SENHA`.

## 2. Variaveis de ambiente

| Variavel | Valor | Descricao |
|---|---|---|
| `NFE_EMISSAO_MODO` | `proprio` | `proprio` = assina e autoriza na SEFAZ; `sieg` = so importa XML autorizado |
| `NFE_UF` | `PR` | UF do emitente; define o webservice |
| `SIEG_TP_AMB` | `2` | 1 = producao, 2 = homologacao |
| `NFE_CERT_DIR` | `/var/data` | Onde o `.pfx` fica guardado |
| `NFE_CERT_KEK` | (string forte) | Cifra a senha do certificado em disco (AES-256-GCM) |
| `NFE_DANFE_PROVIDER` | `local` | `local` (padrao) ou `sieg` |
| `SIEG_IMPORT_XML` | `0` | `1` importa o XML autorizado no cofre SIEG |

## 3. Enviar o certificado

```bash
node scripts/enviar-certificado.js ./AJL.pfx "SENHA_DO_PFX" \
  https://sua-api.onrender.com SUA_API_KEY
```

Ou direto por HTTP:

```bash
curl -X POST https://sua-api.onrender.com/api/v1/nfe/certificado \
  -H "x-api-key: SUA_API_KEY" -H "Content-Type: application/json" \
  -d "{\"pfxBase64\":\"$(base64 -w0 AJL.pfx)\",\"senha\":\"SENHA\"}"
```

A resposta traz titular, CNPJ, emissor e validade. A senha nunca aparece
em log e fica cifrada em disco.

## 4. Testar a conexao com a SEFAZ

```bash
curl -H "x-api-key: SUA_API_KEY" https://sua-api.onrender.com/api/v1/nfe/sefaz/status
```

`cStat 107` = "Servico em Operacao" -> certificado valido e mTLS funcionando.

## 5. Emitir

Basta deixar a fatura com `x_studio_nfe_status = pendente` no Odoo.
O polling emite, e o chatter recebe:

- `NFe<chave>.xml` — o `nfeProc` autorizado (NF-e + protocolo)
- `DANFE-<fatura>.pdf` — gerado localmente

Se a SEFAZ rejeitar, o chatter mostra o `cStat`, o `xMotivo` exato e o
trecho do XML relacionado; a fatura volta para `erro` (ou `pendente`, se
`NFE_STATUS_ON_ERROR=pendente`) para nova tentativa.

## Endpoints novos

| Metodo | Rota | Funcao |
|---|---|---|
| POST | `/api/v1/nfe/certificado` | Upload do `.pfx` (base64 + senha) |
| GET | `/api/v1/nfe/certificado` | Status/validade do certificado |
| DELETE | `/api/v1/nfe/certificado` | Remove o certificado |
| GET | `/api/v1/nfe/sefaz/status` | Status do servico da SEFAZ (testa mTLS) |
| POST | `/api/v1/nfe/danfe` | Gera o DANFE PDF a partir de um XML autorizado |

Todos exigem o header `x-api-key`.
