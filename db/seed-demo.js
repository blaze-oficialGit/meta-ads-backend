import pool from './pool.js';
import { v4 as uuidv4 } from 'uuid';

async function seedDemoData() {
  try {
    console.log(' Gerando dados de demonstração...');

    // Create demo user
    const demoUserId = uuidv4();
    const demoWorkspaceId = uuidv4();

    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, plan)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO NOTHING`,
      [demoUserId, 'demo@utmtracker.com', '$2a$10$dummy.hash.for.demo.only', 'Usuário Demo', 'free']
    );

    await pool.query(
      `INSERT INTO workspaces (id, user_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [demoWorkspaceId, demoUserId, 'Demo Workspace']
    );

    // Generate demo tracking links
    const demoLinks = [
      { name: 'Campanha TikTok Setembro', source: 'tiktok', medium: 'paid', campaign: 'setembro_2026' },
      { name: 'Campanha Meta Ads Q3', source: 'facebook', medium: 'cpc', campaign: 'q3_2026' },
      { name: 'Google Ads - Search', source: 'google', medium: 'cpc', campaign: 'search_brand' },
      { name: 'Instagram Reels', source: 'instagram', medium: 'social', campaign: 'reels_promo' },
      { name: 'Email Marketing', source: 'newsletter', medium: 'email', campaign: 'weekly_digest' }
    ];

    for (const link of demoLinks) {
      const shortCode = uuidv4().substring(0, 8);
      await pool.query(
        `INSERT INTO tracking_links (workspace_id, user_id, name, destination_url, short_code, utm_source, utm_medium, utm_campaign, clicks_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [demoWorkspaceId, demoUserId, link.name, 'https://example.com/oferta', shortCode, link.source, link.medium, link.campaign, Math.floor(Math.random() * 500) + 50]
      );
    }

    // Generate demo visitors and sessions
    const countries = ['Brasil', 'Estados Unidos', 'Portugal', 'Argentina', 'México'];
    const devices = ['mobile', 'desktop', 'tablet'];
    const browsers = ['Chrome', 'Safari', 'Firefox', 'Edge'];

    for (let i = 0; i < 50; i++) {
      const visitorId = `v_demo_${uuidv4().substring(0, 8)}`;
      const sessionId = `s_demo_${uuidv4().substring(0, 8)}`;
      const country = countries[Math.floor(Math.random() * countries.length)];
      const device = devices[Math.floor(Math.random() * devices.length)];
      const browser = browsers[Math.floor(Math.random() * browsers.length)];
      const daysAgo = Math.floor(Math.random() * 30);

      const visitorResult = await pool.query(
        `INSERT INTO visitors (visitor_id, workspace_id, country, device_type, browser, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '${daysAgo} days', NOW() - INTERVAL '${Math.floor(Math.random() * daysAgo)} days')
         RETURNING id`,
        [visitorId, demoWorkspaceId, country, device, browser]
      );
      const visitorDbId = visitorResult.rows[0].id;

      const link = demoLinks[Math.floor(Math.random() * demoLinks.length)];
      await pool.query(
        `INSERT INTO sessions (session_id, visitor_id, workspace_id, utm_source, utm_medium, utm_campaign, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '${daysAgo} days')`,
        [sessionId, visitorDbId, demoWorkspaceId, link.source, link.medium, link.campaign]
      );

      // Generate events
      const sessionResult = await pool.query('SELECT id FROM sessions WHERE session_id = $1', [sessionId]);
      const sessionDbId = sessionResult.rows[0].id;

      await pool.query(
        `INSERT INTO events (session_id, visitor_id, workspace_id, event_type, timestamp)
         VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${daysAgo} days')`,
        [sessionDbId, visitorDbId, demoWorkspaceId, 'page_view']
      );

      if (Math.random() > 0.5) {
        await pool.query(
          `INSERT INTO events (session_id, visitor_id, workspace_id, event_type, timestamp)
           VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${daysAgo} days' + INTERVAL '5 minutes')`,
          [sessionDbId, visitorDbId, demoWorkspaceId, 'click']
        );
      }

      // Generate some leads and orders
      if (Math.random() > 0.7) {
        await pool.query(
          `INSERT INTO leads (session_id, visitor_id, workspace_id, email, created_at)
           VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${daysAgo} days' + INTERVAL '10 minutes')`,
          [sessionDbId, visitorDbId, demoWorkspaceId, `lead${i}@example.com`]
        );
      }

      if (Math.random() > 0.85) {
        const transactionId = `txn_demo_${uuidv4().substring(0, 12)}`;
        const amount = (Math.random() * 200 + 27).toFixed(2);
        await pool.query(
          `INSERT INTO orders (transaction_id, session_id, visitor_id, workspace_id, customer_email, amount, currency, status, product_name, attribution_model, attributed_to, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() - INTERVAL '${daysAgo} days' + INTERVAL '15 minutes')`,
          [transactionId, sessionDbId, visitorDbId, demoWorkspaceId, `customer${i}@example.com`, amount, 'BRL', 'approved', 'Produto Demo', 'last_click', JSON.stringify({ source: link.source, campaign: link.campaign })]
        );

        await pool.query(
          `INSERT INTO events (session_id, visitor_id, workspace_id, event_type, event_data, timestamp)
           VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '${daysAgo} days' + INTERVAL '15 minutes')`,
          [sessionDbId, visitorDbId, demoWorkspaceId, 'purchase', JSON.stringify({ transaction_id: transactionId, amount })]
        );
      }
    }

    console.log('✅ Dados de demonstração gerados com sucesso!');
    console.log('   - 5 links rastreáveis');
    console.log('   - 50 visitantes');
    console.log('   - Eventos, leads e vendas simulados');
    console.log('   Login demo: demo@utmtracker.com / senha: demo123');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro ao gerar dados de demonstração:', error.message);
    process.exit(1);
  }
}

seedDemoData();