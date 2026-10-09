// Uses broker field names from /config, not guessed numeric array offsets. No order or monitor access here.
import { brokerCapacitySnapshot } from './tradelocker.ts';
export async function reserveCapacity(db: any, book: string, trade: string, qty: number, dest: {token:string;accountId:string;accNum:string}) {
  const {data: limit,error}=await db.from('book_capacity_limits').select('book').eq('book',book).maybeSingle();
  if(error||!limit)return {ok:false,reason:'DOCUMENTED_CAPACITY_NOT_CONFIGURED'};
  if (!Deno.env.get('TRADELOCKER_DEVELOPER_API_KEY')) return {ok:false,reason:'MULTI_ACCOUNT_DEVELOPER_ACCESS_UNCONFIGURED'};
  try {
    const snapshot=await brokerCapacitySnapshot(dest.token,dest.accountId,dest.accNum);
    const {error: stateError}=await db.rpc('fn_publish_book_capacity',{p_book:book,p_observed:snapshot.observed_at,p_positions:snapshot.open_positions,p_orders:snapshot.pending_orders,p_margin:snapshot.free_margin_usd,p_position_ids:snapshot.position_ids});
    if(stateError)return {ok:false,reason:'CAPACITY_SNAPSHOT_WRITE_FAILED'};
    const {data,error: reservationError}=await db.rpc('fn_reserve_book_slot',{p_book:book,p_trade:trade,p_qty:qty});
    return reservationError?{ok:false,reason:'CAPACITY_RESERVATION_UNAVAILABLE'}:data;
  }catch{return {ok:false,reason:'BROKER_CAPACITY_UNVERIFIED'};}
}
