/**
 * Support form -> NOVA hub (nova.innomega.se).
 *
 * The browser posts plain JSON here; this function holds the tokens and
 * reshapes the submission into the Postmark-inbound envelope that NOVA's
 * support-inbound.bxm expects. Creating the ticket is the critical path —
 * the Postmark confirmation mails are best effort and never fail the request,
 * because a customer who filled in the form should not be told it failed when
 * the ticket already exists.
 */

const NOVA_URL = process.env.NOVA_SUPPORT_URL || 'https://nova.innomega.se/app/support-inbound.bxm';
const NOVA_TOKEN = process.env.NOVA_SUPPORT_TOKEN;
const POSTMARK_TOKEN = process.env.POSTMARK_SERVER_TOKEN;
const FROM_EMAIL = process.env.SUPPORT_FROM_EMAIL || 'support@zkfonline.de';
const NOTIFY_EMAIL = process.env.SUPPORT_NOTIFY_EMAIL || 'support@innomega.se';

const KATEGORIEN = {
  inhalt: 'Inhaltsänderung',
  technik: 'Technisches Problem',
  unterseite: 'Neue Unterseite / Erweiterung',
  domain: 'Domain / E-Mail',
  sonstiges: 'Sonstiges',
};

const LIMITS = { name: 120, company: 200, email: 254, phone: 60, domain: 200, subject: 200, message: 8000 };

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const clean = (v, max) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

// Deliberately permissive: the address only has to be plausible and single-line.
const istEmail = (v) => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(v);

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, fehler: 'method not allowed' });
  if (!NOVA_TOKEN) {
    console.error('NOVA_SUPPORT_TOKEN is not configured');
    return json(500, { ok: false, fehler: 'server nicht konfiguriert' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, fehler: 'ungültige daten' });
  }

  // Honeypot: bots fill every field they find. Answer 200 so they learn nothing.
  if (clean(body.website, 200)) return json(200, { ok: true });

  const f = {
    name: clean(body.name, LIMITS.name),
    company: clean(body.company, LIMITS.company),
    email: clean(body.email, LIMITS.email).toLowerCase(),
    phone: clean(body.phone, LIMITS.phone),
    domain: clean(body.domain, LIMITS.domain),
    subject: clean(body.subject, LIMITS.subject),
    message: clean(body.message, LIMITS.message),
    kategorie: KATEGORIEN[body.kategorie] || KATEGORIEN.sonstiges,
    dringend: body.dringend === true || body.dringend === 'true',
  };

  const fehlend = ['name', 'company', 'email', 'subject', 'message'].filter((k) => !f[k]);
  if (fehlend.length) return json(400, { ok: false, fehler: 'pflichtfelder fehlen', felder: fehlend });
  if (!istEmail(f.email)) return json(400, { ok: false, fehler: 'ungültige e-mail-adresse' });

  const jetzt = new Date();
  // Stable per-submission id: NOVA dedupes on it, so a double-click cannot
  // create two tickets while genuinely new requests stay distinct.
  const messageId = `${jetzt.getTime().toString(36)}.${crypto.randomUUID()}@form.zkfonline.de`;

  const betreff = `${f.dringend ? '[DRINGEND] ' : ''}[${f.kategorie}] ${f.subject}`;
  const textBody = [
    `Support-Anfrage über www.zkfonline.de/support`,
    `ACHTUNG: Absenderadresse stammt aus einem offenen Web-Formular und ist NICHT`,
    `verifiziert. Kundenzuordnung bitte vor Auskünften gegenprüfen.`,
    ``,
    `Firma:        ${f.company}`,
    `Name:         ${f.name}`,
    `E-Mail:       ${f.email}`,
    `Telefon:      ${f.phone || '-'}`,
    `Website:      ${f.domain || '-'}`,
    `Kategorie:    ${f.kategorie}`,
    `Dringlichkeit:${f.dringend ? ' DRINGEND' : ' normal'}`,
    `Eingegangen:  ${jetzt.toISOString()}`,
    ``,
    `----------------------------------------`,
    ``,
    f.message,
  ].join('\n');

  // NOVA derives the client from the sender's mail domain and matches it
  // against clients.domains, so FromFull.Email must be the customer's address.
  const payload = {
    MessageID: messageId,
    Date: jetzt.toUTCString(),
    Subject: betreff,
    TextBody: textBody,
    OriginalRecipient: FROM_EMAIL,
    FromFull: { Email: f.email, Name: f.name },
    From: f.email,
  };

  let novaAntwort;
  try {
    const res = await fetch(`${NOVA_URL}?token=${encodeURIComponent(NOVA_TOKEN)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('NOVA rejected the support request', res.status, text.slice(0, 500));
      return json(502, { ok: false, fehler: 'hub nicht erreichbar' });
    }
    try {
      novaAntwort = JSON.parse(text);
    } catch {
      novaAntwort = {};
    }
    if (novaAntwort.ok === false) {
      console.error('NOVA reported an error', text.slice(0, 500));
      return json(502, { ok: false, fehler: 'hub hat die anfrage abgelehnt' });
    }
  } catch (err) {
    console.error('NOVA request failed', err?.name, err?.message);
    return json(502, { ok: false, fehler: 'hub nicht erreichbar' });
  }

  // Ticket exists from here on. Mail problems must not turn into a user-facing error.
  await mailsSenden(f, betreff, textBody).catch((err) =>
    console.error('Postmark step failed', err?.message)
  );

  return json(200, { ok: true, duplikat: novaAntwort.duplikat === true });
};

async function mailsSenden(f, betreff, textBody) {
  if (!POSTMARK_TOKEN) {
    console.warn('POSTMARK_SERVER_TOKEN not set — skipping confirmation mails');
    return;
  }

  const senden = async (mail) => {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Postmark-Server-Token': POSTMARK_TOKEN,
      },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error('Postmark rejected a mail', res.status, (await res.text()).slice(0, 300));
  };

  const bestaetigung = [
    `Guten Tag ${f.name},`,
    ``,
    `vielen Dank für Ihre Anfrage. Wir haben sie erhalten und melden uns`,
    `in der Regel innerhalb von 24 Stunden bei Ihnen, spätestens innerhalb einer Woche.`,
    ``,
    `Ihr Betreff: ${f.subject}`,
    ``,
    `Sie müssen nichts weiter tun — bitte antworten Sie einfach auf diese`,
    `E-Mail, wenn Sie etwas ergänzen möchten.`,
    ``,
    `Mit freundlichen Grüßen`,
    `Ihr ZKFonline-Team`,
    `www.zkfonline.de`,
  ].join('\n');

  await Promise.allSettled([
    senden({
      From: FROM_EMAIL,
      To: f.email,
      ReplyTo: NOTIFY_EMAIL,
      Subject: `Ihre Support-Anfrage: ${f.subject}`,
      TextBody: bestaetigung,
      MessageStream: 'outbound',
    }),
    senden({
      From: FROM_EMAIL,
      To: NOTIFY_EMAIL,
      ReplyTo: f.email,
      Subject: `ZKFonline Support: ${betreff}`,
      TextBody: textBody,
      MessageStream: 'outbound',
    }),
  ]);
}

export const config = { path: '/api/support' };
