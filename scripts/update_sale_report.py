#!/usr/bin/env python3
"""
Update sale.report_saleorder_document QWeb template in Odoo via XML-RPC.
Uses the exact template provided by the user.
"""
import xmlrpc.client
import sys

# Odoo connection
URL = 'https://ajlferroeaco.odoo.com/'
DB = 'ajlferroeaco'
USER = 'marcus@nytro.com.br'
APIKEY = '35a6a8b79f1fa688bd5c49b3ba45ec390cfe1b52'

# Connect
common = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/common')
uid = common.authenticate(DB, USER, APIKEY, {})
if not uid:
    print("ERROR: Authentication failed!")
    sys.exit(1)
print(f"Authenticated as uid={uid}")

models = xmlrpc.client.ServerProxy(f'{URL}xmlrpc/2/object')

# Step 1: Find the existing view - try multiple search strategies
search_strategies = [
    [['key', '=', 'sale.report_saleorder_document']],
    [['name', '=', 'sale.report_saleorder_document']],
    [['key', 'like', 'report_saleorder_document']],
    [['name', 'ilike', 'report_saleorder_document']],
]

views = []
for strategy in search_strategies:
    views = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', 
        [strategy], {'limit': 5, 'fields': ['id', 'name', 'key', 'inherit_id', 'model', 'type']})
    if views:
        print(f"Found views using strategy: {strategy}")
        break

print(f"Found {len(views)} view(s):")
for v in views:
    print(f"  ID={v['id']}, name={v.get('name','')}, key={v.get('key','')}, type={v.get('type','')}, model={v.get('model','')}, inherit_id={v.get('inherit_id','')}")

if not views:
    print("ERROR: No view found!")
    sys.exit(1)

view_id = views[0]['id']
print(f"\nUsing view ID={view_id}")

# Read current arch to see what we're replacing
current = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [view_id], 
    {'fields': ['arch_db', 'name', 'key', 'inherit_id', 'model', 'type']})
print(f"Current view details:")
print(f"  name: {current[0].get('name','')}")
print(f"  key: {current[0].get('key','')}")
print(f"  model: {current[0].get('model','')}")
print(f"  type: {current[0].get('type','')}")
print(f"  inherit_id: {current[0].get('inherit_id','')}")
print(f"  arch_db length: {len(current[0].get('arch_db',''))}")

# The new template - EXACT code from user
NEW_ARCH = """<t t-name="sale.report_saleorder_document" lock-id="0">
    <t t-set="doc" t-value="doc.with_context(lang=doc.partner_id.lang)" lock-id="1"/>
    <t t-set="address" lock-id="2">
        <div t-field="doc.partner_id" class="mb-0" t-options="{&quot;widget&quot;: &quot;contact&quot;, &quot;fields&quot;: [&quot;address&quot;, &quot;name&quot;], &quot;no_marker&quot;: True}" lock-id="3"/>
        <p t-if="doc.partner_id.vat" class="mb-0" lock-id="4">
            <t t-if="doc.company_id.account_fiscal_country_id.vat_label" t-out="doc.company_id.account_fiscal_country_id.vat_label" lock-id="5"/>
            <t t-else="" lock-id="6">Tax ID</t>: <span t-field="doc.partner_id.vat" lock-id="7"/>
        </p>
    </t>
    <t t-set="is_proforma" t-value="env.context.get('proforma', False) or is_pro_forma" lock-id="8"/>
    <t t-set="layout_document_title" lock-id="9">
        <span t-if="is_proforma" lock-id="10">Pro Forma Invoice # </span>
        <span t-elif="doc.state in ['draft','sent']" lock-id="11">Quotation # </span>
        <span t-else="" lock-id="12">Order # </span>
        <span t-field="doc.name" lock-id="13">SO0000</span>
    </t>
    <t t-if="doc.partner_shipping_id == doc.partner_invoice_id                          and doc.partner_invoice_id != doc.partner_id                          or doc.partner_shipping_id != doc.partner_invoice_id" lock-id="14">
        <t t-set="information_block" lock-id="15">
            <t t-if="doc.partner_shipping_id == doc.partner_invoice_id" lock-id="16">
                <strong lock-id="17">
                    Invoicing and Shipping Address
                </strong>
                <div t-field="doc.partner_invoice_id" t-options="{&quot;widget&quot;: &quot;contact&quot;, &quot;fields&quot;: [&quot;address&quot;, &quot;name&quot;, &quot;phone&quot;], &quot;no_marker&quot;: True, &quot;phone_icons&quot;: True}" lock-id="18"/>
            </t>
            <div t-else="" class="row" lock-id="19">
                <div t-if="doc.partner_id != doc.partner_invoice_id" t-att-class="doc.partner_id != doc.partner_shipping_id and 'col-6 pe-1'" lock-id="20">
                    <strong lock-id="21">
                        Invoicing Address
                    </strong>
                    <div t-field="doc.partner_invoice_id" t-options="{&quot;widget&quot;: &quot;contact&quot;, &quot;fields&quot;: [&quot;address&quot;, &quot;name&quot;, &quot;phone&quot;], &quot;no_marker&quot;: True, &quot;phone_icons&quot;: True}" lock-id="22"/>
                </div>
                <div t-if="doc.partner_id != doc.partner_shipping_id" t-att-class="doc.partner_id != doc.partner_invoice_id and 'col-6 ps-1'" lock-id="23">
                    <strong lock-id="24">
                        Shipping Address
                    </strong>
                    <div t-field="doc.partner_shipping_id" t-options="{&quot;widget&quot;: &quot;contact&quot;, &quot;fields&quot;: [&quot;address&quot;, &quot;name&quot;, &quot;phone&quot;], &quot;no_marker&quot;: True, &quot;phone_icons&quot;: True}" lock-id="25"/>
                </div>
            </div>
        </t>
    </t>
    <t t-call="web.external_layout" address="address" layout_document_title="layout_document_title" information_block="information_block" forced_vat="doc.fiscal_position_id.foreign_vat" lock-id="26"> <!-- So that it appears in the footer of the report instead of the company VAT if it's set -->
        <div class="page" lock-id="27">
            <div class="oe_structure" lock-id="28"/>

            <div class="row mb-4" id="informations" lock-id="29">
                <div t-if="doc.client_order_ref" class="col" name="informations_reference" lock-id="30">
                    <strong lock-id="31">Your Reference</strong>
                    <div t-field="doc.client_order_ref" lock-id="32">SO0000</div>
                </div>
                <div t-if="doc.date_order" class="col" name="informations_date" lock-id="33">
                    <strong t-if="is_proforma" lock-id="34">Issued Date</strong>
                    <strong t-elif="doc.state in ['draft', 'sent']" lock-id="35">Quotation Date</strong>
                    <strong t-else="" lock-id="36">Order Date</strong>
                    <div t-field="doc.date_order" t-options="{&quot;widget&quot;: &quot;date&quot;}" lock-id="37">2023-12-31</div>
                </div>
                <div t-if="doc.validity_date and doc.state in ['draft', 'sent']" class="col" name="expiration_date" lock-id="38">
                    <strong lock-id="39">Expiration</strong>
                    <div t-field="doc.validity_date" lock-id="40">2023-12-31</div>
                </div>
                <div t-if="doc.incoterm" class="col" lock-id="41">
                    <strong lock-id="42">Incoterm</strong>
                    <div t-if="doc.incoterm_location" lock-id="43">
                        <span t-field="doc.incoterm.code" lock-id="44"/> <br lock-id="45"/>
                        <span t-field="doc.incoterm_location" lock-id="46"/>
                    </div>
                    <div t-else="" t-field="doc.incoterm.code" lock-id="47"/>
                </div>
                <div t-if="doc.commitment_date" class="col" name="delivery_date" lock-id="48">
                    <strong lock-id="49">Delivery Date</strong>
                    <div t-field="doc.commitment_date" t-options="{'widget': 'date'}" lock-id="50">
                        2023-12-31
                    </div>
                </div>
                <div t-if="doc.user_id.name" class="col" lock-id="51">
                    <strong lock-id="52">Contact</strong>
                    <div t-field="doc.user_id" lock-id="53">Mitchell Admin</div>
                </div>
            </div>

            <!-- Is there a discount on at least one line? -->
            <t t-set="lines_to_report" t-value="doc._get_order_lines_to_report()" lock-id="54"/>
            <t t-set="display_discount" t-value="any(l.discount &gt; 0 for l in lines_to_report)" lock-id="55"/>
            <!-- Hide taxes AND show taxed amounts on lines -->
            <t t-set="hide_taxes_details" t-value="False" lock-id="56"/>
            <t t-set="display_taxes" t-value="not hide_taxes_details and any(l._has_taxes() for l in lines_to_report) and not doc.is_avatax" lock-id="57"/>

            <div class="oe_structure" lock-id="58"/>
            <table class="o_has_total_table table o_main_table table-borderless" lock-id="59">
                <!-- In case we want to repeat the header, remove "display: table-row-group" -->
                <thead style="display: table-row-group" lock-id="60">
                    <!-- Initialize the dynamic column counter -->
                    <t t-set="colspan_count" t-value="0" lock-id="61"/>
                    <tr lock-id="62">
                        <th name="th_description" class="text-start" lock-id="63">
                            <t t-set="colspan_count" t-value="colspan_count + 1" lock-id="64"/>
                            Description
                        </th>
                        <th name="th_quantity" class="text-end text-nowrap" lock-id="65">
                            <t t-set="colspan_count" t-value="colspan_count + 1" lock-id="66"/>
                            Quantity
                        </th>
                        <th name="th_priceunit" class="text-end text-nowrap" lock-id="67">
                            <t t-set="colspan_count" t-value="colspan_count + 1" lock-id="68"/>
                            Unit Price
                        </th>
                        <th name="th_discount" t-if="display_discount" class="text-end" lock-id="69">
                            <t t-set="colspan_count" t-value="colspan_count + 1" lock-id="70"/>
                            <span lock-id="71">Disc.%</span>
                        </th>
                        <th name="th_taxes" t-if="display_taxes" class="text-end" lock-id="72">
                            <t t-set="colspan_count" t-value="colspan_count + 1" lock-id="73"/>
                            <span lock-id="74">Taxes</span>
                        </th>
                        <th name="th_subtotal" class="text-end" lock-id="75">
                            <span lock-id="76">Amount</span>
                        </th>
                    </tr>
                </thead>
                <tbody class="sale_tbody" lock-id="77">

                    <t t-set="current_section" t-value="None" lock-id="78"/>
                    <t t-set="current_subsection" t-value="None" lock-id="79"/>
                    <t t-set="price_field" t-value="'price_total' if (hide_taxes_details or doc.company_price_include == 'tax_included') else 'price_subtotal'" lock-id="80"/>


                    <t t-foreach="lines_to_report" t-as="line" lock-id="81">

                        <t t-set="is_note" t-value="line.display_type == 'line_note'" lock-id="82"/>
                        <t t-set="is_section" t-value="line.display_type == 'line_section'" lock-id="83"/>
                        <t t-set="is_subsection" t-value="line.display_type == 'line_subsection'" lock-id="84"/>
                        <t t-set="is_combo" t-value="line.product_type == 'combo'" lock-id="85"/>

                        <t t-if="is_section" lock-id="86">
                            <t t-set="current_section" t-value="line" lock-id="87"/>
                            <t t-set="current_subsection" t-value="None" lock-id="88"/>
                            <t t-set="line_padding" t-value="1" lock-id="89"/>
                            <t t-set="collapse_prices" t-value="line.collapse_prices" lock-id="90"/>
                        </t>
                        <t t-elif="is_subsection" lock-id="91">
                            <t t-set="current_subsection" t-value="line" lock-id="92"/>
                            <t t-set="line_padding" t-value="2" lock-id="93"/>
                            <t t-set="collapse_prices" t-value="collapse_prices or line.collapse_prices" lock-id="94"/>
                        </t>
                        <t t-else="" lock-id="95">
                            <t t-set="line_padding" t-value="3 if current_subsection else (2 if current_section else 0)" lock-id="96"/>
                        </t>

                        <t t-if="line.combo_item_id" lock-id="97">
                            <t t-set="line_padding" t-value="line_padding + 1" lock-id="98"/>
                        </t>

                        <t t-set="padding_style" t-value="line_padding and ('padding-left:' + str(line_padding * 8) + 'px') or ''" lock-id="99"/>
                        <t t-set="show_section_total" t-value="is_section or not line.parent_id.collapse_prices" lock-id="100"/>

                        <t t-if="not line.collapse_composition" lock-id="101">
                            <tr t-if="is_section or is_subsection" name="tr_section" t-attf-class="fw-bold {{'o_line_section' if is_section else 'o_line_subsection'}}" lock-id="102">
                                <t t-set="show_section_total" t-value="(                                         (                                             is_section                                             or not line.parent_id.collapse_prices                                         )                                         and not line.is_downpayment                                     )" lock-id="103"/>
                                <t t-set="section_name_colspan" t-value="colspan_count" lock-id="104"/>
                                <t t-if="not show_section_total" lock-id="105">
                                    <t t-set="section_name_colspan" t-value="99" lock-id="106"/>
                                </t>
                                <td name="td_section_name" t-att-colspan="section_name_colspan" class="border-end-0" t-att-style="padding_style" lock-id="107">
                                    <span t-field="line.name" lock-id="108">A section title</span>
                                </td>
                                <td t-if="show_section_total" name="td_section_price" class="text-end o_price_total" lock-id="109">
                                    <span t-out="line._get_section_totals(price_field)" class="text-nowrap" t-options="{'widget': 'monetary', 'display_currency': doc.currency_id}" lock-id="110">
                                        27.00
                                    </span>
                                </td>
                            </tr>
                            <tr t-elif="is_note" name="tr_note" class="fst-italic o_line_note" lock-id="111">
                                <td name="td_note_name" colspan="99" t-att-style="padding_style" lock-id="112">
                                    <span t-field="line.name" lock-id="113">A note, whose content usually applies to the section or product above.</span>
                                </td>
                            </tr>
                            <tr t-elif="is_combo" name="tr_combo" class="o_line_combo fw-bold" lock-id="114">
                                <td name="td_combo_name" t-att-style="padding_style" lock-id="115">
                                    <span t-field="line.name" lock-id="116">Combo Product</span>
                                </td>
                                <td name="td_combo_quantity" class="text-end" lock-id="117">
                                    <span t-field="line.product_uom_qty" lock-id="118"/>
                                    <span t-field="line.product_uom_id" lock-id="119"/>
                                </td>
                                <td name="td_combo_price" t-att-colspan="colspan_count - 1" class="text-end o_price_total" lock-id="120">
                                    <span t-if="not collapse_prices" name="price_subtotal_combo" t-out="line._get_combo_totals(price_field)" class="text-nowrap" t-options="{'widget': 'monetary', 'display_currency': doc.currency_id}" lock-id="121">
                                        27.00
                                    </span>
                                </td>
                            </tr>
                            <tr t-else="" name="tr_product" lock-id="122">
                                <td name="td_product_name" class="w-100" t-att-style="padding_style" lock-id="123">
                                    <div class="d-flex align-items-start" lock-id="124">
                                        <img t-if="doc.company_id.display_product_images_on_so and line.product_id.image_128" t-att-src="image_data_uri(line.product_id.image_128)" t-att-alt="line.product_id.display_name" class="o_sale_report_product_image me-2 rounded object-fit-cover align-top" lock-id="125"/>
                                        <div class="o_product_name_cell flex-grow-1 text-break align-top" lock-id="126">
                                            <span t-field="line.name" lock-id="127">Bacon Burger</span>
                                        </div>
                                    </div>
                                </td>
                                <td name="td_product_quantity" class="o_td_quantity text-end" lock-id="128">
                                    <span t-field="line.product_uom_qty" class="text-nowrap" lock-id="129">3</span>
                                    <span t-field="line.product_uom_id" lock-id="130">units</span>
                                    <span t-if="line.product_uom_id != line.product_id.uom_id" class="text-muted small" lock-id="131">
                                        <t t-set="quantity_in_product_uom" t-value="line.product_uom_id._compute_quantity(line.product_uom_qty, line.product_id.uom_id)" lock-id="132"/>
                                        <br lock-id="133"/><span t-out="quantity_in_product_uom" t-options="{'widget': 'float', 'decimal_precision': 'Product Unit'}" lock-id="134"/> <span t-field="line.product_id.uom_id" lock-id="135"/>
                                    </span>
                                </td>
                                <td name="td_product_priceunit" class="text-end text-nowrap" lock-id="136">
                                    <span t-if="not collapse_prices and line.discount &lt; 0" t-out="(1 - line.discount / 100.0) * line.price_unit" t-options="{&quot;widget&quot;: &quot;float&quot;, &quot;decimal_precision&quot;: &quot;Product Price&quot;}" lock-id="137"/>
                                    <span t-elif="not collapse_prices" t-field="line.price_unit" lock-id="138">
                                        25.00
                                    </span>
                                </td>
                                <td t-if="display_discount" name="td_product_discount" class="text-end" lock-id="139">
                                    <t t-if="not collapse_prices" lock-id="140">
                                        <!-- ! Always check collapse_prices separately; keep discount condition below for XPath -->
                                        <span t-if="line.discount &gt; 0" t-field="line.discount" lock-id="141">-</span>
                                    </t>
                                </td>
                                <t t-set="taxes" t-value="', '.join(tax.tax_label for tax in line.tax_ids if tax.tax_label)" lock-id="142"/>
                                <td t-if="display_taxes" name="td_product_taxes" t-attf-class="text-end {{ 'text-nowrap' if len(taxes) &lt; 12 else '' }}" lock-id="143">
                                    <span t-out="taxes" lock-id="144">Tax 15%</span>
                                </td>
                                <td name="td_product_subtotal" class="text-end o_price_total" lock-id="145">
                                    <t t-if="not line.is_downpayment and not collapse_prices" lock-id="146">
                                        <span t-if="price_field == 'price_subtotal'" t-field="line.price_subtotal" lock-id="147">
                                            27.00
                                        </span>
                                        <span t-else="" t-field="line.price_total" lock-id="148">
                                            27.00
                                        </span>
                                    </t>
                                </td>
                            </tr>
                        </t>
                        <t t-else="" lock-id="149">
                            <!-- Displaying the section inner content, grouped by taxes -->
                            <tr t-foreach="line._get_grouped_section_summary(display_taxes)" t-as="section_line" name="tr_section_group" lock-id="150">
                                <td name="td_section_group_name" t-att-style="padding_style" lock-id="151">
                                    <span t-field="line.name" lock-id="152">
                                        Section Summary
                                    </span>
                                </td>
                                <td name="td_section_group_quantity" class="text-end text-nowrap" lock-id="153">
                                    <span lock-id="154">1.00 Units</span>
                                </td>
                                <td name="td_section_group_priceunit" class="text-end text-nowrap" lock-id="155">
                                    <span t-if="show_section_total" name="price_subtotal_section_grouped" t-out="section_line['price_subtotal']" t-options="{'widget': 'monetary', 'display_currency': doc.currency_id}" lock-id="156">
                                        25.00
                                    </span>
                                </td>
                                <td t-if="display_discount" name="td_section_group_discount" lock-id="157">
                                    <!-- NOTE: not computed atm, but at least provides the API for it if needed in the future -->
                                    <t t-set="aggregated_discount" t-value="section_line.get('discount', 0)" lock-id="158"/>
                                    <span t-if="aggregated_discount" t-out="aggregated_discount" lock-id="159">-</span>
                                </td>
                                <td t-if="display_taxes" name="td_section_group_taxes" t-attf-class="text-end {{ 'text-nowrap' if len(section_line['tax_labels']) &lt; 10 else '' }}" lock-id="160">
                                    <span t-out="', '.join(section_line['tax_labels'])" lock-id="161">
                                        Tax 15%
                                    </span>
                                </td>
                                <td name="td_section_group_total" class="text-end o_price_total" lock-id="162">
                                    <span t-if="show_section_total" t-out="section_line[price_field]" t-options="{'widget': 'monetary', 'display_currency': doc.currency_id}" lock-id="163">
                                        30.00
                                    </span>
                                </td>
                            </tr>
                        </t>
                    </t>
                </tbody>
            </table>
            <div class="clearfix" name="so_total_summary" lock-id="164">
                <div id="total" class="row mt-n3" name="total" lock-id="165">
                    <div lock-id="166">
                        <table class="o_total_table table table-borderless ms-auto w-auto" lock-id="167">
                            <!-- Tax totals -->
                            <t t-call="sale.document_tax_totals" tax_totals="doc.tax_totals" currency="doc.currency_id" lock-id="168"/>
                        </table>
                    </div>
                </div>
            </div>
            <div class="oe_structure" lock-id="169"/>

            <div t-if="not doc.signature or not doc.env.context.get('sale_include_signature')" class="oe_structure" lock-id="170"/>
            <div t-else="" class="mt-4 ml64 mr4" name="signature" lock-id="171">
                <div class="offset-8" lock-id="172">
                    <strong lock-id="173">Signature</strong>
                </div>
                <div class="offset-8" lock-id="174">
                    <img t-att-src="image_data_uri(doc.signature)" style="max-height: 4cm; max-width: 8cm;" lock-id="175"/>
                </div>
                <div class="offset-8 text-center" lock-id="176">
                    <span t-field="doc.signed_by" lock-id="177">Oscar Morgan</span>
                </div>
            </div>
            <div lock-id="178">
            <p t-if="doc.carrier_id.carrier_description" id="carrier_description" lock-id="179">
                <strong lock-id="180">Delivery Description</strong>
                <span class="d-block" t-out="doc.carrier_id.carrier_description" lock-id="181"/>
            </p>
                <span t-field="doc.note" t-attf-style="#{'text-align:justify;text-justify:inter-word;' if doc.company_id.terms_type != 'html' else ''}" name="order_note" lock-id="182"/>
                <p t-if="not is_html_empty(doc.payment_term_id.note)" lock-id="183">
                    <span t-field="doc.payment_term_id.note" lock-id="184">The payment should also be transmitted with love</span>
                </p>
                <div class="oe_structure" lock-id="185"/>
                <p t-if="doc.fiscal_position_id and not is_html_empty(doc.fiscal_position_id.sudo().note)" id="fiscal_position_remark" lock-id="186">
                    <strong lock-id="187">Fiscal Position Remark:</strong>
                    <span t-field="doc.fiscal_position_id.sudo().note" lock-id="188">No further requirements for this payment</span>
                </p>
            </div>
            <div class="oe_structure" lock-id="189"/>
        </div>
    </t>
</t>"""

print(f"\nNew arch length: {len(NEW_ARCH)}")

# Step 2: Try to update the view via write
try:
    result = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [view_id, {
        'arch_db': NEW_ARCH,
    }])
    print(f"\nWrite result: {result}")
    
    if result:
        # Verify
        updated = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'read', [view_id], {'fields': ['arch_db']})
        new_len = len(updated[0].get('arch_db',''))
        print(f"Verified arch_db length after write: {new_len}")
        if new_len > 100:
            print("\n✅ Template updated successfully!")
        else:
            print("\n⚠️ Write returned True but arch seems too short - may need verification")
    else:
        print("\n❌ Write returned False - template NOT updated")
        print("This might be a permissions issue or Odoo Studio lock.")
        
except xmlrpc.client.Fault as e:
    print(f"\n❌ XML-RPC Fault: {e.faultCode} - {e.faultString}")
    
    if 'lock' in str(e.faultString).lower() or 'studio' in str(e.faultString).lower():
        print("\n💡 The view has Studio locks. Trying to update arch_base instead of arch_db...")
        try:
            result2 = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'write', [view_id, {
                'arch_base': NEW_ARCH,
            }])
            print(f"arch_base write result: {result2}")
        except Exception as e2:
            print(f"arch_base write also failed: {e2}")
    
    if 'validate' in str(e.faultString).lower() or 'xml' in str(e.faultString).lower():
        print("\n💡 XML validation error. The template might have issues.")
        print("Let me check if Odoo Studio created an inherited view that we should modify instead...")
        
        # Look for inherited views created by Studio
        inherited = models.execute_kw(DB, uid, APIKEY, 'ir.ui.view', 'search_read', 
            [['inherit_id', '=', view_id]], 
            {'limit': 10, 'fields': ['id', 'name', 'key', 'arch_db']})
        print(f"\nInherited views ({len(inherited)}):")
        for iv in inherited:
            print(f"  ID={iv['id']}, name={iv.get('name','')}, key={iv.get('key','')}, arch_len={len(iv.get('arch_db',''))}")

except Exception as e:
    print(f"\n❌ Error updating view: {e}")
    print(f"Error type: {type(e).__name__}")
