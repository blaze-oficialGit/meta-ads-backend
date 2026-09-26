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
  const url = new URL(`https://graph.facebook.com/${process.env.META_API_VERSION}/${path}`);
  url.searchParams.set('access_token', accessToken);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  console.log(`📡 Graph API: ${path}`);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) {
    console.error(`❌ Graph API error [${path}]:`, data.error);
  }
  return data;
}

async function graphPost(path, accessToken, body) {
  const url = `https://graph.facebook.com/${process.env.META_API_VERSION}/${path}`;
  console.log(`📤 Graph POST: ${path}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken })
  });
  const data = await res.json();
  if (data.error) {
    console.error(`❌ Graph POST error [${path}]:`, data.error);
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
    scope: 'ads_management,ads_read,business_management,pages_manage_ads,pages_read_engagement',
    response_type: 'code',
  });

  console.log(`🔐 Iniciando login OAuth, state=${state.slice(0,8)}...`);

  // Salva state em cookie para sobreviver a reinícios do Railway
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600000 // 10 minutos
  });

  res.redirect(`https://www.facebook.com/${process.env.META_API_VERSION}/dialog/oauth?${params}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const cookieState = req.cookies?.oauth_state;

  console.log(`📥 Callback recebido: code=${!!code}, state=${!!state}, cookieState=${!!cookieState}, error=${error || 'none'}`);

  if (error) {
    res.clearCookie('oauth_state');
    return res.redirect(`${process.env.FRONTEND_URL}?error=${error}`);
  }

  // Valida state: aceita se estiver na memória OU no cookie (sobrevive a reinícios)
  const stateValid = (state && oauthStates[state]) || (state && cookieState && state === cookieState);

  if (!code || !state || !stateValid) {
    console.error('❌ State inválido ou ausente', {
      hasState: !!state,
      inMemory: !!(state && oauthStates[state]),
      inCookie: !!(state && cookieState && state === cookieState)
    });
    res.clearCookie('oauth_state');
    return res.redirect(`${process.env.FRONTEND_URL}?error=invalid_oauth&msg=${encodeURIComponent('State OAuth expirou ou é inválido. Tente novamente.')}`);
  }

  // Limpa state da memória e cookie
  if (oauthStates[state]) delete oauthStates[state];
  res.clearCookie('oauth_state');

  try {
    console.log('🔄 Trocando code por token...');
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
    console.log('✅ Token de curta duração obtido');

    console.log('🔄 Trocando por token de longa duração...');
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
    console.log('✅ Token de longa duração obtido');

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
    console.log(`✅ ${businesses.length} BM(s) encontrado(s)`);

    if (businesses.length === 0) {
      console.log('👤 Sem BMs, buscando contas pessoais...');
      const directData = await graphGet('me/adaccounts', metaAccessToken, {
        fields: 'name,account_status,currency'
      });
      if (directData.data?.length > 0) {
        businesses.push({
          id: 'personal',
          name: 'Contas Pessoais',
          adAccounts: directData.data.map(acc => {
            const st = accountStatusLabel(acc.account_status);
            return {
              id: acc.id, name: acc.name, currency: acc.currency,
              status: acc.account_status, statusLabel: st.label, statusColor: st.color,
              isActive: acc.account_status === 1, selected: false,
              pixelId: null, pageId: null, advertiserId: null
            };
          })
        });
        console.log(`✅ ${directData.data.length} conta(s) pessoal(is) encontrada(s)`);
      }
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    sessions[sessionToken] = { accessToken: metaAccessToken, businesses };
    console.log(`✅ Login OK — sessionToken=${sessionToken.slice(0,8)}..., ${businesses.length} BM(s)`);
    res.redirect(`${process.env.FRONTEND_URL}?auth=success&token=${sessionToken}`);

  } catch (err) {
    console.error('❌ OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed&msg=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/auth/status', (req, res) => {
  const session = getSession(req);
  if (!session) {
    console.log('📊 Status: desconectado');
    return res.json({ connected: false, businesses: [] });
  }
  const totalAccounts = session.data.businesses.reduce((sum, bm) => sum + bm.adAccounts.length, 0);
  console.log(`📊 Status: conectado, ${session.data.businesses.length} BM(s), ${totalAccounts} conta(s)`);
  res.json({ connected: true, businesses: session.data.businesses });
});

app.post('/api/auth/logout', (req, res) => {
  const session = getSession(req);
  if (session) {
    delete sessions[session.token];
    console.log(`🚪 Logout: ${session.token.slice(0,8)}...`);
  }
  res.json({ ok: true });
});

// --- ROTA: PIXELS DE UMA CONTA ---
app.get('/api/accounts/:accountId/pixels', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    let accId = req.params.accountId;
    if (!accId.startsWith('act_')) accId = `act_${accId}`;

    console.log(`🔍 Buscando pixels para ${accId}`);
    const data = await graphGet(`${accId}/adspixels`, session.data.accessToken, {
      fields: 'id,name,owner_business'
    });

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const pixels = data.data || [];
    console.log(`✅ ${pixels.length} pixel(s) encontrado(s) para ${accId}`);
    res.json({ pixels });
  } catch (err) {
    console.error('❌ Erro pixels:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- ROTA: PÁGINAS DO USUÁRIO ---
app.get('/api/pages', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    console.log('📄 Buscando páginas do usuário...');
    const data = await graphGet('me/accounts', session.data.accessToken, {
      fields: 'id,name,category,picture'
    });
    if (data.error) return res.status(400).json({ error: data.error.message });

    const pages = data.data || [];
    console.log(`✅ ${pages.length} página(s) encontrada(s)`);
    res.json({ pages });
  } catch (err) {
    console.error('❌ Erro páginas:', err);
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
      console.log(`💾 Seleção atualizada para ${accountId}: pixel=${acc.pixelId}, page=${acc.pageId}, adv=${acc.advertiserId}`);
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
      console.log('🤖 IA: usando fallback (sem OPENAI_API_KEY)');
      return res.json({
        campaigns: 5,
        objective: 'OUTCOME_SALES',
        budget_type: 'CBO',
        daily_budget: 100,
        gender: 'all',
        age_min: 25,
        age_max: 45,
        start_time: 'immediate',
        disable_advantage_plus: !!disableAdvantagePlus,
        website_url: '',
        display_link: '',
        url_params: '',
        primary_text: '',
        headline: '',
        description: '',
        call_to_action: 'LEARN_MORE',
        creative_assignments: {}
      });
    }

    console.log('🤖 IA: interpretando comando...');
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
- start_time (HH:MM or "immediate")
- disable_advantage_plus (boolean): true se o usuário pediu para desativar recomendações/IA da Meta
- website_url (string): URL do site de destino
- display_link (string): link de exibição (opcional, aparece no anúncio)
- url_params (string): parâmetros UTM tipo utm_source=facebook&utm_medium=cpc
- primary_text (string): texto principal do anúncio
- headline (string): título do anúncio
- description (string): descrição do anúncio
- call_to_action (string): CTA button - LEARN_MORE/SHOP_NOW/SIGN_UP/CONTACT_US/DOWNLOAD/BOOK_NOW/GET_QUOTE/APPLY_NOW/SEND_MESSAGE/PLAY_GAME/LISTEN_MUSIC/WATCH_VIDEO/USE_APP/CALL_NOW/MESSAGE_PAGE/DONATE/SUBSCRIBE/SAY_THANKS/NO_BUTTON
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

    const result = JSON.parse(completion.choices[0].message.content);
    console.log('✅ IA: interpretação concluída', result);
    res.json(result);
  } catch (err) {
    console.error('❌ AI error:', err);
    res.status(500).json({ error: 'Failed to interpret' });
  }
});

// Mapeia objetivos novos (OUTCOME_*) para legados aceitos universalmente pela Meta
// A API v21.0 rejeita OUTCOME_* em contas/apps sem acesso à nova camada de objetivos
function normalizeObjective(obj) {
  const map = {
    OUTCOME_AWARENESS: 'BRAND_AWARENESS',
    OUTCOME_TRAFFIC: 'LINK_CLICKS',
    OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT',
    OUTCOME_LEADS: 'LEAD_GENERATION',
    OUTCOME_SALES: 'CONVERSIONS',
    OUTCOME_APP_PROMOTION: 'APP_INSTALLS',
    SALES: 'CONVERSIONS',
    TRAFFIC: 'LINK_CLICKS',
    ENGAGEMENT: 'POST_ENGAGEMENT',
    LEADS: 'LEAD_GENERATION',
    AWARENESS: 'BRAND_AWARENESS',
    APP_PROMOTION: 'APP_INSTALLS',
    BRAND_AWARENESS: 'BRAND_AWARENESS',
    LINK_CLICKS: 'LINK_CLICKS',
    POST_ENGAGEMENT: 'POST_ENGAGEMENT',
    LEAD_GENERATION: 'LEAD_GENERATION',
    APP_INSTALLS: 'APP_INSTALLS',
    CONVERSIONS: 'CONVERSIONS',
    REACH: 'REACH',
    VIDEO_VIEWS: 'VIDEO_VIEWS',
    MESSAGES: 'MESSAGES'
  };
  return map[obj] || 'CONVERSIONS';
}

// --- ROTA DE CRIAÇÃO DE CAMPANHAS COMPLETAS (Campaign + AdSet + Ad) ---
app.post('/api/campaigns/create', async (req, res) => {
  const { config, accountIds, accountSelections } = req.body;
  const session = getSession(req);

  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const accessToken = session.data.accessToken;
  if (!accountIds?.length) return res.status(400).json({ error: 'No accounts selected' });

  // Normaliza objetivo para valor legado aceito universalmente
  const rawObjective = config.objective || 'SALES';
  config.objective = normalizeObjective(rawObjective);
  console.log(`🎯 Objetivo normalizado: ${rawObjective} → ${config.objective}`);

  // Validação obrigatória
  const validationErrors = [];
  for (const sel of (accountSelections || [])) {
    if (!sel.pixelId) validationErrors.push(`Conta ${sel.accountId}: Pixel obrigatório`);
    if (!sel.pageId) validationErrors.push(`Conta ${sel.accountId}: Página obrigatória`);
    if (!sel.advertiserId) validationErrors.push(`Conta ${sel.accountId}: Anunciante obrigatório`);
  }
  if (validationErrors.length > 0) {
    console.error('❌ Validação falhou:', validationErrors);
    return res.status(400).json({ error: 'Configuração incompleta', details: validationErrors });
  }

  const results = [];
  const apiVersion = process.env.META_API_VERSION;

  for (const accountId of accountIds) {
    const sel = (accountSelections || []).find(s => s.accountId === accountId) || {};

    for (let i = 1; i <= (config.campaigns || 1); i++) {
      try {
        console.log(`🚀 Criando campanha ${i}/${config.campaigns} para ${accountId}...`);

        // 1. Criar Campaign
        const campaignBody = {
          name: `${config.objective || 'SALES'} Campaign ${i} - Auto`,
          objective: config.objective || 'OUTCOME_SALES',
          status: 'PAUSED',
          special_ad_categories: []
        };

        if (config.budget_type === 'CBO' && config.daily_budget) {
          campaignBody.daily_budget = Math.round(config.daily_budget * 100);
        }

        if (config.disable_advantage_plus) {
          campaignBody.buying_type = 'AUCTION';
        }

        const cleanId = accountId.replace('act_', '');
        const campaignData = await graphPost(`act_${cleanId}/campaigns`, accessToken, campaignBody);

        if (campaignData.error) {
          results.push({ accountId, campaignName: `Campaign ${i}`, success: false, error: campaignData.error.message });
          continue;
        }

        console.log(`✅ Campanha criada: ${campaignData.id}`);

        // 2. Criar Ad Set
        const adSetBody = {
          name: `AdSet ${i} - Auto`,
          campaign_id: campaignData.id,
          status: 'PAUSED',
          optimization_goal: 'OFFSITE_CONVERSIONS',
          billing_event: 'IMPRESSIONS',
          daily_budget: config.budget_type === 'ABO' && config.daily_budget ? Math.round(config.daily_budget * 100) : undefined,
          targeting: {
            age_min: config.age_min || 25,
            age_max: config.age_max || 45,
            genders: config.gender === 'male' ? 1 : config.gender === 'female' ? 2 : 0,
            locales: [6] // Português Brasil
          },
          promoted_object: {
            pixel_id: sel.pixelId,
            custom_event_type: 'PURCHASE'
          }
        };

        const adSetData = await graphPost(`act_${cleanId}/adsets`, accessToken, adSetBody);

        if (adSetData.error) {
          results.push({ accountId, campaignName: `Campaign ${i}`, success: false, error: `AdSet: ${adSetData.error.message}` });
          continue;
        }

        console.log(`✅ AdSet criado: ${adSetData.id}`);

        // 3. Criar Ad Creative
        const finalUrl = config.website_url || '';
        const urlWithParams = config.url_params ? `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}${config.url_params}` : finalUrl;
        const displayUrl = config.display_link || finalUrl;

        const creativeBody = {
          name: `Creative ${i} - Auto`,
          object_story_spec: {
            page_id: sel.pageId,
            link_data: {
              message: config.primary_text || '',
              name: config.headline || '',
              description: config.description || '',
              link: urlWithParams,
              display_link: displayUrl,
              call_to_action: {
                type: config.call_to_action || 'LEARN_MORE'
              }
            }
          }
        };

        const creativeData = await graphPost(`act_${cleanId}/adcreatives`, accessToken, creativeBody);

        if (creativeData.error) {
          results.push({ accountId, campaignName: `Campaign ${i}`, success: false, error: `Creative: ${creativeData.error.message}` });
          continue;
        }

        console.log(`✅ Creative criado: ${creativeData.id}`);

        // 4. Criar Ad
        const adBody = {
          name: `Ad ${i} - Auto`,
          adset_id: adSetData.id,
          creative: { creative_id: creativeData.id },
          status: 'PAUSED'
        };

        const adData = await graphPost(`act_${cleanId}/ads`, accessToken, adBody);

        if (adData.error) {
          results.push({ accountId, campaignName: `Campaign ${i}`, success: false, error: `Ad: ${adData.error.message}` });
          continue;
        }

        console.log(`✅ Ad criado: ${adData.id}`);

        results.push({
          accountId,
          campaignId: campaignData.id,
          adSetId: adSetData.id,
          creativeId: creativeData.id,
          adId: adData.id,
          campaignName: campaignBody.name,
          pixelId: sel.pixelId,
          pageId: sel.pageId,
          advertiserId: sel.advertiserId,
          advantagePlusDisabled: !!config.disable_advantage_plus,
          websiteUrl: urlWithParams,
          displayLink: displayUrl,
          primaryText: config.primary_text,
          headline: config.headline,
          description: config.description,
          callToAction: config.call_to_action,
          success: true
        });

      } catch (err) {
        console.error(`❌ Exceção ao criar campanha ${i}:`, err);
        results.push({ accountId, campaignName: `Campaign ${i}`, success: false, error: err.message });
      }
    }
  }

  res.json(results);
});

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`🚀 Backend rodando em http://localhost:${PORT}`);
  console.log(`📋 FRONTEND_URL: ${process.env.FRONTEND_URL || '(não definido)'}`);
  console.log(`📋 META_APP_ID: ${process.env.META_APP_ID ? '✓ definido' : '✗ NÃO DEFINIDO'}`);
  console.log(`📋 META_REDIRECT_URI: ${process.env.META_REDIRECT_URI || '(não definido)'}`);
});