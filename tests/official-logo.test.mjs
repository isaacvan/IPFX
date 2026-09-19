import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pages=fs.readdirSync(root).filter((name)=>name.endsWith('.html')||name.endsWith('.webmanifest'));

test('all website pages use the approved official IPFX icon asset',()=>{
  const obsolete=/assets\/images\/(?:logo\.svg|favicon(?:-16x16|-32x32)?\.(?:ico|png))|\/favicon\/(?:favicon|android-chrome|apple-touch)/i;
  const offenders=[];
  for(const name of pages){
    const source=fs.readFileSync(path.join(root,name),'utf8');
    if(obsolete.test(source))offenders.push(name);
  }
  assert.deepEqual(offenders,[]);
  assert.ok(fs.existsSync(path.join(root,'desktop/build/icon.png')),'approved official icon is missing');
});

