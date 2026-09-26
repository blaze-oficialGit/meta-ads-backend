import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';

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
app.use(cookieParser());

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
  console.log(`📡 Graph GET: ${path}`);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error) console.error(`❌ Graph GET error [${path}]:`, data.error);
  return data;
}

async function graphPost(path, accessToken, body) {
  const url = `https://graph.facebook.com/${process.env.META_API_VERSION}/${path}`;
  console.log(`📤 Graph POST: ${path}`, JSON.stringify(body).slice(0, 300));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken })
  });
  const data = await res.json();
  if (data.error) console.error(`❌ Graph POST error [${path}]:`, data.error);
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
  res.redirect(`https://www.facebook.com/${process.env.META_API_VERSION}/dialog/oauth?${params}`);
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

    // Configurações globais (pixel/página/anunciante aplicados em todas as contas)
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

// --- ROTA: ANUNCIANTES REAIS DO BM (pessoas verificadas / entidades de transparência) ---
app.get('/api/businesses/:businessId/advertisers', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  try {
    // Tenta buscar assigned_users (pessoas com acesso ao BM)
    const data = await graphGet(`${req.params.businessId}/assigned_users`, session.data.accessToken, {
      fields: 'id,name,email,role'
    });
    if (data.error) {
      // Fallback: retorna lista vazia se não tiver permissão
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

// --- ROTA: CONFIGURAÇÕES GLOBAIS (aplica em todas as contas de uma vez) ---
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

// Normaliza objetivo para OUTCOME_* (sua conta exige)
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

// --- ROTA DE CRIAÇÃO DE CAMPANHAS COMPLETAS ---
// Estrutura correta API v21.0 para OUTCOME_*:
// - Campaign: objective + daily_budget (CBO) + buying_type=AUCTION (se manual)
// - AdSet: SEM optimization_goal/billing_event/promoted_object no corpo inicial
//   → depois criar com promoted_object via endpoint separado OU usar estrutura mínima
// - Na prática, para OUTCOME_SALES a Meta aceita AdSet com:
//   targeting + promoted_object (pixel_id + custom_event_type) + SEM optimization_goal explícito
app.post('/api/campaigns/create', async (req, res) => {
  const { config, accountIds, globalConfig } = req.body;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const accessToken = session.data.accessToken;
  if (!accountIds?.length) return res.status(400).json({ error: 'No accounts selected' });

  // Usa config global se não vier por conta
  const pixelId = globalConfig?.pixelId || session.data.globalConfig?.pixelId;
  const pageId = globalConfig?.pageId || session.data.globalConfig?.pageId;
  const advertiserId = globalConfig?.advertiserId || session.data.globalConfig?.advertiserId;
  const instagramId = globalConfig?.instagramId || session.data.globalConfig?.instagramId;

  if (!pixelId || !pageId) {
    return res.status(400).json({ error: 'Configuração global incompleta: Pixel e Página são obrigatórios' });
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

        // Nomes personalizados ou padrão
        const campaignName = config.campaign_name || `${config.objective} Campaign ${i} - Auto`;
        const adsetName = config.adset_name || `AdSet ${i} - Auto`;
        const adName = config.ad_name || `Ad ${i} - Auto`;

        // ===== 1. CAMPANHA =====
        // Estrutura correta API v21.0 para OUTCOME_SALES com Advantage+:
        // - SEM buying_type explícito (Meta usa o padrão do Advantage+)
        // - SEM promoted_object na campanha (vai no adset)
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

        // ===== 2. AD SET =====
        // FALLBACK EM CASCATA: tenta múltiplas estruturas até uma funcionar.
        // A Meta varia as regras por conta/versão/app — isso garante que funcione sempre.
        const baseTargeting = {
          geo_locations: { countries: ['BR'] },
          age_min: config.age_min || 18,
          age_max: config.age_max || 65
        };

        const adSetVariants = [
          {
            label: 'ODAX completo (destination_type + opt_goal + billing + promoted)',
            body: {
              name: adsetName,
              campaign_id: campaignData.id,
              status: 'PAUSED',
              destination_type: 'WEBSITE',
              optimization_goal: 'OFFSITE_CONVERSIONS',
              billing_event: 'IMPRESSIONS',
              promoted_object: { pixel_id: pixelId, custom_event_type: conversionEvent },
              targeting: baseTargeting
            }
          },
          {
            label: 'Sem destination_type (opt_goal + billing + promoted)',
            body: {
              name: adsetName,
              campaign_id: campaignData.id,
              status: 'PAUSED',
              optimization_goal: 'OFFSITE_CONVERSIONS',
              billing_event: 'IMPRESSIONS',
              promoted_object: { pixel_id: pixelId, custom_event_type: conversionEvent },
              targeting: baseTargeting
            }
          },
          {
            label: 'Sem billing_event (opt_goal + promoted + destination)',
            body: {
              name: adsetName,
              campaign_id: campaignData.id,
              status: 'PAUSED',
              destination_type: 'WEBSITE',
              optimization_goal: 'OFFSITE_CONVERSIONS',
              promoted_object: { pixel_id: pixelId, custom_event_type: conversionEvent },
              targeting: baseTargeting
            }
          },
          {
            label: 'Mínimo ODAX (destination + opt_goal + promoted, sem billing)',
            body: {
              name: adsetName,
              campaign_id: campaignData.id,
              status: 'PAUSED',
              destination_type: 'WEBSITE',
              optimization_goal: 'OFFSITE_CONVERSIONS',
              promoted_object: { pixel_id: pixelId, custom_event_type: conversionEvent },
              targeting: baseTargeting
            }
          },
          {
            label: 'Legacy conversions (sem destination_type, sem billing)',
            body: {
              name: adsetName,
              campaign_id: campaignData.id,
              status: 'PAUSED',
              optimization_goal: 'OFFSITE_CONVERSIONS',
              promoted_object: { pixel_id: pixelId, custom_event_type: conversionEvent },
              targeting: baseTargeting
            }
          },
          {
            label: 'Ultra-mínimo (apenas promoted_object + targeting)',
            body: {
              name: adsetName,
              campaign_id: campaignData.id,
              status: 'PAUSED',
              promoted_object: { pixel_id: pixelId, custom_event_type: conversionEvent },
              targeting: baseTargeting
            }
          }
        ];

        let adSetData = null;
        for (const variant of adSetVariants) {
          const testBody = { ...variant.body };
          // Adiciona opcionais apenas no primeiro attempt (para não poluir fallbacks)
          if (variant === adSetVariants[0]) {
            if (config.budget_type === 'ABO' && config.daily_budget) {
              testBody.daily_budget = Math.round(config.daily_budget * 100);
            }
            if (config.budget_type === 'ABO' && config.bid_strategy && config.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP') {
              testBody.bid_strategy = config.bid_strategy;
            }
            if (config.adset_spend_cap) {
              testBody.spend_cap = Math.round(config.adset_spend_cap * 100);
            }
            if (config.start_time && config.start_time !== 'immediate') {
              testBody.start_time = config.start_time;
            }
            if (config.end_time) {
              testBody.end_time = config.end_time;
            }
            if (config.dynamic_creative) {
              testBody.dynamic_creative_spec = { enabled: true };
            }
          }

          console.log(`🔄 Tentando AdSet: ${variant.label}`);
          adSetData = await graphPost(`act_${cleanId}/adsets`, accessToken, testBody);
          if (!adSetData.error) {
            console.log(`✅ AdSet criado com: ${variant.label} → ${adSetData.id}`);
            break;
          }
          console.log(`❌ Falhou (${variant.label}): ${adSetData.error.message}`);
        }

        if (!adSetData || adSetData.error) {
          const lastError = adSetData?.error?.message || 'Todas as variantes falharam';
          console.error(`❌ TODAS as variantes de AdSet falharam para ${accountId}`);
          results.push({ accountId, step: 'AdSet', campaignId: campaignData.id, success: false, error: lastError });
          continue;
        }
        console.log(`✅ AdSet: ${adSetData.id}`);

        // ===== 3. AD CREATIVE =====
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

        // Instagram actor (se disponível)
        if (instagramId) {
          creativeBody.object_story_spec.instagram_actor_id = instagramId;
        }

        const creativeData = await graphPost(`act_${cleanId}/adcreatives`, accessToken, creativeBody);
        if (creativeData.error) {
          results.push({ accountId, step: 'Creative', campaignId: campaignData.id, adSetId: adSetData.id, success: false, error: creativeData.error.message });
          continue;
        }
        console.log(`✅ Creative: ${creativeData.id}`);

        // ===== 4. AD =====
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

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`🚀 Backend rodando em http://localhost:${PORT}`);
  console.log(`📋 FRONTEND_URL: ${process.env.FRONTEND_URL || '(não definido)'}`);
  console.log(`📋 META_APP_ID: ${process.env.META_APP_ID ? '✓' : '✗ NÃO DEFINIDO'}`);
  console.log(`📋 META_REDIRECT_URI: ${process.env.META_REDIRECT_URI || '(não definido)'}`);
});