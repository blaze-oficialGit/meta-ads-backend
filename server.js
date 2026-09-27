import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'utm-tracker-secret-key-2026-super-safe';
const META_APP_ID = process.env.META_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const META_REDIRECT_URI = 'https://meta-ads-backend-production-2ce8.up.railway.app/api/auth/meta/callback'; // HARDCODED - ignore env var to fix OAuth mismatch
const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const users = new Map();
const workspaces = new Map();
const trackingLinks = new Map();
const visitors = new Map();
const sessions = new Map();
const events = [];
const orders = [];
const leads = [];
const webhookLogs = [];
const metaTokens = new Map();
const metaBusinesses = new Map();
const metaCampaigns = new Map();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
origin: process.env.FRONTEND_URL || 'https://meta-ads-frontend-one.vercel.app',
credentials: true,
methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Muitas requisicoes' }, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);
function authenticateToken(req, res, next) {
const authHeader = req.headers['authorization'];
const token = authHeader && authHeader.split(' ')[1];
if (!token) return res.status(401).json({ error: 'Token necessario' });
try {
const decoded = jwt.verify(token, JWT_SECRET);
const user = users.get(decoded.userId);
if (!user) return res.status(401).json({ error: 'Usuario nao encontrado' });
req.user = user;
next();
} catch (error) { return res.status(401).json({ error: 'Token invalido' }); }
}
function getWorkspace(userId) {
for (const [id, ws] of workspaces) { if (ws.user_id === userId) return { id, ...ws }; }
const wsId = uuidv4();
const ws = { user_id: userId, name: 'Default Workspace', created_at: new Date().toISOString() };
workspaces.set(wsId, ws);
return { id: wsId, ...ws };
}
app.post('/api/auth/register', async (req, res) => {
try {
const { email, password, name } = req.body;
if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatorios' });
const emailLower = email.toLowerCase();
for (const [id, u] of users) { if (u.email === emailLower) return res.status(409).json({ error: 'Email ja cadastrado' }); }
const passwordHash = await bcrypt.hash(password, 10);
const userId = uuidv4();
const user = { id: userId, email: emailLower, password_hash: passwordHash, name: name || null, plan: 'free', created_at: new Date().toISOString() };
users.set(userId, user);
const wsId = uuidv4();
workspaces.set(wsId, { user_id: userId, name: 'Default Workspace', created_at: new Date().toISOString() });
const token = jwt.sign({ userId, email: emailLower }, JWT_SECRET, { expiresIn: '7d' });
res.status(201).json({ message: 'Usuario criado', user: { id: userId, email: emailLower, name: user.name, plan: 'free' }, token });
} catch (error) { console.error('Register error:', error); res.status(500).json({ error: 'Erro ao criar usuario' }); }
});
app.post('/api/auth/login', async (req, res) => {
try {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatorios' });
const emailLower = email.toLowerCase();
let foundUser = null;
for (const [id, u] of users) { if (u.email === emailLower) { foundUser = { id, ...u }; break; } }
if (!foundUser) return res.status(401).json({ error: 'Email ou senha incorretos' });
const validPassword = await bcrypt.compare(password, foundUser.password_hash);
if (!validPassword) return res.status(401).json({ error: 'Email ou senha incorretos' });
const token = jwt.sign({ userId: foundUser.id, email: emailLower }, JWT_SECRET, { expiresIn: '7d' });
res.json({ message: 'Login realizado', user: { id: foundUser.id, email: foundUser.email, name: foundUser.name, plan: foundUser.plan }, token });
} catch (error) { console.error('Login error:', error); res.status(500).json({ error: 'Erro ao fazer login' }); }
});
app.get('/api/auth/me', authenticateToken, (req, res) => {
res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, plan: req.user.plan } });
});
app.put('/api/auth/me', authenticateToken, (req, res) => {
const { name, email } = req.body;
const user = users.get(req.user.id);
if (name !== undefined) user.name = name;
if (email !== undefined) user.email = email.toLowerCase();
user.updated_at = new Date().toISOString();
users.set(req.user.id, user);
res.json({ message: 'Usuario atualizado', user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
});
app.put('/api/auth/change-password', authenticateToken, async (req, res) => {
const { currentPassword, newPassword } = req.body;
if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senhas obrigatorias' });
const user = users.get(req.user.id);
const valid = await bcrypt.compare(currentPassword, user.password_hash);
if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });
user.password_hash = await bcrypt.hash(newPassword, 10);
users.set(req.user.id, user);
res.json({ message: 'Senha alterada' });
});
// In-memory OAuth state store (survives within a single Railway instance)
const oauthStates = new Map();
function cleanupExpiredStates() {
const now = Date.now();
for (const [state, data] of oauthStates) {
if (now - data.createdAt > 600000) oauthStates.delete(state);
}
}
setInterval(cleanupExpiredStates, 60000);
app.get('/api/auth/meta', authenticateToken, (req, res) => {
if (!META_APP_ID) return res.status(500).json({ error: 'META_APP_ID nao configurado' });
const state = uuidv4();
oauthStates.set(state, { userId: req.user.id, createdAt: Date.now() });
const scopes = 'ads_management,ads_read,business_management';
const authUrl = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&state=${state}&scope=${scopes}&response_type=code`;
console.log(`[OAuth] State created: ${state.substring(0,8)}... for user ${req.user.id}`);
res.json({ auth_url: authUrl });
});
app.get('/api/auth/meta/callback', async (req, res) => {
try {
const { code, state, error } = req.query;
const frontendUrl = process.env.FRONTEND_URL || 'https://meta-ads-frontend-one.vercel.app';
if (error) return res.redirect(`${frontendUrl}?error=${encodeURIComponent(error)}`);
const stateData = oauthStates.get(state);
if (!state || !stateData) {
console.error(`[OAuth] Invalid state: ${state ? state.substring(0,8) : 'null'}... not found in memory (${oauthStates.size} states stored)`);
return res.redirect(`${frontendUrl}?error=invalid_state`);
}
const userId = stateData.userId;
oauthStates.delete(state);
if (!code) return res.redirect(`${frontendUrl}?error=no_code`);
const tokenResponse = await fetch(`https://graph.facebook.com/${META_APY_VERSION}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&code=${code}`);
const tokenData = await tokenResponse.json();
if (!tokenData.access_token) return res.redirect(`${process.env.FRONTEND_URL || 'https://meta-ads-frontend-one.vercel.app'}?error=token_failed`);
const longLivedResponse = await fetch(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
const longLivedData = await longLivedResponse.json();
const accessToken = longLivedData.access_token || tokenData.access_token;
const expiresAt = longLivedData.expires_in ? new Date(Date.now() + longLivedData.expires_in * 1000).toISOString() : null;
metaTokens.set(userId, { access_token: accessToken, expires_at: expiresAt, connected_at: new Date().toISOString() });
const meResponse = await fetch(`https://graph.facebook.com/${META_API_VERSION}/me?fields=id,name&access_token=${accessToken}`);
const meData = await meResponse.json();
const user = users.get(userId);
if (user) { user.meta_user_id = meData.id; user.meta_name = meData.name; users.set(userId, user); }
// state already deleted from memory
// user retrieved from state data
res.redirect(`${process.env.FRONTEND_URL || 'https://meta-ads-frontend-one.vercel.app'}?meta_connected=true`);
} catch (error) { console.error('Meta callback error:', error); res.redirect(`${process.env.FRONTEND_URL || 'https://meta-ads-frontend-one.vercel.app'}?error=callback_failed`); }
});
app.get('/api/auth/meta/status', authenticateToken, (req, res) => {
const tokenData = metaTokens.get(req.user.id);
if (!tokenData) return res.json({ connected: false, businesses: [] });
const businesses = Array.from(metaBusinesses.values()).filter(b => b.user_id === req.user.id);
res.json({ connected: true, expires_at: tokenData.expires_at, businesses });
});
app.delete('/api/auth/meta', authenticateToken, (req, res) => {
metaTokens.delete(req.user.id);
for (const [key, b] of metaBusinesses) { if (b.user_id === req.user.id) metaBusinesses.delete(key); }
for (const [key, c] of metaCampaigns) { if (c.user_id === req.user.id) metaCampaigns.delete(key); }
res.json({ success: true, message: 'Meta desconectado' });
});
app.post('/api/meta/businesses', authenticateToken, async (req, res) => {
try {
const tokenData = metaTokens.get(req.user.id);
if (!tokenData) return res.status(401).json({ error: 'Meta nao conectado' });
const response = await fetch(`https://graph.facebook.com/${META_APY_VERSION}/me/businesses?fields=id,name&limit=100&access_token=${tokenData.access_token}`);
const data = await response.json();
if (data.error) return res.status(400).json({ error: data.error.message });
const businesses = (data.data || []).map(b => { const business = { id: b.id, name: b.name, user_id: req.user.id }; metaBusinesses.set(b.id, business); return business; });
res.json({ businesses });
} catch (error) { console.error('Get businesses error:', error); res.status(500).json({ error: 'Erro ao buscar negocios' }); }
});
app.post('/api/meta/campaigns', authenticateToken, async (req, res) => {
try {
const tokenData = metaTokens.get(req.user.id);
if (!tokenData) return res.status(401).json({ error: 'Meta nao conectado' });
const { ad_account_id, name, objective, daily_budget, lifetime_budget, status, pixel_id, conversion_event, config } = req.body;
if (!ad_account_id || !name) return res.status(400).json({ error: 'ad_account_id e name obrigatorios' });
const campaignBody = { name, objective: objective || 'OUTCOME_SALES', special_ad_account_id: ad_account_id, status: status || 'PAUSED', daily_budget: daily_budget ? Math.round(parseFloat(daily_budget) * 100) : undefined, lifetime_budget: lifetime_budget ? Math.round(parseFloat(lifetime_budget) * 100) : undefined };
const campaignResponse = await fetch(`https://graph.facebook.com/${META_APY_VERSION}/${ad_account_id}/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...campaignBody, access_token: tokenData.access_token }) });
const campaignData = await campaignResponse.json();
if (campaignData.error) return res.status(400).json({ error: campaignData.error.message, code: campaignData.error.code });
const pixelId = pixel_id || config?.pixel_id;
const conversionEvent = conversion_event || config?.conversion_event || 'PURCHASE';
const adSetName = `${name} - AdSet `;
const adSetBody = { name: adSetName, campaign_id: campaignData.id, status: 'PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', destination_type: 'WEBSITE', promoted_object: { pixel_id: pixelId, custom_event_type: conversionEvent }, targeting: { age_min: config?.age_min || 18, age_max: config?.age_max || 65, geo_locations: { countries: ['BR'] } } };
if (daily_budget) adSetBody.daily_budget = Math.round(parseFloat(daily_budget) * 100);
if (lifetime_budget) adSetBody.lifetime_budget = Math.round(parseFloat(lifetime_budget) * 100);
const adSetResponse = await fetch(`https://graph.facebook.com/${META_APY_VERSION}/${ad_account_id}/adsets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...adSetBody, access_token: tokenData.access_token }) });
const adSetData = await adSetResponse.json();
if (adSetData.error) return res.status(400).json({ error: `AdSet: ${adSetData.error.message}`, code: adSetData.error.code });
const creativeBody = { name: `${name} - Creative`, object_story_url: config?.object_story_url || 'https://example.com', message: config?.message || '' };
const creativeResponse = await fetch(`https://graph.facebook.com/${META_APY_VERSION}/${ad_account_id}/adcreatives`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...creativeBody, access_token: tokenData.access_token }) });
const creativeData = await creativeResponse.json();
if (creativeData.error) return res.status(400).json({ error: `Creative: ${creativeData.error.message}`, code: creativeData.error.code });
const adBody = { name: `${name} - Ad`, adset_id: adSetData.id, creative: { creative_id: creativeData.id }, status: 'PAUSED' };
const adResponse = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${ad_account_id}/ads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...adBody, access_token: tokenData.access_token }) });
const adData = await adResponse.json();
if (adData.error) return res.status(400).json({ error: `Ad: ${adData.error.message}`, code: adData.error.code });
const campaign = { id: campaignData.id, adset_id: adSetData.id, creative_id: creativeData.id, ad_id: adData.id, name, ad_account_id, objective, status: status || 'PAUSED', created_at: new Date().toISOString(), user_id: req.user.id };
metaCampaigns.set(campaign.id, campaign);
res.json({ success: true, campaign });
} catch (error) { console.error('Create campaign error:', error); res.status(500).json({ error: 'Erro ao criar campanha' }); }
});
app.post('/api/links', authenticateToken, (req, res) => {
const { name, destination_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id } = req.body;
if (!destination_url) return res.status(400).json({ error: 'destination_url obrigatorio' });
const ws = getWorkspace(req.user.id);
const shortCode = uuidv4().substring(0, 8);
const url = new URL(destination_url);
if (utm_source) url.searchParams.set('utm_source', utm_source);
if (utm_medium) url.searchParams.set('utm_medium', utm_medium);
if (utm_campaign) url.searchParams.set('utm_campaign', utm_campaign);
if (utm_content) url.searchParams.set('utm_content', utm_content);
if (utm_term) url.searchParams.set('utm_term', utm_term);
const link = { id: uuidv4(), workspace_id: ws.id, user_id: req.user.id, name, destination_url, short_code: shortCode, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id, clicks_count: 0, created_at: new Date().toISOString() };
trackingLinks.set(link.id, link);
res.json({ success: true, link, tracking_url: url.toString(), short_url: '/r' + shortCode });
});
app.get('/api/links', authenticateToken, (req, res) => { const ws = getWorkspace(req.user.id); const links = Array.from(trackingLinks.values()).filter(l => l.workspace_id === ws.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); res.json({ links, total: links.length }); });
app.delete('/api/links/:id', authenticateToken, (req, res) => { trackingLinks.delete(req.params.id); res.json({ success: true, message: 'Link deletado' }); });
app.get('/api/orders', authenticateToken, (req, res) => { const ws = getWorkspace(req.user.id); const wsOrders = orders.filter(o => o.workspace_id === ws.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); res.json({ orders: wsOrders, total: wsOrders.length }); });
app.get('/api/orders/:id', authenticateToken, (req, res) => { const order = orders.find(o => o.id === req.params.id); if (!order) return res.status(404).json({ error: 'Venda nao encontrada' }); res.json({ order, journey: { events: events.filter(e => e.session_id === order.session_id), clicks: [], leads: leads.filter(l => l.session_id === order.session_id) } }); });
app.get('/api/visitors', authenticateToken, (req, res) => { const allVisitors = Array.from(visitors.values()).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen)); res.json({ visitors: allVisitors.slice(0, 100), total: allVisitors.length }); });
app.get('/api/visitors/:id/journey', authenticateToken, (req, res) => { const visitor = visitors.get(req.params.id) || Array.from(visitors.values()).find(v => v.id === req.params.id); if (!visitor) return res.status(404).json({ error: 'Visitante nao encontrado' }); const vId = visitor.visitor_id || req.params.id; res.json({ visitor, sessions: Array.from(sessions.values()).filter(s => s.visitor_id === vId), events: events.filter(e => e.visitor_id === vId), orders: orders.filter(o => o.visitor_id === vId), leads: leads.filter(l => l.visitor_id === vId) }); });
app.get('/api/events', authenticateToken, (req, res) => { const sorted = [...events].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 100); const enriched = sorted.map(e => { const s = sessions.get(e.session_id); return { ...e, utm_source: s?.utm_source, utm_campaign: s?.utm_campaign }; }); res.json({ events: enriched, total: events.length }); });
app.get('/api/campaigns', authenticateToken, (req, res) => { res.json({ campaigns: [], total: 0 }); });
app.get('/api/integrations', authenticateToken, (req, res) => {
const tokenData = metaTokens.get(req.user.id);
const platforms = [
{ platform: 'meta', name: 'Meta Ads (Facebook/Instagram)', status: 'ready', connected: !!tokenData },
{ platform: 'tiktok', name: 'TikTok Ads', status: 'ready', connected: false },
{ platform: 'google', name: 'Google Ads', status: 'ready', connected: false },
{ platform: 'hotmart', name: 'Hotmart', status: 'webhook', connected: false },
{ platform: 'kiwify', name: 'Kiwify', status: 'webhook', connected: false },
{ platform: 'stripe', name: 'Stripe', status: 'webhook', connected: false }
];
res.json({ integrations: platforms });
});
app.get('/tracking.js', (req, res) => { res.sendFile(join(__dirname, 'public', 'tracking.js')); });

// PATCH campaign - update budget or status via Meta API
app.patch('/api/meta/campaigns/:id', authenticateToken, async (req, res) => {
  try {
    const tokenData = metaTokens.get(req.user.id);
    if (!tokenData) return res.status(401).json({ error: 'Meta nao conectado' });
    const { daily_budget, lifetime_budget, status } = req.body;
    const body = {};
    if (daily_budget !== undefined) body.daily_budget = Math.round(parseFloat(daily_budget) * 100);
    if (lifetime_budget !== undefined) body.lifetime_budget = Math.round(parseFloat(lifetime_budget) * 100);
    if (status !== undefined) body.status = status;
    if (Object.keys(body).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    const response = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${req.params.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, access_token: tokenData.access_token })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message, code: data.error.code });
    res.json({ success: true, id: data.id || req.params.id, updated: body });
  } catch (error) {
    console.error('Patch campaign error:', error);
    res.status(500).json({ error: 'Erro ao atualizar campanha' });
  }
});

// GET ad accounts with details
app.get('/api/meta/adaccounts', authenticateToken, async (req, res) => {
  try {
    const tokenData = metaTokens.get(req.user.id);
    if (!tokenData) return res.status(401).json({ error: 'Meta nao conectado' });
    const response = await fetch(`https://graph.facebook.com/${META_API_VERSION}/me/adaccounts?fields=id,name,account_status,balance,amount_spent,currency&limit=100&access_token=${tokenData.access_token}`);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ accounts: data.data || [] });
  } catch (error) {
    console.error('Get ad accounts error:', error);
    res.status(500).json({ error: 'Erro ao buscar contas' });
  }
});

// GET adsets for a campaign
app.get('/api/meta/campaigns/:id/adsets', authenticateToken, async (req, res) => {
  try {
    const tokenData = metaTokens.get(req.user.id);
    if (!tokenData) return res.status(401).json({ error: 'Meta nao conectado' });
    const response = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${req.params.id}/adsets?fields=id,name,status,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,created_time,updated_time,targeting,optimization_goal,bid_strategy&limit=100&access_token=${tokenData.access_token}`);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ adsets: data.data || [] });
  } catch (error) {
    console.error('Get adsets error:', error);
    res.status(500).json({ error: 'Erro ao buscar conjuntos' });
  }
});

// GET ads for an adset
app.get('/api/meta/adsets/:id/ads', authenticateToken, async (req, res) => {
  try {
    const tokenData = metaTokens.get(req.user.id);
    if (!tokenData) return res.status(401).json({ error: 'Meta nao conectado' });
    const response = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${req.params.id}/ads?fields=id,name,status,created_time,updated_time,effective_status&limit=100&access_token=${tokenData.access_token}`);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ ads: data.data || [] });
  } catch (error) {
    console.error('Get ads error:', error);
    res.status(500).json({ error: 'Erro ao buscar anuncios' });
  }
});

// PATCH adset - update budget or status
app.patch('/api/meta/adsets/:id', authenticateToken, async (req, res) => {
  try {
    const tokenData = metaTokens.get(req.user.id);
    if (!tokenData) return res.status(401).json({ error: 'Meta nao conectado' });
    const { daily_budget, lifetime_budget, status } = req.body;
    const body = {};
    if (daily_budget !== undefined) body.daily_budget = Math.round(parseFloat(daily_budget) * 100);
    if (lifetime_budget !== undefined) body.lifetime_budget = Math.round(parseFloat(lifetime_budget) * 100);
    if (status !== undefined) body.status = status;
    if (Object.keys(body).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    const response = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${req.params.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, access_token: tokenData.access_token })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message, code: data.error.code });
    res.json({ success: true, id: data.id || req.params.id, updated: body });
  } catch (error) {
    console.error('Patch adset error:', error);
    res.status(500).json({ error: 'Erro ao atualizar conjunto' });
  }
});
app.get('/api/health', (req, res) => { res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', storage: 'memory', users_count: users.size, orders_count: orders.length, meta_connected: metaTokens.size }); });
app.use((req, res) => res.status(404).json({ error: 'Endpoint nao encontrado' }));
app.use((err, req, res, next) => { console.error('Error:', err); res.status(err.status || 500).json({ error: err.message || 'Erro interno' }); });
app.listen(PORT, () => { console.log('UTM Tracker Backend running on port ' + PORT); console.log('Storage: in-memory'); console.log('Meta App ID: ' + (META_APP_ID ? 'configured' : 'NOT SET')); console.log('Frontend: ' + (process.env.FRONTEND_URL || 'not set')); });