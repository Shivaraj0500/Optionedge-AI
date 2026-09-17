import { db, scheduler } from 'hatchable';
import { runLiveCycle } from 'lib/live-engine-core.js';

export const access = 'scheduler';
export const methods = ['POST'];

const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

async function broker(userId) {
  const q = await db.query('SELECT access_token,status,expires_at FROM broker_connections WHERE user_id=$1 LIMIT 1',[userId]);
  const b = q.rows[0];
  if (!b?.access_token || b.status !== 'CONNECTED') return null;
  if (b.expires_at && new Date(b.expires_at).getTime() <= Date.now()) {
    await db.query("UPDATE broker_connections SET status='EXPIRED',updated_at=now() WHERE user_id=$1",[userId]);
    return null;
  }
  return b;
}

async function reconcileOrders(userId, campaign) {
  const b = await broker(userId);
  if (!b) return { orders: 0, orderErrors: 1 };
  const q = await db.query("SELECT * FROM live_orders WHERE campaign_id=$1 AND user_id=$2 AND broker_order_id IS NOT NULL AND status NOT IN ('COMPLETE','FILLED','REJECTED','CANCELLED') ORDER BY created_at LIMIT 100",[campaign.id,userId]);
  let updated = 0, errors = 0;
  for (const o of q.rows) {
    try {
      const r = await fetch('https://api.upstox.com/v2/order/details?order_id='+encodeURIComponent(o.broker_order_id),{headers:{Accept:'application/json',Authorization:'Bearer '+b.access_token}});
      const body = await r.json().catch(()=>({}));
      if (r.status === 401) { await db.query("UPDATE broker_connections SET status='EXPIRED',updated_at=now() WHERE user_id=$1",[userId]); errors++; continue; }
      if (!r.ok || body.status !== 'success') { errors++; continue; }
      const d = body.data || {};
      const status = String(d.status || 'UNKNOWN').toUpperCase();
      const filled = num(d.filled_quantity ?? d.filledQuantity,0);
      const avg = Number.isFinite(Number(d.average_price ?? d.averagePrice)) ? Number(d.average_price ?? d.averagePrice) : null;
      await db.query('UPDATE live_orders SET status=$1,filled_quantity=$2,average_price=$3,error_message=$4,updated_at=now() WHERE id=$5 AND user_id=$6',[status,filled,avg,(status==='REJECTED'||status==='CANCELLED')?(d.status_message||d.status_message_raw||null):null,o.id,userId]);
      updated++;

      const legs = await db.query('SELECT * FROM live_campaign_legs WHERE campaign_id=$1 AND leg_id=$2 AND user_id=$3 ORDER BY entry_at DESC LIMIT 1',[campaign.id,o.leg_id,userId]);
      const leg = legs.rows[0];
      if (!leg) continue;
      if (String(o.id) === String(leg.entry_order_id)) {
        if (status === 'REJECTED' || status === 'CANCELLED') {
          await db.query("UPDATE live_campaign_legs SET status='ENTRY_REJECTED',filled_quantity=$1,metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$3 AND user_id=$4",[filled,JSON.stringify({supervisor_order_status:status}),leg.id,userId]);
          await db.query("UPDATE live_campaigns SET recovery_required=true,last_status='ENTRY_FAILED',last_reason=$1,updated_at=now() WHERE id=$2 AND user_id=$3",['ENTRY_'+status,campaign.id,userId]);
        } else if (filled > 0) {
          await db.query("UPDATE live_campaign_legs SET filled_quantity=$1,entry_price=COALESCE($2,entry_price),status=CASE WHEN $1>=requested_quantity THEN 'OPEN' ELSE 'PARTIAL' END,updated_at=now() WHERE id=$3 AND user_id=$4",[filled,avg,leg.id,userId]);
        }
      }
      if (String(o.id) === String(leg.exit_order_id)) {
        if (status === 'REJECTED' || status === 'CANCELLED') {
          await db.query("UPDATE live_campaign_legs SET status='OPEN',metadata=metadata||$1::jsonb,updated_at=now() WHERE id=$2 AND user_id=$3",[JSON.stringify({supervisor_exit_status:status}),leg.id,userId]);
          await db.query("UPDATE live_campaigns SET recovery_required=true,last_status='EXIT_FAILED',last_reason=$1,updated_at=now() WHERE id=$2 AND user_id=$3",['EXIT_'+status,campaign.id,userId]);
        } else if (filled >= num(leg.filled_quantity)) {
          const pnl=(leg.side==='BUY'?1:-1)*(num(avg)-num(leg.entry_price))*num(leg.filled_quantity);
          await db.query("UPDATE live_campaign_legs SET status='CLOSED',exit_price=$1,pnl=$2,exit_at=now(),updated_at=now() WHERE id=$3 AND user_id=$4",[avg,pnl,leg.id,userId]);
          await db.query("UPDATE live_campaigns SET realized_pnl=COALESCE(realized_pnl,0)+$1,last_status='EXIT_FILLED',last_reason='SUPERVISOR_RECONCILIATION',updated_at=now() WHERE id=$2 AND user_id=$3",[pnl,campaign.id,userId]);
        }
      }
    } catch { errors++; }
  }
  return { orders: q.rows.length, updated, orderErrors: errors };
}

async function reconcilePositions(userId,campaign) {
  const b=await broker(userId); if(!b) return {positionState:'BROKER_UNAVAILABLE'};
  const r=await fetch('https://api.upstox.com/v2/portfolio/short-term-positions',{headers:{Accept:'application/json',Authorization:'Bearer '+b.access_token}});
  const body=await r.json().catch(()=>({}));
  if(r.status===401){await db.query("UPDATE broker_connections SET status='EXPIRED',updated_at=now() WHERE user_id=$1",[userId]);return {positionState:'TOKEN_EXPIRED'};}
  if(!r.ok||body.status!=='success')return {positionState:'POSITIONS_UNAVAILABLE'};
  const positions=Array.isArray(body.data)?body.data:[];
  const local=(await db.query("SELECT * FROM live_campaign_legs WHERE campaign_id=$1 AND user_id=$2 AND status IN ('OPEN','PARTIAL','EXIT_SUBMITTED')",[campaign.id,userId])).rows;
  let mismatch=false;
  for(const leg of local){
    const p=positions.find(x=>(x.instrument_token||x.instrument_key)===leg.instrument_key);
    const actual=num(p?.quantity,0), expected=(leg.side==='BUY'?1:-1)*num(leg.filled_quantity,0);
    if(actual!==expected)mismatch=true;
  }
  const tracked=new Set(local.map(x=>x.instrument_key));
  for(const p of positions){const key=p.instrument_token||p.instrument_key;const qty=num(p.quantity,0);if(qty!==0&&!tracked.has(key))mismatch=true;}
  if(mismatch){
    await db.query("UPDATE live_campaigns SET recovery_required=true,last_status='POSITION_MISMATCH',last_reason='UPSTOX_POSITION_RECONCILIATION_MISMATCH',updated_at=now() WHERE id=$1 AND user_id=$2",[campaign.id,userId]);
  } else {
    await db.query("UPDATE live_campaigns SET last_status='RECONCILED',last_reason='UPSTOX_ORDERS_AND_POSITIONS_MATCH',updated_at=now() WHERE id=$1 AND user_id=$2 AND recovery_required=false",[campaign.id,userId]);
  }
  return {positionState:mismatch?'MISMATCH':'MATCH',brokerPositions:positions.filter(x=>num(x.quantity,0)!==0).length};
}

export default async function(req,res){
  const payload=req.body||{};
  const requestedUser=String(payload.user_id||'');
  const users=requestedUser?[requestedUser]:((await db.query("SELECT DISTINCT c.user_id FROM live_campaigns c JOIN live_execution_configs e ON e.user_id=c.user_id WHERE c.status='RUNNING' AND e.armed=true AND e.enabled=true")).rows.map(x=>x.user_id));
  const results=[];
  for(const userId of users){
    const q=await db.query("SELECT * FROM live_campaigns WHERE user_id=$1 AND status='RUNNING' ORDER BY started_at DESC LIMIT 1",[userId]);
    const c=q.rows[0];
    if(!c){results.push({user_id:userId,state:'NO_CAMPAIGN'});continue;}
    const e=await db.query('SELECT armed,enabled FROM live_execution_configs WHERE user_id=$1 LIMIT 1',[userId]);
    if(!e.rows[0]?.armed||e.rows[0]?.enabled===false){results.push({user_id:userId,state:'DISARMED'});continue;}
    const b=await broker(userId);
    if(!b){await db.query("UPDATE live_campaigns SET recovery_required=true,last_status='BROKER_UNAVAILABLE',last_reason='SUPERVISOR_BROKER_RECONCILIATION_FAILED',updated_at=now() WHERE id=$1 AND user_id=$2",[c.id,userId]);results.push({user_id:userId,state:'BROKER_UNAVAILABLE'});continue;}
    const orders=await reconcileOrders(userId,c);
    const positions=await reconcilePositions(userId,c);

    // Re-read after reconciliation: an order/position mismatch or partial fill may
    // have set recovery_required, and that must block the strategy cycle immediately.
    const freshQ=await db.query("SELECT * FROM live_campaigns WHERE id=$1 AND user_id=$2 LIMIT 1",[c.id,userId]);
    const fresh=freshQ.rows[0]||c;
    let cycle=null;
    if(positions.positionState==='MATCH' && !fresh.recovery_required){
      const lock=await db.query("UPDATE live_campaigns SET cycle_lock_until=now()+interval '20 seconds' WHERE id=$1 AND user_id=$2 AND status='RUNNING' AND (cycle_lock_until IS NULL OR cycle_lock_until<now()) RETURNING id",[fresh.id,userId]);
      if(lock.rows.length){
        try{
          cycle=await runLiveCycle(userId,fresh);
        }catch(e){
          cycle={status:500,payload:{error:String(e?.message||e)}};
          await db.query("UPDATE live_campaigns SET last_status='SUPERVISOR_CYCLE_ERROR',last_reason=$1,updated_at=now() WHERE id=$2 AND user_id=$3",[String(e?.message||e).slice(0,500),fresh.id,userId]);
        }finally{
          await db.query('UPDATE live_campaigns SET cycle_lock_until=null WHERE id=$1 AND user_id=$2',[fresh.id,userId]);
        }
      }else cycle={status:409,payload:{error:'LIVE_CYCLE_ALREADY_RUNNING'}};
    }

    const afterQ=await db.query("SELECT status,recovery_required FROM live_campaigns WHERE id=$1 AND user_id=$2 LIMIT 1",[fresh.id,userId]);
    const after=afterQ.rows[0]||fresh;
    results.push({user_id:userId,campaign_id:fresh.id,orders,positions,recovery_required:!!after.recovery_required,cycle});

    // Chain the next five-minute firing only while the live campaign is still
    // armed, enabled, broker-connected and not awaiting recovery.
    const safe=after.status==='RUNNING' && !after.recovery_required;
    if(safe){
      const cfg=await db.query('SELECT armed,enabled FROM live_execution_configs WHERE user_id=$1 LIMIT 1',[userId]);
      const br=await broker(userId);
      if(cfg.rows[0]?.armed && cfg.rows[0]?.enabled!==false && br){
        await scheduler.at(new Date(Date.now()+5*60*1000),'/api/live-supervisor',{payload:{user_id:userId},name:'live-supervisor-'+userId});
      }
    }
  }
  return res.json({ok:true,processed:results.length,results,trigger:req.headers['x-hatchable-trigger']||'unknown'});
}