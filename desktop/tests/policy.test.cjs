const test=require('node:test');
const assert=require('node:assert/strict');
const {trustedNavigation,exportAllowed,windowBounds}=require('../policy.cjs');
test('only exact HTTPS IPFX origin is trusted',()=>{
  assert.ok(trustedNavigation('https://ipfxcapital.com/trading.html?symbol=EURUSD'));
  for(const url of ['http://ipfxcapital.com','https://ipfxcapital.com.evil.test','https://evil.test@ipfxcapital.com',
    'javascript:alert(1)','file:///C:/secret','data:text/html,x','https://ipfxcapital.com:444/trading.html','https://evil.test'])
    assert.equal(trustedNavigation(url),false,url);
});
test('OAuth callback fragments remain on their trusted origin',()=>assert.ok(trustedNavigation('https://ipfxcapital.com/login.html#access_token=test')));
test('export permits reports but never executable or path-traversal names',()=>{
  assert.ok(exportAllowed('blob:https://ipfxcapital.com/uuid','positions.csv'));
  for(const name of ['trade.exe','../positions.csv','a/b.pdf','file.csv:exe','bad.csv\u0000.exe'])
    assert.equal(exportAllowed('https://ipfxcapital.com/export',name),false);
  assert.equal(exportAllowed('https://evil.test/export','positions.csv'),false);
});
test('window is recovered after disconnecting a display',()=>{
  const b=windowBounds({x:9999,y:-9999,width:9000,height:5000},{x:0,y:0,width:1366,height:768});
  assert.deepEqual(b,{x:0,y:0,width:1366,height:768});
});
test('corrupt and tiny-screen dimensions stay visible',()=>{
  const b=windowBounds({x:NaN,width:'bad',height:-5},{x:-600,y:0,width:600,height:500});
  assert.equal(b.width,600);assert.equal(b.height,500);assert.equal(b.x,-600);
});
