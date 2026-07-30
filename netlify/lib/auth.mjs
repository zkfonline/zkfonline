/**
 * Stateless magic-link tokens for the client area.
 *
 * A token is `base64url({e,x,n}).hmac` — the payload carries the email and an
 * expiry, and the HMAC makes it unforgeable. Deliberately stateless: there is no
 * session store to provision or clean up, and losing the secret invalidates every
 * link at once. The trade-off is that a token cannot be revoked individually
 * before it expires, which is acceptable for a 7-day intake form link.
 */
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const secret = () => {
  const s = process.env.ACCESS_SECRET;
  if (!s || s.length < 20) throw new Error('ACCESS_SECRET missing or too short');
  return s;
};

const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export const GUELTIG_TAGE = 7;

export function tokenErstellen(email, tage = GUELTIG_TAGE) {
  const payload = b64url(JSON.stringify({
    e: String(email).toLowerCase(),
    x: Date.now() + tage * 86400_000,
    n: crypto.randomBytes(6).toString('base64url'),
  }));
  return `${payload}.${sign(payload)}`;
}

/** @returns {{ok:true,email:string}|{ok:false,grund:string}} */
export function tokenPruefen(token) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, grund: 'format' };
  const [payload, mac] = token.split('.', 2);

  const erwartet = sign(payload);
  // Constant-time compare; timingSafeEqual throws on length mismatch.
  const a = Buffer.from(mac || '');
  const b = Buffer.from(erwartet);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, grund: 'signatur' };

  let daten;
  try {
    daten = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, grund: 'payload' };
  }
  if (!daten.e || !daten.x) return { ok: false, grund: 'payload' };
  if (Date.now() > daten.x) return { ok: false, grund: 'abgelaufen' };
  return { ok: true, email: daten.e };
}

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const istEmail = (v) => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(v);

export async function postmarkSenden(mail) {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) {
    console.warn('POSTMARK_SERVER_TOKEN not set — mail skipped');
    return { ok: false, grund: 'kein token' };
  }
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify({ MessageStream: 'outbound', ...mail }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Postmark rejected a mail', res.status, text.slice(0, 300));
    return { ok: false, grund: `http ${res.status}` };
  }
  return { ok: true };
}
