import { db } from 'hatchable';
import { evaluateTransition, heikinAshi } from 'lib/transition-signal.js';

export const access='user';
export const methods=['GET'];

const U={'NIFTY 50':'NSE_INDEX|Nifty 50','BANK NIFTY':'NSE_INDEX|Nifty Bank','SENSEX':'BSE_INDEX|SENSEX','BANKEX':'BSE_INDEX|BANKEX'};
const TF={'3m':3,'5m':5,'15m':15,'30m':30,'1h':60};
const istNow=()=>new Date(Date.now()+330*60*1000);
const dateOnly=d=>d.toISOString().slice(0,10);
const shiftDate=(iso,days)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return dateOnly(d)};
const parts=tf=>tf==='1h'?['hours','1']:['minutes',String(TF[tf])];
const completed=(ts,m,now)=>new Date(ts).getTime()+m*60000<=now;
const parse=rows=>rows.map(x=>({timestamp:x[0],open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]||0),oi:Number(x[6]||0)})).filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite));

export default async function(req,res){
  const underlying=String(req.query?.underlying||'NIFTY 50'), timeframe=String(req.query?.timeframe||'15m');
  const key=U[underlying], m=TF[timeframe];
  if(!key)return res.status(400).json({error:'UNSUPPORTED_UNDERLYING'});
  if(!m)return res.status(400).json({error:'INVALID_TIMEFRAME'});
  const candleType=String(req.query?.candle_type||'HEIKIN_ASHI').toUpperCase()==='OHLC'?'OHLC':'HEIKIN_ASHI';
  const cfg={supertrend_period:Number(req.query?.supertrend_period||10),supertrend_multiplier:Number(req.query?.supertrend_multiplier||2),ema_period:Number(req.query?.ema_period||50),rsi_period:Number(req.query?.rsi_period||14),rsi_long_threshold:Number(req.query?.rsi_long_threshold||60),rsi_short_threshold:Number(req.query?.rsi_short_threshold||40)};
  if(!Number.isFinite(cfg.supertrend_period)||cfg.supertrend_period<2||!Number.isFinite(cfg.supertrend_multiplier)||cfg.supertrend_multiplier<=0||!Number.isFinite(cfg.ema_period)||cfg.ema_period<2||!Number.isFinite(cfg.rsi_period)||cfg.rsi_period<2)return res.status(400).json({error:'INVALID_INDICATOR_PARAMETERS'});
  const q=await db.query('SELECT access_token,expires_at,status FROM broker_connections WHERE user_id=$1 LIMIT 1',[req.user.id]);
  const b=q.rows[0];
  if(!b?.access_token||b.status!=='CONNECTED')return res.status(409).json({error:'UPSTOX_NOT_CONNECTED'});
  if(b.expires_at&&new Date(b.expires_at).getTime()<=Date.now())return res.status(409).json({error:'UPSTOX_TOKEN_EXPIRED'});
  const ist=istNow(),to=dateOnly(ist),from=shiftDate(to,timeframe==='3m'||timeframe==='5m'?-20:timeframe==='15m'?-30:-60);const [unit,interval]=parts(timeframe);const h={Accept:'application/json',Authorization:'Bearer '+b.access_token};
  const [hr,ir]=await Promise.all([fetch(`https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${to}/${from}`,{headers:h}),fetch(`https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(key)}/${unit}/${interval}`,{headers:h})]);
  const hd=await hr.json().catch(()=>({})),id=await ir.json().catch(()=>({}));
  if(hr.status===401||ir.status===401){await db.query("UPDATE broker_connections SET status='EXPIRED',updated_at=now() WHERE user_id=$1",[req.user.id]);return res.status(401).json({error:'UPSTOX_TOKEN_EXPIRED'})}
  if(!hr.ok||hd.status!=='success'||!ir.ok||id.status!=='success')return res.status(502).json({error:'UPSTOX_MARKET_DATA_FAILED'});
  const map=new Map();for(const c of parse(hd.data?.candles||[]))map.set(c.timestamp,c);for(const c of parse(id.data?.candles||[]))map.set(c.timestamp,c);
  const raw=[...map.values()].sort((a,z)=>new Date(a.timestamp)-new Date(z.timestamp)).filter(c=>completed(c.timestamp,m,Date.now()));
  const basis=candleType==='HEIKIN_ASHI'?heikinAshi(raw):raw;
  const ev=evaluateTransition(basis,cfg);
  if(!ev.ready)return res.status(422).json({error:ev.reason||'SIGNAL_INDICATORS_UNAVAILABLE',candle_count:raw.length});
  const prev=basis.at(-2),cur=basis.at(-1);
  return res.json({source:'UPSTOX',as_of:new Date().toISOString(),underlying,instrument_key:key,timeframe,candle_type:candleType,previous_candle:prev?.timestamp,current_candle:cur?.timestamp,signal:ev.signal,values:ev.values,checks:ev.checks,parameters:ev.parameters});
}