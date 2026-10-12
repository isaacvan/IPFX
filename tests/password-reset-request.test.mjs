import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../login.html',import.meta.url),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes('// Password reset:'));
for(const mode of ['success','error','network']) test('password reset '+mode,async()=>{
 let click,calls=[];
 const link={style:{},addEventListener(_e,fn){click=fn}};
 const msg={style:{},textContent:''};
 const fields={forgotLink:link,forgotMsg:msg,email:{value:'fixture@example.invalid',focus(){}}};
 vm.runInNewContext(source,{document:{getElementById:id=>fields[id]},location:{origin:'https://ipfxcapital.com'},supabaseClient:{auth:{async resetPasswordForEmail(...args){calls.push(args);if(mode==='network')throw Error('offline');return {error:mode==='error'?{message:'provider unavailable'}:null}}}}});
 await click({preventDefault(){}});
 assert.equal(calls[0][1].redirectTo,'https://ipfxcapital.com/reset-password.html');
 assert.equal(link.style.pointerEvents,'');
 assert.match(msg.textContent,mode==='success'?/If an account exists/:/Could not/);
});
