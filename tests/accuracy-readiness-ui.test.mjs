import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const window={};vm.runInNewContext(fs.readFileSync(new URL('../assets/js/e8-accuracy-readiness.js',import.meta.url),'utf8'),{window});
test('readiness panel distinguishes missing proof, historical coverage and the accepted net target',()=>{
 const h=window.IPFXE8Accuracy.render({window_days:30,source_closed_roots:100,captured_roots:90,legacy_complete_gross:70,currency_supplement_gross:3,missing_archive:10,late_entry:7,missing_quotes:5,unsupported_symbol:4,fx_unavailable:1,paired_broker_net:0});
 assert.match(h,/95%.*not verified/);assert.match(h,/within 5%.*\$0\.01/);assert.match(h,/100 closed Infinity/);assert.match(h,/Missing and failed copies count/);
 assert.match(h,/broker-net outcomes: 0/);assert.match(h,/Measured net accuracy: unavailable/);assert.match(h,/Existing live policy stays unchanged/);
 assert.match(window.IPFXE8Accuracy.render(null),/unavailable/);
});
test('coverage fields cannot inject markup into owner panel',()=>{const h=window.IPFXE8Accuracy.render({window_days:'<img src=x onerror=alert(1)>'});assert.ok(!h.includes('<img'));assert.match(h,/&lt;img/);});
