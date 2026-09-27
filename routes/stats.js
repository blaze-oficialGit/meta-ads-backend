import express from 'express';
import pool from './db/pool.js';
import { authenticateToken, requireWorkspace } from './middleware/auth.js';

const router = express.Router();

// Get dashboard stats
router.get('/dashboard', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { period = '7d', start_date, end_date } = req.query;
    const workspaceId = req.workspace.id;

    // Calculate date range
    let dateFilter;
    let dateParams = [workspaceId];
    let paramCount = 2;

    if (start_date && end_date) {
      dateFilter = `AND created_at >= $${paramCount++} AND created_at <= $${paramCount++}`;
      dateParams.push(start_date, end_date);
    } else {
      const days = period === 'today' ? 0 : period === 'yesterday' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 7;
      if (period === 'today') {
        dateFilter = `AND created_at >= CURRENT_DATE`;
      } else if (period === 'yesterday') {
        dateFilter = `AND created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE`;
      } else {
        dateFilter = `AND created_at >= NOW() - INTERVAL '${days} days'`;
      }
    }

    // Get orders stats
    const ordersQuery = `
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(amount), 0) as total_revenue,
        COALESCE(AVG(amount), 0) as avg_ticket,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_orders,
        COUNT(CASE WHEN status = 'refunded' THEN 1 END) as refunded_orders
      FROM orders
      WHERE workspace_id = $1 ${dateFilter.replace(/created_at/g, 'orders.created_at')}
    `;
    const ordersResult = await pool.query(ordersQuery, dateParams);
    const orders = ordersResult.rows[0];

    // Get clicks count
    const clicksQuery = `
      SELECT COUNT(*) as total_clicks
      FROM clicks
      WHERE workspace_id = $1 ${dateFilter.replace(/created_at/g, 'clicked_at')}
    `;
    const clicksResult = await pool.query(clicksQuery, dateParams);
    const clicks = clicksResult.rows[0].total_clicks;

    // Get leads count
    const leadsQuery = `
      SELECT COUNT(*) as total_leads
      FROM leads
      WHERE workspace_id = $1 ${dateFilter.replace(/created_at/g, 'leads.created_at')}
    `;
    const leadsResult = await pool.query(leadsQuery, dateParams);
    const leads = leadsResult.rows[0].total_leads;

    // Get investment from campaigns (if synced)
    const investmentQuery = `
      SELECT COALESCE(SUM((metrics->>'spend')::numeric), 0) as total_spend
      FROM campaigns
      WHERE workspace_id = $1
    `;
    const investmentResult = await pool.query(investmentQuery, [workspaceId]);
    const investment = investmentResult.rows[0].total_spend;

    // Calculate derived metrics
    const revenue = parseFloat(orders.total_revenue);
    const salesCount = parseInt(orders.approved_orders);
    const cpa = salesCount > 0 ? investment / salesCount : 0;
    const cpl = leads > 0 ? investment / leads : 0;
    const roas = investment > 0 ? revenue / investment : 0;
    const conversionRate = clicks > 0 ? (salesCount / clicks) * 100 : 0;

    // Get time series data for charts
    const timeSeriesQuery = `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as orders_count,
        COALESCE(SUM(amount), 0) as revenue
      FROM orders
      WHERE workspace_id = $1 AND status = 'approved' ${dateFilter.replace(/created_at/g, 'orders.created_at')}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;
    const timeSeriesResult = await pool.query(timeSeriesQuery, dateParams);

    const clicksTimeSeriesQuery = `
      SELECT
        DATE(clicked_at) as date,
        COUNT(*) as clicks_count
      FROM clicks
      WHERE workspace_id = $1 ${dateFilter.replace(/created_at/g, 'clicked_at')}
      GROUP BY DATE(clicked_at)
      ORDER BY date ASC
    `;
    const clicksTimeSeriesResult = await pool.query(clicksTimeSeriesQuery, dateParams);

    res.json({
      summary: {
        investment: parseFloat(investment),
        revenue,
        sales: salesCount,
        leads: parseInt(leads),
        clicks: parseInt(clicks),
        conversion_rate: parseFloat(conversionRate.toFixed(2)),
        cpa: parseFloat(cpa.toFixed(2)),
        cpl: parseFloat(cpl.toFixed(2)),
        roas: parseFloat(roas.toFixed(2)),
        avg_ticket: parseFloat(orders.avg_ticket),
        profit: revenue - investment
      },
      time_series: {
        revenue: timeSeriesResult.rows,
        clicks: clicksTimeSeriesResult.rows
      },
      period,
      is_demo: process.env.DEMO_MODE === 'true'
    });

  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

// Get revenue over time
router.get('/revenue', authenticateToken, requireWorkspace, async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    const workspaceId = req.workspace.id;
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 7;

    const result = await pool.query(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as orders_count,
        COALESCE(SUM(amount), 0) as revenue
      FROM orders
      WHERE workspace_id = $1 AND status = 'approved' AND created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC`,
      [workspaceId]
    );

    res.json({ data: result.rows });
  } catch (error) {
    console.error('Get revenue error:', error);
    res.status(500).json({ error: 'Erro ao carregar dados de receita' });
  }
});

export default router;