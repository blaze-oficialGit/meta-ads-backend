import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Receive purchase webhook (public endpoint for payment platforms)
router.post('/purchase', async (req, res) => {
  try {
    const {
      transaction_id,
      customer = {},
      amount,
      currency = 'BRL',
      status = 'approved',
      product,
      click_id,
      external_id,
      session_id,
      email,
      phone,
      metadata = {}
    } = req.body;

    if (!transaction_id || !amount) {
      return res.status(400).json({ error: 'transaction_id e amount são obrigatórios' });
    }

    // Log the webhook
    await pool.query(
      `INSERT INTO webhook_logs (source, payload, processed)
       VALUES ($1, $2, false)`,
      ['purchase_webhook', JSON.stringify(req.body)]
    );

    // Check for duplicate transaction
    const existingOrder = await pool.query(
      'SELECT id FROM orders WHERE transaction_id = $1',
      [transaction_id]
    );

    if (existingOrder.rows.length > 0) {
      return res.json({
        success: true,
        message: 'Venda já registrada (duplicata ignorada)',
        order_id: existingOrder.rows[0].id
      });
    }

    // Try to find matching session/visitor
    let sessionId = null;
    let visitorId = null;
    let workspaceId = null;
    let attribution = {};

    // Method 1: Match by session_id
    if (session_id) {
      const sessionResult = await pool.query(
        `SELECT id, visitor_id, workspace_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adgroup_id, ad_id
         FROM sessions WHERE session_id = $1`,
        [session_id]
      );
      if (sessionResult.rows.length > 0) {
        const session = sessionResult.rows[0];
        sessionId = session.id;
        visitorId = session.visitor_id;
        workspaceId = session.workspace_id;
        attribution = {
          source: session.utm_source,
          medium: session.utm_medium,
          campaign: session.utm_campaign,
          content: session.utm_content,
          term: session.utm_term,
          campaign_id: session.campaign_id,
          adgroup_id: session.adgroup_id,
          ad_id: session.ad_id
        };
      }
    }

    // Method 2: Match by click_id or external_id in custom_params
    if (!sessionId && (click_id || external_id)) {
      const sessionResult = await pool.query(
        `SELECT s.id, s.visitor_id, s.workspace_id, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.campaign_id, s.adgroup_id, s.ad_id
         FROM sessions s
         WHERE s.custom_params->>'click_id' = $1 OR s.custom_params->>'external_id' = $2
         ORDER BY s.started_at DESC LIMIT 1`,
        [click_id, external_id]
      );
      if (sessionResult.rows.length > 0) {
        const session = sessionResult.rows[0];
        sessionId = session.id;
        visitorId = session.visitor_id;
        workspaceId = session.workspace_id;
        attribution = {
          source: session.utm_source,
          medium: session.utm_medium,
          campaign: session.utm_campaign,
          content: session.utm_content,
          term: session.utm_term,
          campaign_id: session.campaign_id,
          adgroup_id: session.adgroup_id,
          ad_id: session.ad_id
        };
      }
    }

    // Method 3: Match by email
    if (!sessionId && email) {
      const sessionResult = await pool.query(
        `SELECT s.id, s.visitor_id, s.workspace_id, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.campaign_id, s.adgroup_id, s.ad_id
         FROM sessions s
         JOIN leads l ON l.session_id = s.id
         WHERE l.email = $1
         ORDER BY s.started_at DESC LIMIT 1`,
        [email.toLowerCase()]
      );
      if (sessionResult.rows.length > 0) {
        const session = sessionResult.rows[0];
        sessionId = session.id;
        visitorId = session.visitor_id;
        workspaceId = session.workspace_id;
        attribution = {
          source: session.utm_source,
          medium: session.utm_medium,
          campaign: session.utm_campaign,
          content: session.utm_content,
          term: session.utm_term,
          campaign_id: session.campaign_id,
          adgroup_id: session.adgroup_id,
          ad_id: session.ad_id
        };
      }
    }

    // Create the order
    const orderResult = await pool.query(
      `INSERT INTO orders (transaction_id, session_id, visitor_id, workspace_id, customer_email, customer_name, customer_phone, amount, currency, status, product_name, attribution_model, attributed_to, webhook_source, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        transaction_id,
        sessionId,
        visitorId,
        workspaceId,
        email || customer.email,
        customer.name,
        phone || customer.phone,
        amount,
        currency,
        status,
        product,
        'last_click',
        JSON.stringify(attribution),
        'webhook',
        JSON.stringify(req.body)
      ]
    );

    // Record purchase event
    if (sessionId) {
      await pool.query(
        `INSERT INTO events (session_id, visitor_id, workspace_id, event_type, event_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, visitorId, workspaceId, 'purchase', JSON.stringify({ transaction_id, amount, product })]
      );
    }

    // Update webhook log
    await pool.query(
      `UPDATE webhook_logs SET processed = true WHERE source = 'purchase_webhook' AND payload->>'transaction_id' = $1`,
      [transaction_id]
    );

    res.json({
      success: true,
      message: 'Venda registrada com sucesso',
      order_id: orderResult.rows[0].id,
      attributed: Object.keys(attribution).length > 0
    });

  } catch (error) {
    console.error('Webhook purchase error:', error);
    res.status(500).json({ error: 'Erro ao processar webhook de venda' });
  }
});

// Receive lead webhook
router.post('/lead', async (req, res) => {
  try {
    const {
      email,
      phone,
      name,
      session_id,
      click_id,
      data = {}
    } = req.body;

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email ou telefone é obrigatório' });
    }

    let sessionId = null;
    let visitorId = null;
    let workspaceId = null;

    // Try to match session
    if (session_id) {
      const sessionResult = await pool.query(
        'SELECT id, visitor_id, workspace_id FROM sessions WHERE session_id = $1',
        [session_id]
      );
      if (sessionResult.rows.length > 0) {
        sessionId = sessionResult.rows[0].id;
        visitorId = sessionResult.rows[0].visitor_id;
        workspaceId = sessionResult.rows[0].workspace_id;
      }
    }

    if (!sessionId && click_id) {
      const sessionResult = await pool.query(
        `SELECT id, visitor_id, workspace_id FROM sessions
         WHERE custom_params->>'click_id' = $1
         ORDER BY started_at DESC LIMIT 1`,
        [click_id]
      );
      if (sessionResult.rows.length > 0) {
        sessionId = sessionResult.rows[0].id;
        visitorId = sessionResult.rows[0].visitor_id;
        workspaceId = sessionResult.rows[0].workspace_id;
      }
    }

    // Create lead
    await pool.query(
      `INSERT INTO leads (session_id, visitor_id, workspace_id, email, phone, name, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, visitorId, workspaceId, email?.toLowerCase(), phone, name, JSON.stringify(data)]
    );

    // Record lead event
    if (sessionId) {
      await pool.query(
        `INSERT INTO events (session_id, visitor_id, workspace_id, event_type, event_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, visitorId, workspaceId, 'lead', JSON.stringify({ email, phone, name })]
      );
    }

    res.json({ success: true, message: 'Lead registrado com sucesso' });

  } catch (error) {
    console.error('Webhook lead error:', error);
    res.status(500).json({ error: 'Erro ao processar webhook de lead' });
  }
});

// Get webhook logs (authenticated)
router.get('/logs', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await pool.query(
      `SELECT * FROM webhook_logs
       WHERE workspace_id = $1
       ORDER BY received_at DESC
       LIMIT $2 OFFSET $3`,
      [req.workspace.id, parseInt(limit), parseInt(offset)]
    );
    res.json({ logs: result.rows });
  } catch (error) {
    console.error('Get webhook logs error:', error);
    res.status(500).json({ error: 'Erro ao carregar logs de webhook' });
  }
});

export default router;