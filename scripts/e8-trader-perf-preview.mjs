// Local-only desktop verification of the real Books HTML and production cache RPCs.
// Uses synthetic example.invalid data from the SQL fixtures. Never signs into production.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { e8TraderPerformanceRead } from '../supabase/functions/_shared/e8-trader-performance.ts';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const fixtureURL = new URL('../tests/e8-trader-perf-db.test.mjs', import.meta.url);
const source = fs.readFileSync(fixtureURL, 'utf8');
const setup = source.slice(source.indexOf('const U ='), source.indexOf('\nasync function rpc('));
const factory = new Function('fs','pathToFileURL','process','controlSQL','cacheSQL','migration','fixtureURL', setup.replaceAll('import.meta.url','fixtureURL') + '\nreturn fixture;');
const db = await factory(fs,pathToFileURL,process,read('supabase/migrations/20261018190000_e8_copy_backtest.sql'),read('supabase/migrations/20261018200000_e8_copy_backtest_cache.sql'),read('supabase/migrations/20261019100000_e8_trader_performance.sql'),fixtureURL.href)();
const result = (await db.query('select public.ab_e8_trader_perf_refresh_private() r')).rows[0].r;
if (!result.ok) throw Error(JSON.stringify(result));
const transport = { rpc: async (fn, args) => {
  try {
    const entries = Object.entries(args), params = entries.map(([,v])=>v);
    const names = entries.map(([k],i)=>`${k}=>$${i+1}`).join(',');
    return { data: (await db.query(`select public.${fn}(${names}) r`,params)).rows[0].r, error:null };
  } catch(e) { return {data:null,error:{message:e.message}}; }
} };
const stub = `(() => { const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); window.TeamOS={esc,usd:v=>Number(v).toFixed(2),ukTime:v=>new Date(v).toLocaleString('en-GB'),brain:async(action,body)=>{const r=await fetch('/__owner-cache',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...body})});const j=await r.json();if(!r.ok)throw Error(j.error);return j;}}; document.getElementById('osStatus').textContent='LOCAL SQL FIXTURE · synthetic data';document.getElementById('osSide').innerHTML='<a href="#e8traders" style="padding:24px;display:block">IPFX / Books preview</a>';})();`;
http.createServer(async (req,res) => {
  const url = new URL(req.url,'http://127.0.0.1:8139');
  res.setHeader('Cache-Control','no-store');
  if (url.pathname === '/__owner-cache' && req.method === 'POST') {
    let body='';for await (const chunk of req) {body+=chunk;if(body.length>4096){res.writeHead(413).end();return;}}
    try {const b=JSON.parse(body), out=await e8TraderPerformanceRead(transport,b.action,b);res.writeHead(out?.status??400,{'Content-Type':'application/json'}).end(JSON.stringify(out?.body??{ok:false}));} catch {res.writeHead(400).end();} return;
  }
  if (url.pathname === '/assets/js/team-shell.js') {res.writeHead(200,{'Content-Type':'application/javascript'}).end(stub);return;}
  if (['/assets/js/ws-books.js','/assets/js/ws-books-backtest.js'].includes(url.pathname)) {res.writeHead(200,{'Content-Type':'application/javascript'}).end('/* Existing controls are outside this local individual-analysis fixture. */');return;}
  const filename = path.resolve(root,'.'+url.pathname);
  if (!filename.startsWith(root+path.sep) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {res.writeHead(404).end();return;}
  const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'};
  res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream'}).end(fs.readFileSync(filename));
}).listen(8139,'127.0.0.1',()=>console.log('Synthetic SQL Books preview: http://127.0.0.1:8139/workspace/books.html#e8traders'));
