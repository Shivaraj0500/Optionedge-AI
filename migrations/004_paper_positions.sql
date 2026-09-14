CREATE TABLE IF NOT EXISTS paper_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  strategy_id UUID REFERENCES strategy_configs(id) ON DELETE SET NULL,
  underlying TEXT NOT NULL,
  side TEXT NOT NULL,
  option_type TEXT NOT NULL,
  strike NUMERIC NOT NULL,
  quantity INTEGER NOT NULL,
  entry_price NUMERIC NOT NULL,
  exit_price NUMERIC,
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
)