import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('connect', () => {
    console.log('✅ Nova conexão com o banco de dados estabelecida');
  });

  pool.on('error', (err) => {
    console.error('❌ Erro inesperado no pool de conexões:', err);
  });
} else {
  console.warn('⚠️ DATABASE_URL não definido — modo sem banco de dados (apenas Meta Ads API)');
  // Stub pool that returns empty results instead of crashing
  pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    on: () => {},
    end: async () => {}
  };
}

export default pool;
