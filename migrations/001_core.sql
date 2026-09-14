CREATE TABLE IF NOT EXISTS strategy_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  underlying TEXT NOT NULL DEFAULT 'NIFTY 50',
  timeframe TEXT NOT NULL DEFAULT '15m',
  adx_threshold NUMERIC NOT NULL DEFAULT 22,
  atr_multiplier NUMERIC NOT NULL DEFAULT 2,
  square_off TEXT NOT NULL DEFAULT '15:15',
  overnight_exposure BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)