{
    'name': 'SIEG - Emissao NF-e / NFS-e',
    'version': '1.0',
    'category': 'Accounting',
    'summary': 'Emitir NF-e e NFS-e via SIEG a partir de faturas',
    'description': 'Adiciona botao Emitir NF nas faturas (account.move) que integra com o middleware SIEG',
    'depends': ['base', 'account'],
    'data': [
        'views/account_move_views.xml',
    ],
    'installable': True,
    'application': False,
    'license': 'LGPL-3',
}