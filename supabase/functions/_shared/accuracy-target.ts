// Prospective validation accounting, not a live classifier or execution permission.
export type AccuracyTrial={intentId:string;blockId:string;modelVersion:string;frozenBeforeTrial:boolean;heldOut:boolean;
 estimateUsesActualFills:boolean;estimateNet:number|null;brokerNet:number|null;currency:string;
 exactBinding:boolean;completeCosts:boolean;completeQuantity:boolean;statementAuthenticated:boolean;closed:boolean};
export function accuracyTarget(trials:AccuracyTrial[],modelVersion:string){
 const ids=new Set<string>(),blocks=new Map<string,boolean>();let eligible=0,passed=0,missing=0,invalid=0,maxError=0;
 for(const t of trials){
  if(!t.intentId||ids.has(t.intentId)){invalid++;continue;}ids.add(t.intentId);
  const valid=!!t.blockId&&t.modelVersion===modelVersion&&t.frozenBeforeTrial===true&&t.heldOut===true&&t.estimateUsesActualFills===false&&t.currency==='USD';
  const complete=valid&&t.closed===true&&t.exactBinding===true&&t.completeCosts===true&&t.completeQuantity===true&&t.statementAuthenticated===true&&
    t.estimateNet!=null&&t.brokerNet!=null&&Number.isFinite(t.estimateNet)&&Number.isFinite(t.brokerNet);
  let ok=false;if(complete){eligible++;const error=Math.abs(t.estimateNet!-t.brokerNet!),tol=Math.max(.01,.05*Math.abs(t.brokerNet!));maxError=Math.max(maxError,error);ok=error<=tol+1e-10;if(ok)passed++;}
  else missing++;
  if(t.blockId)blocks.set(t.blockId,(blocks.get(t.blockId)??true)&&ok);
 }
 const intended=trials.length,passRate=intended?passed/intended:null,completeRate=intended?eligible/intended:null;
 const n=blocks.size,k=[...blocks.values()].filter(Boolean).length,z=1.96;
 const lower=n?((k/n+z*z/(2*n))-z*Math.sqrt((k/n)*(1-k/n)/n+z*z/(4*n*n)))/(1+z*z/n):null;
 // Fixed held-out plan required; this descriptive Wilson bound assumes independent blocks.
 // A data producer must establish independence, not infer it merely from distinct labels.
 return {target:.95,intended,complete:eligible,passed,missing,invalid,passRate,completeRate,maxAbsoluteError:eligible?maxError:null,
  independentBlockCount:n,passingBlocks:k,descriptiveBlockLower95:lower,
  status:invalid?'CONFLICTING_EVIDENCE':eligible===0?'NET_UNVERIFIED':passRate!<.95?'BELOW_TARGET':'OBSERVED_TARGET_ONLY',
  certified95:false,canEnableLive:false,
  certificationGap:'Needs prospective broker evidence, fixed held-out plan and validated independent blocks; observed pass rate is not certified future accuracy'};
}
