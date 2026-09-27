import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';

export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'Token de autenticação necessário' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Verify user exists in database
    const result = await pool.query(
      'SELECT id, email, name, plan FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token inválido' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(500).json({ error: 'Erro de autenticação' });
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query(
      'SELECT id, email, name, plan FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length > 0) {
      req.user = result.rows[0];
    }
    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
};

export const requireWorkspace = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Autenticação necessária' });
    }

    // Get or create default workspace for user
    let result = await pool.query(
      'SELECT id, name FROM workspaces WHERE user_id = $1 LIMIT 1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      // Create default workspace
      result = await pool.query(
        'INSERT INTO workspaces (user_id, name) VALUES ($1, $2) RETURNING id, name',
        [req.user.id, 'Default Workspace']
      );
    }

    req.workspace = result.rows[0];
    next();
  } catch (error) {
    console.error('Error in requireWorkspace:', error);
    return res.status(500).json({ error: 'Erro ao carregar workspace' });
  }
};