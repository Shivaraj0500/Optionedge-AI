import { db } from 'hatchable';
import { placeLiveOrder } from 'lib/live-order-gateway.js';

export const access='user';
export const methods=['GET','POST'];

export { placeLiveOrder };

export default async function(req,res){
  if(req.method==='POST'){
    const b=req.body||{};
    const result=await placeLiveOrder({
      userId:req.user.id,
      instrumentKey:String(b.instrument_key||''),
      transactionType:String(b.transaction_type||'').toUpperCase(),
      quantity:Number(b.quantity),
      idempotencyKey:String(b.idempotency_key||''),
      campaignId:b.campaign_id||null,
      legId:b.leg_id||null
    });
    if(result.ok)return res.json(result);
    return res.status(result.status||502).json(result);
  }
  const q=await db.query('SELECT id,idempotency_key,campaign_id,leg_id,instrument_key,transaction_type,quantity,broker_order_id,status,filled_quantity,average_price,error_message,created_at,updated_at FROM live_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.id]);
  return res.json({orders:q.rows});
}