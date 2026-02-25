-- 在 Cloudflare Dashboard 的 D1 → Console 执行下面这条
CREATE TABLE IF NOT EXISTS verify_sessions (
  token TEXT PRIMARY KEY,
  session_data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 推荐加索引（加速清理）
CREATE INDEX IF NOT EXISTS idx_expires ON verify_sessions(expires_at);
