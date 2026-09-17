import { db } from 'hatchable';

export const access='user';
export const methods=['GET'];

function modelLabel(model){
  if(model==='ST_EMA_RSI_TRANSITION') return 'ST + EMA + RSI Transition';
  if(model==='LEGACY_ADX_RANGE') return 'Option Selling';
  return model || 'Strategy';
}

function summarize(c){
  const sc=c.config&&typeof c.config==='object'?c.config:{};
  const bits=[];
  if(sc.timeframe)bits.push(sc.timeframe);
  if(sc.candle_type)bits.push(sc.candle_type==='HEIKIN_ASHI'?'Heikin Ashi':'OHLC');
  if(sc.signal_model==='ST_EMA_RSI_TRANSITION'&&sc.signal_config){
    const x=sc.signal_config;
    bits.push(`ST(${x.supertrend_period},${x.supertrend_multiplier})`);
    bits.push(`EMA(${x.ema_period})`);
    bits.push(`RSI(${x.rsi_period}) ${x.rsi_short_threshold}/${x.rsi_long_threshold}`);
    bits.push(x.trade_direction||'BOTH');
  } else {
    if(sc.adx_period!=null)bits.push(`ADX(${sc.adx_period})`);
    if(sc.adx_threshold!=null)bits.push(`Entry < ${sc.adx_threshold}`);
    if(sc.atr_period!=null)bits.push(`ATR(${sc.atr_period})`);
  }
  if(sc.underlying)bits.push(sc.underlying);
  return bits.join(' · ');
}

export default async function(req,res){
  const uid=req.user.id;
  const q=await db.query(`SELECT s.id strategy_id,s.name strategy_name,s.signal_model,s.underlying,s.timeframe,s.enabled strategy_enabled,
      v.id version_id,v.version_number,v.status,v.config,v.created_at version_created_at
    FROM strategy_configs s
    JOIN strategy_versions v ON v.strategy_id=s.id AND v.user_id=s.user_id
    WHERE s.user_id=$1
    ORDER BY s.signal_model,s.updated_at DESC,v.version_number DESC`,[uid]);
  const groups=new Map();
  for(const r of q.rows){
    if(!groups.has(r.strategy_id)) groups.set(r.strategy_id,{id:r.strategy_id,name:r.strategy_name,signal_model:r.signal_model||'LEGACY_ADX_RANGE',strategy_type:modelLabel(r.signal_model||'LEGACY_ADX_RANGE'),underlying:r.underlying,timeframe:r.timeframe,enabled:r.strategy_enabled,versions:[]});
    groups.get(r.strategy_id).versions.push({id:r.version_id,version:r.version_number,status:r.status,created_at:r.version_created_at,summary:summarize(r)});
  }
  const strategies=[...groups.values()];
  return res.json({strategies,defaults:{legacy_label:'Option Selling',transition_label:'ST + EMA + RSI Transition'}});
}