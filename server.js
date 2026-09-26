import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// --- Armazenamento em Memória (MVP) ---
const store = {
  tokens: {},
  businesses: {},
};

// --- ROTAS DE AUTENTICAÇÃO META ---

// 1. Iniciar Login
app.get('/api/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    state: state,
    scope: 'ads_management,ads_read,business_management',
    response_type: 'code',
  });

  res.redirect(`https://www.facebook.com/${process.env.META_API_VERSION}/dialog/oauth?${params}`);
});

// 2. Callback do OAuth
app.get('/api/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== req.session.oauthState) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=invalid_oauth`);
  }

  try {
    // Trocar código por token
    const tokenRes = await fetch(
      `https://graph.facebook.com/${process.env.META_API_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.META_REDIRECT_URI,
        code: code,
      })
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    // Obter token de longa duração
    const longLivedRes = await fetch(
      `https://graph.facebook.com/${process.env.META_API_VERSION}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: tokenData.access_token,
      })
    );
    const longLivedData = await longLivedRes.json();

    const userId = 'current_user';
    store.tokens[userId] = longLivedData.access_token;

    // Buscar Business Managers e Contas
    const businessesRes = await fetch(
      `https://graph.facebook.com/${process.env.META_API_VERSION}/me/businesses?fields=name,owned_ad_accounts{name,account_status,currency}&access_token=${longLivedData.access_token}`
    );
    const businessesData = await businessesRes.json();

    const businesses = (businessesData.data || []).map(bm => ({
      id: bm.id,
      name: bm.name,
      adAccounts: (bm.owned_ad_accounts?.data || []).map(acc => ({
        id: acc.id,
        name: acc.name,
        currency: acc.currency,
        status: acc.account_status,
        selected: false
      }))
    }));

    // Fallback para contas pessoais
    if (businesses.length === 0) {
      const directRes = await fetch(
        `https://graph.facebook.com/${process.env.META_API_VERSION}/me/adaccounts?fields=name,account_status,currency&access_token=${longLivedData.access_token}`
      );
      const directData = await directRes.json();
      if (directData.data?.length > 0) {
        businesses.push({
          id: 'personal',
          name: 'Contas Pessoais',
          adAccounts: directData.data.map(acc => ({
            id: acc.id,
            name: acc.name,
            currency: acc.currency,
            status: acc.account_status,
            selected: false
          }))
        });
      }
    }

    store.businesses[userId] = businesses;
    res.redirect(`${process.env.FRONTEND_URL}?auth=success`);

  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed`);
  }
});

// 3. Verificar Status
app.get('/api/auth/status', (req, res) => {
  const userId = 'current_user';
  const isConnected = !!store.tokens[userId];
  res.json({
    connected: isConnected,
    businesses: isConnected ? store.businesses[userId] || [] : []
  });
});

// --- ROTA DE INTERPRETAÇÃO IA ---
app.post('/api/ai/interpret', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });

  try {
    const { default: OpenAI } = await import('openai');

    if (!process.env.OPENAI_API_KEY) {
      return res.json({
        campaigns: 5,
        objective: 'SALES',
        budget_type: 'CBO',
        daily_budget: 100,
        gender: 'male',
        age_min: 25,
        age_max: 45,
        start_time: '00:00'
      });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a Meta Ads campaign parser. Extract JSON from Portuguese commands.
Return ONLY JSON with: campaigns (number), objective (SALES/LEADS/ENGAGEMENT/AWARENESS/TRAFFIC),
budget_type (CBO/ABO), daily_budget (number BRL), gender (male/female/all),
age_min (number), age_max (number), start_time (HH:MM or "immediate").`
        },
        { role: 'user', content: command }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1
    });

    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Failed to interpret' });
  }
});

// --- ROTA DE CRIAÇÃO DE CAMPANHAS ---
app.post('/api/campaigns/create', async (req, res) => {
  const { config, accountIds } = req.body;
  const userId = 'current_user';
  const accessToken = store.tokens[userId];

  if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
  if (!accountIds?.length) return res.status(400).json({ error: 'No accounts selected' });

  const results = [];
  const apiVersion = process.env.META_API_VERSION;

  for (const accountId of accountIds) {
    for (let i = 1; i <= (config.campaigns || 1); i++) {
      try {
        const body = new URLSearchParams({
          name: `${config.objective} Campaign ${i} - Auto`,
          objective: config.objective || 'SALES',
          status: 'PAUSED',
          special_ad_categories: '[]',
          access_token: accessToken,
        });

        if (config.budget_type === 'CBO' && config.daily_budget) {
          body.append('daily_budget', Math.round(config.daily_budget * 100));
        }

        const cleanId = accountId.replace('act_', '');
        const campaignRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/act_${cleanId}/campaigns`,
          { method: 'POST', body }
        );
        const data = await campaignRes.json();

        if (data.error) {
          results.push({ accountName: accountId, campaignName: `Campaign ${i}`, success: false, error: data.error.message });
        } else {
          results.push({ accountId, accountName: accountId, campaignId: data.id, campaignName: data.name || `Campaign ${i}`, success: true });
        }
      } catch (err) {
        results.push({ accountName: accountId, campaignName: `Campaign ${i}`, success: false, error: err.message });
      }
    }
  }

  res.json(results);
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`🚀 Backend rodando em http://localhost:${PORT}`);
});