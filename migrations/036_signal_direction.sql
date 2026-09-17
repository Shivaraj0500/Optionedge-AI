ALTER TABLE paper_campaigns ADD COLUMN IF NOT EXISTS signal_direction text;
ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS signal_direction text;