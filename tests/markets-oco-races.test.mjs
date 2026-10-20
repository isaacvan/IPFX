// Actual engine linking/fill functions against isolated rows. The query double
// models the existing partial unique index; hooks interleave competing requests
// between individual database statements, without real accounts or prices.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';
const engine=fs.readFileSync(process.env.MARKETS_ENGINE_TEST_SOURCE||new URL('../supabase/functions/trading-engine/index.ts',import.meta.url),'utf8');
const start=engine.indexOf('      // OCO: link this order'),end=engine.indexOf('      const orderId = await logAudit',start);
const pendingStart=engine.indexOf('async function processPendingOrders('),pendingEnd=engine.indexOf('\nasync function ',pendingStart+1);
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture({group=null,hooks={},execute=null}={}){
 const rows=[{id:'original',account_id:'demo',user_id:'owner',symbol:'EURUSD',status:'pending',oco_group:group,side:'buy',order_type:'stop',volume:.01,trigger_price:1.1,sl:null,tp:null}],trades=[];
 const fill=row=>{
  if(!row||row.status!=='pending'||row.oco_group&&rows.some(r=>r.id!==row.id&&r.status==='filled'&&r.oco_group===row.oco_group))return false;
  row.status='filled';row.filled_trade_id='synthetic-'+row.id;trades.push({id:row.filled_trade_id});return true;
 };
 const db={from(table){
  const filters=[];let op='read',patch,columns='*',one=false,limit=null;
  const matches=row=>filters.every(([kind,key,value])=>kind==='eq'?row[key]===value:kind==='neq'?row[key]!==value:kind==='not'?row[key]!=null:row[key]==null);
  const project=row=>columns==='*'?copy(row):Object.fromEntries(columns.split(',').map(key=>[key,row[key]]));
  const q={select(c='*'){columns=c;return q;},eq(k,v){filters.push(['eq',k,v]);return q;},neq(k,v){filters.push(['neq',k,v]);return q;},is(k,v){filters.push(['is',k,v]);return q;},not(k,_op,v){filters.push(['not',k,v]);return q;},limit(n){limit=n;return q;},order(){return q;},maybeSingle(){one=true;return q;},single(){one=true;return q;},insert(p){op='insert';patch=p;return q;},update(p){op='update';patch=p;return q;},then(resolve,reject){return run().then(resolve,reject);}};
  async function run(){
   const info={table,op,patch,filters,rows,trades,fill};
   const failure=await hooks.before?.(info);if(failure)return{data:null,error:{message:failure}};
   if(execute){const result=await execute({table,op,patch,filters,columns,one,limit});await hooks.after?.(info);return result;}
   const store=table==='pending_orders'?rows:trades;
   let selected;
   if(op==='insert'){
    const row={id:table==='pending_orders'?'new-leg':'filled-trade',status:table==='pending_orders'?'pending':'open',...patch};store.push(row);selected=[row];
   }else{
    selected=store.filter(matches);
    if(op==='update'){
     if(patch.status==='filled'&&selected.some(row=>row.oco_group&&store.some(other=>other!==row&&other.status==='filled'&&other.oco_group===row.oco_group)))return{data:null,error:{code:'23505'}};
     selected.forEach(row=>Object.assign(row,patch));
    }
   }
   if(limit!=null)selected=selected.slice(0,limit);
   const result=selected.map(project);
   await hooks.after?.(info);
   return{data:one?result[0]??null:result,error:null};
  }
  return q;
 }};
 const c=vm.createContext({db,acct:{id:'demo',user_id:'owner'},user:{id:'owner'},body:{oco_with:'original'},symbol:'EURUSD',side:'sell',orderType:'stop',volume:.01,trigger:1.09,sl:null,tp:null,expiresAt:null,
  err:(error,status=400)=>({ok:false,error,status}),jsonOk:value=>({ok:true,...value}),Date,console,
  INSTRUMENTS:{EURUSD:{cls:'forex',quote:'USD',contract:100000,maxSpread:1}},MAX_OPEN_POSITIONS:20,
  isTradableAccount:()=>true,fetchQuote:async()=>{await hooks.quote?.();return{bid:1.1,ask:1.1002,spread:.0002};},quoteStale:()=>false,marketOpen:()=>true,pendingTriggered:()=>true,
  symbolCheck:async()=>({ok:true,maxSpread:1}),rulesV2:()=>false,usdPerQuote:async()=>1,usedMarginUsd:async()=>0,ruleGate:()=>null,
  logAudit:async()=>{},ongoingCopyRoute:async()=> 'off',hedgeOpenArmed:async()=>false,mirrorLater(){},fireMirror:async()=>{},bookLater(){},shadowLater(){}});
 vm.runInContext(stripTypeScriptTypes('async function place(){'+engine.slice(start,end)+'return jsonOk({pending:created});}'),c);
 vm.runInContext(stripTypeScriptTypes(engine.slice(pendingStart,pendingEnd)),c);
 return{c,db,rows,trades,fill,hooks};
}

test('a first OCO link assigns a common group while preserving both pending legs',async()=>{
 const f=fixture();assert.equal((await f.c.place()).ok,true);assert.deepEqual(f.rows.map(r=>r.oco_group),['original','original']);assert.ok(f.rows.every(r=>r.status==='pending'));
});
test('a fill between OCO statements can never execute both originally ungrouped legs',async()=>{
 const f=fixture({hooks:{after({table,op,rows,fill}){if(table==='pending_orders'&&op==='insert'){fill(rows[0]);fill(rows[1]);}}}});
 await f.c.place();assert.equal(f.trades.length,1,'one-cancels-other must permit at most one trade');
 assert.ok(f.rows.filter(r=>r.filled_trade_id).every(r=>r.status==='filled'),'cleanup must not relabel a filled leg cancelled');
});
test('an original order cancelled while linking cannot leave a newly executable leg',async()=>{
 const f=fixture({hooks:{before({op,patch,rows}){if(op==='update'&&patch.oco_group)rows[0].status='cancelled';}}});
 assert.equal((await f.c.place()).ok,false);assert.equal(f.rows.length,1);
});
test('a changed group cannot be overwritten using an older link snapshot',async()=>{
 const f=fixture({group:'first-group',hooks:{before({op,patch,rows}){if(op==='update'&&patch.oco_group)rows[0].oco_group='newer-group';}}});
 assert.equal((await f.c.place()).ok,false);assert.equal(f.rows.length,1);assert.equal(f.rows[0].oco_group,'newer-group');
});
test('joining an existing group after its winner completed cancels only the new pending leg',async()=>{
 const f=fixture({group:'existing',hooks:{after({table,op,rows,fill}){if(table==='pending_orders'&&op==='insert')fill(rows[0]);}}});
 const r=await f.c.place();assert.equal(r.ok,false);assert.equal(f.rows[0].status,'filled');assert.equal(f.rows[1].status,'cancelled');
});
test('a newly filled OCO leg is never rewritten as cancelled by failed verification',async()=>{
 const f=fixture({hooks:{before({op,filters}){if(op==='read'&&filters.some(([k,key,value])=>key==='status'&&value==='filled'))return 'synthetic read failure';},after({table,op,rows,fill}){if(table==='pending_orders'&&op==='insert')fill(rows[1]);}}});
 const r=await f.c.place();assert.equal(r.ok,false);assert.match(r.error,/confirm|check/i);assert.equal(f.rows[1].status,'filled');
});
test('a pending snapshot taken before linking uses the claimed current group to cancel siblings',async()=>{
 const f=fixture();let linked=false;f.hooks.quote=async()=>{if(!linked){linked=true;assert.equal((await f.c.place()).ok,true);}};
 const result=await f.c.processPendingOrders(f.db,f.c.acct,[],1000);assert.equal(result.length,1);assert.equal(f.rows[0].status,'filled');assert.equal(f.rows[1].status,'cancelled');
});
test('foreign-account, different-market and no-longer-pending link requests cannot create children',async()=>{
 for(const patch of[{account_id:'foreign'},{symbol:'USDJPY'},{status:'filled'},{status:'cancelled'}]){
  const f=fixture();Object.assign(f.rows[0],patch);assert.equal((await f.c.place()).ok,false);assert.equal(f.rows.length,1);
 }
});
test('standalone pending orders retain their existing ungrouped creation path',async()=>{
 const f=fixture();f.c.body={};assert.equal((await f.c.place()).ok,true);assert.equal(f.rows[1].oco_group,null);assert.equal(f.rows[1].status,'pending');
});
test('a claimed leg without a completed trade does not prematurely consume its new sibling',async()=>{
 const f=fixture({hooks:{after({table,op,rows}){if(table==='pending_orders'&&op==='insert')rows[0].status='filled';}}});
 assert.equal((await f.c.place()).ok,true);assert.equal(f.rows[1].status,'pending');
});
test('database failures cannot expose a new ungrouped OCO leg',async()=>{
 for(const point of ['read','link','insert']){
  const f=fixture({hooks:{before({op,patch}){if(point==='read'&&op==='read'||point==='link'&&op==='update'&&patch.oco_group||point==='insert'&&op==='insert')return 'synthetic database error';}}});
  assert.equal((await f.c.place()).ok,false);assert.equal(f.rows.length,1);assert.equal(f.rows[0].status,'pending');
 }
});

// Check the same production functions against real PostgreSQL statements and
// the repository's actual partial unique index. One small isolated database,
// sequential scenarios; no network, production data or financial mutations.
test('real SQL enforces OCO linking, claim snapshots and completed-winner cleanup',{skip:!process.env.DEMO_TEST_DEPS},async()=>{
 const {PGlite}=await import(pathToFileURL(process.env.DEMO_TEST_DEPS+'/node_modules/@electric-sql/pglite/dist/index.js').href),sql=new PGlite();
 try{
  await sql.exec(`create table pending_orders(id text primary key default 'new-leg',account_id text,user_id text,symbol text,side text,order_type text,volume numeric,trigger_price numeric,sl numeric,tp numeric,expires_at timestamptz,oco_group text,status text default 'pending',fill_price numeric,filled_trade_id text,reject_reason text,resolved_at timestamptz,created_at timestamptz default now());
   create table trades(id text primary key default 'filled-trade',account_id text,user_id text,symbol text,side text,volume numeric,open_price numeric,sl numeric,tp numeric,status text default 'open');`);
  const migration=fs.readFileSync(new URL('../supabase/migrations/20260930130000_trailing_oco_alerts.sql',import.meta.url),'utf8');
  await sql.exec(migration.match(/create unique index if not exists pending_orders_one_fill_per_oco[\s\S]*?;/)[0].replace('public.pending_orders','pending_orders'));
  const reset=()=>sql.exec(`truncate trades,pending_orders;insert into pending_orders(id,account_id,user_id,symbol,side,order_type,volume,trigger_price)values('original','demo','owner','EURUSD','buy','stop',.01,1.1);`);
  const execute=async({table,op,patch,filters,columns,one,limit})=>{
   assert.ok(['pending_orders','trades'].includes(table));const values=[];
   const ident=s=>{assert.match(s,/^[a-z_]+$/);return '"'+s+'"';},param=v=>{values.push(v);return '$'+values.length;};
   const where=()=>filters.length?' where '+filters.map(([kind,key,v])=>ident(key)+(kind==='is'?' is null':kind==='not'?' is not null':(kind==='eq'?' = ':' <> ')+param(v))).join(' and '):'';
   const selected=columns==='*'?'*':columns.split(',').map(ident).join(',');let query;
   if(op==='insert')query='insert into '+ident(table)+'('+Object.keys(patch).map(ident).join(',')+')values('+Object.values(patch).map(param).join(',')+') returning '+selected;
   else if(op==='update')query='update '+ident(table)+' set '+Object.entries(patch).map(([k,v])=>ident(k)+'='+param(v)).join(',')+where()+' returning '+selected;
   else query='select '+selected+' from '+ident(table)+where()+(limit==null?'':' limit '+Number(limit));
   try{const result=await sql.query(query,values);return{data:one?result.rows[0]??null:result.rows,error:null};}catch(error){return{data:null,error:{code:error.code,message:error.message}};}
  };
  await reset();
  const race=fixture({execute,hooks:{async after({table,op}){if(table==='pending_orders'&&op==='insert'){
   for(const id of ['original','new-leg'])try{await sql.query("update pending_orders set status='filled',filled_trade_id=$1 where id=$2 and status='pending'",['trade-'+id,id]);}catch(error){assert.equal(error.code,'23505');}
  }}}});
  await race.c.place();assert.equal((await sql.query("select id from pending_orders where status='filled'")).rows.length,1);
  assert.equal((await sql.query("select id from pending_orders where filled_trade_id is not null and status<>'filled'")).rows.length,0);
  await reset();const snapshot=fixture({execute});let linked=false;snapshot.hooks.quote=async()=>{if(!linked){linked=true;assert.equal((await snapshot.c.place()).ok,true);}};
  const open=await snapshot.c.processPendingOrders(snapshot.db,snapshot.c.acct,[],1000);assert.equal(open.length,1);
  assert.equal((await sql.query("select status from pending_orders where id='new-leg'")).rows[0].status,'cancelled');
  assert.equal((await sql.query('select id from trades')).rows.length,1);
 }finally{await sql.close();}
});
