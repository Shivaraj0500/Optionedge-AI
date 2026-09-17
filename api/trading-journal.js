import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

function istDateOnly(value) { const d=new Date(value||Date.now()); return new Date(d.getTime()+330*60*1000).toISOString().slice(0,10); }
function num(v,fallback=null){const n=Number(v);return Number.isFinite(n)?n:fallback;}
function obj(v){return v&&typeof v==='object'?v:{};}
function strategySnapshot(config,underlying){const c=obj(config);return{name:c.name||null,underlying:c.underlying||underlying,timeframe:c.timeframe||null,candle_type:c.candle_type||null,start_time:c.start_time||null,square_off:c.square_off||'15:15',signal_model:c.signal_model||'LEGACY_ADX_RANGE',signal_config:c.signal_config||null,adx_period:c.adx_period??null,adx_threshold:c.adx_threshold??null,atr_period:c.atr_period??null,atr_multiplier:c.atr_multiplier??null,confirmation_candles:c.confirmation_candles??null,roll_mode:c.roll_mode||null,regime_rule:c.regime_rule||null,option_expiry:c.option_expiry||null,legs:c.legs||null};}

async function syncUser(userId){
  const [paper,live,versions,pRolls,lRolls,orders]=await Promise.all([
    db.query(`SELECT l.*,c.underlying,c.mode AS campaign_mode,c.status AS campaign_status FROM paper_campaign_legs l JOIN paper_campaigns c ON c.id=l.campaign_id AND c.user_id=l.user_id WHERE l.user_id=$1`,[userId]),
    db.query(`SELECT l.*,c.underlying,c.mode AS campaign_mode,c.status AS campaign_status FROM live_campaign_legs l JOIN live_campaigns c ON c.id=l.campaign_id AND c.user_id=l.user_id WHERE l.user_id=$1`,[userId]),
    db.query(`SELECT strategy_id,version_number,config FROM strategy_versions WHERE user_id=$1`,[userId]),
    db.query(`SELECT campaign_id,COUNT(*)::int AS count FROM paper_decisions WHERE user_id=$1 AND status='ROLL' GROUP BY campaign_id`,[userId]),
    db.query(`SELECT campaign_id,COUNT(*)::int AS count FROM live_decisions WHERE user_id=$1 AND status='ROLL' GROUP BY campaign_id`,[userId]),
    db.query(`SELECT id,broker_order_id,status,filled_quantity,average_price FROM live_orders WHERE user_id=$1`,[userId])
  ]);
  const vm=new Map(versions.rows.map(v=>[`${v.strategy_id}:${v.version_number}`,obj(v.config)]));
  const prm=new Map(pRolls.rows.map(x=>[String(x.campaign_id),Number(x.count||0)]));
  const lrm=new Map(lRolls.rows.map(x=>[String(x.campaign_id),Number(x.count||0)]));
  const om=new Map(orders.rows.map(x=>[String(x.id),x]));
  const entries=[];
  for(const r of paper.rows){
    const snap=strategySnapshot(vm.get(`${r.strategy_id}:${r.strategy_version}`),r.underlying);
    entries.push({mode:'PAPER',leg:r,snap,rolls:prm.get(String(r.campaign_id))||0,execution:{simulated:true,metadata:obj(r.metadata),campaign_mode:r.campaign_mode,campaign_status:r.campaign_status}});
  }
  for(const r of live.rows){
    const snap=strategySnapshot(vm.get(`${r.strategy_id}:${r.strategy_version}`),r.underlying),eo=om.get(String(r.entry_order_id)),xo=om.get(String(r.exit_order_id));
    entries.push({mode:'LIVE',leg:r,snap,rolls:lrm.get(String(r.campaign_id))||0,execution:{live:true,entry_order_id:r.entry_order_id,exit_order_id:r.exit_order_id,entry_broker_order_id:eo?.broker_order_id||null,exit_broker_order_id:xo?.broker_order_id||null,entry_order_status:eo?.status||null,exit_order_status:xo?.status||null,entry_filled_quantity:eo?.filled_quantity??null,exit_filled_quantity:xo?.filled_quantity??null,entry_average_price:eo?.average_price??null,exit_average_price:xo?.average_price??null,metadata:obj(r.metadata),campaign_mode:r.campaign_mode,campaign_status:r.campaign_status}});
  }
  if(!entries.length)return 0;
  const sql=`INSERT INTO trading_journal_entries(user_id,source_mode,source_leg_id,campaign_id,strategy_id,strategy_version,strategy_name,underlying,cycle_id,leg_id,role,side,option_type,expiry,strike,instrument_key,trading_symbol,lot_size,lots,requested_quantity,filled_quantity,entry_price,exit_price,current_price,pnl,status,entry_at,exit_at,total_rolls,strategy_snapshot,execution_details,journal_date,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,now()) ON CONFLICT(user_id,source_mode,source_leg_id) DO UPDATE SET strategy_id=EXCLUDED.strategy_id,strategy_version=EXCLUDED.strategy_version,strategy_name=EXCLUDED.strategy_name,underlying=EXCLUDED.underlying,cycle_id=EXCLUDED.cycle_id,leg_id=EXCLUDED.leg_id,role=EXCLUDED.role,side=EXCLUDED.side,option_type=EXCLUDED.option_type,expiry=EXCLUDED.expiry,strike=EXCLUDED.strike,instrument_key=EXCLUDED.instrument_key,trading_symbol=EXCLUDED.trading_symbol,lot_size=EXCLUDED.lot_size,lots=EXCLUDED.lots,requested_quantity=EXCLUDED.requested_quantity,filled_quantity=EXCLUDED.filled_quantity,entry_price=EXCLUDED.entry_price,exit_price=EXCLUDED.exit_price,current_price=EXCLUDED.current_price,pnl=EXCLUDED.pnl,status=EXCLUDED.status,entry_at=EXCLUDED.entry_at,exit_at=EXCLUDED.exit_at,total_rolls=EXCLUDED.total_rolls,strategy_snapshot=EXCLUDED.strategy_snapshot,execution_details=EXCLUDED.execution_details,journal_date=EXCLUDED.journal_date,updated_at=now()`;
  await db.transaction(entries.map(e=>{const r=e.leg;return{sql,params:[userId,e.mode,String(r.id),r.campaign_id,r.strategy_id,Number(r.strategy_version||1),e.snap.name,r.underlying,r.cycle_id,r.leg_id,r.role,r.side,r.option_type,r.expiry,num(r.strike),r.instrument_key,r.trading_symbol,num(r.lot_size),num(r.lots),e.mode==='LIVE'?num(r.requested_quantity):num(r.quantity),num(r.filled_quantity??r.quantity,0),num(r.entry_price),num(r.exit_price),num(r.current_price),num(r.pnl,0),r.status,r.entry_at,r.exit_at,e.rolls,JSON.stringify(e.snap),JSON.stringify(e.execution),istDateOnly(r.exit_at||r.entry_at)]};}));
  return entries.length;
}

export default async function(req,res){
  const userId=req.user.id;
  try{
    await syncUser(userId);
    const q=req.query||{},mode=String(q.mode||'ALL').toUpperCase(),underlying=String(q.underlying||'ALL'),limit=Math.min(Math.max(Number(q.limit||1000),1),1000);
    const params=[userId],where=['user_id=$1'];
    if(['PAPER','LIVE'].includes(mode)){params.push(mode);where.push(`source_mode=$${params.length}`);}
    if(underlying!=='ALL'){params.push(underlying);where.push(`underlying=$${params.length}`);}
    const filterParams=params.slice();params.push(limit);
    const [tq,dq]=await Promise.all([
      db.query(`SELECT * FROM trading_journal_entries WHERE ${where.join(' AND ')} ORDER BY journal_date DESC,COALESCE(exit_at,entry_at) DESC LIMIT $${params.length}`,params),
      db.query(`SELECT journal_date,COUNT(*)::int AS legs,COUNT(DISTINCT campaign_id)::int AS campaigns,COUNT(DISTINCT strategy_id)::int AS strategies,COALESCE(SUM(CASE WHEN status='CLOSED' THEN pnl ELSE 0 END),0) AS realized_pnl,COALESCE(SUM(CASE WHEN status<>'CLOSED' THEN pnl ELSE 0 END),0) AS open_pnl,COALESCE(SUM(pnl),0) AS total_pnl,MAX(total_rolls)::int AS rolls FROM trading_journal_entries WHERE ${where.join(' AND ')} GROUP BY journal_date ORDER BY journal_date DESC`,filterParams)
    ]);
    const trades=tq.rows.map(r=>({...r,strike:num(r.strike),lot_size:num(r.lot_size),lots:num(r.lots),requested_quantity:num(r.requested_quantity),filled_quantity:num(r.filled_quantity,0),entry_price:num(r.entry_price),exit_price:num(r.exit_price),current_price:num(r.current_price),pnl:num(r.pnl,0),total_rolls:Number(r.total_rolls||0),strategy_snapshot:obj(r.strategy_snapshot),execution_details:obj(r.execution_details)}));
    const daily=dq.rows.map(r=>({date:String(r.journal_date),legs:Number(r.legs||0),campaigns:Number(r.campaigns||0),strategies:Number(r.strategies||0),realized_pnl:num(r.realized_pnl,0),open_pnl:num(r.open_pnl,0),pnl:num(r.total_pnl,0),rolls:Number(r.rolls||0)}));
    const asc=[...daily].sort((a,b)=>a.date.localeCompare(b.date));let cumulative=0;const equity_curve=asc.map(d=>({date:d.date,day_pnl:d.pnl,equity:(cumulative+=Number(d.pnl||0))}));
    const summary={days:daily.length,trades:trades.length,closed_trades:trades.filter(x=>x.status==='CLOSED').length,open_trades:trades.filter(x=>x.status!=='CLOSED').length,profitable_days:daily.filter(x=>x.pnl>0).length,loss_days:daily.filter(x=>x.pnl<0).length,realized_pnl:daily.reduce((s,x)=>s+x.realized_pnl,0),open_pnl:daily.reduce((s,x)=>s+x.open_pnl,0),total_pnl:daily.reduce((s,x)=>s+x.pnl,0),total_rolls:daily.reduce((m,x)=>Math.max(m,x.rolls),0)};
    return res.json({summary,daily,equity_curve,trades,filters:{mode,underlying,limit},source:'OptionEdge AI automatic trading journal',synced_at:new Date().toISOString()});
  }catch(e){return res.status(409).json({error:String(e?.message||e),source:'OptionEdge AI automatic trading journal'});}
}