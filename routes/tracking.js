import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from './db/pool.js';
import { optionalAuth } from './middleware/auth.js';

const router = express.Router();

// Track visitor click/event
router.post('/', optionalAuth, async (req, res) => {
  try {
    const {
      visitor_id,
      session_id,
      event_type = 'page_view',
      url,
      referrer,
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
      custom_params = {},
      user_agent,
      ip_address,
      country,
      city,
      device_type,
      browser,
      os
    } = req.body;

    // Get workspace from authenticated user or from tracking link
    let workspaceId = req.user?.id ?
      (await pool.query('SELECT id FROM workspaces WHERE user_id = $1 LIMIT 1', [req.user.id])).rows[0]?.id :
      null;

    // If no workspace from auth, try to get from tracking link
    if (!workspaceId && (campaign_id || utm_campaign)) {
      const linkResult = await pool.query(
        'SELECT workspace_id FROM tracking_links WHERE campaign_id = $1 OR utm_campaign = $2 LIMIT 1',
        [campaign_id, utm_campaign]
      );
      if (linkResult.rows.length > 0) {
        workspaceId = linkResult.rows[0].workspace_id;
      }
    }

    // Create or update visitor
    let visitorResult;
    if (visitor_id) {
      visitorResult = await pool.query(
        `INSERT INTO visitors (visitor_id, workspace_id, country, city, device_type, browser, os, ip_address, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (visitor_id)
         DO UPDATE SET last_seen = NOW(), country = COALESCE($3, visitors.country), city = COALESCE($4, visitors.city)
         RETURNING id`,
        [visitor_id, workspaceId, country, city, device_type, browser, os, ip_address]
      );
    } else {
      const newVisitorId = uuidv4();
      visitorResult = await pool.query(
        `INSERT INTO visitors (visitor_id, workspace_id, country, city, device_type, browser, os, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [newVisitorId, workspaceId, country, city, device_type, browser, os, ip_address]
      );
    }

    const visitorDbId = visitorResult.rows[0].id;
    const finalVisitorId = visitor_id || visitorResult.rows[0].visitor_id;

    // Create or update session
    let sessionResult;
    if (session_id) {
      sessionResult = await pool.query(
        `INSERT INTO sessions (session_id, visitor_id, workspace_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id, referrer, landing_page, custom_params)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (session_id)
         DO UPDATE SET ended_at = NULL, is_active = true
         RETURNING id`,
        [session_id, visitorDbId, workspaceId, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id, referrer, url, JSON.stringify(custom_params)]
      );
    } else {
      const newSessionId = uuidv4();
      sessionResult = await pool.query(
        `INSERT INTO sessions (session_id, visitor_id, workspace_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id, referrer, landing_page, custom_params)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [newSessionId, visitorDbId, workspaceId, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id, placement, creative_id, referrer, url, JSON.stringify(custom_params)]
      );
    }

    const sessionDbId = sessionResult.rows[0].id;
    const finalSessionId = session_id || sessionResult.rows[0].session_id;

    // Record event
    await pool.query(
      `INSERT INTO events (session_id, visitor_id, workspace_id, event_type, event_data)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionDbId, visitorDbId, workspaceId, event_type, JSON.stringify({ url, ...custom_params })]
    );

    // If this is a click event, also record in clicks table
    if (event_type === 'click' || event_type === 'page_view') {
      await pool.query(
        `INSERT INTO clicks (session_id, visitor_id, tracking_link_id, workspace_id, url, referrer, user_agent, ip_address, country, city, device_type, browser, os)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [sessionDbId, visitorDbId, null, workspaceId, url, referrer, user_agent, ip_address, country, city, device_type, browser, os]
      );

      // Update tracking link click count if applicable
      if (campaign_id || utm_campaign) {
        await pool.query(
          `UPDATE tracking_links SET clicks_count = clicks_count + 1
           WHERE (campaign_id = $1 OR utm_campaign = $2) AND workspace_id = $3`,
          [campaign_id, utm_campaign, workspaceId]
        );
      }
    }

    res.json({
      success: true,
      visitor_id: finalVisitorId,
      session_id: finalSessionId,
      message: 'Evento registrado com sucesso'
    });
  } catch (error) {
    console.error('Tracking error:', error);
    res.status(500).json({ error: 'Erro ao registrar evento' });
  }
});

// Track page view (GET endpoint for pixel tracking)
router.get('/pixel', async (req, res) => {
  try {
    const {
      visitor_id,
      session_id,
      url,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      campaign_id,
      adgroup_id,
      ad_id
    } = req.query;

    // Forward to POST handler logic
    req.body = {
      visitor_id,
      session_id,
      event_type: 'page_view',
      url,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_content,
      utm_term,
      campaign_id,
      adgroup_id,
      ad_id,
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    };

    // Return 1x1 transparent pixel
    res.set('Content-Type', 'image/gif');
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  } catch (error) {
    console.error('Pixel tracking error:', error);
    res.status(500).send('');
  }
});

export default router;