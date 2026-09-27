import express from 'express';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Get all visitors
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { limit = 50, offset = 0, search } = req.query;
    let query = 'SELECT * FROM visitors WHERE workspace_id = $1';
    const params = [req.workspace.id];
    let paramCount = 2;

    if (search) {
      query += ` AND (visitor_id ILIKE $${paramCount} OR country ILIKE $${paramCount} OR city ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    query += ` ORDER BY last_seen DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM visitors WHERE workspace_id = $1',
      [req.workspace.id]
    );

    res.json({
      visitors: result.rows,
      total: parseInt(countResult.rows[0].total)
    });
  } catch (error) {
    console.error('Get visitors error:', error);
    res.status(500).json({ error: 'Erro ao carregar visitantes' });
  }
});

// Get visitor journey
router.get('/:id/journey', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    // Get visitor info
    const visitorResult = await pool.query(
      'SELECT * FROM visitors WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id]
    );

    if (visitorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Visitante não encontrado' });
    }

    // Get sessions
    const sessionsResult = await pool.query(
      'SELECT * FROM sessions WHERE visitor_id = $1 ORDER BY started_at DESC',
      [req.params.id]
    );

    // Get events
    const eventsResult = await pool.query(
      'SELECT * FROM events WHERE visitor_id = $1 ORDER BY timestamp ASC',
      [req.params.id]
    );

    // Get clicks
    const clicksResult = await pool.query(
      'SELECT * FROM clicks WHERE visitor_id = $1 ORDER BY clicked_at DESC',
      [req.params.id]
    );

    // Get leads
    const leadsResult = await pool.query(
      'SELECT * FROM leads WHERE visitor_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    // Get orders
    const ordersResult = await pool.query(
      'SELECT * FROM orders WHERE visitor_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({
      visitor: visitorResult.rows[0],
      sessions: sessionsResult.rows,
      events: eventsResult.rows,
      clicks: clicksResult.rows,
      leads: leadsResult.rows,
      orders: ordersResult.rows
    });
  } catch (error) {
    console.error('Get visitor journey error:', error);
    res.status(500).json({ error: 'Erro ao carregar jornada do visitante' });
  }
});

export default router;