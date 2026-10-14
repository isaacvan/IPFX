// Called only after the existing owner identity + MFA checks. No broker order or credential access here.
export async function ongoingCopyControl(db:any,body:Record<string,unknown>,actor:string,developer:boolean){
 const action=String(body.action),id=Number(body.id),reason=typeof body.reason==='string'?body.reason.trim():'';
 const validId=(v:number)=>Number.isSafeInteger(v)&&v>0;
 if(action==='ongoing_copy_status'){
  const [summary,accounts,capacity]=await Promise.all([db.rpc('ongoing_copy_summary',{p_actor:actor}),db.from('ladder_accounts').select('id,label,role,status,api_env,execution_enabled').in('role',['monitor','ladder']),db.from('book_capacity_limits').select('book,position_limit,margin_per_lot_usd,provider_evidence,updated_at')]);
  return summary.error||accounts.error||capacity.error?{status:503,body:{ok:false,error:'Execution status unavailable. Do not assume an earlier ON/OFF display is current.'}}:{status:200,body:{ok:true,...summary.data,accounts:accounts.data??[],capacity:(capacity.data??[]).filter((l:any)=>(summary.data?.connections??[]).some((c:any)=>l.book==='l'+c.account_id)),developer_configured:developer}};
 }
 if(action==='ongoing_copy_find'){
  const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
  if(email.length>254||!email.includes('@'))return {status:400,body:{ok:false,error:'Enter the exact registered IPFX email.'}};
  const r=await db.rpc('copy_test_find_user',{p_email:email});
  return r.error?{status:503,body:{ok:false,error:'Trader lookup unavailable.'}}:!r.data?.person_id?{status:404,body:{ok:false,error:'No registered trader matches that email.'}}:{status:200,body:{ok:true,...r.data}};
 }
 let r;
 if(action==='ongoing_copy_connect'){
  const lots=Number(body.lots),risk=Number(body.risk_usd);
  if(!validId(id)||!Number.isFinite(lots)||lots<=0||lots>1||!Number.isFinite(risk)||risk<=0||risk>100||body.confirm_owned_and_permitted!==true||reason.length<5||reason.length>500)return {status:400,body:{ok:false,error:'Choose your saved account, copy lots, planned risk ceiling and confirm ownership/provider permission.'}};
  r=await db.rpc('ongoing_copy_connect',{p_account:id,p_lots:lots,p_risk:risk,p_actor:actor,p_confirm:true,p_reason:reason});
 }else if(action==='ongoing_copy_start_trader'){
  const version=Number(body.version);
  if(!validId(id)||!validId(version)||typeof body.person_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.person_id)||body.confirm_funded_execution!==true||reason.length<5||reason.length>300)return {status:400,body:{ok:false,error:'Review the trader, destination and sizing, then explicitly start A-book live.'}};
  r=await db.rpc('ongoing_copy_start_trader',{p_connection:id,p_person:body.person_id,p_version:version,p_actor:actor,p_reason:reason,p_developer:developer,p_confirm:true});
 }else if(action==='ongoing_copy_select'){
  if(!validId(id)||typeof body.person_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.person_id)||typeof body.enabled!=='boolean'||reason.length<5||reason.length>300)return {status:400,body:{ok:false,error:'Choose a registered trader and give a reason.'}};
  r=await db.rpc('ongoing_copy_select',{p_connection:id,p_person:body.person_id,p_enabled:body.enabled,p_actor:actor,p_reason:reason,p_confirm:body.confirm_funded_execution===true,p_version:validId(Number(body.version))?Number(body.version):null});
 }else if(action==='ongoing_copy_on'||action==='ongoing_copy_off'||action==='ongoing_copy_disconnect'){
  const version=Number(body.version),on=action==='ongoing_copy_on';
  if(!validId(id)||!validId(version)||(on&&body.confirm_funded_execution!==true))return {status:400,body:{ok:false,error:'Review the current account and explicitly confirm Execution ON.'}};
  r=await db.rpc('ongoing_copy_control',{p_id:id,p_action:action.slice('ongoing_copy_'.length),p_version:version,p_actor:actor,p_developer:developer,p_confirm:body.confirm_funded_execution===true});
 }else return null;
 if(r.error){const message=String(r.error.message??'');const errors:Record<string,string>={STALE_CONNECTION_VERSION:'The setup changed. Refresh, review the trader and start again.',OWNER_PERMISSION_REQUIRED:'Confirm this is your funded account and copying is permitted.',SAVED_ACCOUNT_NOT_READY:'The saved broker connection is unavailable or already enabled elsewhere.',TURN_EXECUTION_OFF_FIRST:'Turn execution OFF before changing connection sizing.',RECONCILE_PENDING_ORDERS_FIRST:'Resolve pending broker receipts before reconnecting.',EXISTING_TEST_MUST_FINISH:'Stop and reconcile any previous test first.',ACTIVE_INFINITY_REQUIRED:'This trader needs an active Infinity challenge.',TRADER_ON_HOLD:'This trader has an unresolved investigation or suspension.',TRADER_ALREADY_ROUTED:'This trader still has a different connection or outstanding copied positions.',CONFIRM_FUNDED_EXECUTION:'Explicitly confirm adding this trader while execution is ON.',DOCUMENTED_CAPACITY_REQUIRED:'Configure verified position and margin capacity before switching ON.',MULTI_ACCOUNT_DEVELOPER_ACCESS_UNCONFIGURED:'JWT-only copying supports one active execution account. Multi-account execution needs developer access.',BOOK_HALTED:'New execution is halted.',REVIEW_CONNECTION_AND_PERMISSION:'Review this exact account and permission before switching ON.',MODEL_ASSIGNMENT_REFUSED:'A selected trader cannot move to A-book live. Review their Brain controls and holds.'};return {status:409,body:{ok:false,error:Object.entries(errors).find(([key])=>message.includes(key))?.[1]??'Execution change unconfirmed. Refresh and review it.'}};}
 return {status:r.data?.ok?200:409,body:r.data??{ok:false,error:'Execution result unavailable.'}};
}
