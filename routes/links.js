import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Generate tracking link
router.post('/generate', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const {
      name,
      destination_url,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      campaign_id,
      adgroup_id,
      ad_id,
      placement,
      creative_id,
      custom_params = {}
    } = req.body;

    if (!destination_url) {
      return res.status(400).json({ error: 'URL de destino é obrigatória' });
    }

    // Generate short code
    const shortCode = uuidv4().substring(0, 8);

    // Build full tracking URL with UTMs
    const url = new URL(destination_url);
    if (utm_source) url.searchParams.set('utm_source', utm_source);
    if (utm_medium) url.searchParams.set('utm_medium', utm_medium);
    if (utm_campaign) url.searchParams.set('utm_campaign', utm_campaign);
    if (utm_content) url.searchParams.set('utm_content', utm_content);
    if (utm_term) url.searchParams.set('utm_term', utm_term);
    if (campaign_id) url.searchParams.set('campaign_id', campaign_id);
    if (adgroup_id) url.searchParams.set('adgroup_id', adgroup_id);
    if (ad_id) url.searchParams.set('ad_id', ad_id);
    if (placement) url.searchParams.set('placement', placement);
    if (creative_id) url.searchParams.set('creative_id', creative_id);

    // Add custom params
    Object.entries(custom_params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });

    const trackingUrl = url.toString();

    // Save to database
    const result = await pool.query(
      `INSERT INTO tracking_links (workspace_id, user_id, name, destination_url, short_code, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id, custom_params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        req.workspace.id,
        req.user.id,
        name,
        destination_url,
        shortCode,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        campaign_id,
        adgroup_id,
        ad_id,
        placement,
        creative_id,
        JSON.stringify(custom_params)
      ]
    );

    res.json({
      success: true,
      link: result.rows[0],
      tracking_url: trackingUrl,
      short_url: `${process.env.FRONTEND_URL}/r/${shortCode}`
    });

  } catch (error) {
    console.error('Generate link error:', error);
    res.status(500).json({ error: 'Erro ao gerar link rastreável' });
  }
});

// Get all tracking links
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await pool.query(
      `SELECT * FROM tracking_links
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.workspace.id, parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM tracking_links WHERE workspace_id = $1',
      [req.workspace.id]
    );

    res.json({
      links: result.rows,
      total: parseInt(countResult.rows[0].total)
    });

  } catch (error) {
    console.error('Get links error:', error);
    res.status(500).json({ error: 'Erro ao carregar links' });
  }
});

// Get single link
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tracking_links WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link não encontrado' });
    }

    res.json({ link: result.rows[0] });

  } catch (error) {
    console.error('Get link error:', error);
    res.status(500).json({ error: 'Erro ao carregar link' });
  }
});

// Delete link
router.delete('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM tracking_links WHERE id = $1 AND workspace_id = $2 RETURNING id',
      [req.params.id, req.workspace.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link não encontrado' });
    }

    res.json({ success: true, message: 'Link deletado com sucesso' });

  } catch (error) {
    console.error('Delete link error:', error);
    res.status(500).json({ error: 'Erro ao deletar link' });
  }
});

// Redirect short URL
router.get('/r/:code', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT destination_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id, custom_params FROM tracking_links WHERE short_code = $1',
      [req.params.code]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('Link não encontrado');
    }

    const link = result.rows[0];

    // Build redirect URL with UTMs
    const url = new URL(link.destination_url);
    if (link.utm_source) url.searchParams.set('utm_source', link.utm_source);
    if (link.utm_medium) url.searchParams.set('utm_medium', link.utm_medium);
    if (link.utm_campaign) url.searchParams.set('utm_campaign', link.utm_campaign);
    if (link.utm_content) url.searchParams.set('utm_content', link.utm_content);
    if (link.utm_term) url.searchParams.set('utm_term', link.utm_term);
    if (link.campaign_id) url.searchParams.set('campaign_id', link.campaign_id);
    if (link.adgroup_id) url.searchParams.set('adgroup_id', link.adgroup_id);
    if (link.ad_id) url.searchParams.set('ad_id', link.ad_id);
    if (link.placement) url.searchParams.set('placement', link.placement);
    if (link.creative_id) url.searchParams.set('creative_id', link.creative_id);

    // Increment click count
    await pool.query(
      'UPDATE tracking_links SET clicks_count = clicks_count + 1 WHERE short_code = $1',
      [req.params.code]
    );

    res.redirect(302, url.toString());

  } catch (error) {
    console.error('Redirect error:', error);
    res.status(500).send('Erro ao redirecionar');
  }
});

export default router;