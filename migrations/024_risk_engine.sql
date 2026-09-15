CREATE TABLE IF NOT EXISTS risk_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE DEFAULT current_setting('hatchable.user_id', true),
  max_daily_loss NUMERIC NOT NULL DEFAULT 50000,
  max_campaign_loss NUMERIC NOT NULL DEFAULT 100000,
  max_position_quantity INTEGER NOT NULL DEFAULT 100000,
  max_rolls INTEGER NOT NULL DEFAULT 5,
  max_premium_exposure NUMERIC NOT NULL DEFAULT 1000000,
  max_spread_pct NUMERIC NOT NULL DEFAULT 10,
  stale_data_seconds INTEGER NOT NULL DEFAULT 1800,
  kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)