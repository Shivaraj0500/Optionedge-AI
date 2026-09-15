CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  strategy_id UUID NOT NULL REFERENCES strategy_configs(id) ON DELETE CASCADE,
  strategy_version INTEGER NOT NULL,
  underlying TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  candle_type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  expiry_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  initial_capital NUMERIC,
  realized_pnl NUMERIC NOT NULL DEFAULT 0,
  total_pnl NUMERIC NOT NULL DEFAULT 0,
  total_trades INTEGER NOT NULL DEFAULT 0,
  winning_trades INTEGER NOT NULL DEFAULT 0,
  losing_trades INTEGER NOT NULL DEFAULT 0,
  fees NUMERIC NOT NULL DEFAULT 0,
  slippage NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  structure_id TEXT NOT NULL,
  entry_at TIMESTAMPTZ NOT NULL,
  exit_at TIMESTAMPTZ,
  action TEXT NOT NULL,
  exit_reason TEXT,
  underlying_spot NUMERIC,
  option_type TEXT NOT NULL,
  side TEXT NOT NULL,
  role TEXT NOT NULL,
  strike NUMERIC NOT NULL,
  instrument_key TEXT,
  trading_symbol TEXT,
  quantity INTEGER NOT NULL,
  entry_price NUMERIC NOT NULL,
  exit_price NUMERIC,
  gross_pnl NUMERIC NOT NULL DEFAULT 0,
  fees NUMERIC NOT NULL DEFAULT 0,
  slippage NUMERIC NOT NULL DEFAULT 0,
  net_pnl NUMERIC NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_user ON backtest_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id, entry_at);