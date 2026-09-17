import { db } from 'hatchable';

export const access = 'user';
export const methods = ['POST'];

export default async function(req,res){
  const userId=req.user.id;
  const brokerQ=await db.query('SELECT access_token,status,expires_at FROM broker_connections WHERE user_id=$1 LIMIT 1',[userId]);
  const broker=brokerQ.rows[0];
  if(!broker?.access_token||broker.status!=='CONNECTED'||(broker.expires_at&&new Date(broker.expires_at).getTime()<=Date.now())) return res.status(409).json({error:'UPSTOX_NOT_CONNECTED'});
  const orderId=String(req.body?.broker_order_id||'');
  const localId=String(req.body?.local_order_id||'');
  if(!orderId&&!localId) return res.status(400).json({error:'ORDER_ID_REQUIRED'});
  let id=orderId;
  if(!id){
    const q=await db.query('SELECT broker_order_id FROM live_orders WHERE user_id=$1 AND id=$2 LIMIT 1',[userId,localId]);
    id=q.rows[0]?.broker_order_id||'';
  }
  if(!id) return res.status(404).json({error:'BROKER_ORDER_NOT_FOUND'});
  const url='https://api.upstox.com/v2/order/details?order_id='+encodeURIComponent(id);
  const r=await fetch(url,{headers:{Accept:'application/json',Authorization:'Bearer '+broker.access_token}});
  const body=await r.json().catch(()=>({}));
  if(!r.ok||body.status!=='success') return res.status(502).json({error:'UPSTOX_ORDER_STATUS_FAILED',status:r.status,details:body});
  const d=body.data||{};
  const status=String(d.status||'').toUpperCase();
  const filled=Number(d.filled_quantity??d.filledQuantity??0);
  const avg=Number(d.average_price??d.averagePrice);
  if(localId){
    await db.query('UPDATE live_orders SET status=$1,filled_quantity=$2,average_price=$3,updated_at=now() WHERE user_id=$4 AND id=$5',[status||'UNKNOWN',Number.isFinite(filled)?filled:0,Number.isFinite(avg)?avg:null,userId,localId]);
  }else{
    await db.query('UPDATE live_orders SET status=$1,filled_quantity=$2,average_price=$3,updated_at=now() WHERE user_id=$4 AND broker_order_id=$5',[status||'UNKNOWN',Number.isFinite(filled)?filled:0,Number.isFinite(avg)?avg:null,userId,id]);
  }
  return res.json({broker_order_id:id,status:d.status||null,filled_quantity:filled,average_price:Number.isFinite(avg)?avg:null,details:d});
}