// The preview fixture is generated from the same version row used by migrations.
// Live screens read the saved row through the engine; this file is preview-only.
import fs from 'node:fs';
const migration=new URL('../supabase/migrations/20261029090000_infinity_v2_versions.sql',import.meta.url);
const match=fs.readFileSync(migration,'utf8').match(/\('infinity_v2','(\{[^\n]+\})'\)/);
if(!match)throw Error('Infinity v2 version row not found');
const rules=JSON.parse(match[1]);
fs.writeFileSync(new URL('../assets/js/infinity-v2-preview.json',import.meta.url),JSON.stringify(rules,null,2));
