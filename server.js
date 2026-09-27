// Blaze Ads Manager Backend v2.1 - Deployed 2026-09-27
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
const { Pool } = pg;

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'blaze-ads-secret-key-change-in-production';
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // Initialize users table
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).then(() => console.log('✅ Users table ready')).catch(err => console.error('❌ DB init:', err.message));
} else {
  console.log('⚠️ No DATABASE_URL - user auth will use in-memory storage');
}

// In-memory user fallback (when no DB)
const memUsers = {};

const app = express();
const PORT = process.env.PORT || 3000;
const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';

app.set('trust proxy', 1);

// CORS - Allow all necessary methods including PATCH for updates
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(cookieParser());

// --- Health Check Endpoint (Required for Railway) ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- USER AUTH MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// --- POST /api/auth/register ---
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nome, email e senha obrigatórios' });
  try {
    if (pool) {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) return res.status(409).json({ error: 'Email já cadastrado' });
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query('INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id,name,email', [name, email, hash]);
      const user = result.rows[0];
      const tok = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
      console.log(`✅ Registrado: ${email}`);
      return res.json({ ok: true, token: tok, user: { id: user.id, name: user.name, email: user.email } });
    } else {
      if (memUsers[email]) return res.status(409).json({ error: 'Email já cadastrado' });
      const hash = await bcrypt.hash(password, 10);
      const id = Object.keys(memUsers).length + 1;
      memUsers[email] = { id, name, email, password_hash: hash };
      const tok = jwt.sign({ id, email, name }, JWT_SECRET, { expiresIn: '7d' });
      console.log(`✅ Registrado (mem): ${email}`);
      return res.json({ ok: true, token: tok, user: { id, name, email } });
    }
  } catch (err) { console.error('❌ Register:', err); res.status(500).json({ error: 'Erro ao criar conta' }); }
});

// --- POST /api/auth/login (email/password) ---
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  try {
    if (pool) {
      const result = await pool.query('SELECT id,name,email,password_hash FROM users WHERE email=$1', [email]);
      if (!result.rows.length) return res.status(401).json({ error: 'Email ou senha incorretos' });
      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Email ou senha incorretos' });
      const tok = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
      console.log(`✅ Login: ${email}`);
      return res.json({ ok: true, token: tok, user: { id: user.id, name: user.name, email: user.email } });
    } else {
      const user = memUsers[email];
      if (!user) return res.status(401).json({ error: 'Email ou senha incorretos' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Email ou senha incorretos' });
      const tok = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
      console.log(`✅ Login (mem): ${email}`);
      return res.json({ ok: true, token: tok, user: { id: user.id, name: user.name, email: user.email } });
    }
  } catch (err) { console.error('❌ Login:', err); res.status(500).json({ error: 'Erro ao fazer login' }); }
});

// --- GET /api/auth/me ---
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    if (pool) {
      const result = await pool.query('SELECT id,name,email FROM users WHERE id=$1', [req.user.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
      return res.json({ ok: true, user: result.rows[0] });
    } else {
      const user = Object.values(memUsers).find(u => u.id === req.user.id);
      if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
      return res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
    }
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar usuário' }); }
});

// --- Armazenamento em Memória (MVP) ---
const sessions = {};
const oauthStates = {};

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const data = sessions[token];
  if (!data) {
    console.log(`⚠️ Token inválido/expirado: ${token.slice(0,8)}...`);
    return null;
  }
  return { token, data };
}

function accountStatusLabel(code) {
  const map = {
    1: { label: 'Ativa', color: 'emerald' },
    2: { label: 'Desativada', color: 'slate' },
    3: { label: 'Em revisão', color: 'amber' },
    7: { label: 'Pagamento pendente', color: 'amber' },
    9: { label: 'Pendente verificação', color: 'amber' },
    100: { label: 'Bloqueada', color: 'red' },
    101: { label: 'Restrita', color: 'red' }
  };
  return map[code] || { label: `Status ${code}`, color: 'slate' };
}

async function graphGet(path, accessToken, params = {}) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${path}`);
  url.searchParams.set('access_token', accessToken);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  console.log(`📡 Graph GET: ${path}`);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) console.error(`❌ Graph GET error [${path}]:`, data.error);
  return data;
}

async function graphPost(path, accessToken, body) {
  const url = `https://graph.facebook.com/${META_API_VERSION}/${path}`;
  const fullBody = { ...body, access_token: accessToken };
  console.log(`📤 Graph POST: ${path}`);
  console.log(`📤 REQUEST BODY:`, JSON.stringify(body, null, 2));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fullBody)
  });
  const data = await res.json();
  if (data.error) {
    console.error(`❌ Graph POST ERROR [${path}]:`);
    console.error(`   message:        ${data.error.message}`);
    console.error(`   type:           ${data.error.type || '(none)'}`);
    console.error(`   code:           ${data.error.code || '(none)'}`);
    console.error(`   error_subcode:  ${data.error.error_subcode || '(none)'}`);
    console.error(`   error_user_title: ${data.error.error_user_title || '(none)'}`);
    console.error(`   error_user_msg:   ${data.error.error_user_msg || '(none)'}`);
    console.error(`   error_data:     ${JSON.stringify(data.error.error_data) || '(none)'}`);
    console.error(`   fbtrace_id:     ${data.error.fbtrace_id || '(none)'}`);
    console.error(`   FULL ERROR:`, JSON.stringify(data.error, null, 2));
  } else {
    console.log(`✅ Graph POST OK [${path}]: id=${data.id || '(no id)'}`);
  }
  return data;
}

// --- ROTAS DE AUTENTICAÇÃO META ---
app.get('/api/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates[state] = Date.now();
  const now = Date.now();
  Object.keys(oauthStates).forEach(k => { if (now - oauthStates[k] > 600000) delete oauthStates[k]; });

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    state: state,
    scope: 'ads_management,ads_read,business_management,pages_read_engagement',
    response_type: 'code',
  });

  console.log(`🔐 Iniciando login OAuth, state=${state.slice(0,8)}...`);
  res.cookie('oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600000 });
  res.redirect(`https://www.facebook.com/${META_API_VERSION}/dialog/oauth?${params}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const cookieState = req.cookies?.oauth_state;
  console.log(`📥 Callback: code=${!!code}, state=${!!state}, cookie=${!!cookieState}, error=${error || 'none'}`);

  if (error) {
    res.clearCookie('oauth_state');
    return res.redirect(`${process.env.FRONTEND_URL}?error=${error}`);
  }

  const stateValid = (state && oauthStates[state]) || (state && cookieState && state === cookieState);
  if (!code || !state || !stateValid) {
    console.error('❌ State inválido', { hasState: !!state, inMemory: !!(state && oauthStates[state]), inCookie: !!(state && cookieState && state === cookieState) });
    res.clearCookie('oauth_state');
    return res.redirect(`${process.env.FRONTEND_URL}?error=invalid_oauth`);
  }

  if (oauthStates[state]) delete oauthStates[state];
  res.clearCookie('oauth_state');

  try {
    console.log('🔄 Trocando code por token...');
    const tokenRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.META_REDIRECT_URI,
        code: code,
      })
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    console.log('🔄 Trocando por token de longa duração...');
    const longLivedRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: tokenData.access_token,
      })
    );
    const longLivedData = await longLivedRes.json();
    const metaAccessToken = longLivedData.access_token || tokenData.access_token;

    console.log('🏢 Buscando Business Managers...');
    const businessesData = await graphGet('me/businesses', metaAccessToken, {
      fields: 'name,owned_ad_accounts{name,account_status,currency}'
    });

    const businesses = (businessesData.data || []).map(bm => ({
      id: bm.id,
      name: bm.name,
      adAccounts: (bm.owned_ad_accounts?.data || []).map(acc => {
        const st = accountStatusLabel(acc.account_status);
        return {
          id: acc.id, name: acc.name, currency: acc.currency,
          status: acc.account_status, statusLabel: st.label, statusColor: st.color,
          isActive: acc.account_status === 1, selected: false
        };
      })
    }));

    if (businesses.length === 0) {
      console.log('👤 Sem BMs, buscando contas pessoais...');
      const directData = await graphGet('me/adaccounts', metaAccessToken, { fields: 'name,account_status,currency' });
      if (directData.data?.length > 0) {
        businesses.push({
          id: 'personal', name: 'Contas Pessoais',
          adAccounts: directData.data.map(acc => {
            const st = accountStatusLabel(acc.account_status);
            return { id: acc.id, name: acc.name, currency: acc.currency, status: acc.account_status, statusLabel: st.label, statusColor: st.color, isActive: acc.account_status === 1, selected: false };
          })
        });
      }
    }

    const globalConfig = { pixelId: null, pageId: null, advertiserId: null, instagramId: null };

    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions[sessionToken] = { accessToken: metaAccessToken, businesses, globalConfig };
    console.log(`✅ Login OK — ${businesses.length} BM(s)`);
    res.redirect(`${process.env.FRONTEND_URL}?auth=success&token=${sessionToken}`);
  } catch (err) {
    console.error('❌ OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed&msg=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/auth/status', (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ connected: false, businesses: [], globalConfig: null });
  res.json({ connected: true, businesses: session.data.businesses, globalConfig: session.data.globalConfig });
});

app.post('/api/auth/logout', (req, res) => {
  const session = getSession(req);
  if (session) delete sessions[session.token];
  res.json({ ok: true });
});

// --- ROTA: PIXELS DE UMA CONTA ---
app.get('/api/accounts/:accountId/pixels', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    let accId = req.params.accountId;
    if (!accId.startsWith('act_')) accId = `act_${accId}`;
    const data = await graphGet(`${accId}/adspixels`, session.data.accessToken, { fields: 'id,name' });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ pixels: data.data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROTA: PÁGINAS DO USUÁRIO ---
app.get('/api/pages', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const data = await graphGet('me/accounts', session.data.accessToken, { fields: 'id,name,category' });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ pages: data.data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROTA: ANUNCIANTES REAIS DO BM ---
app.get('/api/businesses/:businessId/advertisers', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const data = await graphGet(`${req.params.businessId}/assigned_users`, session.data.accessToken, {
      fields: 'id,name,email,role'
    });
    if (data.error) {
      console.warn('⚠️ Sem permissão para assigned_users, retornando vazio');
      return res.json({ advertisers: [] });
    }
    res.json({ advertisers: data.data || [] });
  } catch (err) {
    res.json({ advertisers: [] });
  }
});

// --- ROTA: PERFIS DO INSTAGRAM VINCULADOS ÀS PÁGINAS ---
app.get('/api/pages/:pageId/instagram', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const data = await graphGet(`${req.params.pageId}`, session.data.accessToken, {
      fields: 'instagram_business_account{id,username,name}'
    });
    if (data.error || !data.instagram_business_account) {
      return res.json({ instagram: null });
    }
    res.json({ instagram: data.instagram_business_account });
  } catch (err) {
    res.json({ instagram: null });
  }
});

// --- ROTA: CONFIGURAÇÕES GLOBAIS ---
app.post('/api/global-config', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { pixelId, pageId, advertiserId, instagramId } = req.body;
  if (pixelId !== undefined) session.data.globalConfig.pixelId = pixelId || null;
  if (pageId !== undefined) session.data.globalConfig.pageId = pageId || null;
  if (advertiserId !== undefined) session.data.globalConfig.advertiserId = advertiserId || null;
  if (instagramId !== undefined) session.data.globalConfig.instagramId = instagramId || null;
  console.log(`💾 Config global atualizada:`, session.data.globalConfig);
  res.json({ ok: true, globalConfig: session.data.globalConfig });
});

app.get('/api/global-config', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ globalConfig: session.data.globalConfig });
});

// --- ROTA DE INTERPRETAÇÃO IA ---
app.post('/api/ai/interpret', async (req, res) => {
  const { command, creatives, disableAdvantagePlus } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });

  const creativeList = (creatives || []).map((c, i) => `${i + 1}. "${c.name || c.fileName}" (${c.type})`).join('\n');

  try {
    const { default: OpenAI } = await import('openai');
    if (!process.env.OPENAI_API_KEY) {
      return res.json({
        campaigns: 1, objective: 'OUTCOME_SALES', budget_type: 'CBO', daily_budget: 25,
        gender: 'all', age_min: 18, age_max: 65, conversion_event: 'PURCHASE',
        website_url: '', display_link: '', url_params: '',
        primary_text: '', headline: '', description: '', call_to_action: 'LEARN_MORE',
        campaign_name: '', adset_name: '', ad_name: '',
        placements: 'AUTOMATIC', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        start_time: 'immediate', end_time: '',
        languages: [], dynamic_creative: false,
        creative_assignments: {}
      });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const systemPrompt = `You are a Meta Ads campaign parser. Extract JSON from Portuguese commands.
Return ONLY JSON with these fields:
- campaigns (number)
- objective (OUTCOME_AWARENESS/OUTCOME_TRAFFIC/OUTCOME_ENGAGEMENT/OUTCOME_LEADS/OUTCOME_SALES/OUTCOME_APP_PROMOTION)
- budget_type (CBO/ABO)
- daily_budget (number in BRL)
- gender (male/female/all)
- age_min (number)
- age_max (number)
- conversion_event (PURCHASE/ADD_TO_CART/INITIATE_CHECKOUT/LEAD/COMPLETE_REGISTRATION/VIEW_CONTENT/SEARCH/CONTACT/SUBSCRIBE)
- website_url, display_link, url_params (strings)
- primary_text, headline, description (strings)
- call_to_action (LEARN_MORE/SHOP_NOW/SIGN_UP/CONTACT_US/DOWNLOAD/BOOK_NOW/GET_QUOTE/APPLY_NOW/SEND_MESSAGE/WATCH_VIDEO/CALL_NOW/SUBSCRIBE/DONATE/NO_BUTTON)
- campaign_name, adset_name, ad_name (strings, optional custom names)
- placements (AUTOMATIC or MANUAL)
- bid_strategy (LOWEST_COST_WITHOUT_CAP/COST_CAP/BID_CAP)
- dynamic_creative (boolean)
- creative_assignments (object mapping campaign number to creative name)

AVAILABLE CREATIVES:
${creativeList || '(none)'}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: command }],
      response_format: { type: 'json_object' },
      temperature: 0.1
    });
    const result = JSON.parse(completion.choices[0].message.content);
    res.json(result);
  } catch (err) {
    console.error('❌ AI error:', err);
    res.status(500).json({ error: 'Failed to interpret' });
  }
});

// Normaliza objetivo para OUTCOME_* (ODAX API v21.0)
function normalizeObjective(obj) {
  const map = {
    OUTCOME_AWARENESS: 'OUTCOME_AWARENESS', OUTCOME_TRAFFIC: 'OUTCOME_TRAFFIC',
    OUTCOME_ENGAGEMENT: 'OUTCOME_ENGAGEMENT', OUTCOME_LEADS: 'OUTCOME_LEADS',
    OUTCOME_SALES: 'OUTCOME_SALES', OUTCOME_APP_PROMOTION: 'OUTCOME_APP_PROMOTION',
    SALES: 'OUTCOME_SALES', CONVERSIONS: 'OUTCOME_SALES', WEBSITE_CONVERSIONS: 'OUTCOME_SALES',
    OFFSITE_CONVERSIONS: 'OUTCOME_SALES', PRODUCT_CATALOG_SALES: 'OUTCOME_SALES', STORE_VISITS: 'OUTCOME_SALES',
    TRAFFIC: 'OUTCOME_TRAFFIC', LINK_CLICKS: 'OUTCOME_TRAFFIC',
    ENGAGEMENT: 'OUTCOME_ENGAGEMENT', POST_ENGAGEMENT: 'OUTCOME_ENGAGEMENT', PAGE_LIKES: 'OUTCOME_ENGAGEMENT',
    EVENT_RESPONSES: 'OUTCOME_ENGAGEMENT', OFFER_CLAIMS: 'OUTCOME_ENGAGEMENT', MESSAGES: 'OUTCOME_ENGAGEMENT',
    LEADS: 'OUTCOME_LEADS', LEAD_GENERATION: 'OUTCOME_LEADS',
    AWARENESS: 'OUTCOME_AWARENESS', BRAND_AWARENESS: 'OUTCOME_AWARENESS', REACH: 'OUTCOME_AWARENESS', VIDEO_VIEWS: 'OUTCOME_AWARENESS',
    APP_PROMOTION: 'OUTCOME_APP_PROMOTION', APP_INSTALLS: 'OUTCOME_APP_PROMOTION',
    LOCAL_AWARENESS: 'OUTCOME_AWARENESS'
  };
  return map[obj] || 'OUTCOME_SALES';
}

// ===== MATRIZ DE COMPATIBILIDADE ODAX (API v21.0) =====
const OBJECTIVE_COMPAT = {
  OUTCOME_SALES: {
    destination_type: 'WEBSITE',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    billing_event: 'IMPRESSIONS',
    requires_pixel: true,
    requires_promoted_object: true,
    valid_conversion_events: ['PURCHASE','ADD_TO_CART','INITIATE_CHECKOUT','LEAD','COMPLETE_REGISTRATION','VIEW_CONTENT','SEARCH','CONTACT','SUBSCRIBE']
  },
  OUTCOME_LEADS: {
    destination_type: 'WEBSITE',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    billing_event: 'IMPRESSIONS',
    requires_pixel: true,
    requires_promoted_object: true,
    valid_conversion_events: ['LEAD','COMPLETE_REGISTRATION','VIEW_CONTENT','CONTACT','SUBSCRIBE']
  },
  OUTCOME_TRAFFIC: {
    destination_type: 'WEBSITE',
    optimization_goal: 'LINK_CLICKS',
    billing_event: 'IMPRESSIONS',
    requires_pixel: false,
    requires_promoted_object: false,
    valid_conversion_events: []
  },
  OUTCOME_ENGAGEMENT: {
    destination_type: null,
    optimization_goal: 'POST_ENGAGEMENT',
    billing_event: 'IMPRESSIONS',
    requires_pixel: false,
    requires_promoted_object: false,
    valid_conversion_events: []
  },
  OUTCOME_AWARENESS: {
    destination_type: null,
    optimization_goal: 'REACH',
    billing_event: 'IMPRESSIONS',
    requires_pixel: false,
    requires_promoted_object: false,
    valid_conversion_events: []
  },
  OUTCOME_APP_PROMOTION: {
    destination_type: 'APP',
    optimization_goal: 'APP_INSTALLS',
    billing_event: 'IMPRESSIONS',
    requires_pixel: false,
    requires_promoted_object: true,
    valid_conversion_events: []
  }
};

// Constrói o corpo do AdSet dinamicamente baseado no objetivo
function buildAdSetBody(objective, config, campaignId, pixelId, conversionEvent, adsetName) {
  const compat = OBJECTIVE_COMPAT[objective] || OBJECTIVE_COMPAT.OUTCOME_SALES;

  const body = {
    name: adsetName,
    campaign_id: campaignId,
    status: 'PAUSED',
    billing_event: compat.billing_event,
    optimization_goal: compat.optimization_goal,
    targeting: {
      geo_locations: { countries: config.countries || ['BR'] },
      age_min: config.age_min || 18,
      age_max: config.age_max || 65
    }
  };

  if (compat.destination_type) {
    body.destination_type = compat.destination_type;
  }

  if (compat.requires_promoted_object && compat.requires_pixel && pixelId) {
    const promotedObj = { pixel_id: pixelId };
    if (conversionEvent && compat.valid_conversion_events.includes(conversionEvent)) {
      promotedObj.custom_event_type = conversionEvent;
    } else if (compat.valid_conversion_events.length > 0) {
      promotedObj.custom_event_type = compat.valid_conversion_events[0];
    }
    body.promoted_object = promotedObj;
  } else if (compat.requires_promoted_object && !compat.requires_pixel) {
    if (config.application_id) {
      body.promoted_object = { application_id: config.application_id };
    }
  }

  if (config.budget_type === 'ABO' && config.daily_budget) {
    body.daily_budget = Math.round(config.daily_budget * 100);
  }

  body.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';

  if (config.adset_spend_cap) body.spend_cap = Math.round(config.adset_spend_cap * 100);
  if (config.start_time && config.start_time !== 'immediate') body.start_time = config.start_time;
  if (config.end_time) body.end_time = config.end_time;
  if (config.dynamic_creative) body.dynamic_creative_spec = { enabled: true };

  if (config.placements === 'MANUAL' && config.manual_placements?.length > 0) {
    body.targeting.publisher_platforms = [...new Set(config.manual_placements.map(p => {
      if (p.startsWith('facebook')) return 'facebook';
      if (p.startsWith('instagram')) return 'instagram';
      if (p.startsWith('messenger')) return 'messenger';
      if (p.startsWith('audience')) return 'audience_network';
      return null;
    }).filter(Boolean))];
    const platformMap = {
      facebook_feed: { facebook: ['feed'] },
      facebook_right_column: { facebook: ['right_hand_column'] },
      facebook_story: { facebook: ['story'] },
      instagram_feed: { instagram: ['stream'] },
      instagram_story: { instagram: ['story'] },
      instagram_reels: { instagram: ['reels'] },
      messenger_inbox: { messenger: ['messenger_home'] },
      audience_network: { audience_network: ['classic'] }
    };
    const pos = {};
    config.manual_placements.forEach(p => {
      const mapping = platformMap[p];
      if (mapping) {
        Object.entries(mapping).forEach(([plat, vals]) => {
          if (!pos[plat]) pos[plat] = [];
          pos[plat].push(...vals);
        });
      }
    });
    if (Object.keys(pos).length > 0) body.targeting.device_platforms = ['mobile', 'desktop'];
  }

  return body;
}

// --- ROTA DE CRIAÇÃO DE CAMPANHAS COMPLETAS ---
app.post('/api/campaigns/create', async (req, res) => {
  const { config, accountIds, globalConfig } = req.body;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const accessToken = session.data.accessToken;
  if (!accountIds?.length) return res.status(400).json({ error: 'No accounts selected' });

  const pixelId = globalConfig?.pixelId || session.data.globalConfig?.pixelId;
  const pageId = globalConfig?.pageId || session.data.globalConfig?.pageId;
  const advertiserId = globalConfig?.advertiserId || session.data.globalConfig?.advertiserId;
  const instagramId = globalConfig?.instagramId || session.data.globalConfig?.instagramId;

  const objective = normalizeObjective(config.objective || 'OUTCOME_SALES');
  const compat = OBJECTIVE_COMPAT[objective] || OBJECTIVE_COMPAT.OUTCOME_SALES;
  if (compat.requires_pixel && !pixelId) {
    return res.status(400).json({ error: `Pixel é obrigatório para o objetivo ${objective}` });
  }
  if (!pageId) {
    return res.status(400).json({ error: 'Página do Facebook é obrigatória para criar anúncios' });
  }

  const rawObjective = config.objective || 'OUTCOME_SALES';
  config.objective = normalizeObjective(rawObjective);
  console.log(`🎯 Objetivo: ${rawObjective} → ${config.objective}`);

  const conversionEvent = config.conversion_event || 'PURCHASE';
  console.log(`🎯 Evento conversão: ${conversionEvent}`);

  const results = [];

  for (const accountId of accountIds) {
    const cleanId = accountId.replace('act_', '');

    for (let i = 1; i <= (config.campaigns || 1); i++) {
      try {
        console.log(`🚀 [${accountId}] Campanha ${i}/${config.campaigns}...`);

        const campaignName = config.campaign_name || `${config.objective} Campaign ${i} - Auto`;
        const adsetName = config.adset_name || `AdSet ${i} - Auto`;
        const adName = config.ad_name || `Ad ${i} - Auto`;

        const campaignBody = {
          name: campaignName,
          objective: config.objective,
          status: 'PAUSED',
          special_ad_categories: []
        };
        if (config.budget_type === 'CBO' && config.daily_budget) {
          campaignBody.daily_budget = Math.round(config.daily_budget * 100);
        }

        const campaignData = await graphPost(`act_${cleanId}/campaigns`, accessToken, campaignBody);
        if (campaignData.error) {
          results.push({ accountId, step: 'Campaign', success: false, error: campaignData.error.message });
          continue;
        }
        console.log(`✅ Campanha: ${campaignData.id}`);

        const adSetBody = buildAdSetBody(objective, config, campaignData.id, pixelId, conversionEvent, adsetName);

        console.log(`📋 AdSet [${objective}]:`, JSON.stringify(adSetBody, null, 2));
        const adSetData = await graphPost(`act_${cleanId}/adsets`, accessToken, adSetBody);
        if (adSetData.error) {
          const errDetail = adSetData.error.error_user_msg || adSetData.error.error_user_title || adSetData.error.message;
          results.push({ accountId, step: 'AdSet', campaignId: campaignData.id, success: false, error: errDetail, fullError: adSetData.error });
          continue;
        }
        console.log(`✅ AdSet: ${adSetData.id}`);

        const finalUrl = config.website_url || '';
        const urlWithParams = config.url_params ? `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}${config.url_params}` : finalUrl;
        const displayUrl = config.display_link || finalUrl;

        const creativeBody = {
          name: `Creative ${i} - Auto`,
          object_story_spec: {
            page_id: pageId,
            link_data: {
              message: config.primary_text || '',
              name: config.headline || '',
              description: config.description || '',
              link: urlWithParams,
              call_to_action: { type: config.call_to_action || 'LEARN_MORE' }
            }
          }
        };

        if (instagramId) {
          creativeBody.object_story_spec.instagram_actor_id = instagramId;
        }

        const creativeData = await graphPost(`act_${cleanId}/adcreatives`, accessToken, creativeBody);
        if (creativeData.error) {
          results.push({ accountId, step: 'Creative', campaignId: campaignData.id, adSetId: adSetData.id, success: false, error: creativeData.error.message });
          continue;
        }
        console.log(`✅ Creative: ${creativeData.id}`);

        const adBody = {
          name: adName,
          adset_id: adSetData.id,
          creative: { creative_id: creativeData.id },
          status: 'PAUSED'
        };

        const adData = await graphPost(`act_${cleanId}/ads`, accessToken, adBody);
        if (adData.error) {
          results.push({ accountId, step: 'Ad', campaignId: campaignData.id, adSetId: adSetData.id, creativeId: creativeData.id, success: false, error: adData.error.message });
          continue;
        }
        console.log(`✅ Ad: ${adData.id}`);

        results.push({
          accountId, campaignId: campaignData.id, adSetId: adSetData.id,
          creativeId: creativeData.id, adId: adData.id,
          campaignName, adsetName, adName,
          websiteUrl: urlWithParams, callToAction: config.call_to_action,
          success: true
        });

      } catch (err) {
        console.error(`❌ Exceção campanha ${i}:`, err);
        results.push({ accountId, step: 'Exception', success: false, error: err.message });
      }
    }
  }

  res.json(results);
});

// --- PATCH routes for updating campaigns/adsets ---
app.patch('/api/meta/campaigns/:id', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { daily_budget, lifetime_budget, status } = req.body;
    const body = {};
    if (daily_budget !== undefined) body.daily_budget = Math.round(parseFloat(daily_budget) * 100);
    if (lifetime_budget !== undefined) body.lifetime_budget = Math.round(parseFloat(lifetime_budget) * 100);
    if (status !== undefined) body.status = status;
    if (Object.keys(body).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    
    const data = await graphPost(req.params.id, session.data.accessToken, body);
    if (data.error) return res.status(400).json({ error: data.error.message, code: data.error.code });
    res.json({ success: true, id: data.id || req.params.id, updated: body });
  } catch (error) {
    console.error('Patch campaign error:', error);
    res.status(500).json({ error: 'Erro ao atualizar campanha' });
  }
});

app.patch('/api/meta/adsets/:id', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { daily_budget, lifetime_budget, status } = req.body;
    const body = {};
    if (daily_budget !== undefined) body.daily_budget = Math.round(parseFloat(daily_budget) * 100);
    if (lifetime_budget !== undefined) body.lifetime_budget = Math.round(parseFloat(lifetime_budget) * 100);
    if (status !== undefined) body.status = status;
    if (Object.keys(body).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    
    const data = await graphPost(req.params.id, session.data.accessToken, body);
    if (data.error) return res.status(400).json({ error: data.error.message, code: data.error.code });
    res.json({ success: true, id: data.id || req.params.id, updated: body });
  } catch (error) {
    console.error('Patch adset error:', error);
    res.status(500).json({ error: 'Erro ao atualizar conjunto' });
  }
});

// GET ad accounts with details
app.get('/api/meta/adaccounts', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Meta nao conectado' });
  try {
    const data = await graphGet('me/adaccounts', session.data.accessToken, { 
      fields: 'id,name,account_status,balance,amount_spent,currency',
      limit: '100'
    });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ accounts: data.data || [] });
  } catch (error) {
    console.error('Get ad accounts error:', error);
    res.status(500).json({ error: 'Erro ao buscar contas' });
  }
});

// GET adsets for a campaign
app.get('/api/meta/campaigns/:id/adsets', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Meta nao conectado' });
  try {
    const data = await graphGet(`${req.params.id}/adsets`, session.data.accessToken, {
      fields: 'id,name,status,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,created_time,updated_time,targeting,optimization_goal,bid_strategy',
      limit: '100'
    });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ adsets: data.data || [] });
  } catch (error) {
    console.error('Get adsets error:', error);
    res.status(500).json({ error: 'Erro ao buscar conjuntos' });
  }
});

// GET ads for an adset
app.get('/api/meta/adsets/:id/ads', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Meta nao conectado' });
  try {
    const data = await graphGet(`${req.params.id}/ads`, session.data.accessToken, {
      fields: 'id,name,status,created_time,updated_time,effective_status',
      limit: '100'
    });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ ads: data.data || [] });
  } catch (error) {
    console.error('Get ads error:', error);
    res.status(500).json({ error: 'Erro ao buscar anuncios' });
  }
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`🚀 Backend rodando em http://localhost:${PORT}`);
  console.log(`📋 FRONTEND_URL: ${process.env.FRONTEND_URL || '(não definido)'}`);
  console.log(`📋 META_APP_ID: ${process.env.META_APP_ID ? '✓' : '✗ NÃO DEFINIDO'}`);
  console.log(`📋 META_REDIRECT_URI: ${process.env.META_REDIRECT_URI || '(não definido)'}`);
  console.log(`📋 META_API_VERSION: ${META_API_VERSION}`);
});
