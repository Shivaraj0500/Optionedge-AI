import { db } from 'hatchable';

export const access = 'user';
export const methods = ['POST'];

const UNDERLYINGS = new Set(['NIFTY 50', 'BANK NIFTY', 'SENSEX', 'BANKEX']);
const SEQUENCE = { 'BUY:CE': 1, 'BUY:PE': 2, 'SELL:CE': 3, 'SELL:PE': 4 };
const num = (v, fallback = NaN) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const intrinsic = (type, spot, strike) => type === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);

function legPnl(leg, spot) {
  const sign = leg.side === 'BUY' ? 1 : -1;
  return sign * (intrinsic(leg.option_type, spot, leg.strike) - leg.entry_price) * leg.order_quantity;
}

function payoffAt(legs, spot) { return legs.reduce((sum, leg) => sum + legPnl(leg, spot), 0); }

function breakpoints(legs) {
  const strikes = [...new Set(legs.map(x => x.strike).filter(Number.isFinite))].sort((a,b)=>a-b);
  if (!strikes.length) return [];
  const points = new Set([0, ...strikes]);
  for (let i=0;i<strikes.length-1;i++) points.add((strikes[i] + strikes[i+1]) / 2);
  points.add(strikes[strikes.length-1] + Math.max(strikes[strikes.length-1] * 0.25, 100));
  return [...points].sort((a,b)=>a-b);
}

function roots(legs) {
  const strikes = [...new Set(legs.map(x=>x.strike))].sort((a,b)=>a-b);
  const bounds = [0, ...strikes];
  if (strikes.length) bounds.push(strikes[strikes.length-1] + Math.max(strikes[strikes.length-1] * 0.25, 100));
  const out=[];
  for(let i=0;i<bounds.length-1;i++){
    const a=bounds[i], b=bounds[i+1], pa=payoffAt(legs,a), pb=payoffAt(legs,b);
    if (pa === 0) out.push(a);
    if (pa * pb < 0) out.push(a + (0-pa)*(b-a)/(pb-pa));
    if (pb === 0) out.push(b);
  }
  return [...new Set(out.map(x=>Number(x.toFixed(4))))].sort((a,b)=>a-b);
}

export default async function(req, res) {
  const body = req.body || {};
  const underlying = String(body.underlying || '');
  const expiry = String(body.expiry || '');
  const input = Array.isArray(body.legs) ? body.legs : [];
  const errors=[]; const warnings=[];
  if (!UNDERLYINGS.has(underlying)) errors.push('Unsupported underlying.');
  if (!expiry) errors.push('Resolved expiry is required.');
  if (!input.length) errors.push('At least one resolved leg is required.');

  const legs = input.map((raw,index)=>{
    const side = raw.side === 'BUY' || raw.side === 'SELL' ? raw.side : '';
    const option_type = raw.option_type === 'CE' || raw.option_type === 'PE' ? raw.option_type : '';
    const selected = raw.selected || raw;
    const contract = selected.contract || {};
    const strike=num(selected.strike);
    const entryPrice=num(selected.ltp);
    const lotSize=num(contract.lot_size);
    const lotMultiplier=num(raw.quantity, 1);
    const lots=num(raw.lots, raw.order_lots || 1);
    const rank=SEQUENCE[`${side}:${option_type}`] || 99;
    const instrument_key=String(selected.instrument_key || '');
    if(!side || !option_type) errors.push(`Leg ${index+1}: invalid side or option type.`);
    if(!instrument_key) errors.push(`Leg ${index+1}: missing instrument key.`);
    if(!Number.isFinite(strike) || strike<=0) errors.push(`Leg ${index+1}: invalid strike.`);
    if(!Number.isFinite(entryPrice) || entryPrice<0) errors.push(`Leg ${index+1}: invalid entry LTP.`);
    if(!Number.isFinite(lotSize) || lotSize<=0) errors.push(`Leg ${index+1}: missing valid broker lot size.`);
    if(!Number.isFinite(lotMultiplier) || lotMultiplier<=0 || !Number.isInteger(lotMultiplier)) errors.push(`Leg ${index+1}: quantity/lot must be a positive integer.`);
    if(!Number.isFinite(lots) || lots<=0 || !Number.isInteger(lots)) errors.push(`Leg ${index+1}: lots must be a positive integer.`);
    return {
      leg_id:String(raw.leg_id || `leg-${index+1}`), role:raw.role==='HEDGE'?'HEDGE':'PRIMARY', side, option_type,
      execution_rank:rank, strike, instrument_key, trading_symbol:contract.trading_symbol || null,
      lot_size:lotSize, lots, quantity_per_lot:lotMultiplier,
      order_quantity:Number.isFinite(lotSize)&&Number.isFinite(lotMultiplier)&&Number.isFinite(lots)?lotSize*lotMultiplier*lots:0,
      entry_price:entryPrice, premium_value:Number.isFinite(entryPrice)&&Number.isFinite(lotSize)&&Number.isFinite(lotMultiplier)&&Number.isFinite(lots)?entryPrice*lotSize*lotMultiplier*lots:0
    };
  });

  const seen=new Set();
  for(const l of legs){ if(l.instrument_key && seen.has(l.instrument_key)) errors.push(`Duplicate instrument key: ${l.instrument_key}.`); seen.add(l.instrument_key); }
  const ranks=legs.map(x=>x.execution_rank); const sorted=[...ranks].sort((a,b)=>a-b);
  if(ranks.some((x,i)=>x!==sorted[i])) errors.push('Execution order violation: BUY CE > BUY PE > SELL CE > SELL PE.');
  const primary=legs.filter(x=>x.role==='PRIMARY'); const hedge=legs.filter(x=>x.role==='HEDGE');
  if(hedge.length&&!primary.length) errors.push('Hedge legs require at least one primary leg.');
  const shortPrimary=primary.filter(x=>x.side==='SELL');
  if(shortPrimary.length && !hedge.length) warnings.push('Primary short legs have no explicit hedge legs; risk is not capped by this structure.');
  if(shortPrimary.length && hedge.length){
    const hedgeTypes=new Set(hedge.map(x=>x.option_type));
    for(const s of shortPrimary) if(!hedgeTypes.has(s.option_type)) warnings.push(`${s.option_type} primary short has no same-type hedge leg.`);
  }

  const grossShortPremium=legs.filter(x=>x.side==='SELL').reduce((s,x)=>s+x.premium_value,0);
  const hedgeCost=legs.filter(x=>x.side==='BUY'&&x.role==='HEDGE').reduce((s,x)=>s+x.premium_value,0);
  const primaryBuyCost=legs.filter(x=>x.side==='BUY'&&x.role==='PRIMARY').reduce((s,x)=>s+x.premium_value,0);
  const grossBuyPremium=legs.filter(x=>x.side==='BUY').reduce((s,x)=>s+x.premium_value,0);
  const netPremium=grossShortPremium-grossBuyPremium;
  const netPremiumPerUnit=legs.reduce((s,x)=>s+(x.side==='SELL'?1:-1)*x.entry_price*x.order_quantity,0);

  const testPoints=breakpoints(legs);
  const payoffs=testPoints.map(spot=>({spot,pnl:payoffAt(legs,spot)}));
  let maxProfit=null,maxLoss=null;
  if(payoffs.length){ maxProfit=payoffs.reduce((a,b)=>b.pnl>a.pnl?b:a); maxLoss=payoffs.reduce((a,b)=>b.pnl<a.pnl?b:a); }
  const netCallSlope=legs.reduce((s,x)=>s+(x.option_type==='CE'?(x.side==='BUY'?1:-1)*x.order_quantity:0),0);
  const netPutSlope=legs.reduce((s,x)=>s+(x.option_type==='PE'?(x.side==='SELL'?1:-1)*x.order_quantity:0),0);
  const unboundedUpside=netCallSlope>0;
  const unboundedDownside=netPutSlope<0;
  const breakevens=roots(legs);
  const valid=errors.length===0;

  return res.json({
    valid,status:valid?'POSITION_STRUCTURE_READY':'POSITION_STRUCTURE_BLOCKED',underlying,expiry,
    execution_rule:'BUY CE > BUY PE > SELL CE > SELL PE',
    execution_order:legs,
    campaign:{primary_legs:primary.length,hedge_legs:hedge.length,total_legs:legs.length},
    economics:{gross_short_premium:grossShortPremium,gross_buy_premium:grossBuyPremium,primary_buy_cost:primaryBuyCost,hedge_cost:hedgeCost,net_premium:netPremium,net_premium_per_unit:netPremiumPerUnit},
    expiry_payoff:{max_profit:maxProfit, max_loss:maxLoss, breakevens, unbounded_upside:unboundedUpside, unbounded_downside:unboundedDownside, note:'Expiry payoff is based on resolved entry LTP and broker lot sizes. It is an analytical estimate, not a broker margin guarantee.'},
    errors,warnings,live_orders_enabled:false,
    note:'Position construction is validation-only. No broker order is submitted.'
  });
}