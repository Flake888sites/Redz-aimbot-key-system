-- ============================================================
-- REDZ KEY SYSTEM - Schema Supabase
-- Rode este SQL no SQL Editor do seu projeto Supabase
-- ============================================================

CREATE TABLE IF NOT EXISTS keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_code TEXT NOT NULL UNIQUE,
  hwid TEXT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used TIMESTAMP WITH TIME ZONE,

  CONSTRAINT key_code_length CHECK (char_length(key_code) >= 8)
);

CREATE INDEX IF NOT EXISTS idx_key_code ON keys(key_code);
CREATE INDEX IF NOT EXISTS idx_hwid ON keys(hwid);
CREATE INDEX IF NOT EXISTS idx_expires_at ON keys(expires_at);

-- Row Level Security: o backend usa a chave "anon" para tudo,
-- então as policies abaixo liberam o necessário via API do Supabase.
-- Toda escrita sensível (gerar/revogar) passa pelo server.js, que
-- já é protegido pelo ADMIN_API_KEY antes de chegar ao Supabase.
ALTER TABLE keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_select" ON keys;
CREATE POLICY "allow_select" ON keys FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "allow_insert" ON keys;
CREATE POLICY "allow_insert" ON keys FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS "allow_update" ON keys;
CREATE POLICY "allow_update" ON keys FOR UPDATE
  USING (true);
