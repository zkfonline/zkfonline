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

  let token;
  try {
    token = tokenErstellen(email);
  } catch (err) {
    console.error('ACCESS_SECRET problem:', err.message);
    return json(500, { ok: false, fehler: 'server nicht konfiguriert' });
  }

  const basis = process.env.SITE_URL || url.origin;
  const link = `${basis}/auftrag/?zugang=${encodeURIComponent(token)}`;

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
