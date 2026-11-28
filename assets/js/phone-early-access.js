// Phone early access from the email (28 Nov 2026). Kept apart from markets-phone.js, which never talks to the network.
//  - trading.html?phone=1&ea=<token> claims early access for the trader's account (public.mobile_early_access) and
//    removes the token from the address bar.
//  - window.ipfxCheckPhoneEarlyAccess(): once per signed-in account, asks the database whether that account has claimed
//    it, and if so switches the phone version on for this browser (the same flag markets-phone.js reads).
(function () {
  'use strict';
  const SB = 'https://agulweemteoeagscmppy.supabase.co';
  const SB_AUTH_KEY = 'sb-agulweemteoeagscmppy-auth-token';
  const DEVICE_KEY = 'ipfx-phone-early-access';
  const anonKey = () => { try { return typeof SB_ANON !== 'undefined' ? SB_ANON : null; } catch (_) { return null; } };
  function session() {
    try {
      let raw = localStorage.getItem(SB_AUTH_KEY);
      if (raw === null) { let acc = '', i = 0, part; while ((part = localStorage.getItem(SB_AUTH_KEY + '.' + i)) !== null) { acc += part; i++; } raw = acc || null; }
      if (!raw) return null;
      if (raw.startsWith('base64-')) raw = new TextDecoder().decode(Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0)));
      const s = JSON.parse(raw), sess = s && s.user ? s : (s && s.currentSession) || null;
      return sess && sess.user && sess.user.id && sess.access_token ? sess : null;
    } catch (_) { return null; }
  }

  const token = new URLSearchParams(location.search).get('ea');
  if (token && /^[0-9a-f]{64}$/.test(token) && anonKey()) {
    fetch(SB + '/rest/v1/rpc/fn_claim_mobile_early_access', {
      method: 'POST', headers: { apikey: anonKey(), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: token }),
    }).catch(() => {});
    try { const u = new URL(location.href); u.searchParams.delete('ea'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (_) {}
  }

  const checked = new Set();
  window.ipfxCheckPhoneEarlyAccess = function () {
    const s = session();
    if (!s || checked.has(s.user.id) || !anonKey()) return;
    checked.add(s.user.id);
    fetch(SB + '/rest/v1/mobile_early_access?select=user_id&claimed_at=not.is.null&user_id=eq.' + encodeURIComponent(s.user.id),
      { headers: { apikey: anonKey(), Authorization: 'Bearer ' + s.access_token } })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => { if (Array.isArray(rows) && rows.length) { try { localStorage.setItem(DEVICE_KEY, '1'); } catch (_) {} } })
      .catch(() => {});
  };
})();
