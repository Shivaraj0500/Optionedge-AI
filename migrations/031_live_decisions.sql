CREATE TABLE IF NOT EXISTS live_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  campaign_id UUID NOT NULL REFERENCES live_campaigns(id) ON DELETE CASCADE,
  strategy_id UUID REFERENCES strategy_configs(id) ON DELETE SET NULL,
  strategy_version INTEGER NOT NULL DEFAULT 1,
  candle_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  regime TEXT,
  indicators JSONB NOT NULL DEFAULT '{}'::jsonb,
  signal JSONB NOT NULL DEFAULT '{}'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  cycle_at TIMESTAMPTZ NOT NULL DEFAULT now()
)