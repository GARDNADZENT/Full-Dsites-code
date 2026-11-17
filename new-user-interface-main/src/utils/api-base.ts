const configured = (process.env.BACKEND_API_URL || '').trim().replace(/\/$/, '');

export const API_BASE = configured || '/api';
