/* Authenticated engine state supplies these notices. No extra polling, tokens,
   browser notifications, external messages or account commands. */
(() => {
  const seen=new Set();let account=null;
  function clear(){document.getElementById('serviceInbox')?.remove();document.getElementById('serviceNoticeBanner')?.remove();seen.clear();account=null;}
  function render(controls,accountId){
    if(account!==accountId){clear();account=accountId;}
    if(!controls)return;
    const panel=document.getElementById('bp-alerts');if(!panel)return;
    let inbox=document.getElementById('serviceInbox');
    if(!inbox){inbox=document.createElement('section');inbox.id='serviceInbox';inbox.style.cssText='padding:16px;border-bottom:1px solid #48536b';panel.prepend(inbox);}
    inbox.replaceChildren();const title=document.createElement('h3');title.textContent='Account notifications';inbox.append(title);
    if(controls.unavailable){const p=document.createElement('p');p.textContent='Account notifications could not be loaded. Refresh the connection.';inbox.append(p);return;}
    const notices=Array.isArray(controls.notices)?controls.notices:[];
    for(const n of notices){const item=document.createElement('article'),h=document.createElement('strong'),p=document.createElement('p'),time=document.createElement('small');
      h.textContent=n.title;p.textContent=n.message;time.textContent=new Date(n.created_at).toLocaleString('en-GB');item.append(h,p,time);inbox.append(item);
    }
    if(!notices.length){const p=document.createElement('p');p.textContent='No team warnings or review notices.';inbox.append(p);}
    const fresh=notices.find(n=>!seen.has(n.id));for(const n of notices)seen.add(n.id);
    let banner=document.getElementById('serviceNoticeBanner');
    if(controls.paused||fresh){
      if(!banner){banner=document.createElement('aside');banner.id='serviceNoticeBanner';banner.setAttribute('role','status');banner.style.cssText='position:fixed;right:20px;top:90px;max-width:430px;padding:18px;background:#182031;color:#fff;border:2px solid #e8a244;z-index:1900;box-shadow:0 6px 24px #0008';document.body.append(banner);}
      banner.replaceChildren();const h=document.createElement('strong'),p=document.createElement('p');h.textContent=controls.paused?'New trades paused for review':fresh.title;p.textContent=controls.paused?controls.reason:fresh.message;banner.append(h,p);
      const view=document.createElement('button');view.type='button';view.textContent='View account notifications';view.addEventListener('click',()=>{window.switchBtab?.('alerts',document.querySelector('.btab[onclick*="alerts"]'));banner.remove();});banner.append(view);
      if(!controls.paused){const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='Dismiss';dismiss.addEventListener('click',()=>banner.remove());banner.append(dismiss);}
    }else if(banner&&banner.dataset.paused==='true')banner.remove();
    if(banner)banner.dataset.paused=String(!!controls.paused);
  }
  window.IPFXServiceNotices={render,clear};
})();
