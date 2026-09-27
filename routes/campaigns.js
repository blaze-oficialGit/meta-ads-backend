import express from 'express';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Get all campaigns
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { platform, limit = 50, offset = 0 } = req.query;
    let query = 'SELECT * FROM campaigns WHERE workspace_id = $1';
    const params = [req.workspace.id];
    let paramCount = 2;

    if (platform) {
      query += ` AND platform = $${paramCount++}`;
      params.push(platform);
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM campaigns WHERE workspace_id = $1',
      [req.workspace.id]
    );

    res.json({
      campaigns: result.rows,
      total: parseInt(countResult.rows[0].total)
    });

  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(500).json({ error: 'Erro ao carregar campanhas' });
  }
});

// Get campaign with ad groups and ads
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const campaignResult = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id]
    );

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campanha não encontrada' });
    }

    const adGroupsResult = await pool.query(
      'SELECT * FROM ad_groups WHERE campaign_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    const adsResult = await pool.query(
      `SELECT a.* FROM ads a
       JOIN ad_groups ag ON a.ad_group_id = ag.id
       WHERE ag.campaign_id = $1
       ORDER BY a.created_at DESC`,
      [req.params.id]
    );

    // Get orders attributed to this campaign
    const ordersResult = await pool.query(
      `SELECT * FROM orders
       WHERE workspace_id = $1 AND attributed_to->>'campaign_id' = $2
       ORDER BY created_at DESC`,
      [req.workspace.id, campaignResult.rows[0].external_id]
    );

    res.json({
      campaign: campaignResult.rows[0],
      ad_groups: adGroupsResult.rows,
      ads: adsResult.rows,
      orders: ordersResult.rows
    });

  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Erro ao carregar campanha' });
  }
});

// Sync campaigns from integration (placeholder for future API integrations)
router.post('/sync', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { platform } = req.body;

    // Check if integration exists
    const integrationResult = await pool.query(
      'SELECT * FROM integrations WHERE workspace_id = $1 AND platform = $2 AND is_active = true',
      [req.workspace.id, platform]
    );

    if (integrationResult.rows.length === 0) {
      return res.status(400).json({
        error: `Integração com ${platform} não configurada. Vá em Integrações para conectar.`
      });
    }

    // Placeholder: In production, this would call the platform's API
    // For now, return a message indicating the integration structure is ready
    res.json({
      success: true,
      message: `Estrutura de sincronização pronta para ${platform}. Configure as credenciais da API para ativar.`,
      integration: integrationResult.rows[0]
    });

  } catch (error) {
    console.error('Sync campaigns error:', error);
    res.status(500).json({ error: 'Erro ao sincronizar campanhas' });
  }
});

export default router;