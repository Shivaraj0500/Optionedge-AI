import { db } from 'hatchable';
import { state, start, strategyFor, exitLeg, runLiveCycle } from 'lib/live-engine-core.js';

export const access='user';
export const methods=['GET','POST'];

export default async function(req,res){
  const uid=req.user.id;
  const cid=req.query?.campaign_id||req.body?.campaign_id||null;
  if(req.method==='GET')return res.json(await state(uid,cid));
  const action=String(req.body?.action||'CYCLE').toUpperCase();
  try{
    if(action==='START'){
      const c=await start(uid,req.body||{});
      return res.status(201).json(await state(uid,c.id));
    }
    const q=cid
      ?await db.query('SELECT * FROM live_campaigns WHERE id=$1 AND user_id=$2 LIMIT 1',[cid,uid])
      :await db.query("SELECT * FROM live_campaigns WHERE user_id=$1 AND status='RUNNING' ORDER BY started_at DESC LIMIT 1",[uid]);
    const c=q.rows[0];
    if(!c)return res.status(404).json({error:'LIVE_CAMPAIGN_NOT_RUNNING'});
    if(action==='DISARM'||action==='STOP'||action==='SQUARE_OFF'){
      if(action==='STOP'||action==='SQUARE_OFF'){
        const reason=action==='STOP'?'USER_STOP':'MANUAL_SQUARE_OFF';
        const legs=(await db.query("SELECT * FROM live_campaign_legs WHERE campaign_id=$1 AND user_id=$2 AND status IN ('OPEN','PARTIAL','EXIT_SUBMITTED')",[c.id,uid])).rows;
        for(const leg of legs)await exitLeg(uid,c,leg,reason);
        const remain=(await db.query("SELECT COUNT(*)::int count FROM live_campaign_legs WHERE campaign_id=$1 AND user_id=$2 AND status<>'CLOSED' AND filled_quantity>0",[c.id,uid])).rows[0].count;
        if(Number(remain)===0){
          await db.query("UPDATE live_campaigns SET status=$1,closed_at=CASE WHEN $1='STOPPED' THEN now() ELSE closed_at END,last_status=$1,last_reason=$2,updated_at=now(),recovery_required=false WHERE id=$3 AND user_id=$4",[action==='STOP'?'STOPPED':'RUNNING',reason,c.id,uid]);
          await addDecisionCompat(uid,c,await strategyFor(uid,c),null,action,reason,'LIVE_POSITION',{action:'CLOSE'},{live:true});
        }else await db.query("UPDATE live_campaigns SET recovery_required=true,last_status='EXIT_PENDING',last_reason='LIVE_EXIT_PENDING',updated_at=now() WHERE id=$1 AND user_id=$2",[c.id,uid]);
      }
      return res.json(await state(uid,c.id));
    }
    if(c.recovery_required)return res.status(409).json({...await state(uid,c.id),error:'LIVE_RECOVERY_REQUIRED'});
    const lock=await db.query("UPDATE live_campaigns SET cycle_lock_until=now()+interval '20 seconds' WHERE id=$1 AND user_id=$2 AND status='RUNNING' AND (cycle_lock_until IS NULL OR cycle_lock_until<now()) RETURNING id",[c.id,uid]);
    if(!lock.rows.length)return res.status(409).json({error:'LIVE_CYCLE_ALREADY_RUNNING'});
    try{
      const result=await runLiveCycle(uid,c);
      return res.status(result?.status||200).json(result?.payload??result);
    }finally{
      await db.query('UPDATE live_campaigns SET cycle_lock_until=null WHERE id=$1 AND user_id=$2',[c.id,uid]);
    }
  }catch(e){
    return res.status(409).json({...await state(uid,cid),error:String(e?.message||e)});
  }
}

// Kept local to preserve the existing STOP/SQUARE_OFF audit behavior without
// coupling the API wrapper to the core's private decision helper.
async function addDecisionCompat(userId,c,strategy,ctx,status,reason,regime,signal,details){
  await db.query('INSERT INTO live_decisions(user_id,campaign_id,strategy_id,strategy_version,candle_at,status,reason,regime,indicators,signal,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[
    userId,c.id,strategy.id,strategy.version,ctx?.lastCandle?.timestamp||null,status,reason,regime||null,
    JSON.stringify(ctx?{adx:ctx.indicator.adx,plus_di:ctx.indicator.plus_di,minus_di:ctx.indicator.minus_di,atr:ctx.indicator.atr,spot:ctx.spot,atr_upper:ctx.upper,atr_lower:ctx.lower}:{}),
    JSON.stringify(signal||{}),JSON.stringify(details||{})
  ]);
}