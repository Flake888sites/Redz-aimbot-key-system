const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

// ==================== CONFIGURAÇÃO ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // Para gerar chaves via HTML

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==================== FUNÇÕES AUXILIARES ====================

// Gera uma chave aleatória formatada
function gerarChave() {
  const partes = [];
  for (let i = 0; i < 4; i++) {
    partes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return partes.join('-');
}

// Calcula o hash HWID (simplificado para o exemplo)
function calcularHashHWID(hwid) {
  return crypto.createHash('sha256').update(hwid).digest('hex');
}

// Verifica se uma chave expirou
async function chaveExpirou(chaveData) {
  const agora = new Date();
  const expiracaoData = new Date(chaveData.expira_em);
  return agora > expiracaoData;
}

// ==================== ROTAS DE AUTENTICAÇÃO ====================

// Verifica se a chave é válida e retorna informações
app.post('/api/verificar-chave', async (req, res) => {
  try {
    const { chave, hwid } = req.body;

    if (!chave || !hwid) {
      return res.status(400).json({ sucesso: false, erro: 'Chave e HWID são obrigatórios' });
    }

    // Busca a chave no banco de dados
    const { data, error } = await supabase
      .from('chaves')
      .select('*')
      .eq('chave', chave)
      .single();

    if (error || !data) {
      return res.status(401).json({ sucesso: false, erro: 'Chave inválida' });
    }

    // Verifica se a chave está ativa
    if (!data.ativa) {
      return res.status(401).json({ sucesso: false, erro: 'Chave desativada' });
    }

    // Verifica se a chave expirou
    if (await chaveExpirou(data)) {
      // Desativa a chave automaticamente se expirou
      await supabase
        .from('chaves')
        .update({ ativa: false })
        .eq('id', data.id);

      return res.status(401).json({ sucesso: false, erro: 'Chave expirada' });
    }

    // Se a chave ainda não tem HWID vinculado, vincula agora
    if (!data.hwid) {
      const hwidHash = calcularHashHWID(hwid);
      const { error: updateError } = await supabase
        .from('chaves')
        .update({ hwid: hwidHash })
        .eq('id', data.id);

      if (updateError) {
        return res.status(500).json({ sucesso: false, erro: 'Erro ao vinculcar HWID' });
      }

      return res.status(200).json({
        sucesso: true,
        mensagem: 'Chave verificada e HWID vinculado',
        expiracaoEm: data.expira_em
      });
    }

    // Verifica se o HWID corresponde
    const hwidHash = calcularHashHWID(hwid);
    if (data.hwid !== hwidHash) {
      return res.status(401).json({ sucesso: false, erro: 'HWID não corresponde à chave' });
    }

    // Chave válida e HWID corresponde
    return res.status(200).json({
      sucesso: true,
      mensagem: 'Autenticação bem-sucedida',
      expiracaoEm: data.expira_em
    });

  } catch (erro) {
    console.error('Erro em /verificar-chave:', erro);
    return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor' });
  }
});

// ==================== ROTAS DE ADMIN ====================

// Gera uma nova chave (acesso apenas com senha)
app.post('/api/gerar-chave', async (req, res) => {
  try {
    const { senha, tempoMinutos } = req.body;

    // Verifica a senha
    if (senha !== ADMIN_PASSWORD) {
      return res.status(401).json({ sucesso: false, erro: 'Senha incorreta' });
    }

    if (!tempoMinutos || tempoMinutos <= 0) {
      return res.status(400).json({ sucesso: false, erro: 'Tempo inválido' });
    }

    // Cria a chave
    const chave = gerarChave();
    const expiraEm = new Date();
    expiraEm.setMinutes(expiraEm.getMinutes() + parseInt(tempoMinutos));

    const { data, error } = await supabase
      .from('chaves')
      .insert([
        {
          chave,
          expira_em: expiraEm.toISOString(),
          ativa: true
        }
      ])
      .select();

    if (error) {
      console.error('Erro ao criar chave:', error);
      return res.status(500).json({ sucesso: false, erro: 'Erro ao criar chave' });
    }

    return res.status(201).json({
      sucesso: true,
      mensagem: 'Chave criada com sucesso',
      chave,
      expiraEm: data[0].expira_em
    });

  } catch (erro) {
    console.error('Erro em /gerar-chave:', erro);
    return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor' });
  }
});

// Lista todas as chaves (ativas e expiradas)
app.post('/api/listar-chaves', async (req, res) => {
  try {
    const { senha } = req.body;

    // Verifica a senha
    if (senha !== ADMIN_PASSWORD) {
      return res.status(401).json({ sucesso: false, erro: 'Senha incorreta' });
    }

    const { data, error } = await supabase
      .from('chaves')
      .select('*')
      .order('criada_em', { ascending: false });

    if (error) {
      console.error('Erro ao listar chaves:', error);
      return res.status(500).json({ sucesso: false, erro: 'Erro ao listar chaves' });
    }

    // Classifica as chaves como ativas ou expiradas
    const agora = new Date();
    const chaves = data.map(chave => ({
      ...chave,
      status: new Date(chave.expira_em) > agora && chave.ativa ? 'ativa' : 'expirada'
    }));

    return res.status(200).json({
      sucesso: true,
      chaves
    });

  } catch (erro) {
    console.error('Erro em /listar-chaves:', erro);
    return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor' });
  }
});

// Reseta uma chave (limpa HWID e reseta a expiração)
app.post('/api/resetar-chave', async (req, res) => {
  try {
    const { senha, chave, tempoMinutos } = req.body;

    // Verifica a senha
    if (senha !== ADMIN_PASSWORD) {
      return res.status(401).json({ sucesso: false, erro: 'Senha incorreta' });
    }

    if (!chave) {
      return res.status(400).json({ sucesso: false, erro: 'Chave é obrigatória' });
    }

    if (!tempoMinutos || tempoMinutos <= 0) {
      return res.status(400).json({ sucesso: false, erro: 'Tempo inválido' });
    }

    // Busca a chave
    const { data: chaveData, error: findError } = await supabase
      .from('chaves')
      .select('id')
      .eq('chave', chave)
      .single();

    if (findError || !chaveData) {
      return res.status(404).json({ sucesso: false, erro: 'Chave não encontrada' });
    }

    // Calcula nova data de expiração
    const expiraEm = new Date();
    expiraEm.setMinutes(expiraEm.getMinutes() + parseInt(tempoMinutos));

    // Atualiza a chave
    const { error: updateError } = await supabase
      .from('chaves')
      .update({
        hwid: null, // Limpa o HWID
        expira_em: expiraEm.toISOString(),
        ativa: true
      })
      .eq('id', chaveData.id);

    if (updateError) {
      return res.status(500).json({ sucesso: false, erro: 'Erro ao resetar chave' });
    }

    return res.status(200).json({
      sucesso: true,
      mensagem: 'Chave resetada com sucesso',
      expiraEm: expiraEm.toISOString()
    });

  } catch (erro) {
    console.error('Erro em /resetar-chave:', erro);
    return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor' });
  }
});

// Deleta uma chave
app.post('/api/deletar-chave', async (req, res) => {
  try {
    const { senha, chave } = req.body;

    // Verifica a senha
    if (senha !== ADMIN_PASSWORD) {
      return res.status(401).json({ sucesso: false, erro: 'Senha incorreta' });
    }

    if (!chave) {
      return res.status(400).json({ sucesso: false, erro: 'Chave é obrigatória' });
    }

    // Deleta a chave
    const { error } = await supabase
      .from('chaves')
      .delete()
      .eq('chave', chave);

    if (error) {
      return res.status(500).json({ sucesso: false, erro: 'Erro ao deletar chave' });
    }

    return res.status(200).json({
      sucesso: true,
      mensagem: 'Chave deletada com sucesso'
    });

  } catch (erro) {
    console.error('Erro em /deletar-chave:', erro);
    return res.status(500).json({ sucesso: false, erro: 'Erro interno do servidor' });
  }
});

// ==================== ESPAÇO PARA SEU SCRIPT ====================
// Você pode adicionar suas rotas customizadas aqui
// Exemplo:
// app.get('/api/seu-endpoint', (req, res) => {
//   // Seu código aqui
// });

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'Server is running' });
});

// ==================== INICIALIZAÇÃO ====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log('🔐 Sistema de autenticação ativo');
});
