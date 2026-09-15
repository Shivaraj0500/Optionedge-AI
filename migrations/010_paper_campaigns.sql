CREATE TABLE IF NOT EXISTS paper_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  strategy_id UUID REFERENCES strategy_configs(id) ON DELETE SET NULL,
  underlying TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  mode TEXT NOT NULL DEFAULT 'LIVE_MARKET_PAPER',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
)