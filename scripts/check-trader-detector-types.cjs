// Type-check Edge source using the exact installed supabase-js declarations.
// Deno runtime builtins are declared locally; no remote imports or execution.
const ts=require('../internal-control/dashboard/node_modules/typescript');
const path=require('node:path');
const fs=require('node:fs');
const root=path.resolve(__dirname,'..');
const shim=path.join(root,'__detector_deno_typecheck__.d.ts');
const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
  strict:true,noEmit:true,allowImportingTsExtensions:true,skipLibCheck:true,lib:['lib.es2022.d.ts','lib.dom.d.ts'],types:[]};
const host=ts.createCompilerHost(options);
const originalGet=host.getSourceFile.bind(host);
host.getSourceFile=(file,language,...rest)=>path.resolve(file)===shim?ts.createSourceFile(file,
  'declare const Deno: { env: { get(key:string): string|undefined }; serve(handler:(request:Request)=>Response|Promise<Response>):void };',language):originalGet(file,language,...rest);
host.resolveModuleNames=(names,containing)=>names.map(name=>{
  if(name.startsWith('https://esm.sh/@supabase/supabase-js@')) return {resolvedFileName:path.join(root,'internal-control/dashboard/node_modules/@supabase/supabase-js/dist/index.d.mts'),extension:ts.Extension.Dmts};
  return ts.resolveModuleName(name,containing,options,host).resolvedModule;
});
const program=ts.createProgram([path.join(root,'supabase/functions/trader-detector/index.ts'),shim],options,host);
const diagnostics=ts.getPreEmitDiagnostics(program);
for(const d of diagnostics) console.error(ts.formatDiagnostic(d,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
console.log(`Edge worker typecheck: ${diagnostics.length} errors`);
process.exitCode=diagnostics.length?1:0;
