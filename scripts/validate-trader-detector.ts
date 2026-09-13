// Usage: node --experimental-strip-types scripts/validate-trader-detector.ts INPUT.json OUTPUT.json
// INPUT = {manifest: ValidationManifest, records: HoldoutPrediction[]}.
// Reads only the explicit supplied export. Never contacts production or promotes policies.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateHoldout } from '../internal-control/lib/detector-validation.ts';
const [input,output]=process.argv.slice(2);
if(!input||!output) throw new Error('Usage: validate-trader-detector.ts INPUT.json OUTPUT.json');
if(resolve(input)===resolve(output)) throw new Error('Output must differ from input');
const supplied=JSON.parse(await readFile(resolve(input),'utf8'));
const report=evaluateHoldout(supplied.manifest,supplied.records);
await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(`${report.status}; ${report.cohort.scored} scored traders; ${report.blockers.length} blockers. Report: ${resolve(output)}`);
if(report.blockers.length) process.exitCode=2;
