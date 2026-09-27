import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import authRoutes from './routes/auth.js';
import trackingRoutes from './routes/tracking.js';
import webhookRoutes from './routes/webhooks.js';
import statsRoutes from './routes/stats.js';
import campaignsRoutes from './routes/campaigns.js';
import linksRoutes from './routes/links.js';
import visitorsRoutes from './routes/visitors.js';
import eventsRoutes from './routes/events.js';
import integrationsRoutes from './routes/integrations.js';
import ordersRoutes from './routes/orders.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Muitas requisições, tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to API routes
app.use('/api/', limiter);

// Public tracking endpoint (no rate limit for tracking pixels/scripts)
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // higher limit for tracking
  message: { error: 'Too many tracking requests' },
  skipSuccessfulRequests: true,
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/track', trackingLimiter, trackingRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/links', linksRoutes);
app.use('/api/visitors', visitorsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/orders', ordersRoutes);

// Serve tracking script
app.get('/tracking.js', (req, res) => {
  res.sendFile(join(__dirname, '../public/tracking.js'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint não encontrado' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 UTM Tracker Backend rodando em http://localhost:${PORT}`);
  console.log(`📊 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`🔒 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 DATABASE_URL: ${process.env.DATABASE_URL ? '✓ Configurado' : '✗ NÃO CONFIGURADO'}`);
});

export default app;