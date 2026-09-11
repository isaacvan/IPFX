const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright');
const fixtureBody='<!doctype html><title>Desktop test fixture</title><h1>Desktop isolation fixture</h1><a id="external" href="https://example.invalid">External</a>';
let fixtureRequests=0;
const fixture=http.createServer((_req,res)=>{
  fixtureRequests++;
  res.writeHead(200,{'Content-Type':'text/html','Content-Length':Buffer.byteLength(fixtureBody),'Connection':'close'});
  res.end(fixtureBody);
});
let application;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ipfx-desktop-test-'));
fs.writeFileSync(path.join(profile,'window.json'),'null');
(async()=>{
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+fixture.address().port+'/trading.html';
  async function launch(){
    application=await _electron.launch({executablePath:require('electron'),args:[path.resolve(__dirname,'../main.cjs')],
      env:{...process.env,NODE_ENV:'test',IPFX_DESKTOP_TEST_URL:url,IPFX_DESKTOP_TEST_PROFILE:profile},timeout:30000});
    const page=await application.firstWindow();
    try {await page.waitForSelector('#external',{state:'attached'});}
    catch(error){throw new Error(`Fixture unavailable: url=${page.url()} requests=${fixtureRequests}; ${error.message}`);}
    assert.equal(page.url(),url);
    return page;
  }
  async function shutdown(){
    await application.evaluate(({app})=>app.exit(0)).catch(()=>{});
    application=null;
  }
  let page=await launch();
  assert.deepEqual(await page.evaluate(()=>({node:typeof require,process:typeof process,bridge:typeof window.electron})),
    {node:'undefined',process:'undefined',bridge:'undefined'});
  const prefs=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  assert.equal(await application.evaluate(({BrowserWindow,session})=>
    BrowserWindow.getAllWindows()[0].webContents.session===session.fromPartition('persist:ipfx-markets')),true);
  await page.evaluate(()=>document.querySelector('#external').click());
  assert.equal(page.url(),url);
  await page.evaluate(()=>window.open('https://example.invalid'));
  assert.equal(application.windows().length,1);
  assert.equal(await page.evaluate(async()=> (await navigator.permissions.query({name:'geolocation'})).state),'denied');
  await application.evaluate(({dialog})=>{
    globalThis.desktopTestPrompts=[];
    dialog.showMessageBox=async(_window,options)=>{
      globalThis.desktopTestPrompts.push(options.message);
      return {response:0,checkboxChecked:false};
    };
  });
  await application.evaluate(({BrowserWindow})=>{
    const contents=BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({type:'keyDown',keyCode:'R',modifiers:[process.platform==='darwin'?'meta':'control']});
    contents.sendInputEvent({type:'keyUp',keyCode:'R',modifiers:[process.platform==='darwin'?'meta':'control']});
  });
  await application.evaluate(()=>new Promise((resolve,reject)=>{
    const started=Date.now();const poll=()=>globalThis.desktopTestPrompts.length>=1?resolve():Date.now()-started>2000?reject(new Error('Reload prompt not shown')):setTimeout(poll,20);poll();
  }));
  assert.equal(await application.evaluate(()=>globalThis.desktopTestPrompts.length),1);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
  await application.evaluate(()=>new Promise((resolve,reject)=>{
    const started=Date.now();const poll=()=>globalThis.desktopTestPrompts.length>=2?resolve():Date.now()-started>2000?reject(new Error('Close prompt not shown')):setTimeout(poll,20);poll();
  }));
  assert.equal(application.windows().length,1);
  assert.equal(await application.evaluate(()=>globalThis.desktopTestPrompts.length),2);
  await page.evaluate(()=>localStorage.setItem('desktop-smoke','saved'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('desktop-smoke')),'saved');
  await application.evaluate(({session})=>session.fromPartition('persist:ipfx-markets').flushStorageData());
  await page.waitForTimeout(250);
  await new Promise(resolve=>{fixture.close(resolve);fixture.closeAllConnections();});
  await application.evaluate(({BrowserWindow},entry)=>BrowserWindow.getAllWindows()[0].loadURL(entry).catch(()=>{}),url);
  await page.waitForURL('**/offline.html');
  assert.match(await page.locator('h1').innerText(),/IPFX Markets/);
  await shutdown();
  console.log('PASS: actual Electron runtime, sandbox/context isolation, no Node bridge, external navigation/popup blocking, permissions denied, reload/close confirmations, corrupt settings recovery, persistent profile storage, offline fallback');
})().catch(async e=>{
  console.error(e);
  if(application) {
    await application.evaluate(({BrowserWindow,app})=>{BrowserWindow.getAllWindows()[0]?.destroy();app.exit(1);}).catch(()=>{});
    if(application.process().exitCode===null) application.process().kill();
  }
  fixture.close();process.exitCode=1;
});
