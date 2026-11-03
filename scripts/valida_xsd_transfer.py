# Valida XSD do XML de transferencia gerado vs XML modelo autorizado pela SEFAZ
# (mesmo metodo do commit eb512a2: paridade de erros — so falsos positivos IBS aceitos)
import sys
from lxml import etree

XSD = '/home/z/my-project/repos/API-Odoo/scripts/xsd/_nfe_global_wrapper.xsd'
ALVO = '/tmp/nfe_transfer_teste.xml'
MODELO = '/home/z/my-project/upload/NFe_42260922603750000514550010000000141081562740.xml'

schema = etree.XMLSchema(etree.parse(XSD))

def valida(path, rotulo):
    doc = etree.parse(path)
    ok = schema.validate(doc)
    erros = [(e.line, str(e.message)) for e in schema.error_log]
    # filtra falsos positivos conhecidos (IBS/CBS do XSD local antigo + assinatura ausente)
    falsos = ('IBSCBS', 'vNFTot', 'IBSCBSTot', 'gCBS', 'gIBS', 'Signature', 'infRespTec', 'hashCSRT', 'idCSRT')
    reais = [(l, m) for (l, m) in erros if not any(f.lower() in m.lower() for f in falsos)]
    print(f'{rotulo}: {"VALIDO" if ok else "ERROS"} — total={len(erros)} reais(apos filtro)={len(reais)}')
    for l, m in reais[:12]:
        print(f'   linha {l}: {m[:200]}')
    return set(m.split("'")[1] if "'" in m else m for _, m in erros)

e_ger = valida(ALVO, 'XML GERADO (transferencia)')
e_mod = valida(MODELO, 'XML MODELO (autorizado SEFAZ 100)')
real_ger = {m for m in e_ger if not any(f.lower() in m.lower() for f in ('IBSCBS', 'vnftot', 'signature', 'infresptec', 'hashcsrt', 'idcsrt', 'gibscbs', 'gcbs', 'gibs'))}
real_mod = {m for m in e_mod if not any(f.lower() in m.lower() for f in ('IBSCBS', 'vnftot', 'signature', 'infresptec', 'hashcsrt', 'idcsrt', 'gibscbs', 'gcbs', 'gibs'))}
extra = real_ger - real_mod
print('\nErros do GERADO que o MODELO tambem nao tem (devem ser 0):', len(extra))
for m in sorted(extra)[:10]:
    print('  EXTRA:', m[:200])
sys.exit(1 if extra else 0)
