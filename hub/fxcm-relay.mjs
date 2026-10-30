// FXCM price relay for the trading engine. FXCM's rates.fxcm.com certificate expired on 30 Oct 2026 05:54 UTC; the engine (Deno)
// refuses it, so every FXCM price stopped. The hub reads the same public XML and accepts ONLY an expiry problem: the certificate
// must still chain to a trusted issuer and match rates.fxcm.com, and may be at most MAX_EXPIRED_DAYS past its end date.
// Any other TLS problem (unknown issuer, self-signed, wrong name) is refused. One upstream read serves all callers for CACHE_MS.
import https from 'node:https';
import tls from 'node:tls';

const HOST = 'rates.fxcm.com';
const MAX_EXPIRED_DAYS = 21;
const CACHE_MS = 200;
const MAX_BYTES = 1024 * 1024;
let cached = { at: 0, xml: null }, inFlight = null;
export const relayStats = { reads: 0, served: 0, errors: 0, lastError: null, expiredCert: false };

function readOnce() {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path: '/RatesXML?ts=' + Date.now(), servername: HOST, agent: false, rejectUnauthorized: false, timeout: 2500,
      headers: { Accept: 'application/xml', 'Cache-Control': 'no-cache', 'User-Agent': 'IPFXHub/1.0' },
    }, (res) => {
      const sock = res.socket, cert = sock.getPeerCertificate(), why = sock.authorizationError;
      const fail = (m) => { res.destroy(); reject(new Error(m)); };
      if (why && why !== 'CERT_HAS_EXPIRED') return fail('tls ' + why);
      const idErr = tls.checkServerIdentity(HOST, cert);
      if (idErr) return fail('tls name ' + idErr.code);
      relayStats.expiredCert = why === 'CERT_HAS_EXPIRED';
      if (why && Date.now() - Date.parse(cert.valid_to) > MAX_EXPIRED_DAYS * 86_400_000) return fail('tls certificate expired too long ago');
      if (res.statusCode !== 200) return fail('http ' + res.statusCode);
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) fail('too large'); else chunks.push(c); });
      res.on('end', () => {
        const xml = Buffer.concat(chunks).toString();
        if (!xml.includes('<Rates')) return reject(new Error('not rates xml'));
        resolve(xml);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export async function fxcmRates() {
  if (cached.xml && Date.now() - cached.at < CACHE_MS) { relayStats.served++; return cached.xml; }
  if (!inFlight) {
    relayStats.reads++;
    inFlight = readOnce().then((xml) => { cached = { at: Date.now(), xml }; return xml; })
      .catch((e) => { relayStats.errors++; relayStats.lastError = String(e.message || e).slice(0, 120); throw e; })
      .finally(() => { inFlight = null; });
  }
  const xml = await inFlight;
  relayStats.served++;
  return xml;
}
