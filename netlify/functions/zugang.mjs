/**
 * Client-area access: emails a magic link, and verifies one.
 *
 *   POST /api/zugang            { email }          -> sends the link
 *   POST /api/zugang?pruefen=1  { token }          -> validates it
 *
 * Requesting a link always answers 200 regardless of the address, so the
 * endpoint cannot be used to discover who is a customer.
 */
import { tokenErstellen, tokenPruefen, json, istEmail, postmarkSenden, GUELTIG_TAGE } from '../lib/auth.mjs';

const FROM = process.env.SUPPORT_FROM_EMAIL || 'support@zkfonline.de';
const NOTIFY = process.env.SUPPORT_NOTIFY_EMAIL || 'support@innomega.de';

// Canonical, non-negotiable base for magic links. Only an env var may override it —
// never anything derived from the incoming request.
const BASIS = (process.env.SITE_URL || 'https://www.zkfonline.de').replace(/\/+$/, '');

/**
 * Best-effort throttle so this endpoint cannot be used to mail-bomb an address or
 * burn Postmark reputation. Serverless gives no shared state, so this only limits a
 * single warm instance — it raises the cost of abuse, it does not eliminate it.
 * A durable limit needs shared storage.
 */
const letzte = new Map();
const FENSTER_MS = 60_000;
const MAX_PRO_FENSTER = 3;

function zuVieleAnfragen(key) {
  const jetzt = Date.now();
  const treffer = (letzte.get(key) || []).filter((t) => jetzt - t < FENSTER_MS);
  treffer.push(jetzt);
  letzte.set(key, treffer);
  if (letzte.size > 500) {
    for (const [k, v] of letzte) if (!v.some((t) => jetzt - t < FENSTER_MS)) letzte.delete(k);
  }
  return treffer.length > MAX_PRO_FENSTER;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, fehler: 'method not allowed' });

  let body;
  try { body = await req.json(); } catch { return json(400, { ok: false, fehler: 'ungültige daten' }); }

  const url = new URL(req.url);

  // --- verify a token -------------------------------------------------
  if (url.searchParams.has('pruefen')) {
    try {
      const r = tokenPruefen(body.token);
      return r.ok
        ? json(200, { ok: true, email: r.email })
        : json(401, { ok: false, fehler: r.grund });
    } catch (err) {
      console.error('token check failed', err.message);
      return json(500, { ok: false, fehler: 'server nicht konfiguriert' });
    }
  }

  // --- request a link -------------------------------------------------
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 254);
  if (!istEmail(email)) return json(400, { ok: false, fehler: 'ungültige e-mail-adresse' });

  // Throttle per recipient and per caller. Still answers 200 so the response stays
  // indistinguishable from a successful request.
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  if (zuVieleAnfragen(`m:${email}`) || zuVieleAnfragen(`i:${ip}`)) {
    console.warn('rate limited magic-link request', email);
    return json(200, { ok: true });
  }

  let token;
  try {
    token = tokenErstellen(email);
  } catch (err) {
    console.error('ACCESS_SECRET problem:', err.message);
    return json(500, { ok: false, fehler: 'server nicht konfiguriert' });
  }

  // NEVER derive this from the request. `url.origin` follows the Host header, so a
  // spoofed Host would mail the victim a valid token pointing at an attacker's domain.
  const link = `${BASIS}/auftrag/?zugang=${encodeURIComponent(token)}`;

  const text = [
    `Guten Tag,`,
    ``,
    `hier ist Ihr persönlicher Zugang zum ZKFonline-Auftragsbereich.`,
    `Dort hinterlegen Sie in Ruhe alle Angaben und Bilder für Ihre neue Internetseite —`,
    `Sie können jederzeit unterbrechen und später weitermachen.`,
    ``,
    link,
    ``,
    `Der Link ist ${GUELTIG_TAGE} Tage gültig und nur für Sie bestimmt.`,
    `Falls Sie diesen Zugang nicht angefordert haben, können Sie diese E-Mail ignorieren.`,
    ``,
    `Mit freundlichen Grüßen`,
    `Ihr ZKFonline-Team`,
    `www.zkfonline.de`,
  ].join('\n');

  const versand = await postmarkSenden({
    From: FROM,
    To: email,
    ReplyTo: NOTIFY,
    Subject: 'Ihr Zugang zum ZKFonline-Auftragsbereich',
    TextBody: text,
  }).catch((err) => {
    console.error('magic link mail failed', err.message);
    return { ok: false, grund: err.message };
  });

  // Always 200: never reveal whether the address exists or whether mail worked.
  if (!versand.ok) console.error('magic link could not be delivered to', email, versand.grund);
  return json(200, { ok: true });
};

export const config = { path: '/api/zugang' };
