// Owner API helpers. Connecting/preparing never starts a broker order.
export async function copyTestControl(db:any,body:Record<string,unknown>,actor:string,developerConfigured:boolean){
 const action=String(body.action);
 if(action==='copy_test_find'){
  const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
  if(email.length>254||!email.includes('@'))return {status:400,body:{ok:false,error:'Enter the exact registered IPFX email.'}};
  const r=await db.rpc('copy_test_find_user',{p_email:email});
  return r.error?{status:503,body:{ok:false,error:'Registered trader lookup unavailable.'}}:!r.data?.person_id?{status:404,body:{ok:false,error:'No registered IPFX trader matches that email.'}}:{status:200,body:{ok:true,...r.data}};
 }
 if(action==='copy_test_status'){
  const [sessions,connections]=await Promise.all([db.rpc('copy_test_summary',{p_actor:actor}),db.from('ladder_accounts').select('id,label,role,status,api_env,execution_enabled,copy_test_only').eq('role','ladder')]);
  return sessions.error||connections.error?{status:503,body:{ok:false,error:'Test status unavailable.'}}:{status:200,body:{ok:true,sessions:sessions.data??[],connections:connections.data??[],developer_configured:developerConfigured}};
 }
 let r;
 if(action==='copy_test_prepare'){
  const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
  const risk=Number(body.risk_usd),destination=Number(body.destination_id),reason=typeof body.reason==='string'?body.reason.trim():'';
  if(!uuid(body.person_id)||!uuid(body.source_account_id)||!Number.isSafeInteger(destination)||destination<1||!Number.isFinite(risk)||risk<=0||risk>100||reason.length<5||reason.length>500)return {status:400,body:{ok:false,error:'Choose one trader, their Demo account, a saved funded connection, a maximum planned stop risk and a reason.'}};
  r=await db.rpc('copy_test_prepare',{p_person:body.person_id,p_source:body.source_account_id,p_destination:destination,p_risk:risk,p_actor:actor,p_reason:reason});
 }else if(action==='copy_test_start'||action==='copy_test_stop'){
  const id=Number(body.id),version=Number(body.version);
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(version)||version<1||(action==='copy_test_start'&&body.confirm_funded_execution!==true))return {status:400,body:{ok:false,error:'Review the current test and explicitly confirm owner activation.'}};
  r=await db.rpc('copy_test_control',{p_id:id,p_action:action==='copy_test_start'?'start':'stop',p_version:version,p_actor:actor,p_developer:developerConfigured});
 }else return null;
 if(r.error){const msg=String(r.error.message??'');const known:Record<string,string>={MONITOR_AND_ALIASES_ARE_READ_ONLY:'The E8 monitor and duplicate connections are read-only. Choose a separate execution account.',FUNDED_CONNECTION_MUST_BE_SAVED_OFF:'Choose a funded execution connection saved with copying off.',SELECT_OWN_ACTIVE_INFINITY_ACCOUNT:'Choose this trader’s active Infinity challenge account.',TRADER_ON_HOLD:'This trader has an unresolved hold or suspension.',TEST_OR_CONNECTION_NOT_READY:'The current test or connection is not ready. Refresh and review it.',ACCOUNT_USED_BY_OTHER_COPIER:'This account is already used by another copier.',DOCUMENTED_CAPACITY_AND_DEVELOPER_ACCESS_REQUIRED:'Documented position/margin capacity and developer API access are required before activation.',BOOK_HALTED:'New book risk is halted.',TEST_ALREADY_FINISHED:'This test has already finished.',ENTER_BOUNDED_MAXIMUM_TRADE_RISK:'Enter a valid maximum planned stop risk.'};return {status:409,body:{ok:false,error:Object.entries(known).find(([code])=>msg.includes(code))?.[1]??'The test could not be saved. Refresh and check its current state.'}};}
 return {status:r.data?.ok?200:409,body:r.data??{ok:false,error:'Test result unavailable.'}};
}
