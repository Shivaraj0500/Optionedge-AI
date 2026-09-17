import { db } from 'hatchable';
export const access = 'user';
export const methods = ['GET','POST'];

const DEFAULT_RISK={max_daily_loss:50000,max_campaign_loss:100000,max_position_quantity:100000,max_rolls:5,max_premium_exposure:1000000,max_spread_pct:10,stale_data_seconds:1800,kill_switch:false};
async function state(userId){
  const [c,b,r]=await Promise.all([
    db.query('SELECT * FROM live_execution_configs WHERE user_id=$1 LIMIT 1',[userId]),
    db.query('SELECT status, expires_at, access_token IS NOT NULL AS has_token FROM broker_connections WHERE user_id=$1 LIMIT 1',[userId]),
    db.query('SELECT * FROM risk_configs WHERE user_id=$1 LIMIT 1',[userId])
  ]);
  const cfg=c.rows[0]||{enabled:true,armed:false,broker:'upstox',product:'I',order_type:'MARKET',validity:'DAY',market_protection:-1,auto_slice:true};
  const broker=b.rows[0]||null; const risk=r.rows[0]||DEFAULT_RISK;
  const tokenValid=!!broker?.has_token && broker.status==='CONNECTED' && (!broker.expires_at || new Date(broker.expires_at).getTime()>Date.now());
  return {enabled:!!cfg.enabled,armed:!!cfg.armed,ready:!!cfg.enabled&&!!cfg.armed&&tokenValid&&!risk.kill_switch,broker_connected:tokenValid,broker_status:broker?.status||'DISCONNECTED',settings:{broker:cfg.broker,product:cfg.product,order_type:cfg.order_type,validity:cfg.validity,market_protection:Number(cfg.market_protection),auto_slice:!!cfg.auto_slice},risk:{max_daily_loss:Number(risk.max_daily_loss),max_campaign_loss:Number(risk.max_campaign_loss),max_position_quantity:Number(risk.max_position_quantity),max_rolls:Number(risk.max_rolls),max_premium_exposure:Number(risk.max_premium_exposure),max_spread_pct:Number(risk.max_spread_pct),stale_data_seconds:Number(risk.stale_data_seconds),kill_switch:!!risk.kill_switch}};
}
export default async function(req,res){
  const userId=req.user.id;
  if(req.method==='GET') return res.json(await state(userId));
  const action=String(req.body?.action||'').toUpperCase();
  if(!['ARM','DISARM'].includes(action)) return res.status(400).json({error:'INVALID_ACTION'});
  if(action==='ARM'){
    const s=await state(userId);
    if(s.risk.kill_switch) return res.status(409).json({error:'KILL_SWITCH_ACTIVE'});
    if(!s.broker_connected) return res.status(409).json({error:'UPSTOX_NOT_CONNECTED'});
  }
  await db.query(`INSERT INTO live_execution_configs(user_id,enabled,armed,updated_at) VALUES($1,true,$2,now()) ON CONFLICT(user_id) DO UPDATE SET enabled=true, armed=EXCLUDED.armed, updated_at=now()`,[userId,action==='ARM']);
  await db.query('INSERT INTO audit_events(user_id,event_type,entity_type,details) VALUES($1,$2,$3,$4)',[userId,action==='ARM'?'LIVE_EXECUTION_ARMED':'LIVE_EXECUTION_DISARMED','live_execution',JSON.stringify({source:'manual_control'})]);
  return res.json(await state(userId));
}