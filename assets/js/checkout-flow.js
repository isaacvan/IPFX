(() => {
  'use strict';
  const url = 'https://agulweemteoeagscmppy.supabase.co';
  const anon = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ';
  const db = window.supabase.createClient(url, anon);
  const $ = id => document.getElementById(id);
  let tier = null, quote = null, stripe = null, elements = null, element = null;
  let checkout = null, generation = 0, busy = false, verifiedEmail = '';
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
  async function call(body) {
    const {data:{session}} = await db.auth.getSession();
    if (!session) throw new Error('Sign in or create and verify your account before checkout.');
    const response = await fetch(url + '/functions/v1/create-payment-intent', {
      method:'POST', headers:{'Content-Type':'application/json', apikey:anon, Authorization:'Bearer ' + session.access_token},
      body:JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Checkout is currently unavailable. No new payment was taken.');
    return data;
  }
  function resetPayment() {
    generation++;
    element?.unmount();
    element = null; elements = null; checkout = null; quote = null;
    $('step3Next').disabled = true;
    $('payForm').style.display = 'none';
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
    const current = ++generation;
    $('step3Next').disabled = true;
    $('payDemoNotice').style.display = 'none';
    $('payLoading').style.display = 'flex';
    try {
      const {data:{user},error} = await db.auth.getUser();
      if (error || !user?.email) throw new Error('Sign in or create and verify your account before checkout.');
      verifiedEmail = user.email;
      $('email').value = user.email; $('email').readOnly = true;
      const sku = 'trad_' + tier + '_p1';
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
  $('step2Next').addEventListener('click', () => {
    const fields = ['firstName','lastName','email','country','experience'];
    for (const id of fields) {
      if (!$(id).value.trim() || !$(id).checkValidity()) { $(id).reportValidity(); $(id).focus(); return; }
    }
    for (const id of ['ageConfirm','terms','cancellationWaiver']) {
      if (!$(id).checked) { $(id).focus(); $(id).reportValidity(); return; }
    }
    step(3); mountPayment();
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
  const initial = location.hash.slice(1);
  document.querySelectorAll('.tier-card').forEach(card => { if (card.dataset.tier === initial) card.click(); });
})();
