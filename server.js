// ============================================================
// REDZ KEY SYSTEM - Backend (Express + Supabase)
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ---------- Validação de variáveis de ambiente obrigatórias ----------
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_KEY', 'ADMIN_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ ERRO: variável de ambiente "${key}" não definida. Confira seu .env`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(express.json());

// ============================================================
// RATE LIMITING (em memória) — 5 requisições / minuto por HWID/IP
// ============================================================
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX = 5;
const rateLimitMap = new Map(); // chave -> [timestamps]

function isRateLimited(identifier) {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(identifier) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );

  if (timestamps.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(identifier, timestamps);
    return true;
  }

  timestamps.push(now);
  rateLimitMap.set(identifier, timestamps);
  return false;
}

// Limpeza periódica do mapa de rate limit (evita memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitMap.entries()) {
    const filtered = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (filtered.length === 0) {
      rateLimitMap.delete(key);
    } else {
      rateLimitMap.set(key, filtered);
    }
  }
}, 5 * 60 * 1000); // a cada 5 minutos

// ============================================================
// MIDDLEWARE: Proteção Admin (API Key)
// ============================================================
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (!token || token !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: 'Não autorizado' });
  }
  next();
}

// ============================================================
// HELPERS
// ============================================================
function generateKeyCode() {
  // Formato: REDZ-XXXX-XXXX-XXXX-XXXX
  const segment = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `REDZ-${segment()}-${segment()}-${segment()}-${segment()}`;
}

function isValidHwidFormat(hwid) {
  return typeof hwid === 'string' && /^[a-f0-9]{16,128}$/i.test(hwid);
}

// ============================================================
// ROTA: Health check (útil para o Render confirmar que está no ar)
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'REDZ Key System', time: new Date().toISOString() });
});

// ============================================================
// ROTA: Validar Key + HWID (chamada pelo runner.lua)
// POST /api/validate
// body: { key: string, hwid: string }
// ============================================================
app.post('/api/validate', async (req, res) => {
  try {
    const { key, hwid } = req.body || {};

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, error: 'Key ausente ou inválida' });
    }
    if (!hwid || !isValidHwidFormat(hwid)) {
      return res.status(400).json({ success: false, error: 'HWID ausente ou inválido' });
    }

    // Rate limit por HWID (evita brute force de keys)
    if (isRateLimited(hwid)) {
      return res.status(429).json({
        success: false,
        error: 'Muitas tentativas. Aguarde 1 minuto e tente novamente.',
      });
    }

    // Busca a key no banco
    const { data: keyRow, error: fetchError } = await supabase
      .from('keys')
      .select('*')
      .eq('key_code', key.trim())
      .maybeSingle();

    if (fetchError) {
      console.error('Erro Supabase (select):', fetchError.message);
      return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
    }

    if (!keyRow) {
      return res.status(404).json({ success: false, error: 'Key não encontrada' });
    }

    if (!keyRow.is_active) {
      return res.status(403).json({ success: false, error: 'Key revogada' });
    }

    const expiresAt = new Date(keyRow.expires_at);
    if (expiresAt.getTime() <= Date.now()) {
      return res.status(403).json({ success: false, error: 'Key expirada' });
    }

    // HWID: vincula na 1ª validação, senão compara
    if (!keyRow.hwid) {
      const { error: updateError } = await supabase
        .from('keys')
        .update({ hwid, last_used: new Date().toISOString() })
        .eq('id', keyRow.id);

      if (updateError) {
        console.error('Erro Supabase (bind hwid):', updateError.message);
        return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
      }

      return res.json({
        success: true,
        message: 'Key validada e vinculada a este dispositivo.',
        expires_at: keyRow.expires_at,
      });
    }

    if (keyRow.hwid !== hwid) {
      return res.status(403).json({
        success: false,
        error: 'Esta key já está vinculada a outro dispositivo.',
      });
    }

    // HWID confere -> atualiza last_used
    await supabase
      .from('keys')
      .update({ last_used: new Date().toISOString() })
      .eq('id', keyRow.id);

    return res.json({
      success: true,
      message: 'Key válida.',
      expires_at: keyRow.expires_at,
    });
  } catch (err) {
    console.error('Erro inesperado /api/validate:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ============================================================
// ROTA (ADMIN): Gerar nova key
// POST /api/generate-key
// header: Authorization: Bearer ADMIN_API_KEY
// body: { days: number }
// ============================================================
app.post('/api/generate-key', requireAdmin, async (req, res) => {
  try {
    const days = Number(req.body?.days);

    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      return res.status(400).json({ success: false, error: 'Campo "days" inválido (1-3650)' });
    }

    const keyCode = generateKeyCode();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('keys')
      .insert({
        key_code: keyCode,
        hwid: null,
        expires_at: expiresAt,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error('Erro Supabase (insert):', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao gerar key' });
    }

    return res.json({ success: true, key: data.key_code, expires_at: data.expires_at });
  } catch (err) {
    console.error('Erro inesperado /api/generate-key:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ============================================================
// ROTA (ADMIN): Listar todas as keys
// GET /api/keys
// ============================================================
app.get('/api/keys', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('keys')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Erro Supabase (list):', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao listar keys' });
    }

    return res.json({ success: true, keys: data });
  } catch (err) {
    console.error('Erro inesperado /api/keys:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ============================================================
// ROTA (ADMIN): Revogar key
// POST /api/revoke-key
// body: { id: string }
// ============================================================
app.post('/api/revoke-key', requireAdmin, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ success: false, error: 'ID ausente' });
    }

    const { error } = await supabase
      .from('keys')
      .update({ is_active: false })
      .eq('id', id);

    if (error) {
      console.error('Erro Supabase (revoke):', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao revogar key' });
    }

    return res.json({ success: true, message: 'Key revogada com sucesso' });
  } catch (err) {
    console.error('Erro inesperado /api/revoke-key:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ============================================================
// ROTA (ADMIN): Resetar HWID de uma key (útil se cliente trocar de PC)
// POST /api/reset-hwid
// body: { id: string }
// ============================================================
app.post('/api/reset-hwid', requireAdmin, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ success: false, error: 'ID ausente' });
    }

    const { error } = await supabase
      .from('keys')
      .update({ hwid: null })
      .eq('id', id);

    if (error) {
      console.error('Erro Supabase (reset-hwid):', error.message);
      return res.status(500).json({ success: false, error: 'Erro ao resetar HWID' });
    }

    return res.json({ success: true, message: 'HWID resetado com sucesso' });
  } catch (err) {
    console.error('Erro inesperado /api/reset-hwid:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ============================================================
// ROTA: Servir o script principal PROTEGIDO (main.lua)
// Só entrega o código se a validação foi feita com sucesso (token curto)
// GET /api/main-script?key=...&hwid=...
// ============================================================
app.get('/api/main-script', async (req, res) => {
  try {
    const { key, hwid } = req.query;

    if (!key || !hwid || !isValidHwidFormat(String(hwid))) {
      return res.status(400).send('-- Acesso negado');
    }

    const { data: keyRow, error } = await supabase
      .from('keys')
      .select('*')
      .eq('key_code', String(key).trim())
      .maybeSingle();

    if (error || !keyRow || !keyRow.is_active) {
      return res.status(403).send('-- Acesso negado');
    }

    if (new Date(keyRow.expires_at).getTime() <= Date.now()) {
      return res.status(403).send('-- Key expirada');
    }

    if (keyRow.hwid !== hwid) {
      return res.status(403).send('-- HWID não corresponde');
    }

    // Aqui você entregaria o conteúdo real do main.lua.
    // Recomendado: ler de um arquivo local no servidor (fora do repo público)
    // ou de um storage privado, nunca do GitHub público.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(`
-- main.lua carregado com sucesso via REDZ Key System
print("REDZ Script carregado! Bem-vindo.")
`);
  } catch (err) {
    console.error('Erro inesperado /api/main-script:', err);
    return res.status(500).send('-- Erro interno');
  }
});

// ============================================================
// 404 handler
// ============================================================
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Rota não encontrada' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ REDZ Key System rodando na porta ${PORT}`);
});
