(() => {
  'use strict';
  const url = 'https://agulweemteoeagscmppy.supabase.co';
  const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const db = window.supabase?.createClient ? window.supabase.createClient(url, anon) : null;
  const $ = id => document.getElementById(id);
  let tier = null, quote = null, stripe = null, elements = null, element = null;
  let checkout = null, generation = 0, busy = false, verifiedEmail = '';
  const REQUEST_TIMEOUT_MS = 12000;
  function step(n) {
    document.querySelectorAll('.step-content').forEach(el => el.classList.toggle('active', el.id === 'step' + n));
    document.querySelectorAll('.step').forEach((el, i) => {
      el.classList.toggle('active', i + 1 === n);
      el.classList.toggle('completed', i + 1 < n);
    });
    $('progressFill').style.width = Math.min(100, (n - 1) / 3 * 100) + '%';
    window.scrollTo({top:0, behavior:'auto'});
  }
  function message(text) {
    $('payDemoNotice').textContent = text;
    $('payDemoNotice').style.display = 'block';
  }
  function selectedSku() {
    const card = document.querySelector('.tier-card.selected');
    return card?.dataset.sku || ('trad_' + tier + '_p1');
  }
  async function saveIdentity() {
    const { data:{user}, error: userError } = await db.auth.getUser();
    if (userError || !user) {
      const next = location.pathname + location.search + location.hash;
      location.href = '/login.html?next=' + encodeURIComponent(next);
      throw new Error('Sign in or create and verify your account before checkout.');
    }
    const dob = $('dateOfBirth').value;
    const adultCutoff = new Date(); adultCutoff.setFullYear(adultCutoff.getFullYear() - 18);
    if (!dob || new Date(dob + 'T12:00:00') > adultCutoff) throw new Error('You must be at least 18 years old.');
    const profile = {
      legal_first_name: $('firstName').value.trim(), legal_last_name: $('lastName').value.trim(),
      legal_middle_names: '', date_of_birth: dob, phone_e164: $('phone').value.trim(),
      address_line_1: $('addressLine1').value.trim(), address_line_2: $('addressLine2').value.trim(),
      city: $('city').value.trim(), region: $('region').value.trim(), postal_code: $('postalCode').value.trim(),
      country_code: $('country').value, nationality_code: $('country').value === 'ZZ' ? null : $('country').value,
    };
    const { error } = await db.rpc('submit_identity_profile', { p_profile: profile });
    if (error) {
      const code = String(error.message || '');
      if (code.includes('MUST_BE_18')) throw new Error('You must be at least 18 years old.');
      throw new Error('We could not securely save your identity details. Check every required field and try again.');
    }
  }
  function challengeTypeForSku(sku) {
    if (sku.startsWith('fut_')) return 'futures';
    if (sku.startsWith('pac_')) return 'pac';
    return 'traditional';
  }
  async function submitChallengeReview() {
    const sku = selectedSku();
    const details = {
      source: 'website_checkout',
      experience: $('experience').value,
      referral_source: $('referral').value || null,
      age_confirmed: $('ageConfirm').checked,
      terms_accepted: $('terms').checked,
      cancellation_waiver: $('cancellationWaiver').checked,
      newsletter: $('newsletter').checked,
    };
    const { data, error } = await db.rpc('submit_challenge_application', {
      p_challenge_type: challengeTypeForSku(sku),
      p_details: details,
      p_preset_id: sku,
    });
    if (error) throw new Error('We could not submit your challenge application. Check your details and try again.');
    return data;
  }
  function showReview(application) {
    const denied = application?.status === 'denied';
    const section = $('step2');
    section.innerHTML = `<div class="form-section" style="text-align:center;padding:48px 30px">
      <div style="width:54px;height:54px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:${denied?'rgba(239,68,68,.12)':'rgba(37,99,235,.12)'};color:${denied?'#ef4444':'#60a5fa'};font-size:24px">${denied?'×':'✓'}</div>
      <h2 style="margin-bottom:12px">${denied?'Approved for this challenge: No':'Application received'}</h2>
      <p style="max-width:560px;margin:0 auto;color:var(--muted);line-height:1.7">${denied
        ? (application.decision_note || 'This challenge request was not approved.')
        : 'Your identity, address and challenge details have been submitted securely. We will review whether you can start this challenge within the next 24 hours.'}</p>
      ${denied?'':'<p style="margin-top:14px;color:#94a3b8;font-size:.84rem">No payment has been requested and no trading account has been created.</p>'}
      <a href="/dashboard.html" class="btn-primary" style="display:inline-block;text-decoration:none;margin-top:24px">View application status</a>
    </div>`;
    document.querySelectorAll('.step').forEach((el, i) => {
      el.classList.toggle('active', i === 1);
      el.classList.toggle('completed', i < 1);
    });
    $('progressFill').style.width = '33.333%';
    window.scrollTo({top:0,behavior:'auto'});
  }
  async function call(body, fn) {
    const {data:{session}} = await db.auth.getSession();
    if (!session) throw new Error('Sign in or create and verify your account before checkout.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url + '/functions/v1/' + (fn || 'create-payment-intent'), {
        method:'POST', headers:{'Content-Type':'application/json', apikey:anon, Authorization:'Bearer ' + session.access_token},
        body:JSON.stringify(body), signal:controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Checkout is currently unavailable. No new payment was taken.');
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Checkout took too long to respond. No new payment was requested; retry the same checkout.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  function resetPayment() {
    generation++;
    element?.unmount();
    element = null; elements = null; checkout = null; quote = null;
    $('step3Next').disabled = true;
    $('payForm').style.display = 'none';
    $('payDivider').style.display = 'none';
    $('payCrypto').style.display = 'none';
    $('cryptoError').style.display = 'none';
  }
  document.querySelectorAll('.tier-card').forEach(card => {
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
    });
    card.addEventListener('click', () => {
      if (busy) return;
      resetPayment();
      tier = card.dataset.tier;
      document.querySelectorAll('.tier-card').forEach(c => {
        c.classList.toggle('selected', c === card);
        c.setAttribute('aria-checked', String(c === card));
      });
      $('step1Next').disabled = false;
      $('paySummaryTotal').textContent = 'Sign in to view';
    });
  });
  async function mountPayment() {
    if (elements || busy) return;
    if (!db || typeof window.Stripe !== 'function') {
      message('Secure checkout is temporarily unavailable. Please refresh or contact support.');
      return;
    }
    const current = ++generation;
    $('step3Next').disabled = true;
    $('payDemoNotice').style.display = 'none';
    $('payLoading').style.display = 'flex';
    try {
      const {data:{user},error} = await db.auth.getUser();
      if (error || !user?.email) throw new Error('Sign in or create and verify your account before checkout.');
      verifiedEmail = user.email;
      $('email').value = user.email; $('email').readOnly = true;
      const sku = selectedSku();
      $('payDivider').style.display = 'flex';
      $('payCrypto').style.display = 'block';
      $('payCrypto').disabled = false;
      $('payCrypto').textContent = 'Pay with Crypto (BTC, ETH, USDT & more)';
      const data = await call({action:'quote',sku});
      if (current !== generation) return;
      quote = data.product;
      stripe = window.Stripe(data.publishable_key);
      const storageKey = 'ipfx-checkout-v2:' + user.id + ':' + sku;
      let key;
      try { key = sessionStorage.getItem(storageKey); } catch {}
      if (!/^[0-9a-f-]{36}$/i.test(key || '')) key = crypto.randomUUID();
      try { sessionStorage.setItem(storageKey,key); } catch {}
      checkout = await call({sku,request_key:key,terms_version:quote.terms_version,terms_accepted:$('terms').checked});
      if (current !== generation) return;
      if (checkout.test_mode !== true) throw new Error('Unexpected checkout mode.');
      const total = new Intl.NumberFormat('en-US',{style:'currency',currency:checkout.currency}).format(checkout.amount_minor/100);
      $('paySummaryTotal').textContent = total;
      $('reviewTotal').textContent = total;
      message('Test checkout. No real money is collected and no live trading account is activated.');
      elements = stripe.elements({clientSecret:checkout.client_secret,appearance:{theme:'night',
        variables:{colorPrimary:'#2563eb',colorBackground:'#0a0a0c',colorText:'#ffffff',borderRadius:'8px'}}});
      element = elements.create('payment');
      element.mount('#payment-element');
      $('payForm').style.display = 'block';
      element.on('ready', () => { if (current === generation) $('step3Next').disabled = false; });
      element.on('loaderror', () => message('Payment form unavailable. Please retry later.'));
    } catch(error) {
      if (current === generation) message(error.message);
    } finally {
      if (current === generation) $('payLoading').style.display = 'none';
    }
  }
  $('payForm').addEventListener('submit', e => e.preventDefault());
  $('step1Next').addEventListener('click', () => step(2));
  $('step2Back').addEventListener('click', () => step(1));
  $('step2Next').addEventListener('click', async () => {
    const fields = ['firstName','lastName','email','phone','dateOfBirth','addressLine1','city','postalCode','country','experience'];
    for (const id of fields) {
      if (!$(id).value.trim() || !$(id).checkValidity()) { $(id).reportValidity(); $(id).focus(); return; }
    }
    for (const id of ['ageConfirm','terms','cancellationWaiver']) {
      if (!$(id).checked) { $(id).focus(); $(id).reportValidity(); return; }
    }
    const btn = $('step2Next');
    btn.disabled = true; btn.textContent = 'Securing your details…';
    try {
      await saveIdentity();
      const application = await submitChallengeReview();
      if (application?.status === 'approved') {
        step(3);
        await mountPayment();
      } else {
        showReview(application);
      }
    }
    catch (error) { message(error.message || 'Could not save your details.'); }
    finally { btn.disabled = false; btn.textContent = 'Continue'; }
  });
  $('step3Back').addEventListener('click', () => step(2));
  $('step3Next').addEventListener('click', async () => {
    if (!elements || !checkout) return;
    const {error} = await elements.submit();
    if (error) { message(error.message); return; }
    $('reviewTier').textContent = quote.label;
    $('reviewName').textContent = $('firstName').value + ' ' + $('lastName').value;
    $('reviewEmail').textContent = verifiedEmail;
    $('reviewCountry').textContent = $('country').selectedOptions[0].textContent;
    step(4);
  });
  $('step4Back').addEventListener('click', () => { if (!busy) step(3); });
  $('step4Submit').addEventListener('click', async () => {
    if (busy || !checkout || !elements) return;
    busy = true; $('step4Submit').disabled = true; $('step4Back').disabled = true;
    $('step4Submit').textContent = 'Confirming test payment...';
    try {
      const result = await stripe.confirmPayment({elements,redirect:'if_required',
        confirmParams:{return_url:location.origin + '/start-challenge.html'}});
      if (result.error) throw new Error(result.error.message);
      // A browser result never grants an entitlement. Wait for verified webhook state.
      let recorded = false;
      for (let i=0;i<10;i++) {
        const {order} = await call({action:'status',order_id:checkout.order_id});
        if (order.status === 'paid') { recorded = true; break; }
        if (order.status === 'review') throw new Error('Payment needs reconciliation. Do not pay again; contact support.');
        await new Promise(resolve => setTimeout(resolve,1500));
      }
      if (!recorded) throw new Error('Confirmation is still pending. Do not pay again; retain order ' + checkout.order_id + '.');
      $('confirmEmail').textContent = verifiedEmail;
      $('confirmationOrder').textContent = checkout.order_id;
      step(5);
    } catch(error) { step(3); message(error.message || 'Payment status unavailable. Do not pay again.'); }
    finally { busy=false; $('step4Submit').disabled=false; $('step4Back').disabled=false; $('step4Submit').textContent='Confirm Test Payment'; }
  });
  $('payCrypto').addEventListener('click', async () => {
    if (busy || !tier) return;
    $('cryptoError').style.display = 'none';
    busy = true; $('payCrypto').disabled = true; $('step3Next').disabled = true;
    $('payCrypto').textContent = 'Opening crypto checkout…';
    try {
      const {data:{user},error} = await db.auth.getUser();
      if (error || !user?.email) throw new Error('Sign in or create and verify your account before checkout.');
      const sku = selectedSku();
      const cryptoQuote = await call({action:'quote',sku}, 'nowpayments-checkout');
      const storageKey = 'ipfx-checkout-crypto-v1:' + user.id + ':' + sku;
      let key;
      try { key = sessionStorage.getItem(storageKey); } catch {}
      if (!/^[0-9a-f-]{36}$/i.test(key || '')) key = crypto.randomUUID();
      try { sessionStorage.setItem(storageKey,key); } catch {}
      const invoice = await call({sku,request_key:key,terms_version:cryptoQuote.product.terms_version,terms_accepted:$('terms').checked}, 'nowpayments-checkout');
      if (!invoice.invoice_url) throw new Error('Crypto checkout is unavailable right now.');
      location.href = invoice.invoice_url;
    } catch(error) {
      $('cryptoError').textContent = error.message || 'Crypto checkout is currently unavailable.';
      $('cryptoError').style.display = 'block';
      $('payCrypto').disabled = false; $('step3Next').disabled = false;
      $('payCrypto').textContent = 'Pay with Crypto (BTC, ETH, USDT & more)';
    } finally { busy = false; }
  });
  const initial = location.hash.slice(1);
  document.querySelectorAll('.tier-card').forEach(card => { if (card.dataset.tier === initial) card.click(); });
  (async () => {
    if (!db) return;
    const { data:{user} } = await db.auth.getUser();
    if (!user) return;
    $('email').value = user.email || ''; $('email').readOnly = true;
    const { data:p } = await db.rpc('get_my_identity_profile');
    if (!p?.complete) return;
    $('firstName').value=p.legal_first_name||''; $('lastName').value=p.legal_last_name||'';
    $('phone').value=p.phone_e164||''; $('dateOfBirth').value=p.date_of_birth||'';
    $('addressLine1').value=p.address_line_1||''; $('addressLine2').value=p.address_line_2||'';
    $('city').value=p.city||''; $('region').value=p.region||''; $('postalCode').value=p.postal_code||'';
    if ([...$('country').options].some(o=>o.value===p.country_code)) $('country').value=p.country_code;
  })().catch(()=>{});
})();
