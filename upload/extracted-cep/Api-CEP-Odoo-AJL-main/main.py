from fastapi import FastAPI
from pydantic import BaseModel
import requests

app = FastAPI()


class CEPRequest(BaseModel):
    cep: str


@app.get("/")
def home():
    return {
        "status": "online",
        "servico": "API CEP Odoo AJL",
        "versao": "3.0"
    }


@app.get("/health")
def health():
    return {
        "status": "ok"
    }


@app.post("/cep")
def consultar_cep(dados: CEPRequest):

    # =========================================================
    # 1. LIMPA O CEP
    # =========================================================

    cep = ''.join(
        c for c in dados.cep
        if c.isdigit()
    )

    if len(cep) != 8:
        return {
            "sucesso": False,
            "erro": "CEP invalido",
            "cep_recebido": dados.cep
        }

    headers = {
        "User-Agent": "API-CEP-Odoo-AJL/3.0",
        "Accept": "application/json"
    }


    # =========================================================
    # 2. OPENCEP
    #    PRINCIPAL
    # =========================================================

    opencep_url = (
        f"https://opencep.com/v1/{cep}.json"
    )

    try:

        resposta = requests.get(
            opencep_url,
            timeout=10,
            headers=headers
        )

        if resposta.status_code == 200:

            dados_cep = resposta.json()

            if dados_cep and not dados_cep.get("erro"):

                return {
                    "sucesso": True,
                    "fonte": "OpenCEP",

                    "cep": dados_cep.get(
                        "cep",
                        cep
                    ),

                    "rua": dados_cep.get(
                        "logradouro"
                    ),

                    "bairro": dados_cep.get(
                        "bairro"
                    ),

                    "cidade": dados_cep.get(
                        "localidade"
                    ),

                    "estado": dados_cep.get(
                        "uf"
                    ),

                    "pais": "Brasil",

                    "ibge_cidade": dados_cep.get(
                        "ibge"
                    ),

                    "ibge_estado": None
                }

    except requests.exceptions.RequestException:
        pass

    except Exception:
        pass


    # =========================================================
    # 3. CEPIFY
    #    FALLBACK 1
    # =========================================================

    cepify_url = (
        f"https://cepify.com.br/ws/{cep}/json"
    )

    try:

        resposta = requests.get(
            cepify_url,
            timeout=10,
            headers=headers
        )

        if resposta.status_code == 200:

            dados_cep = resposta.json()

            if dados_cep and not dados_cep.get("erro"):

                return {
                    "sucesso": True,
                    "fonte": "Cepify",

                    "cep": dados_cep.get(
                        "cep",
                        cep
                    ),

                    "rua": dados_cep.get(
                        "logradouro"
                    ),

                    "bairro": dados_cep.get(
                        "bairro"
                    ),

                    "cidade": dados_cep.get(
                        "localidade"
                    ),

                    "estado": dados_cep.get(
                        "uf"
                    ),

                    "pais": "Brasil",

                    "ibge_cidade": dados_cep.get(
                        "ibge"
                    ),

                    "ibge_estado": None
                }

    except requests.exceptions.RequestException:
        pass

    except Exception:
        pass


    # =========================================================
    # 4. VIACEP
    #    FALLBACK 2
    # =========================================================

    viacep_url = (
        f"https://viacep.com.br/ws/{cep}/json/"
    )

    try:

        resposta = requests.get(
            viacep_url,
            timeout=10,
            headers=headers
        )

        if resposta.status_code == 200:

            dados_cep = resposta.json()

            if dados_cep and not dados_cep.get("erro"):

                return {
                    "sucesso": True,
                    "fonte": "ViaCEP",

                    "cep": dados_cep.get(
                        "cep",
                        cep
                    ),

                    "rua": dados_cep.get(
                        "logradouro"
                    ),

                    "bairro": dados_cep.get(
                        "bairro"
                    ),

                    "cidade": dados_cep.get(
                        "localidade"
                    ),

                    "estado": dados_cep.get(
                        "uf"
                    ),

                    "pais": "Brasil",

                    "ibge_cidade": dados_cep.get(
                        "ibge"
                    ),

                    "ibge_estado": None
                }

    except requests.exceptions.RequestException:
        pass

    except Exception:
        pass


    # =========================================================
    # 5. BRASILAPI
    #    FALLBACK 3
    # =========================================================

    brasilapi_url = (
        f"https://brasilapi.com.br/cep/v1/{cep}"
    )

    try:

        resposta = requests.get(
            brasilapi_url,
            timeout=10,
            headers=headers
        )

        if resposta.status_code == 200:

            dados_cep = resposta.json()

            if dados_cep and not dados_cep.get("erro"):

                ibge = dados_cep.get(
                    "ibge",
                    {}
                )

                return {
                    "sucesso": True,
                    "fonte": "BrasilAPI",

                    "cep": dados_cep.get(
                        "cep",
                        cep
                    ),

                    "rua": dados_cep.get(
                        "street"
                    ),

                    "bairro": dados_cep.get(
                        "neighborhood"
                    ),

                    "cidade": dados_cep.get(
                        "city"
                    ),

                    "estado": dados_cep.get(
                        "state"
                    ),

                    "pais": "Brasil",

                    "ibge_cidade": (
                        ibge.get("city")
                        if isinstance(ibge, dict)
                        else None
                    ),

                    "ibge_estado": (
                        ibge.get("state")
                        if isinstance(ibge, dict)
                        else None
                    )
                }

    except requests.exceptions.RequestException:
        pass

    except Exception:
        pass


    # =========================================================
    # 6. NENHUMA FONTE RESPONDEU
    # =========================================================

    return {
        "sucesso": False,
        "erro": "Nao foi possivel consultar o CEP nas fontes disponiveis.",
        "cep": cep,
        "fontes_consultadas": [
            "OpenCEP",
            "Cepify",
            "ViaCEP",
            "BrasilAPI"
        ]
    }
