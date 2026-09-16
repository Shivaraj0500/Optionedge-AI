import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

const UNDERLYINGS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'BANK NIFTY': 'NSE_INDEX|Nifty Bank'
};

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function fmtError(e) { return String(e?.message || 'DATA_UNAVAILABLE'); }

async function broker(userId) {
  const q = await db.query('SELECT access_token, expires_at, status FROM broker_connections WHERE user_id=$1 LIMIT 1', [userId]);
  const c = q.rows[0];
  if (!c || c.status !== 'CONNECTED' || !c.access_token) throw new Error('UPSTOX_NOT_CONNECTED');
  if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) throw new Error('UPSTOX_TOKEN_EXPIRED');
  return c;
}

async function liveLtp(connection, instrumentKeys) {
  const keys = [...new Set((instrumentKeys || []).filter(Boolean))];
  if (!keys.length) return {};
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };
  const url = 'https://api.upstox.com/v3/market-quote/ltp?instrument_key=' + encodeURIComponent(keys.join(','));
  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('UPSTOX_TOKEN_EXPIRED');
  if (!response.ok || data.status !== 'success') throw new Error('UPSTOX_LTP_FAILED');
  const out = {};
  for (const [key, value] of Object.entries(data.data || {})) {
    const price = n(value?.last_price);
    if (price == null) continue;
    out[key] = price;
    if (value?.instrument_token) out[value.instrument_token] = price;
  }
  return out;
}

async function liveIndex(connection, underlying, timeframe = '15m') {
  const instrumentKey = UNDERLYINGS[underlying];
  const minutes = timeframe === '3m' ? 3 : timeframe === '5m' ? 5 : timeframe === '30m' ? 30 : timeframe === '1h' ? 60 : 15;
  const unit = minutes === 60 ? 'hours' : 'minutes';
  const interval = String(minutes === 60 ? 1 : minutes);
  const now = Date.now();
  const ist = new Date(now + 330 * 60 * 1000);
  const toDate = ist.toISOString().slice(0, 10);
  const from = new Date(ist.getTime() - 20 * 86400000);
  const fromDate = from.toISOString().slice(0, 10);
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + connection.access_token };
  const [hist, intra] = await Promise.all([
    fetch(`https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${toDate}/${fromDate}`, { headers }),
    fetch(`https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`, { headers })
  ]);
  const hd = await hist.json().catch(() => ({}));
  const id = await intra.json().catch(() => ({}));
  if (hist.status === 401 || intra.status === 401) throw new Error('UPSTOX_TOKEN_EXPIRED');
  if (!hist.ok || hd.status !== 'success') throw new Error('UPSTOX_HISTORICAL_DATA_FAILED');
  if (!intra.ok || id.status !== 'success') throw new Error('UPSTOX_INTRADAY_DATA_FAILED');
  const map = new Map();
  for (const row of [...(hd.data?.candles || []), ...(id.data?.candles || [])]) {
    const ts = row?.[0];
    const close = n(row?.[4]);
    if (ts && close != null) map.set(ts, { timestamp: ts, open: n(row[1]), high: n(row[2]), low: n(row[3]), close, volume: n(row[5], 0) });
  }
  const candles = [...map.values()].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  if (!candles.length) throw new Error('MARKET_DATA_UNAVAILABLE');
  const last = candles[candles.length - 1];
  // Wilder-style ADX/DI, matching the existing indicator engine.
  const period = 14, tr=[], plus=[], minus=[];
  for (let i=1;i<candles.length;i++) {
    const p=candles[i-1], c=candles[i], up=c.high-p.high, down=p.low-c.low;
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
    plus.push(up>down&&up>0?up:0); minus.push(down>up&&down>0?down:0);
  }
  if (tr.length < period*2) throw new Error('INSUFFICIENT_CANDLES');
  let atr=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  let pDm=plus.slice(0,period).reduce((a,b)=>a+b,0)/period;
  let mDm=minus.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const dx=[]; let plusDi=0, minusDi=0;
  for(let i=period-1;i<tr.length;i++){
    if(i>=period){atr=((atr*(period-1))+tr[i])/period;pDm=((pDm*(period-1))+plus[i])/period;mDm=((mDm*(period-1))+minus[i])/period;}
    if(atr>0){plusDi=100*pDm/atr;minusDi=100*mDm/atr;const den=plusDi+minusDi;dx.push(den?100*Math.abs(plusDi-minusDi)/den:0);}
  }
  if(dx.length<period) throw new Error('INSUFFICIENT_CANDLES');
  let adx=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<dx.length;i++) adx=((adx*(period-1))+dx[i])/period;
  const liveQuotes = await liveLtp(connection, [instrumentKey]);
  const liveSpot = n(liveQuotes[instrumentKey]);
  return { underlying, timeframe, price:liveSpot ?? last.close, price_source:liveSpot!=null?'UPSTOX_LTP_V3':'UPSTOX_CANDLE_CLOSE', adx, plus_di:plusDi, minus_di:minusDi, atr, indicator_candle:last.timestamp, indicator_live:true, source:'UPSTOX' };
}

export default async function(req,res){
  const userId=req.user.id;
  const tf=String(req.query?.timeframe||'15m');
  try {
    const connection=await broker(userId);
    const [nifty, banknifty, tradesQ]=await Promise.all([
      liveIndex(connection,'NIFTY 50',tf).catch(e=>({underlying:'NIFTY 50',error:fmtError(e),source:'UPSTOX'})),
      liveIndex(connection,'BANK NIFTY',tf).catch(e=>({underlying:'BANK NIFTY',error:fmtError(e),source:'UPSTOX'})),
      db.query(`SELECT l.id,l.campaign_id,l.strategy_id,l.strategy_version,l.role,l.side,l.option_type,l.execution_rank,l.expiry,l.strike,l.trading_symbol,l.instrument_key,l.quantity,l.entry_price,l.current_price,l.pnl,l.status,l.entry_at,l.last_mark_at,c.underlying,c.status AS campaign_status,c.started_at FROM paper_campaign_legs l JOIN paper_campaigns c ON c.id=l.campaign_id AND c.user_id=l.user_id WHERE l.user_id=$1 AND l.status='OPEN' AND c.status='RUNNING' ORDER BY c.started_at DESC,l.execution_rank ASC`,[userId])
    ]);
    const rawTrades = tradesQ.rows.map(t=>({...t,strike:n(t.strike),quantity:n(t.quantity,0),entry_price:n(t.entry_price),current_price:n(t.current_price),pnl:n(t.pnl,0)}));
    const liveQuotes = await liveLtp(connection, rawTrades.map(t => t.instrument_key));
    const trades = rawTrades.map(t => {
      const livePrice = n(liveQuotes[t.instrument_key]);
      const currentPrice = livePrice ?? t.current_price;
      const pnl = Number.isFinite(livePrice) ? (t.side === 'BUY' ? 1 : -1) * (livePrice - Number(t.entry_price)) * Number(t.quantity) : Number(t.pnl || 0);
      return { ...t, current_price: currentPrice, pnl, live_price: Number.isFinite(livePrice), mark_source: Number.isFinite(livePrice) ? 'UPSTOX_LTP_V3' : 'STORED_PAPER_MARK' };
    });
    const liveTrades = trades.filter(t => t.live_price);
    if (liveTrades.length) {
      await db.transaction(liveTrades.map(t => ({
        sql: 'UPDATE paper_campaign_legs SET current_price=$1,pnl=$2,last_mark_at=now() WHERE id=$3 AND user_id=$4 AND status=$5',
        params: [t.current_price, t.pnl, t.id, userId, 'OPEN']
      })));
    }
    const runningPnl=trades.reduce((s,t)=>s+Number(t.pnl||0),0);
    const campaigns=[...new Set(trades.map(t=>t.campaign_id))];
    return res.json({source:'OptionEdge AI Dashboard',as_of:new Date().toISOString(),timeframe:tf,indices:{nifty,nifty_bank:banknifty},running:{campaigns:campaigns.length,legs:trades.length,pnl:runningPnl,trades}});
  } catch(e) {
    return res.status(409).json({error:fmtError(e),source:'OptionEdge AI Dashboard'});
  }
}