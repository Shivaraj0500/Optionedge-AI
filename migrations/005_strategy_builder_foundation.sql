CREATE TABLE strategy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategy_configs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  version_number integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  config jsonb NOT NULL,
  config_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(strategy_id, version_number)
);