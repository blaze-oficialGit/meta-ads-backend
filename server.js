import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// --- Armazenamento em Memória (MVP) ---
const sessions = {};
const oauthStates = {};

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  return token && sessions[token] ? { token, data: sessions[token] } : null;
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
  const url = new URL(`https://graph.facebook.com/${process.env.META_API_VERSION}/${path}`);
  url.searchParams.set('access_token', accessToken);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  return res.json();
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
    scope: 'ads_management,ads_read,business_management,pages_manage_ads,pages_read_engagement',
    response_type: 'code',
  });

  res.redirect(`https://www.facebook.com/${process.env.META_API_VERSION}/dialog/oauth?${params}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${process.env.FRONTEND_URL}?error=${error}`);
  if (!code || !state || !oauthStates[state]) return res.redirect(`${process.env.FRONTEND_URL}?error=invalid_oauth`);
  delete oauthStates[state];

  try {
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
    const metaAccessToken = longLivedData.access_token || tokenData.access_token;

    // Buscar BMs + contas com status
    const businessesRes = await fetch(
      `https://graph.facebook.com/${process.env.META_API_VERSION}/me/businesses?fields=name,owned_ad_accounts{name,account_status,currency}&access_token=${metaAccessToken}`
    );
    const businessesData = await businessesRes.json();

    const businesses = (businessesData.data || []).map(bm => ({
      id: bm.id,
      name: bm.name,
      adAccounts: (bm.owned_ad_accounts?.data || []).map(acc => {
        const st = accountStatusLabel(acc.account_status);
        return {
          id: acc.id,
          name: acc.name,
          currency: acc.currency,
          status: acc.account_status,
          statusLabel: st.label,
          statusColor: st.color,
          isActive: acc.account_status === 1,
          selected: false,
          pixelId: null,
          pageId: null,
          advertiserId: null
        };
      })
    }));

    // Fallback: contas pessoais
    if (businesses.length === 0) {
      const directData = await graphGet('me/adaccounts', metaAccessToken, { fields: 'name,account_status,currency' });
      if (directData.data?.length > 0) {
        businesses.push({
          id: 'personal',
          name: 'Contas Pessoais',
          adAccounts: directData.data.map(acc => {
            const st = accountStatusLabel(acc.account_status);
            return {
              id: acc.id, name: acc.name, currency: acc.currency,
              status: acc.account_status, statusLabel: st.label, statusColor: st.color,
              isActive: acc.account_status === 1, selected: false, pixelId: null, pageId: null, advertiserId: null
            };
          })
        });
      }
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions[sessionToken] = { accessToken: metaAccessToken, businesses };
    console.log(`✅ Login OK — ${businesses.length} BM(s)`);
    res.redirect(`${process.env.FRONTEND_URL}?auth=success&token=${sessionToken}`);

  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed&msg=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/auth/status', (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ connected: false, businesses: [] });
  res.json({ connected: true, businesses: session.data.businesses });
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
    const cleanId = req.params.accountId.replace('act_', '');
    const data = await graphGet(`act_${cleanId}/adspixels`, session.data.accessToken, {
      fields: 'id,name,owner_business'
    });
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
    const data = await graphGet('me/accounts', session.data.accessToken, {
      fields: 'id,name,category,picture'
    });
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ pages: data.data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROTA: SALVAR SELEÇÕES (pixel/página/anunciante por conta) ---
app.post('/api/accounts/update-selection', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { accountId, pixelId, pageId, advertiserId } = req.body;
  for (const bm of session.data.businesses) {
    const acc = bm.adAccounts.find(a => a.id === accountId);
    if (acc) {
      if (pixelId !== undefined) acc.pixelId = pixelId || null;
      if (pageId !== undefined) acc.pageId = pageId || null;
      if (advertiserId !== undefined) acc.advertiserId = advertiserId || null;
      break;
    }
  }
  res.json({ ok: true });
});

// --- ROTA: VALIDAR CONFIGURAÇÕES OBRIGATÓRIAS ---
app.post('/api/accounts/validate-required', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { accountIds } = req.body;
  if (!accountIds?.length) return res.status(400).json({ error: 'No accounts provided' });

  const missing = [];
  for (const bm of session.data.businesses) {
    for (const acc of bm.adAccounts) {
      if (!accountIds.includes(acc.id)) continue;
      const gaps = [];
      if (!acc.pixelId) gaps.push('Pixel');
      if (!acc.pageId) gaps.push('Página');
      if (!acc.advertiserId) gaps.push('Anunciante');
      if (gaps.length > 0) {
        missing.push({ accountId: acc.id, accountName: acc.name, missing: gaps });
      }
    }
  }

  if (missing.length > 0) {
    return res.json({ valid: false, missing });
  }
  res.json({ valid: true });
});

// --- ROTA DE INTERPRETAÇÃO IA ---
app.post('/api/ai/interpret', async (req, res) => {
  const { command, creatives, disableAdvantagePlus } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });

  const creativeList = (creatives || [])
    .map((c, i) => `${i + 1}. "${c.name || c.fileName}" (${c.type})`)
    .join('\n');

  try {
    const { default: OpenAI } = await import('openai');

    if (!process.env.OPENAI_API_KEY) {
      return res.json({
        campaigns: 5,
        objective: 'SALES',
        budget_type: 'CBO',
        daily_budget: 100,
        gender: 'all',
        age_min: 25,
        age_max: 45,
        start_time: 'immediate',
        disable_advantage_plus: !!disableAdvantagePlus,
        creative_assignments: {}
      });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const systemPrompt = `You are a Meta Ads campaign parser. Extract JSON from Portuguese commands.
Return ONLY JSON with these fields:
- campaigns (number)
- objective (SALES/LEADS/ENGAGEMENT/AWARENESS/TRAFFIC)
- budget_type (CBO/ABO)
- daily_budget (number in BRL)
- gender (male/female/all)
- age_min (number)
- age_max (number)
- start_time (HH:MM or "immediate")
- disable_advantage_plus (boolean): true se o usuário pediu para desativar recomendações/IA da Meta
- creative_assignments (object): maps each campaign number (as string "1","2"...) to the NAME of the creative to use.

AVAILABLE CREATIVES (use exact names in creative_assignments):
${creativeList || '(none uploaded)'}

If user mentions a creative by name/keyword, match it to the closest available creative name. If not specified, assign all creatives round-robin across campaigns.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
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
  const { config, accountIds, accountSelections } = req.body;
  const session = getSession(req);

  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const accessToken = session.data.accessToken;
  if (!accountIds?.length) return res.status(400).json({ error: 'No accounts selected' });

  // Validação obrigatória
  const validationErrors = [];
  for (const sel of (accountSelections || [])) {
    if (!sel.pixelId) validationErrors.push(`Conta ${sel.accountId}: Pixel obrigatório`);
    if (!sel.pageId) validationErrors.push(`Conta ${sel.accountId}: Página obrigatória`);
    if (!sel.advertiserId) validationErrors.push(`Conta ${sel.accountId}: Anunciante obrigatório`);
  }
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: 'Configuração incompleta', details: validationErrors });
  }

  const results = [];
  const apiVersion = process.env.META_API_VERSION;

  for (const accountId of accountIds) {
    const sel = (accountSelections || []).find(s => s.accountId === accountId) || {};
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

        // Desativar Advantage+ / recomendações de IA da Meta
        if (config.disable_advantage_plus) {
          // buying_type FIXED permite controle manual; advantage_campaign_toggle desativa otimizações automáticas
          body.append('buying_type', 'FIXED');
          body.append('advantage_campaign_toggle', '{"enabled":false}');
        }

        const cleanId = accountId.replace('act_', '');
        const campaignRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/act_${cleanId}/campaigns`,
          { method: 'POST', body }
        );
        const data = await campaignRes.json();

        if (data.error) {
          results.push({ accountId, campaignName: `Campaign ${i}`, success: false, error: data.error.message });
        } else {
          results.push({
            accountId,
            campaignId: data.id,
            campaignName: data.name || `Campaign ${i}`,
            pixelId: sel.pixelId || null,
            pageId: sel.pageId || null,
            advertiserId: sel.advertiserId || null,
            advantagePlusDisabled: !!config.disable_advantage_plus,
            success: true
          });
        }
      } catch (err) {
        results.push({ accountId, campaignName: `Campaign ${i}`, success: false, error: err.message });
      }
    }
  }

  res.json(results);
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(` Backend rodando em http://localhost:${PORT}`);
});