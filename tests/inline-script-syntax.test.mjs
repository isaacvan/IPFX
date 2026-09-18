import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const file of ['dashboard.html','start-challenge.html','admin.html','login.html','signup.html','trading.html']) {
  test(`${file} inline scripts parse`, () => {
    const html=fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
    const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(m=>!/(?:^|\s)src\s*=|application\/ld\+json|type\s*=\s*["']module/i.test(m[1]));
    assert.ok(scripts.length>0);
    scripts.forEach((m,index)=>new vm.Script(m[2],{filename:`${file}:inline-${index+1}`}));
  });
}
