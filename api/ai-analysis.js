import { ai, db } from 'hatchable';

export const access = 'user';
export const methods = ['GET', 'POST'];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateWithRetry(opts) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await ai.generateText(opts); }
    catch (error) {
      lastError = error;
      const message = String(error?.message || error || '');
      const transient = /\b(429|500|502|503|504)\b|high demand|temporar|unavailable|overloaded/i.test(message);
      if (!transient || attempt === 1) throw error;
      await sleep(800);
    }
  }
  throw lastError || new Error('AI_PROVIDER_UNAVAILABLE');
}

export default async function(req, res) {
  const userId = req.user.id;
  try {
    const strategyQ = await db.query('SELECT * FROM strategy_configs WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 1', [userId]);
    const strategy = strategyQ.rows[0] || null;
    const campaignQ = await db.query('SELECT * FROM paper_campaigns WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1', [userId]);
    const campaign = campaignQ.rows[0] || null;
    const riskQ = await db.query('SELECT * FROM risk_configs WHERE user_id=$1 LIMIT 1', [userId]);
    const risk = riskQ.rows[0] || null;
    const bt = await db.query('SELECT * FROM backtest_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5', [userId]);
    const decisionQ = campaign ? await db.query('SELECT * FROM paper_decisions WHERE user_id=$1 AND campaign_id=$2 ORDER BY cycle_at DESC LIMIT 1', [userId, campaign.id]) : { rows: [] };
    const decision = decisionQ.rows[0] || null;
    const context = {
      strategy: strategy ? { ...strategy, secret: undefined } : null,
      campaign: campaign ? { id: campaign.id, status: campaign.status, strategy_id: campaign.strategy_id, strategy_version: campaign.strategy_version, realized_pnl: campaign.realized_pnl, last_status: campaign.last_status, last_reason: campaign.last_reason, last_cycle_at: campaign.last_cycle_at } : null,
      risk: risk ? { ...risk, kill_switch: Boolean(risk.kill_switch) } : null,
      latest_decision: decision,
      backtests: bt.rows.map(r => ({ id:r.id, created_at:r.created_at, strategy_id:r.strategy_id, strategy_version:r.strategy_version, status:r.status, metrics:r.metrics }))
    };
    const prompt = `Analyze the following OptionEdge AI state as a conservative institutional risk/research copilot. Return ONLY valid JSON with exactly these keys: regime (string), thesis (string), risks (array of concise strings), safeguards (array of concise strings), confidence (string: HIGH/MEDIUM/LOW/INSUFFICIENT_DATA), next_step (string). Do not predict prices, promise returns, invent missing data, or place/authorize orders. Distinguish verified data from missing data. If live market context is absent, say so. The deterministic strategy and Risk Engine are authoritative; AI may explain or flag, but must never override them. A running paper campaign is simulation only.\n\nSTATE:\n${JSON.stringify(context)}`;
    // Use Hatchable's configured BYOK provider rather than hard-coding a model
    // family. This keeps the copilot aligned with the provider key configured
    // by the project owner (OpenAI in this deployment).
    const r = await generateWithRetry({ prompt, system: 'You are a risk-aware quantitative options research copilot. Valid JSON only. Never invent facts.', purpose: 'options-risk-copilot', userId });
    if (r.finishReason === 'length' || r.finishReason === 'max_tokens') throw new Error('AI_RESPONSE_TRUNCATED');
    let text = (r.text || r.output || '').replace(/^```json\s*/, '').replace(/```$/, '').trim();
    const analysis = JSON.parse(text);
    const required = ['regime','thesis','risks','safeguards','confidence','next_step'];
    if (!required.every(k => Object.prototype.hasOwnProperty.call(analysis, k)) || !Array.isArray(analysis.risks) || !Array.isArray(analysis.safeguards)) throw new Error('AI returned an invalid response contract');
    const saved = await db.query(`INSERT INTO ai_copilot_runs (user_id,strategy_id,strategy_version,campaign_id,request_context,response,model) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at`, [userId, strategy?.id || null, strategy?.version || null, campaign?.id || null, JSON.stringify(context), JSON.stringify(analysis), r.model || 'gemini']);
    await db.query(`INSERT INTO audit_events (user_id,event_type,entity_type,entity_id,details) VALUES ($1,$2,$3,$4,$5)`, [userId, 'AI_COPILOT_ANALYSIS', 'ai_copilot_run', saved.rows[0].id, JSON.stringify({confidence:analysis.confidence, strategy_id:strategy?.id || null, campaign_id:campaign?.id || null})]);
    return res.json({ analysis, run_id: saved.rows[0].id, created_at: saved.rows[0].created_at, context_summary: {strategy_version:strategy?.version || null, campaign_status:campaign?.status || 'NONE', live_context_verified:Boolean(decision), backtests:bt.rows.length} });
  } catch (error) {
    console.error('AI copilot failed', error);
    return res.status(502).json({ error: 'AI_COPILOT_UNAVAILABLE', detail: 'Configured AI provider is temporarily unavailable or returned an invalid response. No AI conclusion was stored.' });
  }
}