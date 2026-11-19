require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { initializeDatabase, ensureDatabaseInitialized } = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const corsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

// Middleware
app.use(helmet());
app.use(morgan('combined'));
app.use(
    cors(
        corsOrigins.length > 0
            ? {
                  origin(origin, callback) {
                      if (!origin || corsOrigins.includes(origin)) {
                          callback(null, true);
                          return;
                      }
                      callback(new Error(`Origin ${origin} is not allowed by CORS`));
                  },
              }
            : undefined
    )
);
app.use(express.json());

// Root & health check endpoints
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        service: 'dsites-backend',
        endpoints: ['/health', '/api/bot-ideas', '/api/best-bot-stats', '/api/scanner/signal'],
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'API server is running' });
});

// Routes (ensure tables exist on cold start in serverless environments)
if (process.env.VERCEL) {
    app.use('/api', async (_req, _res, next) => {
        try {
            await ensureDatabaseInitialized();
            next();
        } catch (error) {
            next(error);
        }
    });
}
app.use('/api/bot-ideas', require('./routes/bot-ideas'));
app.use('/api/best-bot-stats', require('./routes/best-bot-stats'));
app.use('/api/scanner', require('./routes/scanner'));
// Diagnostic only: reports whether this host can reach Deriv's WebSocket API.
app.use('/api/deriv-egress-probe', require('./routes/deriv-egress-probe'));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Initialize database and start server
async function start() {
    try {
        await initializeDatabase();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`API server running on http://0.0.0.0:${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

if (require.main === module && !process.env.VERCEL) {
    start();
}

module.exports = app;
