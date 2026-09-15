import { db } from 'hatchable';

export const access = 'user';
export const methods = ['GET'];

export default async function(req,res){
  const uid=req.user.id;
  const runId=String(req.query?.run_id||'');
  if(!runId)return res.status(400).json({error:'run_id required'});
  const run=(await db.query('SELECT * FROM backtest_runs WHERE id=$1 AND user_id=$2 LIMIT 1',[runId,uid])).rows[0];
  if(!run)return res.status(404).json({error:'BACKTEST_RUN_NOT_FOUND'});
  const q=await db.query(`SELECT id,structure_id,entry_at,exit_at,action,exit_reason,underlying_spot,option_type,side,role,strike,quantity,entry_price,exit_price,gross_pnl,fees,slippage,net_pnl FROM backtest_trades WHERE run_id=$1 AND user_id=$2 ORDER BY COALESCE(exit_at,entry_at),id`,[runId,uid]);
  const rows=q.rows;
  const exits=rows.filter(x=>x.action==='EXIT');
  const daily=new Map(), structures=new Map(), roles=new Map();
  let equity=0,peak=0,maxDd=0,bestDay=null,worstDay=null;
  for(const x of exits){
    const pnl=Number(x.net_pnl||0); equity+=pnl; peak=Math.max(peak,equity); maxDd=Math.min(maxDd,equity-peak);
    const day=String(x.exit_at||'').slice(0,10); daily.set(day,(daily.get(day)||0)+pnl);
    const sid=String(x.structure_id); const s=structures.get(sid)||{structure_id:sid,pnl:0,legs:0,reason:x.exit_reason||'UNKNOWN'}; s.pnl+=pnl;s.legs++;structures.set(sid,s);
    const role=x.role||'UNKNOWN'; roles.set(role,(roles.get(role)||0)+pnl);
  }
  const dailyRows=[...daily.entries()].map(([date,pnl])=>({date,pnl}));
  for(const d of dailyRows){if(bestDay===null||d.pnl>bestDay.pnl)bestDay=d;if(worstDay===null||d.pnl<worstDay.pnl)worstDay=d;}
  const wins=exits.filter(x=>Number(x.net_pnl)>0),losses=exits.filter(x=>Number(x.net_pnl)<0);
  const result={run:{id:run.id,strategy_id:run.strategy_id,strategy_version:run.strategy_version,underlying:run.underlying,timeframe:run.timeframe,start_date:run.start_date,end_date:run.end_date,expiry_date:run.expiry_date,status:run.status,data_quality:run.data_quality,engine_version:run.engine_version},metrics:{total_pnl:Number(run.total_pnl||0),gross_pnl:Number(run.gross_pnl||0),fees:Number(run.fees||0),slippage:Number(run.slippage||0),trades:exits.length,wins:wins.length,losses:losses.length,win_rate:run.win_rate==null?null:Number(run.win_rate),profit_factor:run.profit_factor==null?null:Number(run.profit_factor),expectancy:run.expectancy==null?null:Number(run.expectancy),avg_win:run.avg_win==null?null:Number(run.avg_win),avg_loss:run.avg_loss==null?null:Number(run.avg_loss),max_drawdown:Number(run.max_drawdown||0),structures:Number(run.total_structures||0),rolls:Number(run.rolls||0),best_day:bestDay,worst_day:worstDay},daily:dailyRows,structures:[...structures.values()],role_pnl:[...roles.entries()].map(([role,pnl])=>({role,pnl})),equity:dailyRows.reduce((a,d)=>{const last=a.length?a[a.length-1].equity:0;a.push({date:d.date,equity:last+d.pnl});return a},[]),disclosure:'Analytics are derived only from recorded historical backtest exit legs. Historical option fills use Upstox candle closes plus configured slippage; no synthetic chain snapshots are introduced.'};
  res.json(result);
}