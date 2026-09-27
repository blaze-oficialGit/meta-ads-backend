import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

let pool = null;

try {
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('connect', () => {
      console.log('✅ Nova conexão com o banco de dados estabelecida');
    });

    pool.on('error', (err) => {
      console.error('⚠️ Erro no pool de conexões (não fatal):', err.message);
      // NÃO chamar process.exit - deixa o server rodar mesmo sem DB
    });
  } else {
    console.warn('⚠️ DATABASE_URL não definido - rotas de auth JWT não funcionarão, mas Meta Ads OAuth funcionará');
  }
} catch (err) {
  console.error('⚠️ Erro ao inicializar pool de DB (não fatal):', err.message);
  pool = null;
}

// Wrapper que retorna erro amigável se pool não existir
const safePool = {
  query: async (...args) => {
    if (!pool) {
      throw new Error('Banco de dados não configurado. Defina DATABASE_URL no Railway.');
    }
    return pool.query(...args);
  },
  end: async () => {
    if (pool) return pool.end();
  }
};

export default safePool;
