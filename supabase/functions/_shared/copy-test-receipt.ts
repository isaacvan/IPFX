// Receipt evidence only; no I/O, dispatch, activation or price substitution.
export function exactTestOpenReceipt(qty:number,orderId:unknown,positionId:unknown,fill:{qty:number;price:number;orderId?:string|null;positionId?:string|null}|null){
 return qty===.01&&typeof orderId==='string'&&/^[1-9]\d{0,19}$/.test(orderId)&&typeof positionId==='string'&&/^[1-9]\d{0,19}$/.test(positionId)&&
  fill!==null&&Number.isFinite(fill.qty)&&Math.abs(fill.qty-qty)<1e-8&&Number.isFinite(fill.price)&&fill.price>0&&fill.orderId===orderId&&fill.positionId===positionId;
}
