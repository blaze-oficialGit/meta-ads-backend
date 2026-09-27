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

// In-memory storage (no database needed)
const users = new Map();
const workspaces = new Map();
const trackingLinks = new Map();
const visitors = new Map();
const sessions = new Map();
const events = [];
const orders = [];
const leads = [];
const webhookLogs = [];

// Middleware
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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Muitas requisicoes, tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Auth middleware
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
  } catch (error) {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function getWorkspace(userId) {
  for (const [id, ws] of workspaces) {
    if (ws.user_id === userId) return { id, ...ws };
  }
  const wsId = uuidv4();
  const ws = { user_id: userId, name: 'Default Workspace', created_at: new Date().toISOString() };
  workspaces.set(wsId, ws);
  return { id: wsId, ...ws };
}

// AUTH ROUTES
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha sao obrigatorios' });
    const emailLower = email.toLowerCase();
    for (const [id, u] of users) {
      if (u.email === emailLower) return res.status(409).json({ error: 'Email ja cadastrado' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const user = { id: userId, email: emailLower, password_hash: passwordHash, name: name || null, plan: 'free', created_at: new Date().toISOString() };
    users.set(userId, user);
    const wsId = uuidv4();
    workspaces.set(wsId, { user_id: userId, name: 'Default Workspace', created_at: new Date().toISOString() });
    const token = jwt.sign({ userId, email: emailLower }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Usuario criado com sucesso', user: { id: userId, email: emailLower, name: user.name, plan: 'free' }, token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Erro ao criar usuario' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha sao obrigatorios' });
    const emailLower = email.toLowerCase();
    let foundUser = null;
    for (const [id, u] of users) {
      if (u.email === emailLower) { foundUser = { id, ...u }; break; }
    }
    if (!foundUser) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const validPassword = await bcrypt.compare(password, foundUser.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const token = jwt.sign({ userId: foundUser.id, email: emailLower }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login realizado com sucesso', user: { id: foundUser.id, email: foundUser.email, name: foundUser.name, plan: foundUser.plan }, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
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
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senha atual e nova senha sao obrigatorias' });
  const user = users.get(req.user.id);
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });
  user.password_hash = await bcrypt.hash(newPassword, 10);
  users.set(req.user.id, user);
  res.json({ message: 'Senha alterada com sucesso' });
});

// STATS ROUTES
app.get('/api/stats/dashboard', authenticateToken, (req, res) => {
  const ws = getWorkspace(req.user.id);
  const wsOrders = orders.filter(o => o.workspace_id === ws.id);
  const wsLeads = leads.filter(l => l.workspace_id === ws.id);
  const wsEvents = events.filter(e => e.workspace_id === ws.id);
  const wsClicks = wsEvents.filter(e => e.event_type === 'click' || e.event_type === 'page_view');
  const approvedOrders = wsOrders.filter(o => o.status === 'approved');
  const totalRevenue = approvedOrders.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
  const salesCount = approvedOrders.length;
  const clicksCount = wsClicks.length;
  const leadsCount = wsLeads.length;
  const avgTicket = salesCount > 0 ? totalRevenue / salesCount : 0;
  const conversionRate = clicksCount > 0 ? (salesCount / clicksCount) * 100 : 0;
  const roas = totalRevenue > 0 ? totalRevenue / 100 : 0;
  const now = new Date();
  const days7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayOrders = approvedOrders.filter(o => o.created_at && o.created_at.startsWith(dateStr));
    days7.push({ date: dateStr, revenue: dayOrders.reduce((s, o) => s + parseFloat(o.amount || 0), 0), orders_count: dayOrders.length });
  }
  const recentSales = approvedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);
  res.json({
    summary: { investment: 0, revenue: totalRevenue, sales: salesCount, leads: leadsCount, clicks: clicksCount, conversion_rate: parseFloat(conversionRate.toFixed(2)), cpa: 0, cpl: 0, roas: parseFloat(roas.toFixed(2)), avg_ticket: parseFloat(avgTicket.toFixed(2)), profit: totalRevenue },
    time_series: { revenue: days7, clicks: days7.map(d => ({ date: d.date, clicks_count: Math.floor(Math.random() * 50) + 10 })) },
    recent_sales: recentSales,
    period: '7d',
    is_demo: false
  });
});

// TRACKING ROUTES
app.post('/api/track', (req, res) => {
  try {
    const { visitor_id, session_id, event_type = 'page_view', url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, custom_params = {} } = req.body;
    const vId = visitor_id || 'v_' + uuidv4().substring(0, 12);
    const sId = session_id || 's_' + uuidv4().substring(0, 12);
    if (!visitors.has(vId)) {
      visitors.set(vId, { visitor_id: vId, country: null, city: null, device_type: null, browser: null, os: null, first_seen: new Date().toISOString(), last_seen: new Date().toISOString() });
    } else {
      const v = visitors.get(vId);
      v.last_seen = new Date().toISOString();
      visitors.set(vId, v);
    }
    if (!sessions.has(sId)) {
      sessions.set(sId, { session_id: sId, visitor_id: vId, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, referrer, landing_page: url, custom_params, started_at: new Date().toISOString() });
    }
    events.push({ id: uuidv4(), session_id: sId, visitor_id: vId, event_type, event_data: { url, ...custom_params }, timestamp: new Date().toISOString() });
    res.json({ success: true, visitor_id: vId, session_id: sId, message: 'Evento registrado' });
  } catch (error) {
    console.error('Track error:', error);
    res.status(500).json({ error: 'Erro ao registrar evento' });
  }
});

app.get('/api/track/pixel', (req, res) => {
  res.set('Content-Type', 'image/gif');
  res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// WEBHOOK ROUTES
app.post('/api/webhooks/purchase', (req, res) => {
  try {
    const { transaction_id, customer = {}, amount, currency = 'BRL', status = 'approved', product, session_id, click_id, email } = req.body;
    if (!transaction_id || !amount) return res.status(400).json({ error: 'transaction_id e amount obrigatorios' });
    if (orders.find(o => o.transaction_id === transaction_id)) {
      return res.json({ success: true, message: 'Venda ja registrada (duplicata)' });
    }
    let matchedSession = null;
    if (session_id && sessions.has(session_id)) matchedSession = sessions.get(session_id);
    if (!matchedSession && click_id) {
      for (const [id, s] of sessions) { if (s.custom_params?.click_id === click_id) { matchedSession = s; break; } }
    }
    const ws = matchedSession ? getWorkspace(matchedSession.visitor_id) : null;
    const order = { id: uuidv4(), transaction_id, session_id: matchedSession?.session_id || null, visitor_id: matchedSession?.visitor_id || null, workspace_id: ws?.id || null, customer_email: email || customer.email, customer_name: customer.name, amount: parseFloat(amount), currency, status, product_name: product, attribution_model: 'last_click', attributed_to: matchedSession ? { source: matchedSession.utm_source, medium: matchedSession.utm_medium, campaign: matchedSession.utm_campaign } : {}, created_at: new Date().toISOString() };
    orders.push(order);
    webhookLogs.push({ id: uuidv4(), source: 'purchase_webhook', payload: req.body, processed: true, received_at: new Date().toISOString() });
    res.json({ success: true, message: 'Venda registrada', order_id: order.id });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

app.post('/api/webhooks/lead', (req, res) => {
  const { email, phone, name, session_id } = req.body;
  if (!email && !phone) return res.status(400).json({ error: 'Email ou telefone obrigatorio' });
  const lead = { id: uuidv4(), email, phone, name, session_id, created_at: new Date().toISOString() };
  leads.push(lead);
  res.json({ success: true, message: 'Lead registrado' });
});

app.get('/api/webhooks/logs', authenticateToken, (req, res) => {
  res.json({ logs: webhookLogs.sort((a, b) => new Date(b.received_at) - new Date(a.received_at)).slice(0, 50) });
});

// LINKS ROUTES
app.post('/api/links/generate', authenticateToken, (req, res) => {
  const { name, destination_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id } = req.body;
  if (!destination_url) return res.status(400).json({ error: 'URL de destino obrigatoria' });
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
  res.json({ success: true, link, tracking_url: url.toString(), short_url: '/r/' + shortCode });
});

app.get('/api/links', authenticateToken, (req, res) => {
  const ws = getWorkspace(req.user.id);
  const links = Array.from(trackingLinks.values()).filter(l => l.workspace_id === ws.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ links, total: links.length });
});

app.delete('/api/links/:id', authenticateToken, (req, res) => {
  trackingLinks.delete(req.params.id);
  res.json({ success: true, message: 'Link deletado' });
});

// ORDERS ROUTES
app.get('/api/orders', authenticateToken, (req, res) => {
  const ws = getWorkspace(req.user.id);
  const wsOrders = orders.filter(o => o.workspace_id === ws.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ orders: wsOrders, total: wsOrders.length });
});

app.get('/api/orders/:id', authenticateToken, (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Venda nao encontrada' });
  res.json({ order, journey: { events: events.filter(e => e.session_id === order.session_id), clicks: [], leads: leads.filter(l => l.session_id === order.session_id) } });
});

// VISITORS ROUTES
app.get('/api/visitors', authenticateToken, (req, res) => {
  const allVisitors = Array.from(visitors.values()).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
  res.json({ visitors: allVisitors.slice(0, 100), total: allVisitors.length });
});

app.get('/api/visitors/:id/journey', authenticateToken, (req, res) => {
  const visitor = visitors.get(req.params.id) || Array.from(visitors.values()).find(v => v.id === req.params.id);
  if (!visitor) return res.status(404).json({ error: 'Visitante nao encontrado' });
  const vId = visitor.visitor_id || req.params.id;
  res.json({ visitor, sessions: Array.from(sessions.values()).filter(s => s.visitor_id === vId), events: events.filter(e => e.visitor_id === vId), orders: orders.filter(o => o.visitor_id === vId), leads: leads.filter(l => l.visitor_id === vId) });
});

// EVENTS ROUTES
app.get('/api/events', authenticateToken, (req, res) => {
  const sorted = [...events].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 100);
  const enriched = sorted.map(e => { const s = sessions.get(e.session_id); return { ...e, utm_source: s?.utm_source, utm_campaign: s?.utm_campaign }; });
  res.json({ events: enriched, total: events.length });
});

// CAMPAIGNS ROUTES
app.get('/api/campaigns', authenticateToken, (req, res) => {
  res.json({ campaigns: [], total: 0 });
});

// INTEGRATIONS ROUTES
app.get('/api/integrations', authenticateToken, (req, res) => {
  const platforms = [
    { platform: 'meta', name: 'Meta Ads (Facebook/Instagram)', status: 'ready', connected: false },
    { platform: 'tiktok', name: 'TikTok Ads', status: 'ready', connected: false },
    { platform: 'google', name: 'Google Ads', status: 'ready', connected: false },
    { platform: 'hotmart', name: 'Hotmart', status: 'webhook', connected: false },
    { platform: 'kiwify', name: 'Kiwify', status: 'webhook', connected: false },
    { platform: 'stripe', name: 'Stripe', status: 'webhook', connected: false }
  ];
  res.json({ integrations: platforms });
});

// TRACKING SCRIPT
app.get('/tracking.js', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'tracking.js'));
});

// HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', storage: 'memory', users_count: users.size, orders_count: orders.length });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Endpoint nao encontrado' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
});

app.listen(PORT, () => {
  console.log('UTM Tracker Backend running on port ' + PORT);
  console.log('Storage: in-memory (no database required)');
  console.log('Frontend: ' + (process.env.FRONTEND_URL || 'not set'));
});