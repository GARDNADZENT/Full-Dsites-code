const { Pool } = require('pg');

const useSupabaseRest = Boolean(
    !process.env.DATABASE_URL && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
);

const pool = process.env.DATABASE_URL
    ? new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: {
              rejectUnauthorized: false,
          },
      })
    : null;

if (pool) {
    pool.on('error', err => {
        console.error('[DB] Unexpected error on idle client', err);
        if (!process.env.VERCEL) {
            process.exit(-1);
        }
    });
}

async function supabaseRest(table, { method = 'GET', query = '', body, prefer } = {}) {
    const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
    if (!baseUrl || !key) {
        const err = new Error('Database is not configured (set DATABASE_URL or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
        err.status = 503;
        throw err;
    }

    const url = `${baseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
    const headers = {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
    };
    if (prefer) {
        headers.Prefer = prefer;
    }

    const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Supabase REST error (${response.status}): ${text}`);
        err.status = response.status >= 500 ? 502 : 400;
        throw err;
    }

    if (response.status === 204) {
        return [];
    }
    const text = await response.text();
    return text ? JSON.parse(text) : [];
}

let initPromise = null;

async function initializeDatabase() {
    if (useSupabaseRest) {
        await supabaseRest('bot_ideas', { query: 'select=id&limit=1' });
        console.log('[DB] Supabase REST connection verified.');
        return;
    }

    if (!pool) {
        const err = new Error('DATABASE_URL or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY is required');
        err.status = 503;
        throw err;
    }

    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_ideas (
        id SERIAL PRIMARY KEY,
        bot_name VARCHAR(255) NOT NULL,
        strategy_description TEXT NOT NULL,
        submitted_by VARCHAR(255) NOT NULL,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_runs INTEGER DEFAULT 0,
        profits INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        profit_amount DECIMAL(15, 2),
        loss_amount DECIMAL(15, 2),
        bot_xml TEXT,
        bot_xml_filename VARCHAR(255),
        developed_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await pool.query(`
      CREATE TABLE IF NOT EXISTS scanner_signals (
        id SERIAL PRIMARY KEY,
        scan_time TIMESTAMP NOT NULL,
        next_scan_time TIMESTAMP,
        market_symbol VARCHAR(50) NOT NULL,
        market_label VARCHAR(100),
        group_name VARCHAR(100),
        trade_type VARCHAR(50),
        contract_type VARCHAR(50),
        direction VARCHAR(50),
        barrier INTEGER,
        confidence DECIMAL(5, 2),
        edge DECIMAL(10, 4),
        z_score DECIMAL(10, 4),
        recommended_runs INTEGER,
        signal_label VARCHAR(255),
        tick_count INTEGER,
        is_valid BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        id SERIAL PRIMARY KEY,
        bot_id VARCHAR(255) NOT NULL UNIQUE,
        total_runs INTEGER DEFAULT 0,
        profits INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        profit_amount DECIMAL(15, 2),
        loss_amount DECIMAL(15, 2),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

        console.log('[DB] Database connection successful');
        console.log('[DB] Database tables verified / created.');
    } catch (err) {
        console.error('[DB] Error initializing database:', err);
        throw err;
    }
}

function ensureDatabaseInitialized() {
    if (!initPromise) {
        initPromise = initializeDatabase().catch(err => {
            initPromise = null;
            throw err;
        });
    }
    return initPromise;
}

module.exports = {
    pool,
    useSupabaseRest,
    supabaseRest,
    initializeDatabase,
    ensureDatabaseInitialized,
};
