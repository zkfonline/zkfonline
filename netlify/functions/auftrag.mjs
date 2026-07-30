/**
 * New-website intake ("Auftrag") -> NOVA enquiries + Postmark.
 *
 * Requires a valid client-area token. Images arrive as data URLs already
 * downscaled in the browser; they are re-validated here and attached to the
 * internal mail. The NOVA enquiry is the system of record — mail is best effort.
 */
import crypto from 'node:crypto';
import { tokenPruefen, json, istEmail, postmarkSenden } from '../lib/auth.mjs';

const NOVA_URL = process.env.NOVA_ENQUIRY_URL || 'https://nova.innomega.se/app/enquiry-inbound.bxm';
const NOVA_TOKEN = process.env.NOVA_ENQUIRY_TOKEN;
const FROM = process.env.SUPPORT_FROM_EMAIL || 'support@zkfonline.de';
const NOTIFY = process.env.SUPPORT_NOTIFY_EMAIL || 'support@innomega.de';

const MAX_BILDER = 10;
const MAX_BILD_BYTES = 2_500_000;   // per image, after browser downscaling
const MAX_GESAMT_BYTES = 9_000_000; // Postmark caps a message at 10 MB

const T = (v, max) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

const FELDER = [
  ['firma', 'Firma', 200], ['inhaber', 'Inhaber/Geschäftsführer', 200],
  ['strasse', 'Straße', 200], ['plz', 'PLZ', 20], ['ort', 'Ort', 120],
  ['telefon', 'Telefon', 60], ['fax', 'Fax', 60], ['email', 'E-Mail', 254],
  ['wunschdomain', 'Wunschdomain', 200], ['bestehendeDomain', 'Bestehende Domain', 200],
  ['oeffnungszeiten', 'Öffnungszeiten', 1000], ['leistungen', 'Leistungen', 3000],
  ['marken', 'Marken / Partner', 1000], ['ueberUns', 'Über den Betrieb', 4000],
  ['mitarbeiter', 'Mitarbeiterzahl', 60], ['gruendung', 'Gegründet', 60],
  ['notdienst', 'Notdienst', 200], ['zusatzWuensche', 'Zusätzliche Wünsche', 4000],
];

const erlaubteTypen = new Set(['image/jpeg', 'image/png', 'image/webp']);

function bilderPruefen(roh) {
  if (!Array.isArray(roh)) return { bilder: [], fehler: null };
  if (roh.length > MAX_BILDER) return { bilder: [], fehler: `maximal ${MAX_BILDER} bilder` };

  const bilder = [];
  let gesamt = 0;
  for (const [i, b] of roh.entries()) {
    const dataUrl = String(b?.data ?? '');
    const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!m) return { bilder: [], fehler: `bild ${i + 1}: ungültiges format` };
    if (!erlaubteTypen.has(m[1])) return { bilder: [], fehler: `bild ${i + 1}: nur JPG, PNG oder WebP` };

    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return { bilder: [], fehler: `bild ${i + 1}: leer` };
    if (buf.length > MAX_BILD_BYTES) return { bilder: [], fehler: `bild ${i + 1}: zu groß` };
    gesamt += buf.length;
    if (gesamt > MAX_GESAMT_BYTES) return { bilder: [], fehler: 'bilder insgesamt zu groß' };

    const endung = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg';
    bilder.push({
      Name: `${String(i + 1).padStart(2, '0')}-${T(b?.name, 60).replace(/[^\w.\- ]/g, '_') || 'bild'}.${endung}`,
      Content: buf.toString('base64'),
      ContentType: m[1],
      bytes: buf.length,
    });
  }
  return { bilder, fehler: null };
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, fehler: 'method not allowed' });
  if (!NOVA_TOKEN) {
    console.error('NOVA_ENQUIRY_TOKEN is not configured');
    return json(500, { ok: false, fehler: 'server nicht konfiguriert' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, fehler: 'ungültige daten' }); }

  // --- access gate -----------------------------------------------------
  let sitzung;
  try {
    sitzung = tokenPruefen(body.token);
  } catch (err) {
    console.error('ACCESS_SECRET problem:', err.message);
    return json(500, { ok: false, fehler: 'server nicht konfiguriert' });
  }
  if (!sitzung.ok) return json(401, { ok: false, fehler: 'zugang ungültig', grund: sitzung.grund });

  if (T(body.website, 200)) return json(200, { ok: true }); // honeypot

  const d = {};
  for (const [key, , max] of FELDER) d[key] = T(body[key], max);
  // The address the link was issued to wins over anything typed into the form.
  if (!istEmail(d.email)) d.email = sitzung.email;

  const fehlend = ['firma', 'inhaber', 'ort', 'telefon', 'leistungen'].filter((k) => !d[k]);
  if (fehlend.length) return json(400, { ok: false, fehler: 'pflichtfelder fehlen', felder: fehlend });

  const { bilder, fehler } = bilderPruefen(body.bilder);
  if (fehler) return json(400, { ok: false, fehler });

  const jetzt = new Date();
  const referenz = crypto.randomUUID();

  const zeilen = FELDER
    .filter(([k]) => d[k])
    .map(([k, label]) => `${(label + ':').padEnd(26)}${d[k].includes('\n') ? '\n  ' + d[k].replace(/\n/g, '\n  ') : d[k]}`);

  const textBody = [
    'NEUER WEBSITE-AUFTRAG über www.zkfonline.de/auftrag',
    '='.repeat(60),
    '',
    ...zeilen,
    '',
    `Bilder:                   ${bilder.length}`,
    `Zugang verifiziert für:   ${sitzung.email}`,
    `Referenz:                 ${referenz}`,
    `Eingegangen:              ${jetzt.toISOString()}`,
  ].join('\n');

  // NOVA's enquiry endpoint accepts a flat object; `id` is its dedupe key.
  const novaPayload = {
    id: referenz,
    created_at: jetzt.toISOString(),
    form_name: 'auftrag',
    site_url: 'https://www.zkfonline.de',
    data: {
      name: d.inhaber,
      company: d.firma,
      email: d.email,
      phone: d.telefon,
      message: textBody,
      referrer: 'https://www.zkfonline.de/auftrag/',
    },
  };

  try {
    const res = await fetch(`${NOVA_URL}?token=${encodeURIComponent(NOVA_TOKEN)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(novaPayload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('NOVA rejected the order', res.status, text.slice(0, 400));
      return json(502, { ok: false, fehler: 'hub nicht erreichbar' });
    }
    let antwort = {};
    try { antwort = JSON.parse(text); } catch {}
    if (antwort.ok === false) {
      console.error('NOVA reported an error', text.slice(0, 400));
      return json(502, { ok: false, fehler: 'hub hat den auftrag abgelehnt' });
    }
  } catch (err) {
    console.error('NOVA request failed', err?.name, err?.message);
    return json(502, { ok: false, fehler: 'hub nicht erreichbar' });
  }

  // Order is recorded from here on — mail failures must not fail the request.
  try {
    await postmarkSenden({
      From: FROM, To: NOTIFY, ReplyTo: d.email,
      Subject: `Neuer Website-Auftrag: ${d.firma}`,
      TextBody: textBody,
      Attachments: bilder.map(({ Name, Content, ContentType }) => ({ Name, Content, ContentType })),
    });
    await postmarkSenden({
      From: FROM, To: d.email, ReplyTo: NOTIFY,
      Subject: 'Ihr Website-Auftrag bei ZKFonline',
      TextBody: [
        `Guten Tag ${d.inhaber},`,
        '',
        'vielen Dank — wir haben Ihre Angaben für die neue Internetseite erhalten.',
        `Übermittelt wurden ${bilder.length} Bild(er) sowie Ihre Betriebsdaten.`,
        '',
        'Wir sichten alles und melden uns mit einem ersten Entwurf bei Ihnen.',
        'Wenn Ihnen noch etwas einfällt, antworten Sie einfach auf diese E-Mail.',
        '',
        `Ihre Referenz: ${referenz}`,
        '',
        'Mit freundlichen Grüßen',
        'Ihr ZKFonline-Team',
        'www.zkfonline.de',
      ].join('\n'),
    });
  } catch (err) {
    console.error('Postmark step failed', err?.message);
  }

  return json(200, { ok: true, referenz, bilder: bilder.length });
};

export const config = { path: '/api/auftrag' };
