// Post-dispatch evidence only. This function cannot submit, repeat or finalise an order.
// deno-lint-ignore no-explicit-any
export function saveDispatchEvidence(db:any,input:{operationId:number;sentAt:string;ackAt:string|null;ackMs:number|null;receiptLookupMs:number|null;fillPrice:number|null;fillQty:number|null;fillConfirmed:boolean;instrumentId?:string|null}){
 const work=async()=>{try{
  const {error}=await db.rpc('e8_record_dispatch',{p_operation:input.operationId,p_sent:input.sentAt,p_ack:input.ackAt,
   p_ack_ms:input.ackMs,p_receipt_ms:input.receiptLookupMs,p_fill_price:input.fillPrice,p_fill_qty:input.fillQty,p_confirmed:input.fillConfirmed,p_instrument:input.instrumentId??null});
  if(error)console.warn('E8_DISPATCH_EVIDENCE_NOT_SAVED');
 }catch{console.warn('E8_DISPATCH_EVIDENCE_NOT_SAVED');}};
 const promise=work();
 // EdgeRuntime keeps this best-effort telemetry alive after the response; no trade waits on it.
 const runtime=(globalThis as unknown as {EdgeRuntime?:{waitUntil:(p:Promise<unknown>)=>void}}).EdgeRuntime;
 if(runtime?.waitUntil)runtime.waitUntil(promise);
 return promise;
}
