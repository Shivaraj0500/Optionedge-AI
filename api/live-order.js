import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET','POST'];

const DEFAULT_RISK = { max_daily_loss:50000,max_campaign_loss:100000,max_position_quantity:100000,max_rolls:5,max_premium_exposure:1000000,max_spread_pct:10,stale_data_seconds:1800,kill_switch:false };

async function execution(userId){
  const [e,b,r] = await Promise.all([
    db.query('SELECT * FROM live_execution_configs WHERE user_id=$1 LIMIT 1',[userId]),
    db.query('SELECT access_token,status,expires_at FROM broker_connections WHERE user_id=$1 LIMIT 1',[userId]),
    db.query('SELECT * FROM risk_configs WHERE user_id=$1 LIMIT 1',[userId])
  ]);
  const cfg=e.rows[0]||{enabled:true,armed:false,product:'I',order_type:'MARKET',validity:'DAY',market_protection:-1,auto_slice:true};
  const broker=b.rows[0]||null;
  const risk=r.rows[0]||DEFAULT_RISK;
  const tokenValid=!!broker?.access_token&&broker.status==='CONNECTED'&&(!broker.expires_at||new Date(broker.expires_at).getTime()>Date.now());
  return {cfg,broker,risk,tokenValid};
}

function cleanError(body){
  if(!body) return 'UPSTOX_ORDER_FAILED';
  return String(body.message||body.error||body.status||'UPSTOX_ORDER_FAILED').slice(0,500);
}

async function submit(req,res){
  const userId=req.user.id;
  const s=await execution(userId);
  if(!s.cfg.enabled||!s.cfg.armed) return res.status(409).json({error:'LIVE_EXECUTION_NOT_ARMED'});
  if(s.risk.kill_switch) return res.status(409).json({error:'KILL_SWITCH_ACTIVE'});
  if(!s.tokenValid) return res.status(409).json({error:'UPSTOX_NOT_CONNECTED'});

  const b=req.body||{};
  const instrumentKey=String(b.instrument_key||'');
  const transactionType=String(b.transaction_type||'').toUpperCase();
  const quantity=Number(b.quantity);
  const idem=String(b.idempotency_key||'');
  if(!instrumentKey||!/^NSE_(FO|EQ)\\|.+|^BSE_(FO|EQ)\\|.+/.test(instrumentKey)) return res.status(400).json({error:'INVALID_INSTRUMENT_KEY'});
  if(!['BUY','SELL'].includes(transactionType)) return res.status(400).json({error:'INVALID_TRANSACTION_TYPE'});
  if(!Number.isInteger(quantity)||quantity<=0||quantity>Number(s.risk.max_position_quantity)) return res.status(400).json({error:'QUANTITY_LIMIT_EXCEEDED'});
  if(!idem||idem.length>160) return res.status(400).json({error:'INVALID_IDEMPOTENCY_KEY'});

  const existing=await db.query('SELECT * FROM live_orders WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1',[userId,idem]);
  if(existing.rows[0]) return res.json({replayed:true,order:existing.rows[0]});

  const payload={quantity,product:String(s.cfg.product||'I'),validity:String(s.cfg.validity||'DAY'),price:0,tag:('OE_'+idem).slice(0,40),instrument_token:instrumentKey,order_type:String(s.cfg.order_type||'MARKET'),transaction_type:transactionType,disclosed_quantity:0,trigger_price:0,is_amo:false,slice:!!s.cfg.auto_slice,market_protection:Number(s.cfg.market_protection??-1)};
  if(payload.order_type!=='MARKET') return res.status(409).json({error:'ONLY_MARKET_ORDERS_ENABLED'});

  const inserted=await db.query('INSERT INTO live_orders(user_id,idempotency_key,campaign_id,leg_id,instrument_key,transaction_type,quantity,requested_payload,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[userId,idem,b.campaign_id||null,b.leg_id||null,instrumentKey,transactionType,quantity,JSON.stringify({...payload,authorization:'server-side'}),'SUBMITTING']);
  const localId=inserted.rows[0].id;

  try{
    const r=await fetch('https://api-hft.upstox.com/v3/order/place',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:'Bearer '+s.broker.access_token},body:JSON.stringify(payload)});
    const body=await r.json().catch(()=>({}));
    if(!r.ok||body.status!=='success'){
      const msg=cleanError(body);
      await db.query('UPDATE live_orders SET status=$1,error_message=$2,updated_at=now() WHERE id=$3',['REJECTED',msg,localId]);
      await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[userId,'LIVE_ORDER_REJECTED','live_order',localId,JSON.stringify({broker_status:r.status,error:msg})]);
      return res.status(502).json({error:'UPSTOX_ORDER_REJECTED',message:msg,local_order_id:localId});
    }
    const orderIds=Array.isArray(body.data?.order_ids)?body.data.order_ids:[];
    await db.query('UPDATE live_orders SET status=$1,broker_order_id=$2,updated_at=now() WHERE id=$3',['SUBMITTED',orderIds[0]||null,localId]);
    await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',[userId,'LIVE_ORDER_SUBMITTED','live_order',localId,JSON.stringify({broker_order_ids:orderIds,latency_ms:body.metadata?.latency??null})]);
    return res.json({replayed:false,local_order_id:localId,broker_order_ids:orderIds,status:'SUBMITTED',metadata:body.metadata||{}});
  }catch(err){
    const msg=String(err?.message||err).slice(0,500);
    await db.query('UPDATE live_orders SET status=$1,error_message=$2,updated_at=now() WHERE id=$3',['ERROR',msg,localId]);
    return res.status(502).json({error:'UPSTOX_REQUEST_FAILED',message:msg,local_order_id:localId});
  }
}

export default async function(req,res){
  const userId=req.user.id;
  if(req.method==='POST') return submit(req,res);
  const q=await db.query('SELECT id,idempotency_key,campaign_id,leg_id,instrument_key,transaction_type,quantity,broker_order_id,status,filled_quantity,average_price,error_message,created_at,updated_at FROM live_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[userId]);
  return res.json({orders:q.rows});
}