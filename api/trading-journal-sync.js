import { db } from 'hatchable';

export const access = 'scheduler';
export const methods = ['POST'];
export const schedule = '0 * * * *';

function istDateOnly(value) { return new Date(new Date(value || Date.now()).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10); }
function json(v) { return v && typeof v === 'object' ? v : {}; }
function n(v, d = null) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function snap(x, base) { return { name:x.name||null, underlying:x.underlying||base, timeframe:x.timeframe||null, candle_type:x.candle_type||null, start_time:x.start_time||null, square_off:x.square_off||'15:15', adx_period:x.adx_period??null, adx_threshold:x.adx_threshold??null, atr_period:x.atr_period??null, atr_multiplier:x.atr_multiplier??null, confirmation_candles:x.confirmation_candles??null, roll_mode:x.roll_mode||null, regime_rule:x.regime_rule||null, option_expiry:x.option_expiry||null, legs:x.legs||null }; }

async function syncUser(userId) {
  const [paper, live, versions, pr, lr, orders] = await Promise.all([
    db.query(`SELECT l.*,c.underlying,c.mode AS campaign_mode,c.status AS campaign_status FROM paper_campaign_legs l JOIN paper_campaigns c ON c.id=l.campaign_id AND c.user_id=l.user_id WHERE l.user_id=$1`, [userId]),
    db.query(`SELECT l.*,c.underlying,c.mode AS campaign_mode,c.status AS campaign_status FROM live_campaign_legs l JOIN live_campaigns c ON c.id=l.campaign_id AND c.user_id=l.user_id WHERE l.user_id=$1`, [userId]),
    db.query(`SELECT strategy_id,version_number,config FROM strategy_versions WHERE user_id=$1`, [userId]),
    db.query(`SELECT campaign_id,COUNT(*)::int count FROM paper_decisions WHERE user_id=$1 AND status='ROLL' GROUP BY campaign_id`, [userId]),
    db.query(`SELECT campaign_id,COUNT(*)::int count FROM live_decisions WHERE user_id=$1 AND status='ROLL' GROUP BY campaign_id`, [userId]),
    db.query(`SELECT id,broker_order_id,status,filled_quantity,average_price FROM live_orders WHERE user_id=$1`, [userId])
  ]);
  const vm=new Map(versions.rows.map(x=>[`${x.strategy_id}:${x.version_number}`,json(x.config)]));
  const pm=new Map(pr.rows.map(x=>[String(x.campaign_id),Number(x.count||0)]));
  const lm=new Map(lr.rows.map(x=>[String(x.campaign_id),Number(x.count||0)]));
  const om=new Map(orders.rows.map(x=>[String(x.id),x]));
  const rows=[];
  for(const r of paper.rows){
    const s=snap(vm.get(`${r.strategy_id}:${r.strategy_version}`)||{},r.underlying);
    rows.push([userId,'PAPER',String(r.id),r.campaign_id,r.strategy_id,Number(r.strategy_version||1),s.name,r.underlying,r.cycle_id,r.leg_id,r.role,r.side,r.option_type,r.expiry,n(r.strike),r.instrument_key,r.trading_symbol,n(r.lot_size),n(r.lots),n(r.quantity),n(r.quantity,0),n(r.entry_price),n(r.exit_price),n(r.current_price),n(r.pnl,0),r.status,r.entry_at,r.exit_at,pm.get(String(r.campaign_id))||0,JSON.stringify(s),JSON.stringify({simulated:true,metadata:json(r.metadata),campaign_mode:r.campaign_mode,campaign_status:r.campaign_status}),istDateOnly(r.exit_at||r.entry_at)]);
  }
  for(const r of live.rows){
    const s=snap(vm.get(`${r.strategy_id}:${r.strategy_version}`)||{},r.underlying),eo=om.get(String(r.entry_order_id)),xo=om.get(String(r.exit_order_id));
    rows.push([userId,'LIVE',String(r.id),r.campaign_id,r.strategy_id,Number(r.strategy_version||1),s.name,r.underlying,r.cycle_id,r.leg_id,r.role,r.side,r.option_type,r.expiry,n(r.strike),r.instrument_key,r.trading_symbol,n(r.lot_size),n(r.lots),n(r.requested_quantity),n(r.filled_quantity,0),n(r.entry_price),n(r.exit_price),n(r.current_price),n(r.pnl,0),r.status,r.entry_at,r.exit_at,lm.get(String(r.campaign_id))||0,JSON.stringify(s),JSON.stringify({live:true,entry_order_id:r.entry_order_id,exit_order_id:r.exit_order_id,entry_broker_order_id:eo?.broker_order_id||null,exit_broker_order_id:xo?.broker_order_id||null,entry_order_status:eo?.status||null,exit_order_status:xo?.status||null,entry_filled_quantity:eo?.filled_quantity??null,exit_filled_quantity:xo?.filled_quantity??null,entry_average_price:eo?.average_price??null,exit_average_price:xo?.average_price??null,metadata:json(r.metadata),campaign_mode:r.campaign_mode,campaign_status:r.campaign_status}),istDateOnly(r.exit_at||r.entry_at)]);
  }
  if(!rows.length)return 0;
  const sql=`INSERT INTO trading_journal_entries(user_id,source_mode,source_leg_id,campaign_id,strategy_id,strategy_version,strategy_name,underlying,cycle_id,leg_id,role,side,option_type,expiry,strike,instrument_key,trading_symbol,lot_size,lots,requested_quantity,filled_quantity,entry_price,exit_price,current_price,pnl,status,entry_at,exit_at,total_rolls,strategy_snapshot,execution_details,journal_date,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,now()) ON CONFLICT(user_id,source_mode,source_leg_id) DO UPDATE SET strategy_id=EXCLUDED.strategy_id,strategy_version=EXCLUDED.strategy_version,strategy_name=EXCLUDED.strategy_name,underlying=EXCLUDED.underlying,cycle_id=EXCLUDED.cycle_id,leg_id=EXCLUDED.leg_id,role=EXCLUDED.role,side=EXCLUDED.side,option_type=EXCLUDED.option_type,expiry=EXCLUDED.expiry,strike=EXCLUDED.strike,instrument_key=EXCLUDED.instrument_key,trading_symbol=EXCLUDED.trading_symbol,lot_size=EXCLUDED.lot_size,lots=EXCLUDED.lots,requested_quantity=EXCLUDED.requested_quantity,filled_quantity=EXCLUDED.filled_quantity,entry_price=EXCLUDED.entry_price,exit_price=EXCLUDED.exit_price,current_price=EXCLUDED.current_price,pnl=EXCLUDED.pnl,status=EXCLUDED.status,entry_at=EXCLUDED.entry_at,exit_at=EXCLUDED.exit_at,total_rolls=EXCLUDED.total_rolls,strategy_snapshot=EXCLUDED.strategy_snapshot,execution_details=EXCLUDED.execution_details,journal_date=EXCLUDED.journal_date,updated_at=now()`;
  await db.transaction(rows.map(p => ({sql, params:p})));
  return rows.length;
}

export default async function(req,res){
  try{
    const ids=await db.query(`SELECT DISTINCT user_id FROM (SELECT user_id FROM paper_campaign_legs UNION SELECT user_id FROM live_campaign_legs) x WHERE user_id IS NOT NULL AND user_id<>''`);
    let synced=0;
    for(const r of ids.rows) synced+=await syncUser(r.user_id);
    return res.json({ok:true,users:ids.rows.length,synced,run_at:new Date().toISOString()});
  }catch(e){ return res.status(409).json({ok:false,error:String(e?.message||e)}); }
}