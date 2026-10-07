import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,account,user,root,slice} from './helpers/e8-db-fixture.mjs';
import {replayReference} from '../supabase/functions/_shared/e8-reference.ts';

const deps=process.env.DEMO_TEST_DEPS;
function random(seed){let x=seed;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>0;};}
const uuid=n=>'10000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const price=u=>(u/100000).toFixed(5);
const lots=u=>(u/100).toFixed(2);
function cents(value){const s=String(value),negative=s.startsWith('-'),[a,b='']=s.replace('-','').split('.');assert.match(b.slice(2),/^0*$/);return(BigInt(a)*100n+BigInt((b+'00').slice(0,2)))*(negative?-1n:1n);}

test('10,000 deterministic replays reconcile against integer arithmetic across direction, spread, costs and partial exits',()=>{
 const next=random(20261007);let exits=0;
 for(let i=0;i<10000;i++){
  const side=next()%2?'buy':'sell',book=next()%2?'a':'b',qty=10+next()%200,n=1+next()%Math.min(8,qty);
  const entry=100000+next()%30000,spread=next()%60,fees=next()%2000;
  const quote=[{accountId:1,symbol:'EURUSD',bid:Number(price(entry)),ask:Number(price(entry+spread)),startedAt:1100,receivedAt:1200}];
  let remaining=qty,same=0n,reverse=0n,spreadCost=0n;const close=[];
  for(let j=0;j<n;j++){
   const q=j===n-1?remaining:1+next()%(remaining-(n-j-1));remaining-=q;
   const bid=entry-1000+next()%2001,sp=next()%100,at=20000+j*10000;
   close.push({at,lots:Number(lots(q))});quote.push({accountId:1,symbol:'EURUSD',bid:Number(price(bid)),ask:Number(price(bid+sp)),startedAt:at+100,receivedAt:at+200});
   same+=BigInt(side==='buy'?bid-entry-spread:entry-bid-sp)*BigInt(q);
   reverse+=BigInt(side==='buy'?entry-bid-sp:bid-entry-spread)*BigInt(q);
   spreadCost+=BigInt(spread+sp)*BigInt(q);exits++;
  }
  const r=replayReference({accountId:1,symbol:'EURUSD',traderSide:side,book,lots:Number(lots(qty)),openedAt:1000,closes:close,scaleUSD:100000,feesUSD:fees/100,adverseBps:0,minDelayMs:100,maxWaitMs:15000,assumptionSource:'Synthetic integer oracle'},quote);
  assert.equal(r.available,true);assert.ok(Math.abs(r.grossUSD-Number(book==='a'?same:reverse)/100)<1e-7);
  assert.ok(Math.abs(r.netUSD-Number((book==='a'?same:reverse)-BigInt(fees))/100)<1e-7);
  assert.equal(same+reverse,-spreadCost);assert.equal(remaining,0);
 }
 assert.ok(exits>=10000);
});

test('2,000 PostgreSQL trade lifecycles survive bounded batches, retries, state changes and raw quote expiry',{skip:!deps,timeout:180000},async()=>{
 const {db}=await fixture();try{
  await db.exec('create index stress_reference_lookup on e8_reference_quotes(account_id,symbol,received_at desc);');
  const states=['BB_DEMO','AB_DEMO','BB_LIVE','AB_LIVE'],sizes=[25000,50000,100000,200000];
  for(let g=0;g<4;g++)await db.exec(`insert into trading_accounts values('${uuid(60000+g)}','ipfx','demo','demo',${sizes[g]});insert into ab_trader_profiles values('${uuid(61000+g)}','${states[g]}');`);
  const next=random(719),expected=new Map(),sql=[],base=Date.now()-2000*150000-60000;let fillEvents=0;
  const stamp=t=>new Date(t).toISOString();
  for(let i=0;i<2000;i++){
   const id=uuid(70000+i),g=i%4,side=next()%2?'buy':'sell',qty=10+next()%150,n=1+next()%8,opened=base+i*150000;
   const entry=100000+next()%30000,spread=next()%50;
   sql.push(`insert into trades(id,account_id,user_id,symbol,side,volume,status,open_price,opened_at) values('${id}','${uuid(60000+g)}','${uuid(61000+g)}','EURUSD','${side}',${lots(qty)},'open',${price(entry+spread)},'${stamp(opened)}');`);
   sql.push(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at) values(3,'EURUSD',${price(entry)},${price(entry+spread)},'${stamp(opened+900)}','${stamp(opened+1000)}');`);fillEvents++;
   let remaining=qty,same=0n,reverse=0n,spreadCost=0n;
   for(let j=0;j<n;j++){
    const q=j===n-1?remaining:1+next()%(remaining-(n-j-1));remaining-=q;
    const bid=entry-600+next()%1201,sp=next()%80,closed=opened+15000+j*13000;
    const amount=BigInt(side==='buy'?bid-entry-spread:entry-bid-sp)*BigInt(q);
    same+=amount;reverse+=BigInt(side==='buy'?entry-bid-sp:bid-entry-spread)*BigInt(q);spreadCost+=BigInt(spread+sp)*BigInt(q);
    const pnl=(Number(amount)/100).toFixed(2);
    if(j===n-1)sql.push(`update trades set status='closed',closed_at='${stamp(closed)}',close_price=${price(bid)},pnl=${pnl} where id='${id}';`);
    else{
     sql.push(`update trades set volume=${lots(remaining)},sl=1.01 where id='${id}';`);
     sql.push(`insert into trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,status,open_price,opened_at,closed_at,close_price,pnl,close_reason) values('${uuid(100000+i*12+j)}','${id}','${uuid(60000+g)}','${uuid(61000+g)}','EURUSD','${side}',${lots(q)},'closed',${price(entry+spread)},'${stamp(opened)}','${stamp(closed)}',${price(bid)},${pnl},'partial');`);
    }
    sql.push(`insert into e8_reference_quotes(account_id,symbol,bid,ask,requested_at,received_at) values(3,'EURUSD',${price(bid)},${price(bid+sp)},'${stamp(closed+900)}','${stamp(closed+1000)}');`);fillEvents++;
   }
   assert.equal(same+reverse,-spreadCost);expected.set(id,{same,reverse,qty,g});
  }
  for(let offset=0;offset<sql.length;offset+=500)await db.exec(sql.slice(offset,offset+500).join('\n'));
  await db.exec("update ab_trader_profiles set book_state=case when book_state like 'AB_%' then 'BB_DEMO' else 'AB_DEMO' end;");
  let rounds=0;
  while(true){const r=(await db.query('select e8_sim_tick() r')).rows[0].r;assert.ok(r.processed<=1000);rounds++;if(!r.waiting)break;assert.ok(rounds<30);}
  const results=(await db.query('select * from e8_sim_trade_results')).rows;
  assert.equal(results.length,2000);assert.ok(rounds>1);
  for(const r of results){const e=expected.get(r.trade_id);assert.equal(r.status,'CLOSED_GROSS_ESTIMATE');assert.equal(cents(r.same_gross_usd),e.same);assert.equal(cents(r.reverse_gross_usd),e.reverse);assert.equal(cents(r.source_pnl_usd),e.same);assert.equal(r.selected_book,e.g%2?'a':'b');assert.equal(r.net_usd,null);assert.equal(Number(r.exited_lots),e.qty/100);assert.ok(Math.abs(Number(r.selected_gross_50k_usd)-Number(e.g%2?e.same:e.reverse)/100*50000/sizes[e.g])<1e-7);}
  assert.equal(Number((await db.query('select count(*) n from e8_sim_prices')).rows[0].n),fillEvents);
  await db.query('select e8_sim_tick()');assert.equal(Number((await db.query('select count(*) n from e8_sim_prices')).rows[0].n),fillEvents);
  await db.exec('delete from e8_reference_quotes');assert.equal((await db.query('select count(*) n from e8_sim_trade_results where status=\'CLOSED_GROSS_ESTIMATE\'')).rows[0].n,2000);
 }finally{await db.close();}
});

test('an oversized partial exit is explicitly inconsistent even before final close',{skip:!deps},async()=>{
 const {db,open,quote,result}=await fixture();try{
  await open();await db.exec(`insert into trades(id,parent_trade_id,account_id,user_id,symbol,side,volume,status,open_price,opened_at,closed_at,pnl,close_reason) values('${slice}','${root}','${account}','${user}','EURUSD','buy',.03,'closed',1.1,now()-interval '120 seconds',now()-interval '40 seconds',3,'partial');`);
  await quote(119,1.1,1.1002);await quote(39,1.101,1.1012);await db.query('select e8_sim_tick()');
  const r=await result();assert.equal(r.status,'QUANTITY_MISMATCH');assert.equal(r.reverse_gross_usd,null);
 }finally{await db.close();}
});

test('sub-second exits, missing monitors and old source rows never invent completed results',{skip:!deps},async()=>{
 const {db,open,quote,result}=await fixture();try{
  await open();await db.exec(`update trades set status='closed',closed_at=now()-interval '119.8 seconds',pnl=1 where id='${root}';`);
  await quote(119,1.1,1.1002);await db.query('select e8_sim_tick()');assert.equal((await result()).status,'ENTRY_OBSERVATION_AFTER_EXIT');assert.equal((await result()).reverse_gross_usd,null);
 }finally{await db.close();}
 const f=await fixture();try{await f.db.exec('update e8_monitor_profiles set enabled=false');await f.open();await f.db.query('select e8_sim_tick()');assert.equal((await f.result()).status,'NO_ENABLED_REFERENCE_FOR_SYMBOL');}finally{await f.db.close();}
 const h=await fixture();try{await h.db.exec(`insert into trades(id,account_id,user_id,symbol,side,volume,status,open_price,opened_at,closed_at,pnl) values('${root}','${account}','${user}','EURUSD','buy',.02,'closed',1.1,now()-interval '2 days',now()-interval '1 day',10);`);assert.equal((await h.db.query('select count(*) n from e8_sim_positions')).rows[0].n,0);}finally{await h.db.close();}
});
