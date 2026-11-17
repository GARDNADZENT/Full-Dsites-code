const express = require('express');
const { pool, useSupabaseRest, supabaseRest } = require('../db');
const router = express.Router();

function computeRates(row, includeLossRate = false) {
    const totalRuns = Number(row.total_runs) || 0;
    const profits = Number(row.profits) || 0;
    const losses = Number(row.losses) || 0;
    const winRate = totalRuns > 0 ? Number(((profits / totalRuns) * 100).toFixed(2)) : 0;
    const formatted = {
        bot_id: row.bot_id,
        total_runs: totalRuns,
        profits,
        losses,
        profit_amount: row.profit_amount,
        loss_amount: row.loss_amount,
        win_rate: winRate,
    };
    if (includeLossRate) {
        formatted.loss_rate = totalRuns > 0 ? Number(((losses / totalRuns) * 100).toFixed(2)) : 0;
    }
    return formatted;
}

// GET best bot statistics
router.get('/', async (req, res, next) => {
    try {
        if (useSupabaseRest) {
            const rows = await supabaseRest('bot_stats', {
                query: 'select=bot_id,total_runs,profits,losses,profit_amount,loss_amount&order=profits.desc,total_runs.desc&limit=20',
            });
            return res.json(rows.map(r => computeRates(r, true)));
        }

        const result = await pool.query(`
      SELECT 
        bot_id,
        total_runs,
        profits,
        losses,
        profit_amount,
        loss_amount,
        CASE 
          WHEN total_runs > 0 THEN ROUND((profits::numeric / total_runs) * 100, 2)
          ELSE 0 
        END as win_rate,
        CASE 
          WHEN total_runs > 0 THEN ROUND((losses::numeric / total_runs) * 100, 2)
          ELSE 0 
        END as loss_rate
      FROM bot_stats
      ORDER BY profits DESC, total_runs DESC
      LIMIT 20
    `);

        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// GET single bot stats
router.get('/:botId', async (req, res, next) => {
    try {
        if (useSupabaseRest) {
            const rows = await supabaseRest('bot_stats', {
                query: `select=bot_id,total_runs,profits,losses,profit_amount,loss_amount&bot_id=eq.${encodeURIComponent(req.params.botId)}&limit=1`,
            });
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Bot stats not found' });
            }
            return res.json(computeRates(rows[0], false));
        }

        const result = await pool.query(
            `SELECT 
        bot_id,
        total_runs,
        profits,
        losses,
        profit_amount,
        loss_amount,
        CASE 
          WHEN total_runs > 0 THEN ROUND((profits::numeric / total_runs) * 100, 2)
          ELSE 0 
        END as win_rate
      FROM bot_stats
      WHERE bot_id = $1`,
            [req.params.botId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Bot stats not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

// POST update bot stats (internal use)
router.post('/:botId', async (req, res, next) => {
    try {
        const { total_runs, profits, losses, profit_amount, loss_amount } = req.body;

        if (useSupabaseRest) {
            const rows = await supabaseRest('bot_stats', {
                method: 'POST',
                query: 'on_conflict=bot_id',
                prefer: 'resolution=merge-duplicates,return=representation',
                body: {
                    bot_id: req.params.botId,
                    total_runs: total_runs || 0,
                    profits: profits || 0,
                    losses: losses || 0,
                    profit_amount: profit_amount ?? null,
                    loss_amount: loss_amount ?? null,
                    updated_at: new Date().toISOString(),
                },
            });
            return res.json(rows[0]);
        }

        const result = await pool.query(
            `INSERT INTO bot_stats (bot_id, total_runs, profits, losses, profit_amount, loss_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (bot_id) DO UPDATE SET
         total_runs = $2,
         profits = $3,
         losses = $4,
         profit_amount = $5,
         loss_amount = $6,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
            [req.params.botId, total_runs || 0, profits || 0, losses || 0, profit_amount, loss_amount]
        );

        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
