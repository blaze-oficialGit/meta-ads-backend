import express from 'express';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Get all integrations
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, platform, account_id, is_active, created_at, updated_at,
              CASE WHEN access_token IS NOT NULL THEN true ELSE false END as has_credentials
       FROM integrations
       WHERE workspace_id = $1
       ORDER BY platform`,
      [req.workspace.id]
    );

    // List of supported platforms
    const supportedPlatforms = [
      { platform: 'meta', name: 'Meta Ads (Facebook/Instagram)', status: 'ready' },
      { platform: 'tiktok', name: 'TikTok Ads', status: 'ready' },
      { platform: 'google', name: 'Google Ads', status: 'ready' },
      { platform: 'hotmart', name: 'Hotmart', status: 'webhook' },
      { platform: 'kiwify', name: 'Kiwify', status: 'webhook' },
      { platform: 'stripe', name: 'Stripe', status: 'webhook' }
    ];

    // Merge with existing integrations
    const integrations = supportedPlatforms.map(sp => {
      const existing = result.rows.find(r => r.platform === sp.platform);
      return {
        ...sp,
        connected: !!existing,
        integration: existing || null
      };
    });

    res.json({ integrations });
  } catch (error) {
    console.error('Get integrations error:', error);
    res.status(500).json({ error: 'Erro ao carregar integrações' });
  }
});

// Connect integration (save credentials)
router.post('/connect', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { platform, access_token, refresh_token, account_id, config = {} } = req.body;

    if (!platform) {
      return res.status(400).json({ error: 'Platform é obrigatório' });
    }

    // Check if integration already exists
    const existing = await pool.query(
      'SELECT id FROM integrations WHERE workspace_id = $1 AND platform = $2',
      [req.workspace.id, platform]
    );

    let result;
    if (existing.rows.length > 0) {
      // Update existing
      result = await pool.query(
        `UPDATE integrations
         SET access_token = $1, refresh_token = $2, account_id = $3, config = $4, is_active = true, updated_at = NOW()
         WHERE workspace_id = $5 AND platform = $6
         RETURNING id, platform, account_id, is_active`,
        [access_token, refresh_token, account_id, JSON.stringify(config), req.workspace.id, platform]
      );
    } else {
      // Create new
      result = await pool.query(
        `INSERT INTO integrations (workspace_id, user_id, platform, access_token, refresh_token, account_id, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, platform, account_id, is_active`,
        [req.workspace.id, req.user.id, platform, access_token, refresh_token, account_id, JSON.stringify(config)]
      );
    }

    res.json({
      success: true,
      message: `Integração com ${platform} conectada com sucesso`,
      integration: result.rows[0]
    });
  } catch (error) {
    console.error('Connect integration error:', error);
    res.status(500).json({ error: 'Erro ao conectar integração' });
  }
});

// Disconnect integration
router.delete('/:platform', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM integrations WHERE workspace_id = $1 AND platform = $2 RETURNING id',
      [req.workspace.id, req.params.platform]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Integração não encontrada' });
    }

    res.json({
      success: true,
      message: `Integração com ${req.params.platform} desconectada`
    });
  } catch (error) {
    console.error('Disconnect integration error:', error);
    res.status(500).json({ error: 'Erro ao desconectar integração' });
  }
});

// Get webhook URL for payment platforms
router.get('/webhook-url/:platform', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { platform } = req.params;
    const webhookUrl = `${process.env.FRONTEND_URL?.replace('localhost:5173', 'localhost:3000') || 'http://localhost:3000'}/api/webhooks/${platform === 'purchase' ? 'purchase' : 'lead'}`;

    res.json({
      platform,
      webhook_url: webhookUrl,
      instructions: `Configure este URL como webhook de ${platform} na plataforma de pagamento. O sistema receberá automaticamente as vendas e atribuirá aos UTMs corretos.`
    });
  } catch (error) {
    console.error('Get webhook URL error:', error);
    res.status(500).json({ error: 'Erro ao gerar URL do webhook' });
  }
});

export default router;