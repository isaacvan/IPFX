/* Classic team pages: a bar at the top pointing to the matching page in the new workspace. */
(() => {
  'use strict';
  const MAP = { 'admin.html': ['/workspace/', 'Overview'], 'trader-analytics.html': ['/workspace/traders.html', 'Traders'], 'team-a-book.html': ['/workspace/books.html', 'Books'],
    'team-b-book.html': ['/workspace/books.html', 'Books'], 'team-brain.html': ['/workspace/traders.html', 'Traders'], 'team-treasury.html': ['/workspace/treasury.html', 'Treasury'],
    'team-e8-monitor.html': ['/workspace/costs.html', 'Costs & E8'], 'team-feedback.html': ['/workspace/queues.html', 'Queues'] };
  const page = location.pathname.split('/').pop() || '';
  const [href, name] = MAP[page] || ['/workspace/', 'Overview'];
  const bar = document.createElement('div');
  bar.setAttribute('role', 'note');
  bar.style.cssText = 'position:relative;z-index:9999;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:9px 16px;background:#0a84ff;color:#fff;font:600 13.5px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
  bar.innerHTML = '<span>This is the classic view.</span>';
  const a = document.createElement('a');
  a.href = href; a.textContent = 'Open ' + name + ' in the new workspace →';
  a.style.cssText = 'color:#fff;background:rgba(255,255,255,.2);padding:4px 12px;border-radius:999px;text-decoration:none';
  bar.appendChild(a);
  const add = () => document.body.prepend(bar);
  document.body ? add() : document.addEventListener('DOMContentLoaded', add);
})();
