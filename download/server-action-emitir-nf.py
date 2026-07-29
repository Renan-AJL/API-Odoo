=================================================================
SERVER ACTION: Emitir NF
Modelo: account.move
Tipo: Execute Python Code
Acao: Cria uma nova acao em servidor (Settings > Technical > Server Actions)
     ou Adicionar uma acao em (Settings > Automations > Server Actions)
=================================================================

INSTRUCOES:
1. Va em Settings > Technical > Server Actions
2. Crie nova acao:
   - Action Name: Emitir NF
   - Model: account.move
   - Trigger: Action Button
   - Click the "Add a new line" in the code section
   - Cole todo o codigo abaixo (tudo entre as linhas ===)

3. Adicione um botao na fatura (via Studio ou formulario):
   - Va em uma fatura (account.move form view)
   - Studio > Adicionar Botao
   - Nome: "Emitir NF"
   - Acao: Execute Server Action > Emitir NF

CAMPOS OBRIGATORIOS em account.move (x_studio_):
  - x_studio_status_emissao (Selection: rascunho,pendente,processando,autorizada,erro)
  - x_studio_numero_nf (Char)
  - x_studio_serie (Char)
  - x_studio_protocolo (Char)
  - x_studio_chave_acesso (Char)
  - x_studio_data_emissao (Date)
  - x_studio_url_consulta (Char)
  - x_studio_xml_envio (Text)
  - x_studio_xml_retorno (Text)
  - x_studio_erro (Char)
  - x_studio_codigo_erro (Char)
  - x_studio_mensagem_erro (Text)

CAMPOS OBRIGATORIOS em res.company (x_studio_):
  - x_studio_sieg_ultimo_nfe (Integer, default 0)
  - x_studio_sieg_ultimo_nfse (Integer, default 0)
  - x_studio_sieg_serie_nfe (Char, default: 100)
  - x_studio_sieg_serie_nfse (Char, default: 1)
=================================================================