ALTER TABLE paper_campaigns ADD COLUMN IF NOT EXISTS strategy_version_id uuid;
ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS strategy_version_id uuid;
ALTER TABLE trading_journal_entries ADD COLUMN IF NOT EXISTS strategy_version_id uuid;

UPDATE paper_campaigns c SET strategy_version_id=v.id FROM strategy_versions v WHERE c.strategy_version_id IS NULL AND v.strategy_id=c.strategy_id AND v.user_id=c.user_id AND v.version_number=c.strategy_version;
UPDATE live_campaigns c SET strategy_version_id=v.id FROM strategy_versions v WHERE c.strategy_version_id IS NULL AND v.strategy_id=c.strategy_id AND v.user_id=c.user_id AND v.version_number=c.strategy_version;
UPDATE trading_journal_entries j SET strategy_version_id=v.id FROM strategy_versions v WHERE j.strategy_version_id IS NULL AND v.strategy_id=j.strategy_id AND v.user_id=j.user_id AND v.version_number=j.strategy_version;

CREATE INDEX IF NOT EXISTS idx_strategy_versions_user_strategy ON strategy_versions(user_id, strategy_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_paper_campaigns_strategy_version ON paper_campaigns(user_id, strategy_id, strategy_version_id);
CREATE INDEX IF NOT EXISTS idx_live_campaigns_strategy_version ON live_campaigns(user_id, strategy_id, strategy_version_id);