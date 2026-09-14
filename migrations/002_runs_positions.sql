CREATE TABLE IF NOT EXISTS strategy_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  strategy_id UUID NOT NULL REFERENCES strategy_configs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'BACKTEST',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  underlying TEXT NOT NULL,
  entry_spot NUMERIC,
  exit_spot NUMERIC,
  pnl NUMERIC,
  notes TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)