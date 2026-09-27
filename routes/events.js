import express from 'express';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Get all events
router.get('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { limit = 100, offset = 0, event_type, start_date, end_date } = req.query;
    let query = 'SELECT e.*, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term FROM events e LEFT JOIN sessions s ON e.session_id = s.id WHERE e.workspace_id = $1';
    const params = [req.workspace.id];
    let paramCount = 2;

    if (event_type) {
      query += ` AND e.event_type = $${paramCount++}`;
      params.push(event_type);
    }

    if (start_date) {
      query += ` AND e.timestamp >= $${paramCount++}`;
      params.push(start_date);
    }

    if (end_date) {
      query += ` AND e.timestamp <= $${paramCount++}`;
      params.push(end_date);
    }

    query += ` ORDER BY e.timestamp DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM events WHERE workspace_id = $1',
      [req.workspace.id]
    );

    res.json({
      events: result.rows,
      total: parseInt(countResult.rows[0].total)
    });
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Erro ao carregar eventos' });
  }
});

// Record event (authenticated)
router.post('/', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { session_id, event_type, event_data = {} } = req.body;

    if (!session_id || !event_type) {
      return res.status(400).json({ error: 'session_id e event_type são obrigatórios' });
    }

    // Get session to verify ownership
    const sessionResult = await pool.query(
      'SELECT id, visitor_id FROM sessions WHERE session_id = $1 AND workspace_id = $2',
      [session_id, req.workspace.id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    const session = sessionResult.rows[0];

    const result = await pool.query(
      `INSERT INTO events (session_id, visitor_id, workspace_id, event_type, event_data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [session.id, session.visitor_id, req.workspace.id, event_type, JSON.stringify(event_data)]
    );

    res.json({
      success: true,
      event_id: result.rows[0].id,
      message: 'Evento registrado com sucesso'
    });
  } catch (error) {
    console.error('Record event error:', error);
    res.status(500).json({ error: 'Erro ao registrar evento' });
  }
});

export default router;