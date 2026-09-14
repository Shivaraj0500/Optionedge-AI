import { ai } from 'hatchable';

export const access = 'user';
export const methods = ['POST'];

export default async function(req, res) {
  const b = req.body || {};
  const prompt = `Act as a conservative quantitative options-selling research assistant. Analyze this proposed Indian index option-selling setup: underlying=${b.underlying || 'NIFTY 50'}, timeframe=${b.timeframe || '15m'}, ADX threshold=${b.adx || 22}, ATR corridor=${b.atr || 2}x ATR, entry=ATM short CE + ATM short PE, roll only after a confirmed candle close outside the corridor, square-off=${b.squareOff || '15:15'}, overnight exposure=none. Return concise JSON with keys regime, thesis, risks, safeguards, next_step. Do not predict prices or guarantee returns. Emphasize that live execution requires verified market data, broker connectivity, position limits, and human approval.`;
  try {
    const r = await ai.generateText({ model: 'sonnet', prompt, system: 'You are an institutional-style risk-aware options research copilot. Valid JSON only.', purpose: 'options-strategy-analysis' });
    let text = (r.text || r.output || '').replace(/^```json\s*/, '').replace(/```$/, '').trim();
    return res.json({ analysis: JSON.parse(text) });
  } catch (e) {
    console.error('AI analysis failed', e);
    return res.status(502).json({ error: 'AI analysis is not available until the Anthropic provider key is configured in Hatchable Setup.' });
  }
}