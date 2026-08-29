'use strict';
// HTML email templates for Crumb & Ember.
//
// Design notes, because email is not the web:
//
// * Tables and inline styles only. No flexbox, no grid, no <style> block —
//   Gmail strips embedded CSS in several contexts and Outlook never had it.
// * NO IMAGES ANYWHERE. The banner is built from type and colour blocks, so
//   it renders instantly and identically whether or not the client blocks
//   remote images — which Gmail does by default for unknown senders. An
//   image-based banner would show as a grey box on exactly the first email a
//   new customer receives, which is the one that matters most.
// * Colours are the site's own tokens (services/frontend/index.html), so the
//   mail and the shop look like the same business.
// * Dark mode: the palette leads with saturated pink and chocolate rather
//   than white. Gmail's dark theme rewrites near-white backgrounds and leaves
//   saturated ones alone, so the banner survives the treatment the recipient
//   in the screenshot is actually using.
// * Every template returns plain text too. A text/plain alternative is what
//   keeps the message out of spam filters and readable in a watch preview.

// Site palette — services/frontend/index.html :root
const C = {
  pink:   '#FFE3EF',  // strawberry milk — page base
  milk:   '#FFF6EE',  // card cream
  choc:   '#33200F',  // ink — dark chocolate
  straw:  '#FF4D8D',  // strawberry
  butter: '#FFB428',  // butter / yolk
  pist:   '#2FBF71',  // pistachio
  sky:    '#37C3F0',  // icing blue — used for the live-tracking moments
  cocoa:  '#6B4A2F',  // muted ink for secondary text
  crust:  '#E7C9A9'   // hairline / rule
};

// Nunito, Space Mono and Titan One are the site faces; none of them can be
// relied on in mail, so each stack degrades to something with the same
// personality — rounded grotesque, then monospace for anything numeric.
const F_BODY = "'Nunito','Trebuchet MS',Verdana,Helvetica,Arial,sans-serif";
const F_MONO = "'Space Mono','Courier New',Courier,monospace";

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Negatives get the sign in front of the symbol (-₹320.00, not ₹-320.00),
// which is how a discount line should read.
const money = (n, currency = '₹') => {
  const v = Number(n || 0);
  const body = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '-' : ''}${currency}${body}`;
};

// --- shared chrome ---------------------------------------------------------

// Hidden preheader: the grey line the inbox shows next to the subject. Left
// unset it fills with whatever text comes first, which is usually the banner
// wordmark repeated — a wasted second line in the inbox list.
const preheader = (text) => `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(text)}</div>
      <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>`;

// The banner. Chocolate band, butter rule, letterspaced wordmark, and a
// coloured eyebrow strip whose colour is the one thing that changes between
// message types — so the mail is identifiable before a word is read.
const banner = (accent, eyebrow) => `
        <tr>
          <td style="background-color:${C.choc};padding:28px 32px 22px 32px;border-radius:18px 18px 0 0;">
            <div style="font-family:${F_BODY};font-size:26px;font-weight:800;color:${C.milk};letter-spacing:3px;line-height:1.1;">
              CRUMB<span style="color:${C.butter};">&nbsp;&amp;&nbsp;</span>EMBER
            </div>
            <div style="font-family:${F_MONO};font-size:11px;color:${C.crust};letter-spacing:2.5px;padding-top:6px;">
              SMALL&nbsp;BATCH&nbsp;BAKERY
            </div>
          </td>
        </tr>
        <tr><td style="background-color:${accent};height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>
        <tr>
          <td style="background-color:${C.milk};padding:26px 32px 0 32px;">
            <div style="font-family:${F_MONO};font-size:11px;font-weight:700;color:${accent};letter-spacing:2.5px;text-transform:uppercase;">
              ${esc(eyebrow)}
            </div>
          </td>
        </tr>`;

const footer = () => `
        <tr>
          <td style="background-color:${C.milk};padding:26px 32px 30px 32px;border-radius:0 0 18px 18px;border-top:1px solid ${C.crust};">
            <div style="font-family:${F_BODY};font-size:13px;color:${C.cocoa};line-height:1.6;">
              Crumb &amp; Ember · baked this morning, gone by four
            </div>
            <div style="font-family:${F_BODY};font-size:12px;color:${C.cocoa};line-height:1.6;padding-top:6px;">
              This is an automated message — replies aren't monitored.
            </div>
          </td>
        </tr>`;

const shell = (title, accent, inner, pre) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.pink};">
${preheader(pre)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.pink};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
${banner(accent, inner.eyebrow)}
${inner.body}
${footer()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

// --- verification code -----------------------------------------------------
// Signature element: the code as separate digit tiles, the way a bakery
// counter ticket prints them. It also solves a real problem — a six-digit run
// of identical-width mono glyphs is easy to misread and hard to select on a
// phone, and the tiles force a pause between characters.
function verificationCode(data = {}) {
  const code = String(data.code || '');
  const minutes = Number(data.expiresMinutes || 10);
  const purpose = data.purpose || 'verification';
  const name = data.customerName ? `${esc(data.customerName)}, this` : 'This';

  const tiles = code.split('').map((ch) => `
                    <td style="padding:0 4px;">
                      <div style="background-color:${C.choc};border-radius:10px;width:46px;height:58px;line-height:58px;text-align:center;font-family:${F_MONO};font-size:26px;font-weight:700;color:${C.butter};">${esc(ch)}</div>
                    </td>`).join('');

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:27px;line-height:1.25;font-weight:800;color:${C.choc};">
              Here's your code
            </h1>
            <p style="margin:10px 0 0 0;font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.cocoa};">
              ${name} confirms your ${esc(purpose)}. It works once, and only for the next ${esc(minutes)} minutes.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:24px 32px 4px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
              <tr>
                <td>
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${tiles}</tr></table>
                </td>
              </tr>
            </table>
            <div style="text-align:center;padding-top:14px;font-family:${F_MONO};font-size:12px;color:${C.cocoa};letter-spacing:1px;">
              EXPIRES IN ${esc(minutes)} MINUTES
            </div>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 28px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.pink};border-left:4px solid ${C.straw};border-radius:0 10px 10px 0;padding:14px 16px;">
                  <div style="font-family:${F_BODY};font-size:14px;line-height:1.6;color:${C.choc};">
                    Didn't ask for this? Ignore the email — nothing changes without the code. Nobody from Crumb &amp; Ember will ever ask you for it.
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;

  const text = [
    `Your Crumb & Ember code is ${code}.`,
    `It confirms your ${purpose} and expires in ${minutes} minutes.`,
    '',
    "Didn't ask for this? Ignore this email — nothing changes without the code.",
    'Nobody from Crumb & Ember will ever ask you for it.'
  ].join('\n');

  return {
    subject: 'Your Crumb & Ember verification code',
    html: shell('Your Crumb & Ember verification code', C.straw,
      { eyebrow: 'Verification code', body }, `${code} — expires in ${minutes} minutes`),
    text
  };
}

// --- order confirmation ----------------------------------------------------
// Signature element: a docket-style itemised list with dotted leaders, set the
// way the counter prints it. The status strip is three fixed stages because
// that is genuinely what happens to an order here — it is a real sequence, not
// decorative numbering.
function orderConfirmation(data = {}) {
  const orderId = data.orderId || '—';
  const currency = data.currency || '₹';
  const items = Array.isArray(data.items) ? data.items : [];
  const greeting = data.customerName ? `Thanks, ${esc(data.customerName)}` : 'Thanks for your order';
  const when = data.readyAt || data.eta || '';
  const pickup = data.fulfilment === 'pickup';
  const where = data.address || (pickup ? 'Collection at the counter' : '');
  const whereLabel = pickup ? 'PICKING UP' : 'GOING TO';

  const rows = items.map((it) => `
              <tr>
                <td style="padding:9px 0;border-bottom:1px dotted ${C.crust};font-family:${F_BODY};font-size:15px;color:${C.choc};">
                  ${esc(it.name)}
                  ${Number(it.qty) > 1 ? `<div style="font-family:${F_MONO};font-size:12px;color:${C.cocoa};padding-top:2px;">${esc(it.qty)} &times; ${esc(money(Number(it.price || 0) / Number(it.qty), currency))}</div>` : ''}
                </td>
                <td align="right" style="padding:9px 0;border-bottom:1px dotted ${C.crust};font-family:${F_MONO};font-size:14px;color:${C.choc};white-space:nowrap;">
                  ${esc(money(it.price, currency))}
                </td>
              </tr>`).join('');

  const totalRow = (label, value, strong) => `
              <tr>
                <td style="padding:${strong ? '12px 0 0 0' : '7px 0 0 0'};font-family:${F_BODY};font-size:${strong ? '16px' : '14px'};font-weight:${strong ? '800' : '400'};color:${strong ? C.choc : C.cocoa};">${esc(label)}</td>
                <td align="right" style="padding:${strong ? '12px 0 0 0' : '7px 0 0 0'};font-family:${F_MONO};font-size:${strong ? '18px' : '14px'};font-weight:${strong ? '700' : '400'};color:${strong ? C.choc : C.cocoa};white-space:nowrap;">${esc(money(value, currency))}</td>
              </tr>`;

  const stage = (label, active) => `
                <td width="33%" align="center" style="padding:0 3px;">
                  <div style="background-color:${active ? C.pist : C.crust};height:5px;line-height:5px;font-size:0;border-radius:3px;">&nbsp;</div>
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:1px;color:${active ? C.choc : C.cocoa};padding-top:7px;">${esc(label)}</div>
                </td>`;

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:27px;line-height:1.25;font-weight:800;color:${C.choc};">
              ${greeting} — it's in the oven
            </h1>
            <p style="margin:10px 0 0 0;font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.cocoa};">
              Order <span style="font-family:${F_MONO};color:${C.choc};font-weight:700;">${esc(orderId)}</span>${when ? ` · ready ${esc(when)}` : ''}
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 6px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>${stage('BAKING', true)}${stage('BOXED', false)}${stage('READY', false)}</tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:18px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${rows}
              ${data.subtotal != null ? totalRow('Subtotal', data.subtotal) : ''}
              ${data.delivery != null ? totalRow('Delivery', data.delivery) : ''}
              ${data.discount ? totalRow('Discount', -Math.abs(data.discount)) : ''}
              ${totalRow('Total', data.total, true)}
            </table>
          </td>
        </tr>
        ${where ? `
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.pink};border-left:4px solid ${C.pist};border-radius:0 10px 10px 0;padding:14px 16px;">
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:2px;color:${C.cocoa};">${esc(whereLabel)}</div>
                  <div style="font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.choc};padding-top:3px;">${esc(where)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : ''}
        <tr>
          <td style="background-color:${C.milk};padding:24px 32px 30px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.straw};border-radius:12px;">
                  <a href="${esc(data.orderUrl || '#')}" style="display:inline-block;padding:14px 28px;font-family:${F_BODY};font-size:15px;font-weight:800;color:${C.milk};text-decoration:none;letter-spacing:0.3px;">
                    Track this order
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;

  const text = [
    `${data.customerName ? `Thanks, ${data.customerName}` : 'Thanks for your order'} — it's in the oven.`,
    `Order ${orderId}${when ? ` · ready ${when}` : ''}`,
    '',
    ...items.map((it) => Number(it.qty) > 1
      ? `  ${it.name}  (${it.qty} x ${money(Number(it.price || 0) / Number(it.qty), currency)})  ${money(it.price, currency)}`
      : `  ${it.name}  ${money(it.price, currency)}`),
    '',
    data.subtotal != null ? `Subtotal ${money(data.subtotal, currency)}` : '',
    data.delivery != null ? `Delivery ${money(data.delivery, currency)}` : '',
    `Total ${money(data.total, currency)}`,
    where ? `\n${pickup ? 'Picking up' : 'Going to'}: ${where}` : '',
    data.orderUrl ? `\nTrack this order: ${data.orderUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: `Order ${orderId} is in the oven`,
    html: shell(`Order ${orderId}`, C.pist, { eyebrow: 'Order confirmed', body },
      `${items.length} item${items.length === 1 ? '' : 's'} · ${money(data.total, currency)}${when ? ` · ready ${when}` : ''}`),
    text
  };
}

// --- rider picked up (out for delivery) ------------------------------------
// Signature element: a big ETA tile — the one thing the customer actually
// wants at a glance — sitting above the same docket-style item list as the
// order confirmation, so the two mails read as chapters of one story. Sent
// the moment the delivery-service's live tracker flips a bike order into
// "out_for_delivery" (i.e. the rider has physically picked it up).
function riderPickedUp(data = {}) {
  const orderId = data.orderId || '—';
  const currency = data.currency || '₹';
  const items = Array.isArray(data.items) ? data.items : [];
  const greeting = data.customerName ? `${esc(data.customerName)}, your` : 'Your';
  const riderName = data.riderName || 'your rider';
  const etaMinutes = data.etaMinutes != null && Number.isFinite(Number(data.etaMinutes)) ? Math.max(0, Math.round(Number(data.etaMinutes))) : null;
  const etaTime = data.etaTime || '';
  const address = data.address || '';

  const stage = (label, active) => `
                <td width="33%" align="center" style="padding:0 3px;">
                  <div style="background-color:${active ? C.sky : C.crust};height:5px;line-height:5px;font-size:0;border-radius:3px;">&nbsp;</div>
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:1px;color:${active ? C.choc : C.cocoa};padding-top:7px;">${esc(label)}</div>
                </td>`;

  const rows = items.map((it) => `
              <tr>
                <td style="padding:9px 0;border-bottom:1px dotted ${C.crust};font-family:${F_BODY};font-size:15px;color:${C.choc};">
                  ${esc(it.name)}
                  ${Number(it.qty) > 1 ? `<div style="font-family:${F_MONO};font-size:12px;color:${C.cocoa};padding-top:2px;">${esc(it.qty)}&times;</div>` : ''}
                </td>
                ${it.price != null ? `<td align="right" style="padding:9px 0;border-bottom:1px dotted ${C.crust};font-family:${F_MONO};font-size:14px;color:${C.choc};white-space:nowrap;">${esc(money(it.price, currency))}</td>` : ''}
              </tr>`).join('');

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:27px;line-height:1.25;font-weight:800;color:${C.choc};">
              ${greeting} order is on its way
            </h1>
            <p style="margin:10px 0 0 0;font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.cocoa};">
              Order <span style="font-family:${F_MONO};color:${C.choc};font-weight:700;">${esc(orderId)}</span> just left the counter with ${esc(riderName)}.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 6px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>${stage('BAKED', true)}${stage('PICKED UP', true)}${stage('DELIVERED', false)}</tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="background-color:${C.choc};border-radius:14px;padding:18px 20px;">
                  <div style="font-family:${F_MONO};font-size:11px;letter-spacing:2px;color:${C.crust};">ARRIVING IN</div>
                  <div style="font-family:${F_MONO};font-size:34px;font-weight:700;color:${C.butter};padding-top:4px;">
                    ${etaMinutes != null ? `~${esc(etaMinutes)} min` : esc(etaTime || 'shortly')}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${items.length ? `
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${rows}
            </table>
          </td>
        </tr>` : ''}
        ${address ? `
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.pink};border-left:4px solid ${C.sky};border-radius:0 10px 10px 0;padding:14px 16px;">
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:2px;color:${C.cocoa};">GOING TO</div>
                  <div style="font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.choc};padding-top:3px;">${esc(address)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : ''}
        <tr>
          <td style="background-color:${C.milk};padding:24px 32px 30px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.sky};border-radius:12px;">
                  <a href="${esc(data.trackingUrl || data.orderUrl || '#')}" style="display:inline-block;padding:14px 28px;font-family:${F_BODY};font-size:15px;font-weight:800;color:${C.choc};text-decoration:none;letter-spacing:0.3px;">
                    Track live location &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;

  const text = [
    `${data.customerName ? `${data.customerName}, your` : 'Your'} order ${orderId} just left the counter with ${riderName}.`,
    etaMinutes != null ? `Arriving in about ${etaMinutes} minutes.` : (etaTime ? `Arriving ${etaTime}.` : ''),
    '',
    ...items.map((it) => Number(it.qty) > 1 ? `  ${it.qty} x ${it.name}` : `  ${it.name}`),
    address ? `\nGoing to: ${address}` : '',
    (data.trackingUrl || data.orderUrl) ? `\nTrack live location: ${data.trackingUrl || data.orderUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: `Your order ${orderId} is on the way${etaMinutes != null ? ` — ~${etaMinutes} min` : ''}`,
    html: shell(`Order ${orderId} — on the way`, C.sky, { eyebrow: 'Out for delivery', body },
      `${riderName} has it${etaMinutes != null ? ` · ~${etaMinutes} min away` : ''}`),
    text,
    // Compact variant for SMS/push, where the item list and stage strip don't fit.
    push: {
      title: 'Your order is on the way 🚴',
      body: `${riderName} just picked up order ${orderId}` +
        (etaMinutes != null ? ` — arriving in ~${etaMinutes} min.` : '.')
    }
  };
}

// --- delivered / order complete --------------------------------------------
// Sent once, the moment a bike delivery's live status flips to "delivered"
// (i.e. the eta window has closed). Deliberately light — the sale is done,
// so this is a "thanks, here's the receipt shape and a nudge to reorder"
// note rather than another wall of logistics.
function orderDelivered(data = {}) {
  const orderId = data.orderId || '—';
  const currency = data.currency || '₹';
  const items = Array.isArray(data.items) ? data.items : [];
  const greeting = data.customerName ? `${esc(data.customerName)}, your` : 'Your';
  const riderName = data.riderName || 'your rider';

  const stage = (label, active) => `
                <td width="33%" align="center" style="padding:0 3px;">
                  <div style="background-color:${active ? C.pist : C.crust};height:5px;line-height:5px;font-size:0;border-radius:3px;">&nbsp;</div>
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:1px;color:${active ? C.choc : C.cocoa};padding-top:7px;">${esc(label)}</div>
                </td>`;

  const rows = items.map((it) => `
              <tr>
                <td style="padding:9px 0;border-bottom:1px dotted ${C.crust};font-family:${F_BODY};font-size:15px;color:${C.choc};">
                  ${esc(it.name)}
                  ${Number(it.qty) > 1 ? `<div style="font-family:${F_MONO};font-size:12px;color:${C.cocoa};padding-top:2px;">${esc(it.qty)}&times;</div>` : ''}
                </td>
              </tr>`).join('');

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:27px;line-height:1.25;font-weight:800;color:${C.choc};">
              ${greeting} order has arrived 🎉
            </h1>
            <p style="margin:10px 0 0 0;font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.cocoa};">
              Order <span style="font-family:${F_MONO};color:${C.choc};font-weight:700;">${esc(orderId)}</span> was delivered by ${esc(riderName)}. We hope it's still warm.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 6px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>${stage('BAKED', true)}${stage('PICKED UP', true)}${stage('DELIVERED', true)}</tr>
            </table>
          </td>
        </tr>
        ${items.length ? `
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${rows}
            </table>
          </td>
        </tr>` : ''}
        <tr>
          <td style="background-color:${C.milk};padding:24px 32px 30px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.straw};border-radius:12px;">
                  <a href="${esc(data.reorderUrl || data.orderUrl || '#')}" style="display:inline-block;padding:14px 28px;font-family:${F_BODY};font-size:15px;font-weight:800;color:#fff;text-decoration:none;letter-spacing:0.3px;">
                    Order again &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;

  const text = [
    `${data.customerName ? `${data.customerName}, your` : 'Your'} order ${orderId} was delivered by ${riderName}. Enjoy!`,
    '',
    ...items.map((it) => Number(it.qty) > 1 ? `  ${it.qty} x ${it.name}` : `  ${it.name}`),
    (data.reorderUrl || data.orderUrl) ? `\nOrder again: ${data.reorderUrl || data.orderUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: `Delivered — order ${orderId} has arrived`,
    html: shell(`Order ${orderId} — delivered`, C.pist, { eyebrow: 'Delivered', body }, `${riderName} handed it off just now`),
    text,
    push: { title: 'Delivered! 🎉', body: `Order ${orderId} has arrived. Enjoy!` }
  };
}

const TEMPLATES = {
  'verification-code': verificationCode,
  'order-confirmation': orderConfirmation,
  'rider-picked-up': riderPickedUp,
  'order-delivered': orderDelivered
};

// Returns { subject, html, text }. The caller's explicit subject always wins,
// so a template can be reused for a resend or an A/B without a code change.
function render(name, data = {}, overrides = {}) {
  const fn = TEMPLATES[name];
  if (!fn) throw Object.assign(new Error(`unknown template: ${name}`), { permanent: true });
  const out = fn(data);
  return { ...out, subject: overrides.subject || out.subject };
}

module.exports = { render, TEMPLATES, templateNames: Object.keys(TEMPLATES), palette: C, esc, money };

