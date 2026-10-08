/* Account labels describe source accounts, never inferred from A/B routing. */
(() => {
  const names={demo:'Demo practice',infinity:'Infinity',traditional:'Traditional',futures:'Futures',pac:'PAC'};
  function kind(a){
    if(a.phase==='demo'||a.status==='demo'||a.challenge_type==='demo')return 'demo';
    return Object.hasOwn(names,a.challenge_type)?a.challenge_type:'unknown';
  }
  function label(a){const k=kind(a);return (names[k]||'Account type unknown')+(k!=='demo'&&Number(a.stage)>0?' · Stage '+a.stage:'');}
  function available(a){return !a.access_revoked_at&&['active','demo'].includes(a.status);}
  function visible(accounts){
    if(!Array.isArray(accounts))return null;
    const current=accounts.filter(a=>available(a)||Number(a.open_positions)>0);
    return current.length?current:accounts.slice(0,1);
  }
  function latest(accounts){return (accounts||[]).filter(a=>Number.isFinite(Date.parse(a.last_order_at)))
    .sort((a,b)=>Date.parse(b.last_order_at)-Date.parse(a.last_order_at))[0]||null;}
  function matches(accounts,filter){const list=visible(accounts);return !filter||(filter==='unknown'&&list===null)||(list||[]).some(a=>kind(a)===filter);}
  globalThis.IPFXBrainAccountLabels=Object.freeze({kind,label,available,visible,latest,matches});
})();
