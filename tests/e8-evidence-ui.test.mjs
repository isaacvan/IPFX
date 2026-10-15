import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
test('evidence form imports reviewed exact IDs, reports unknown prices, escapes values and fits desktop/mobile',{skip:!process.env.E8_BROWSER_TEST,timeout:60000},async()=>{
 const require=createRequire(import.meta.url),{chromium}=require(process.env.E8_PLAYWRIGHT);
 const browser=await chromium.launch({headless:true,executablePath:process.env.E8_CHROME,args:['--disable-background-networking']});
 try{const context=await browser.newContext(),page=await context.newPage(),calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main style="max-width:960px;padding:20px;margin:auto;box-sizing:border-box"><section id="evidence" style="padding:20px"></section></main></body></html>');
  await page.addStyleTag({content:fs.readFileSync(new URL('../assets/css/team-os.css',import.meta.url),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(new URL('../assets/js/e8-evidence.js',import.meta.url),'utf8')});
  await page.exposeFunction('fixtureCall',(action,body)=>{calls.push({action,body});return action==='evidence_overview'?{ok:true,evidence:{accounts:[{id:3,label:'Synthetic E8 <img src=x>',account_id:'123'}],coverage:{events:5,requested:5,observed:4},receipts:[],event_quotes:[],dispatches:[{source_trade_id:'synthetic-trade',event:'close',side:'sell',sent_at:new Date().toISOString(),ack_ms:123,receipt_lookup_ms:400,fill_confirmed:true,fill_price:4100,provider_age_ms:null,received_age_ms:null,quote_shortfall:null}],snapshots:[]}}:action==='import_receipt'?{ok:true}: {ok:true,result:{available:false,reason:'ENTRY_PRE_EVENT_QUOTE_MISSING'}};});
  await page.evaluate(()=>window.IPFXE8Evidence.init((action,body)=>window.fixtureCall(action,body),document.querySelector('#evidence')));
  await page.getByText('Evidence updated. Broker execution unchanged.').waitFor();assert.equal(await page.locator('img').count(),0);
  await page.getByText('Import a Closed Positions receipt',{exact:true}).click();const form=page.locator('[data-receipt]');
  await form.locator('[name=account_id]').selectOption('3');
  for(const [name,value]of Object.entries({positionId:'360287970193809597',openingOrderId:'360287970213574522',closingOrderIds:'360287970213574691',quantity:'0.01',gross:'-0.49',net:'-0.55',fee:'-0.06',swap:'0',evidenceNote:'Synthetic Closed Positions row reviewed'}))await form.locator(`[name=${name}]`).fill(value);
  await form.locator('[name=feeIncludesCommission]').selectOption('true');await form.locator('[name=reviewed]').check();
  await form.getByRole('button',{name:'Match and save reviewed receipt'}).click();await page.getByText('Reviewed receipt saved; source trading results and execution are unchanged.').waitFor();
  const saved=calls.find(c=>c.action==='import_receipt').body;assert.equal(saved.receipt.positionId,'360287970193809597');assert.equal(saved.receipt.swap,0);assert.equal(saved.receipt.commission,null);assert.equal(saved.confirm_reviewed,true);
  await page.getByText('Import a Closed Positions receipt',{exact:true}).click();await page.getByText('Dispatch timing and quote comparisons · 1',{exact:true}).click();assert.match(await page.locator('#evidence').innerText(),/provider quote age: Unknown/);
  for(const width of[1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);if(process.env.E8_EVIDENCE_SCREENSHOT)await page.screenshot({path:process.env.E8_EVIDENCE_SCREENSHOT.replace('.png','-'+width+'.png'),fullPage:true});}
  assert.deepEqual(errors,[]);assert.deepEqual(calls.map(c=>c.action),['evidence_overview','import_receipt']);
 }finally{await browser.close();}
});
