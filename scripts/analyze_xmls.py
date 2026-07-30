import xml.etree.ElementTree as ET

ns_nfe = {'nfe': 'http://www.portalfiscal.inf.br/nfe'}
ns_nfse = {'nfse': 'http://www.sped.fazenda.gov.br/nfse'}

def tag(el):
    return el.tag.split('}')[1] if '}' in el.tag else el.tag

def print_tree(el, indent=0):
    prefix = '  ' * indent
    children = list(el)
    if not children:
        print(f'{prefix}<{tag(el)}> {el.text}')
    else:
        print(f'{prefix}<{tag(el)}>')
        for c in children:
            print_tree(c, indent + 1)

# ==================== NF-e ====================
print('=' * 70)
print('NF-e STRUCTURE (from SIEG authorized XML)')
print('=' * 70)

nfe_file = '/home/z/my-project/upload/xmls/41260716859095000133551000000002131431458224.xml'
tree = ET.parse(nfe_file)
root = tree.getroot()

nfe = root.find('.//nfe:NFe', ns_nfe)
inf = nfe.find('nfe:infNFe', ns_nfe)

print(f'\nRoot: <{tag(root)}> versao={root.get("versao")}')
print(f'  <NFe> xmlns={nfe.attrib.get("xmlns","")}')
print(f'    <infNFe> Id={inf.get("Id","")} versao={inf.get("versao","")}')

# Count items
dets = inf.findall('nfe:det', ns_nfe)
print(f'    Total items (det): {len(dets)}')

# Print first det item structure
print(f'\n--- det[1] structure ---')
det1 = dets[0]
print_tree(det1, 3)

# Print ide
print(f'\n--- ide ---')
ide = inf.find('nfe:ide', ns_nfe)
for c in ide:
    print(f'  {tag(c)}: {c.text}')

# Print emit
print(f'\n--- emit ---')
emit = inf.find('nfe:emit', ns_nfe)
print_tree(emit, 1)

# Print dest
print(f'\n--- dest ---')
dest = inf.find('nfe:dest', ns_nfe)
print_tree(dest, 1)

# Print total
print(f'\n--- total > ICMSTot ---')
icms_tot = inf.find('nfe:total/nfe:ICMSTot', ns_nfe)
for c in icms_tot:
    print(f'  {tag(c)}: {c.text}')

# Print transp
print(f'\n--- transp ---')
transp = inf.find('nfe:transp', ns_nfe)
print_tree(transp, 1)

# Print cobr
print(f'\n--- cobr ---')
cobr = inf.find('nfe:cobr', ns_nfe)
if cobr is not None:
    print_tree(cobr, 1)

# Print pag
print(f'\n--- pag ---')
pag = inf.find('nfe:pag', ns_nfe)
print_tree(pag, 1)

# Print infAdic
print(f'\n--- infAdic ---')
inf_adic = inf.find('nfe:infAdic', ns_nfe)
if inf_adic is not None:
    print_tree(inf_adic, 1)

# Print infRespTec
print(f'\n--- infRespTec ---')
inf_resp = inf.find('nfe:infRespTec', ns_nfe)
if inf_resp is not None:
    print_tree(inf_resp, 1)

# Print protNFe
print(f'\n--- protNFe (SEFAZ protocol) ---')
prot = root.find('.//nfe:protNFe/nfe:infProt', ns_nfe)
if prot is not None:
    print_tree(prot, 1)

# Signature present?
sig = root.find('.//{http://www.w3.org/2000/09/xmldsig#}Signature')
print(f'\nSignature present: {sig is not None}')

# ==================== NFS-e ====================
print('\n' + '=' * 70)
print('NFS-e STRUCTURE (from SIEG authorized XML)')
print('=' * 70)

nfse_file = '/home/z/my-project/upload/xmls/41004001211615524000103000000000058726076261731160.xml'
tree2 = ET.parse(nfse_file)
root2 = tree2.getroot()

print(f'\nRoot: <{tag(root2)}> versao={root2.get("versao")}')
print(f'  xmlns: {root2.attrib}')

inf_nfse = root2.find('nfse:infNFSe', ns_nfse)

# Print all infNFSe children
print(f'\n--- infNFSe ---')
for c in inf_nfse:
    t = tag(c)
    if t == 'DPS':
        print(f'  <DPS versao={c.get("versao")}>')
        inf_dps = c.find('nfse:infDPS', ns_nfse)
        print(f'    <infDPS Id={inf_dps.get("Id","")}>')
        for dc in inf_dps:
            dt = tag(dc)
            children = list(dc)
            if not children:
                print(f'      <{dt}> {dc.text}')
            else:
                print(f'      <{dt}>')
                for dcc in children:
                    dchildren = list(dcc)
                    if not dchildren:
                        print(f'        <{tag(dcc)}> {dcc.text}')
                    else:
                        print(f'        <{tag(dcc)}>')
                        for dccc in dchildren:
                            ddchildren = list(dccc)
                            if not ddchildren:
                                print(f'          <{tag(dccc)}> {dccc.text}')
                            else:
                                print(f'          <{tag(dccc)}>')
                                for dcccc in ddchildren:
                                    print(f'            <{tag(dcccc)}> {dcccc.text}')
    elif t == 'emit':
        print(f'  <{t}>')
        for ec in c:
            et = tag(ec)
            if et == 'enderNac':
                print(f'    <{et}>')
                for eec in ec:
                    print(f'      <{tag(eec)}> {eec.text}')
            else:
                print(f'    <{et}> {ec.text}')
    elif t == 'valores':
        print(f'  <{t}>')
        for vc in c:
            vt = tag(vc)
            vchildren = list(vc)
            if not vchildren:
                print(f'    <{vt}> {vc.text}')
            else:
                print(f'    <{vt}>')
                for vvc in vchildren:
                    print(f'      <{tag(vvc)}> {vvc.text}')
    else:
        print(f'  <{t}> {c.text}')

# NFS-e Signature
sig2 = root2.find('{http://www.w3.org/2000/09/xmldsig#}Signature')
print(f'\nSignature present: {sig2 is not None}')

# ==================== ODOO MAPPING SUMMARY ====================
print('\n' + '=' * 70)
print('ODOO FIELD MAPPING SUMMARY')
print('=' * 70)

print('''
=== NF-e (products) ===
Field                    | XML Path                           | Odoo Source
-------------------------|-------------------------------------|-----------------------
cUF                      | ide/cUF                             | company.state_id.ibge_code
cNF                      | ide/cNF                             | AUTO (random 8 digits)
natOp                    | ide/natOp                           | sale.order.note or config
mod                      | ide/mod                             | FIXED "55"
serie                    | ide/serie                           | Odoo journal sequence or config
nNF                      | ide/nNF                             | sale.order name or sequence
dhEmi                    | ide/dhEmi                           | sale.order.date_order
tpNF                     | ide/tpNF                            | FIXED "1" (saída)
idDest                   | ide/idDest                          | computed from UF dest
cMunFG                   | ide/cMunFG                          | company city IBGE code
tpAmb                    | ide/tpAmb                           | "1" prod / "2" homolog
finNFe                   | ide/finNFe                          | "1" normal
indFinal                 | ide/indFinal                        | partner.is_consumer
indPres                  | ide/indPres                         | "0" não presencial / "1" presencial
procEmi                  | ide/procEmi                         | "0" emissão própria (via SIEG)
verProc                  | ide/verProc                         | Odoo version string

CNPJ (emit)              | emit/CNPJ                           | company.cnpj_cpf
xNome (emit)             | emit/xNome                          | company.legal_name
xFant (emit)             | emit/xFant                          | company.name
enderEmit                | emit/enderEmit/*                    | company partner address
IE (emit)                | emit/IE                             | company.inscr_est
CRT (emit)               | emit/CRT                            | company.tax_framework (1=SN, 3=RegNormal)

CNPJ/CPF (dest)          | dest/CNPJ or dest/CPF               | partner.cnpj_cpf
xNome (dest)             | dest/xNome                          | partner.legal_name
enderDest                | dest/enderDest/*                    | partner address
indIEDest                | dest/indIEDest                      | computed (1=contrib, 2=isento, 9=NF)
IE (dest)                | dest/IE                             | partner.inscr_est
email (dest)             | dest/email                          | partner.email

cProd                    | det/prod/cProd                      | product.default_code
cEAN                     | det/prod/cEAN                       | product.barcode or "SEM GTIN"
xProd                    | det/prod/xProd                      | product.name
NCM                      | det/prod/NCM                        | product.ncm_id.code
CFOP                     | det/prod/CFOP                       | computed (5102 venda fora UF SN)
uCom                     | det/prod/uCom                       | product.uom_id
qCom                     | det/prod/qCom                       | line.product_uom_qty
vUnCom                   | det/prod/vUnCom                     | line.price_unit
vProd                    | det/prod/vProd                      | line.price_subtotal
indTot                   | det/prod/indTot                     | "1" (compõe total)

ICMS (Simples Nacional)   | det/imposto/ICMS/ICMSSN102          | CSOSN from tax config
PIS                      | det/imposto/PIS                     | from tax config
COFINS                   | det/imposto/COFINS                  | from tax config

vProd (total)            | total/ICMSTot/vProd                 | SUM of line vProd
vNF (total)              | total/ICMSTot/vNF                   | sale.order.amount_total
vBC, vICMS, etc          | total/ICMSTot/*                     | computed from taxes

modFrete                 | transp/modFrete                     | "9" sem frete
vol/qVol, esp, pesoL/B  | transp/vol/*                        | from delivery/packing

nFat                     | cobr/fat/nFat                       | sale.order.name
vOrig, vLiq              | cobr/fat/vOrig, vLiq               | sale.order.amount_total
dup[]                    | cobr/dup[]                          | from payment terms
tPag                     | pag/detPag/tPag                     | payment method (15=BOLETO, pix=65...)
vPag                     | pag/detPag/vPag                     | payment value

infCpl                   | infAdic/infCpl                      | sale.order.note


=== NFS-e (services) ===
Field                    | XML Path                           | Odoo Source
-------------------------|-------------------------------------|-----------------------
verAplic                 | infDPS/verAplic                     | "1.1.0" (SIEG)
tpAmb                    | infDPS/tpAmb                        | "1" prod / "2" homolog
dhEmi                    | infDPS/dhEmi                        | sale.order.date_order
serie                    | infDPS/serie                        | config (default "1")
nDPS                     | infDPS/nDPS                         | sequence
dCompet                  | infDPS/dCompet                      | date of service
tpEmit                   | infDPS/tpEmit                       | "1" (prestador)
cLocEmi                  | infDPS/cLocEmi                      | company city IBGE

CNPJ (prest)             | prest/CNPJ                          | company.cnpj_cpf
IM (prest)               | prest/IM                            | company.inscr_mun
fone (prest)             | prest/fone                          | company.phone
email (prest)            | prest/email                         | company.email
opSimpNac                | prest/regTrib/opSimpNac             | company.tax_framework mapping
regApTribSN              | prest/regTrib/regApTribSN           | "1" for SN

CNPJ (toma)              | toma/CNPJ                           | partner.cnpj_cpf
xNome (toma)             | toma/xNome                          | partner.legal_name
end/toma                 | toma/end/*                          | partner address

cTribNac                 | serv/cServ/cTribNac                 | from service type config
xDescServ                | serv/cServ/xDescServ                | product.name + description
cNBS                     | serv/cServ/cNBS                      | from service config
cIntContrib              | serv/cServ/cIntContrib               | municipal service code

cLocPrestacao            | serv/locPrest/cLocPrestacao         | IBGE code of service location
vServ                    | valores/vServPrest/vServ            | sale.order.amount_total
tribISSQN                | valores/trib/tribMun/tribISSQN      | "1" (sim)
tpRetISSQN               | valores/trib/tribMun/tpRetISSQN     | "1" (retido) or "2" (não retido)

pTotTribFed              | trib/totTrib/pTotTrib/pTotTribFed   | IBPT estimate
pTotTribEst              | trib/totTrib/pTotTrib/pTotTribEst   | IBPT estimate  
pTotTribMun              | trib/totTrib/pTotTrib/pTotTribMun   | IBPT estimate
''')
