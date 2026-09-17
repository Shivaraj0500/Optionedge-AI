import { db } from 'hatchable';

const DEFAULT_RISK={max_position_quantity:100000,kill_switch:false};
const cleanError=body=>String(body?.message||body?.error||body?.status||'UPSTOX_ORDER_FAILED').slice(0,500);
const validInstrument=k=>/^(NSE|BSE)_(FO|EQ)\|.+/.test(String(k||''));

async function execution(userId){
  const [e,b,r]=await Promise.all([
    db.query('SELECT * FROM live_execution_configs WHERE user_id=$1 LIMIT 1',[userId]),
    db.query('SELECT access_token,status,expires_at FROM broker_connections WHERE user_id=$1 LIMIT 1',[userId]),
    db.query('SELECT * FROM risk_configs WHERE user_id=$1 LIMIT 1',[userId])
  ]);
  const cfg=e.rows[0]||{enabled:true,armed:false,product:'I',order_type:'MARKET',validity:'DAY',market_protection:-1,auto_slice:true};
  const broker=b.rows[0]||null,risk=r.rows[0]||DEFAULT_RISK;
  const tokenValid=!!broker?.access_token&&broker.status==='CONNECTED'&&(!broker.expires_at||new Date(broker.expires_at).getTime()>Date.now());
  return{cfg,broker,risk,tokenValid};
}

export async function placeLiveOrder({userId,instrumentKey,transactionType,quantity,idempotencyKey,campaignId=null,legId=null,product=null}){
  const s=await execution(userId);
  if(!s.cfg.enabled||!s.cfg.armed)return{ok:false,status:409,error:'LIVE_EXECUTION_NOT_ARMED'};
  if(s.risk.kill_switch)return{ok:false,status:409,error:'KILL_SWITCH_ACTIVE'};
  if(!s.tokenValid)return{ok:false,status:409,error:'UPSTOX_NOT_CONNECTED'};
  if(!validInstrument(instrumentKey))return{ok:false,status:400,error:'INVALID_INSTRUMENT_KEY'};
  if(!['BUY','SELL'].includes(transactionType))return{ok:false,status:400,error:'INVALID_TRANSACTION_TYPE'};
  if(!Number.isInteger(quantity)||quantity<=0||quantity>Number(s.risk.max_position_quantity))return{ok:false,status:400,error:'QUANTITY_LIMIT_EXCEEDED'};
  if(!idempotencyKey||String(idempotencyKey).length>160)return{ok:false,status:400,error:'INVALID_IDEMPOTENCY_KEY'};
  const existing=await db.query('SELECT * FROM live_orders WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1',[userId,idempotencyKey]);
  if(existing.rows[0])return{ok:true,replayed:true,order:existing.rows[0]};
  const selectedProduct=product==='D'||product==='I'?product:String(s.cfg.product||'I');
  const payload={quantity,product:selectedProduct,validity:String(s.cfg.validity||'DAY'),price:0,tag:('OE_'+idempotencyKey).slice(0,40),instrument_token:instrumentKey,order_type:String(s.cfg.order_type||'MARKET'),transaction_type:transactionType,disclosed_quantity:0,trigger_price:0,is_amo:false,slice:!!s.cfg.auto_slice,market_protection:Number(s.cfg.market_protection??-1)};
  if(payload.order_type!=='MARKET')return{ok:false,status:409,error:'ONLY_MARKET_ORDERS_ENABLED'};
  const ins=await db.query('INSERT INTO live_orders(user_id,idempotency_key,campaign_id,leg_id,instrument_key,transaction_type,quantity,requested_payload,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[userId,idempotencyKey,campaignId,legId,instrumentKey,transactionType,quantity,JSON.stringify({...payload,authorization:'server-side'}),'SUBMITTING']);
  const localId=ins.rows[0].id;
  try{
    const r=await fetch('https://api-hft.upstox.com/v3/order/place',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+s.broker.access_token},body:JSON.stringify(payload)});
    const body=await r.json().catch(()=>({}));
    if(!r.ok||body.status!=='success'){const msg=cleanError(body);await db.query('UPDATE live_orders SET status=$1,error_message=$2,updated_at=now() WHERE id=$3',['REJECTED',msg,localId]);await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[userId,'LIVE_ORDER_REJECTED','live_order',localId,JSON.stringify({broker_status:r.status,error:msg,campaign_id:campaignId,leg_id:legId})]);return{ok:false,status:502,error:'UPSTOX_ORDER_REJECTED',message:msg,local_order_id:localId};}
    const ids=Array.isArray(body.data?.order_ids)?body.data.order_ids:[];if(!ids.length){await db.query('UPDATE live_orders SET status=$1,error_message=$2,updated_at=now() WHERE id=$3',['ERROR','UPSTOX_RETURNED_NO_ORDER_ID',localId]);return{ok:false,status:502,error:'UPSTOX_NO_ORDER_ID',local_order_id:localId};}
    await db.query('UPDATE live_orders SET status=$1,broker_order_id=$2,updated_at=now() WHERE id=$3',['SUBMITTED',ids[0],localId]);
    await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[userId,'LIVE_ORDER_SUBMITTED','live_order',localId,JSON.stringify({broker_order_ids:ids,campaign_id:campaignId,leg_id:legId,latency_ms:body.metadata?.latency??null})]);
    return{ok:true,replayed:false,local_order_id:localId,broker_order_ids:ids,status:'SUBMITTED',metadata:body.metadata||{}};
  }catch(err){const msg=String(err?.message||err).slice(0,500);await db.query('UPDATE live_orders SET status=$1,error_message=$2,updated_at=now() WHERE id=$3',['ERROR',msg,localId]);return{ok:false,status:502,error:'UPSTOX_REQUEST_FAILED',message:msg,local_order_id:localId};}
}