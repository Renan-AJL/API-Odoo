#!/usr/bin/env python3
"""
Diagnóstico e Correção da Fatura S01233
=========================================
Verifica por que o pagamento PIX de R$ 1,08 não aparece como pago
e corrige os campos faltantes.

Execute: python3 diagnosticar_s01233.py <ODOO_API_KEY>

O que este script faz:
1. Busca a fatura S01233 no Odoo
2. Mostra TODOS os campos itau e seus valores
3. Verifica o chatter para encontrar o TXID
4. Se o TXID foi encontrado no chatter mas não no campo, escreve no campo
5. Mostra o que precisa ser feito para o polling encontrar a fatura
"""
import xmlrpc.client
import sys
import re

# ============================================================
# CONFIG
# ============================================================
ODOO_URL = 'https://ajlferroeaco.odoo.com'
ODOO_DB  = 'ajlferroeaco'
ODOO_USER = 'marcus@nytro.com.br'
ODOO_API_KEY = sys.argv[1] if len(sys.argv) > 1 else ''

if not ODOO_API_KEY:
    print('Usage: python3 diagnosticar_s01233.py <ODOO_API_KEY>')
    print('  ODOO_API_KEY = sua API key do Odoo (mesma do Render ODOO_API_KEY)')
    sys.exit(1)

# ============================================================
# XML-RPC helpers
# ============================================================
common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

def authenticate():
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
    if not uid:
        print('ERRO: Autenticacao falhou. Verifique API key.')
        sys.exit(1)
    return uid

def execute(uid, model, method, args, kwargs=None):
    if kwargs:
        return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs)
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args)

# ============================================================
# MAIN
# ============================================================
def main():
    print('Conectando ao Odoo...')
    uid = authenticate()
    print(f'Autenticado: UID={uid}\n')

    # Buscar fatura S01233
    print('=' * 70)
    print('PASSO 1: Buscar fatura S01233')
    print('=' * 70)

    inv_ids = execute(uid, 'account.move', 'search', [
        [['name', '=', 'S01233'], ['move_type', '=', 'out_invoice']]
    ])

    if not inv_ids:
        # Tentar com ilike
        inv_ids = execute(uid, 'account.move', 'search', [
            [['name', 'ilike', 'S01233'], ['move_type', '=', 'out_invoice']]
        ])

    if not inv_ids:
        print('ERRO: Fatura S01233 nao encontrada no Odoo!')
        print('Verifique se o nome esta correto (pode ser S01233 ou outro formato)')
        # Listar faturas recentes
        recent = execute(uid, 'account.move', 'search', [
            [['move_type', '=', 'out_invoice']],
        ], {'order': 'id desc', 'limit': 10})
        if recent:
            names = execute(uid, 'account.move', 'read', [recent, ['name', 'amount_total']])
            print('\nFaturas recentes:')
            for n in names:
                print(f'  {n["name"]} - R$ {n["amount_total"]}')
        return

    inv_id = inv_ids[0]
    print(f'Fatura encontrada: ID={inv_id}')

    # Ler todos os campos itau
    print('\n' + '=' * 70)
    print('PASSO 2: Ler campos Itau da fatura')
    print('=' * 70)

    itau_fields = [
        'name', 'move_type', 'payment_state', 'amount_total', 'amount_residual',
        'x_studio_itau_situacao',
        'x_studio_itau_status_pagamento',
        'x_studio_itau_tipo_pagamento',
        'x_studio_itau_pix_status',
        'x_studio_itau_pix_data_pagamento',
        'x_studio_itau_pix_e2e',
        'x_studio_itau_txid',
        'x_studio_itau_pix_copia_cola',
        'x_studio_itau_nosso_numero',
        'x_studio_itau_boleto_status',
        'x_studio_itau_boleto_data_pagamento',
        'x_studio_itau_link_status',
        'x_studio_itau_boletos_html',
        'x_studio_boleto_cancelado',
    ]

    try:
        inv_data = execute(uid, 'account.move', 'read', [inv_ids, itau_fields])
        inv = inv_data[0]
    except Exception as e:
        print(f'ERRO ao ler campos: {e}')
        print('Alguns campos podem nao existir ainda. Tentando campos basicos...')
        basic_fields = ['name', 'move_type', 'payment_state', 'amount_total', 'amount_residual']
        inv = execute(uid, 'account.move', 'read', [inv_ids, basic_fields])[0]
        # Adicionar campos itau como None
        for f in itau_fields:
            if f not in inv:
                inv[f] = '<CAMPO INEXISTENTE>'

    print(f'\n  Fatura:           {inv.get("name", "N/A")}')
    print(f'  payment_state:    {inv.get("payment_state", "N/A")}')
    print(f'  Valor total:      R$ {inv.get("amount_total", 0)}')
    print(f'  Saldo residual:   R$ {inv.get("amount_residual", 0)}')
    print()
    print(f'  --- Campos Itau ---')
    for f in itau_fields:
        if f.startswith('x_studio_'):
            val = inv.get(f, '<INEXISTENTE>')
            if val is False:
                val = 'False (vazio)'
            elif val is None:
                val = 'None (nulo)'
            status = '✅' if val and val != 'False (vazio)' and val != 'None (nulo)' and val != '<INEXISTENTE>' else '❌'
            print(f'  {status} {f:45s} = {val}')

    # Verificar chatter
    print('\n' + '=' * 70)
    print('PASSO 3: Buscar TXID no Chatter (notas internas)')
    print('=' * 70)

    msg_ids = execute(uid, 'mail.message', 'search', [
        [['model', '=', 'account.move'], ['res_id', '=', inv_id]],
    ], {'order': 'id desc', 'limit': 20})

    found_txid = None
    found_pix_copia_cola = None

    if msg_ids:
        msgs = execute(uid, 'mail.message', 'read', [msg_ids, ['body', 'message_type', 'create_date']])
        for m in msgs:
            body = m.get('body', '') or ''
            # Procurar TXID no body
            txid_match = re.search(r'TXID[:\s]+([a-zA-Z0-9\-]{20,})', body)
            if txid_match:
                found_txid = txid_match.group(1)
            # Procurar PIX Copia e Cola
            pix_match = re.search(r'PIX Copia e Cola[:\s]+(\S+)', body)
            if pix_match:
                found_pix_copia_cola = pix_match.group(1)
            
            # Mostrar mensagens relevantes
            if 'PIX' in body or 'Itau' in body or 'itau' in body or 'boleto' in body.lower():
                print(f'\n  [{m["create_date"]}] ({m["message_type"]})')
                # Limpar HTML
                clean = re.sub(r'<[^>]+>', ' ', body)
                clean = re.sub(r'\s+', ' ', clean).strip()
                print(f'  {clean[:200]}')
    else:
        print('  Nenhuma mensagem no chatter')

    # Diagnóstico
    print('\n' + '=' * 70)
    print('PASSO 4: Diagnóstico')
    print('=' * 70)

    current_txid = inv.get('x_studio_itau_txid')
    current_tipo = inv.get('x_studio_itau_tipo_pagamento')
    current_situacao = inv.get('x_studio_itau_situacao')
    payment_state = inv.get('payment_state')

    print(f'\n  Tem TXID no campo?        {"SIM" if current_txid else "NAO"}')
    print(f'  Tem TXID no chatter?      {"SIM (" + found_txid[:20] + "...)" if found_txid else "NAO"}')
    print(f'  Tem tipo_pagamento?       {"SIM (" + str(current_tipo) + ")" if current_tipo else "NAO"}')
    print(f'  Tem situacao?             {"SIM (" + str(current_situacao) + ")" if current_situacao else "NAO"}')
    print(f'  payment_state Odoo?       {payment_state}')
    print(f'  Pode ser encontrado pelo poll? {"SIM" if current_txid and current_tipo else "NAO"}')

    # Correção automática
    print('\n' + '=' * 70)
    print('PASSO 5: Correção')
    print('=' * 70)

    needs_fix = False
    fix_vals = {}

    # Se payment_state já é 'paid', o pagamento já foi registrado no Odoo
    if payment_state == 'paid':
        print('\n  ✅ A fatura JA ESTA PAGA no Odoo (payment_state=paid)')
        print('  Os campos Itau podem estar desatualizados.')
        if not current_situacao or current_situacao == False:
            fix_vals['x_studio_itau_situacao'] = 'pago'
            fix_vals['x_studio_itau_status_pagamento'] = 'pago'
            fix_vals['x_studio_itau_pix_status'] = 'concluida'
            needs_fix = True
            print('  → Vou atualizar campos Itau para refletir o pagamento')
    else:
        print('\n  ❌ A fatura NAO esta paga no Odoo (payment_state=' + str(payment_state) + ')')
        
        # Se TXID foi encontrado no chatter mas não no campo
        if found_txid and not current_txid:
            fix_vals['x_studio_itau_txid'] = found_txid
            print(f'  → TXID encontrado no chatter: {found_txid}')
            print('  → Vou gravar no campo x_studio_itau_txid')

        # Se tipo_pagamento não está definido
        if not current_tipo or current_tipo == False:
            fix_vals['x_studio_itau_tipo_pagamento'] = 'pix'
            print('  → Vou definir tipo_pagamento = pix')

        # Se situacao não está definida
        if not current_situacao or current_situacao == False:
            fix_vals['x_studio_itau_situacao'] = 'emitido'
            print('  → Vou definir situacao = emitido')

        if found_pix_copia_cola and (not inv.get('x_studio_itau_pix_copia_cola') or inv.get('x_studio_itau_pix_copia_cola') == False):
            fix_vals['x_studio_itau_pix_copia_cola'] = found_pix_copia_cola
            print('  → Vou gravar PIX Copia e Cola do chatter')

        needs_fix = len(fix_vals) > 0

    if needs_fix:
        print(f'\n  Campos a atualizar: {list(fix_vals.keys())}')
        confirm = input('\n  Aplicar correcoes? (s/N): ').strip().lower()
        if confirm == 's':
            try:
                execute(uid, 'account.move', 'write', [[inv_id], fix_vals])
                print('  ✅ Campos atualizados com sucesso!')
                
                # Invalidar cache de campos no middleware
                print('\n  NOTA: Apos a correcao, aguarde ate 5 minutos para o cache')
                print('  do middleware expirar, ou reinicie o servidor no Render.')
                print('  O polling ira encontrar a fatura na proxima verificacao (a cada 60s).')
            except Exception as e:
                print(f'  ❌ Erro ao atualizar: {e}')
        else:
            print('  Correcoes canceladas.')
    else:
        print('\n  Nenhuma correcao necessaria.')

    # Instruções finais
    print('\n' + '=' * 70)
    print('INSTRUCOES FINAIS')
    print('=' * 70)
    print("""
  Para que o pagamento de R$ 1,08 do S01233 apareça como PAGO:

  1. Se o PIX ainda nao foi pago: O cliente precisa pagar o PIX.
     O Itau enviara um webhook OU o polling detectara em ate 60s.

  2. Se o PIX ja foi pago mas o Odoo nao atualizou:
     a) O TXID precisa estar gravado no campo x_studio_itau_txid
     b) O tipo_pagamento precisa ser 'pix' 
     c) O polling (a cada 60s) consultara o Itau e atualizara o status

  3. Se o pagamento ja foi confirmado no Odoo (payment_state=paid)
     mas os campos Itau estao vazios, rode este script com -f para
     forcar a atualizacao dos campos.

  4. Para verificar manualmente o status do PIX no Itau:
     Acesse o middleware: POST /api/v1/itau/status/consultar-pix/<TXID>
     (Substitua <TXID> pelo TXID da cobranca)
""")

if __name__ == '__main__':
    main()
