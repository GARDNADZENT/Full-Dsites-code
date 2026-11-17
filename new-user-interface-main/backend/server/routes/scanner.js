const express = require('express');
const { pool, useSupabaseRest, supabaseRest } = require('../db');
const router = express.Router();

let lastSignal = null;
let nextScanTime = new Date(Date.now() + 240000); // 4 minutes from now
let scannerStatus = 'initializing';

function mapSignalRow(signal) {
    const scanDate = signal.scan_time instanceof Date ? signal.scan_time : new Date(signal.scan_time);
    const nextDate = signal.next_scan_time
        ? signal.next_scan_time instanceof Date
            ? signal.next_scan_time
            : new Date(signal.next_scan_time)
        : nextScanTime;
    return {
        scanTime: scanDate.toISOString(),
        nextScanTime: nextDate.toISOString(),
        marketSymbol: signal.market_symbol,
        marketLabel: signal.market_label,
        groupName: signal.group_name,
        tradeType: signal.trade_type,
        contractType: signal.contract_type,
        direction: signal.direction,
        barrier: signal.barrier,
        confidence: signal.confidence != null ? parseFloat(signal.confidence) : null,
        edge: signal.edge != null ? parseFloat(signal.edge) : null,
        zScore: signal.z_score != null ? parseFloat(signal.z_score) : null,
        recommendedRuns: signal.recommended_runs,
        signalLabel: signal.signal_label,
        tickCount: signal.tick_count,
        isValid: signal.is_valid,
    };
}

async function fetchLatestSignal() {
    if (useSupabaseRest) {
        const rows = await supabaseRest('scanner_signals', {
            query: 'select=*&is_valid=eq.true&order=scan_time.desc&limit=1',
        });
        return rows.length > 0 ? mapSignalRow(rows[0]) : null;
    }
    if (!pool) return null;
    const result = await pool.query(`
      SELECT * FROM scanner_signals
      WHERE is_valid = true
      ORDER BY scan_time DESC
      LIMIT 1
    `);
    return result.rows.length > 0 ? mapSignalRow(result.rows[0]) : null;
}

async function initializeScannerData() {
    try {
        const latest = await fetchLatestSignal();
        if (latest) {
            lastSignal = latest;
            scannerStatus = 'ok';
            console.log(`[Scanner] Loaded last signal from DB: ${latest.marketLabel} ${latest.direction}`);
        } else {
            scannerStatus = 'idle';
        }
    } catch (error) {
        console.error('[Scanner] Error loading initial signal:', error);
    }
}

// GET current scanner signal
router.get('/signal', async (req, res, next) => {
    try {
        if (process.env.VERCEL || !lastSignal) {
            const latest = await fetchLatestSignal();
            if (latest) {
                lastSignal = latest;
                nextScanTime = new Date(latest.nextScanTime);
                scannerStatus = 'ok';
            } else if (scannerStatus === 'initializing') {
                scannerStatus = 'idle';
            }
        }
        res.json({
            status: scannerStatus,
            signal: lastSignal,
            nextScanTime: nextScanTime.toISOString(),
        });
    } catch (error) {
        next(error);
    }
});

// POST new scanner signal (internal use)
router.post('/signal', async (req, res, next) => {
    try {
        const {
            marketSymbol,
            marketLabel,
            groupName,
            tradeType,
            contractType,
            direction,
            barrier,
            confidence,
            edge,
            zScore,
            recommendedRuns,
            signalLabel,
            tickCount,
            isValid,
        } = req.body;

        const scanTime = new Date();
        nextScanTime = new Date(scanTime.getTime() + 240000); // 4 minutes

        if (useSupabaseRest) {
            const rows = await supabaseRest('scanner_signals', {
                method: 'POST',
                prefer: 'return=representation',
                body: {
                    scan_time: scanTime.toISOString(),
                    next_scan_time: nextScanTime.toISOString(),
                    market_symbol: marketSymbol,
                    market_label: marketLabel ?? null,
                    group_name: groupName ?? null,
                    trade_type: tradeType ?? null,
                    contract_type: contractType ?? null,
                    direction: direction ?? null,
                    barrier: barrier ?? null,
                    confidence: confidence ?? null,
                    edge: edge ?? null,
                    z_score: zScore ?? null,
                    recommended_runs: recommendedRuns ?? null,
                    signal_label: signalLabel ?? null,
                    tick_count: tickCount ?? null,
                    is_valid: isValid ?? true,
                },
            });
            lastSignal = mapSignalRow(rows[0]);
            scannerStatus = 'ok';
            return res.status(201).json(lastSignal);
        }

        await pool.query(
            `INSERT INTO scanner_signals (
        scan_time, next_scan_time, market_symbol, market_label, group_name,
        trade_type, contract_type, direction, barrier, confidence, edge,
        z_score, recommended_runs, signal_label, tick_count, is_valid
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
            [
                scanTime,
                nextScanTime,
                marketSymbol,
                marketLabel,
                groupName,
                tradeType,
                contractType,
                direction,
                barrier,
                confidence,
                edge,
                zScore,
                recommendedRuns,
                signalLabel,
                tickCount,
                isValid,
            ]
        );

        lastSignal = {
            scanTime: scanTime.toISOString(),
            nextScanTime: nextScanTime.toISOString(),
            marketSymbol,
            marketLabel,
            groupName,
            tradeType,
            contractType,
            direction,
            barrier,
            confidence: parseFloat(confidence),
            edge: parseFloat(edge),
            zScore: parseFloat(zScore),
            recommendedRuns,
            signalLabel,
            tickCount,
            isValid,
        };

        scannerStatus = 'ok';
        res.status(201).json(lastSignal);
    } catch (error) {
        next(error);
    }
});

if (!process.env.VERCEL) {
    initializeScannerData();
}

module.exports = router;
