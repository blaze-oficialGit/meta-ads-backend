import express from 'express';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Get all orders
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status, platform, campaign, product, start_date, end_date } = req.query;
    let query = `SELECT o.*, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.campaign_id, s.adgroup_id, s.ad_id
                 FROM orders o
                 LEFT JOIN sessions s ON o.session_id = s.id
                 WHERE o.workspace_id = $1`;
    const params = [req.workspace.id];
    let paramCount = 2;

    if (status) {
      query += ` AND o.status = $${paramCount++}`;
      params.push(status);
    }

    if (campaign) {
      query += ` AND (s.utm_campaign ILIKE $${paramCount} OR o.attributed_to->>'campaign' ILIKE $${paramCount})`;
      params.push(`%${campaign}%`);
      paramCount++;
    }

    if (product) {
      query += ` AND o.product_name ILIKE $${paramCount++}`;
      params.push(`%${product}%`);
    }

    if (start_date) {
      query += ` AND o.created_at >= $${paramCount++}`;
      params.push(start_date);
    }

    if (end_date) {
      query += ` AND o.created_at <= $${paramCount++}`;
      params.push(end_date);
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM orders WHERE workspace_id = $1',
      [req.workspace.id]
    );

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0].total)
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Erro ao carregar vendas' });
  }
});

// Get single order with full journey
router.get('/:id', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const orderResult = await pool.query(
      `SELECT o.*, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.campaign_id, s.adgroup_id, s.ad_id, s.referrer, s.landing_page
       FROM orders o
       LEFT JOIN sessions s ON o.session_id = s.id
       WHERE o.id = $1 AND o.workspace_id = $2`,
      [req.params.id, req.workspace.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Venda não encontrada' });
    }

    const order = orderResult.rows[0];

    // Get full journey if session exists
    let journey = null;
    if (order.session_id) {
      const eventsResult = await pool.query(
        'SELECT * FROM events WHERE session_id = $1 ORDER BY timestamp ASC',
        [order.session_id]
      );

      const clicksResult = await pool.query(
        'SELECT * FROM clicks WHERE session_id = $1 ORDER BY clicked_at ASC',
        [order.session_id]
      );

      const leadsResult = await pool.query(
        'SELECT * FROM leads WHERE session_id = $1',
        [order.session_id]
      );

      journey = {
        events: eventsResult.rows,
        clicks: clicksResult.rows,
        leads: leadsResult.rows
      };
    }

    res.json({
      order,
      journey
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Erro ao carregar venda' });
  }
});

// Update order status
router.patch('/:id/status', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status é obrigatório' });
    }

    const result = await pool.query(
      'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3 RETURNING id, status',
      [status, req.params.id, req.workspace.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Venda não encontrada' });
    }

    res.json({
      success: true,
      message: 'Status atualizado com sucesso',
      order: result.rows[0]
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

export default router;