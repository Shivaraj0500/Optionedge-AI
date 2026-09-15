import { ai, db } from 'hatchable';

export const access = 'user';
export const methods = ['POST'];

function clean(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

export default async function(req, res) {
  const b = req.body || {};
  const userId = req.user?.id;
  try {
    const strategyId = clean(b.strategy_id);
    let strategy = null;
    if (strategyId) {
      const s = await db.query(`SELECT id,name,version,underlying,timeframe,candle_type,start_time,square_off,overnight_exposure,adx_period,adx_threshold,atr_period,atr_multiplier,confirmation_candles,regime_rule,leg_config,option_expiry FROM strategy_configs WHERE id=$1 AND user_id=$2 LIMIT 1`, [strategyId, userId]);
      strategy = s.rows[0] || null;
    }
    const riskQ = await db.query(`SELECT max_daily_loss,max_campaign_loss,max_position_quantity,max_rolls,max_premium_exposure,max_spread_pct,stale_data_seconds,kill_switch FROM risk_configs WHERE user_id=$1 LIMIT 1`, [userId]);
    const risk = riskQ.rows[0] || null;
    const campaignQ = await db.query(`SELECT id,strategy_id,underlying,status,mode,strategy_version,entry_spot,corridor_upper,corridor_lower,active_expiry,last_status,last_reason,realized_pnl,started_at,updated_at FROM paper_campaigns WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1`, [userId]);
    const campaign = campaignQ.rows[0] || null;
    let legs = [];
    let decision = null;
    if (campaign) {
      const l = await db.query(`SELECT leg_id,role,side,option_type,execution_rank,strike,quantity,entry_price,current_price,pnl,status FROM paper_campaign_legs WHERE user_id=$1 AND campaign_id=$2 ORDER BY execution_rank`, [userId, campaign.id]);
      legs = l.rows;
      const d = await db.query(`SELECT candle_at,status,reason,regime,indicators,signal,details,cycle_at FROM paper_decisions WHERE user_id=$1 AND campaign_id=$2 ORDER BY cycle_at DESC LIMIT 1`, [userId, campaign.id]);
      decision = d.rows[0] || null;
    }
    const bt = await db.query(`SELECT id,strategy_id,strategy_version,start_date,end_date,status,total_pnl,max_drawdown,win_rate,profit_factor,expectancy,avg_win,avg_loss,total_trades,winning_trades,losing_trades,rolls,total_structures,data_quality,engine_version,created_at FROM backtest_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 3`, [userId]);

    const context = {
      strategy: strategy ? {...strategy, leg_config: strategy.leg_config} : null,
      risk,
      campaign: campaign ? {...campaign, realized_pnl: Number(campaign.realized_pnl || 0)} : null,
      active_legs: legs.map(x => ({...x, strike:Number(x.strike), quantity:Number(x.quantity), pnl:Number(x.pnl || 0), entry_price:Number(x.entry_price), current_price:x.current_price == null ? null : Number(x.current_price)})),
      latest_decision: decision ? {...decision, indicators: decision.indicators, signal: decision.signal} : null,
      recent_backtests: bt.rows.map(x => ({...x, total_pnl:Number(x.total_pnl||0), max_drawdown:Number(x.max_drawdown||0), win_rate:x.win_rate==null?null:Number(x.win_rate), profit_factor:x.profit_factor==null?null:Number(x.profit_factor), expectancy:x.expectancy==null?null:Number(x.expectancy)})),
      user_market_context: b.market_context || null
    };

    const prompt = `Analyze the following OptionEdge AI state as a conservative institutional risk/research copilot. Return ONLY valid JSON with exactly these keys: regime (string), thesis (string), risks (array of concise strings), safeguards (array of concise strings), confidence (string: HIGH/MEDIUM/LOW/INSUFFICIENT_DATA), next_step (string). Do not predict prices, promise returns, invent missing data, or place/authorize orders. Distinguish verified data from missing data. If live market context is absent, say so. The deterministic strategy and Risk Engine are authoritative; AI may explain or flag, but must never override them. A running paper campaign is simulation only.\n\nSTATE:\n${JSON.stringify(context)}`;
    const r = await ai.generateText({ model: 'gemini', prompt, system: 'You are a risk-aware quantitative options research copilot. Valid JSON only. Never invent facts.', purpose: 'options-risk-copilot', userId });
    let text = (r.text || r.output || '').replace(/^```json\s*/, '').replace(/```$/, '').trim();
    const analysis = JSON.parse(text);
    const required = ['regime','thesis','risks','safeguards','confidence','next_step'];
    if (!required.every(k => Object.prototype.hasOwnProperty.call(analysis, k)) || !Array.isArray(analysis.risks) || !Array.isArray(analysis.safeguards)) throw new Error('AI returned an invalid response contract');
    const saved = await db.query(`INSERT INTO ai_copilot_runs (user_id,strategy_id,strategy_version,campaign_id,request_context,response,model) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`, [userId, strategy?.id || null, strategy?.version || null, campaign?.id || null, JSON.stringify(context), JSON.stringify(analysis), r.model || 'gemini']);
    await db.query(`INSERT INTO audit_events (user_id,event_type,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5)`, [userId, 'AI_COPILOT_ANALYSIS', 'ai_copilot_run', saved.rows[0].id, JSON.stringify({confidence:analysis.confidence, strategy_id:strategy?.id || null, campaign_id:campaign?.id || null})]);
    return res.json({ analysis, run_id: saved.rows[0].id, created_at: saved.rows[0].created_at, context_summary: {strategy_version:strategy?.version || null, campaign_status:campaign?.status || 'NONE', live_context_verified:Boolean(decision), backtests:bt.rows.length} });
  } catch (e) {
    console.error('AI copilot failed', e);
    return res.status(502).json({ error: e.message === 'AI returned an invalid response contract' ? e.message : 'AI Risk Copilot is unavailable until the configured AI provider is available. No AI conclusion was stored.' });
  }
}