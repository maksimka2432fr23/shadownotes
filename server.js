/**
 * ShadowNotes Server
 * Anonymous self-destructing notes with Redis storage
 */

const express = require('express');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const logger = pino({ level: LOG_LEVEL });

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
});

const NOTE_PREFIX = 'note:';

// Middleware
app.use(express.json({ limit: '10kb' }));
app.use(cors({
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"]
        }
    }
}));
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
});

const createLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false
});

const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
});

const deleteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false
});

// Helper functions
function encrypt(text, key) {
    return CryptoJS.AES.encrypt(text, key).toString();
}

function decrypt(ciphertext, key) {
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    return bytes.toString(CryptoJS.enc.Utf8);
}

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function validateTTL(ttl) {
    const validOptions = [10, 60, 1440, 10080]; // minutes: 10min, 1hour, 24hours, 7 days
    return validOptions.includes(ttl) ? ttl : 60;
}

function noteKey(id) {
    return `${NOTE_PREFIX}${id}`;
}

async function getNote(id) {
    const data = await redis.get(noteKey(id));
    return data ? JSON.parse(data) : null;
}

async function setNote(id, note, ttlMs) {
    await redis.set(noteKey(id), JSON.stringify(note), { PX: ttlMs });
}

async function updateNote(id, note) {
    const key = noteKey(id);
    const ttlMs = await redis.pttl(key);
    if (ttlMs > 0) {
        await redis.set(key, JSON.stringify(note), { PX: ttlMs });
    } else {
        await redis.set(key, JSON.stringify(note));
    }
}

async function deleteNote(id) {
    await redis.del(noteKey(id));
}

function sendError(res, status, code, error, details) {
    return res.status(status).json({ error, code, details });
}

// API Routes
const apiRouter = express.Router();
apiRouter.use(apiLimiter);

// Create a new note
apiRouter.post('/notes', createLimiter, async (req, res) => {
    try {
        const { content, ttl = 60, burnOnRead = false, password = null } = req.body;

        if (!content || typeof content !== 'string') {
            return sendError(res, 400, 'CONTENT_REQUIRED', 'Content is required');
        }

        if (content.length > 10000) {
            return sendError(res, 400, 'CONTENT_TOO_LONG', 'Content too long (max 10KB)');
        }

        const noteId = crypto.randomUUID();
        const now = Date.now();
        const ttlMinutes = validateTTL(ttl);
        const ttlMs = ttlMinutes * 60 * 1000;
        const expiresAt = now + ttlMs;

        let storedContent = content;
        let passwordHash = null;
        let passwordSalt = null;

        if (password) {
            storedContent = encrypt(content, password);
            passwordSalt = crypto.randomBytes(16).toString('hex');
            passwordHash = hashPassword(password, passwordSalt);
        }

        const note = {
            id: noteId,
            content: storedContent,
            passwordHash,
            passwordSalt,
            createdAt: now,
            expiresAt,
            burnOnRead: Boolean(burnOnRead),
            views: 0,
            failedAttempts: 0,
            lockUntil: null
        };

        await setNote(noteId, note, ttlMs);

        const baseUrl = `${req.protocol}://${req.get('host')}`;

        res.json({
            id: noteId,
            url: `${baseUrl}/#/note/${noteId}`,
            expiresAt,
            createdAt: now
        });

        logger.info({ noteId, ttlMinutes }, 'Note created');
    } catch (error) {
        logger.error({ err: error }, 'Create note failed');
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Check if note exists and get metadata (without revealing content)
apiRouter.get('/notes/:id/metadata', async (req, res) => {
    try {
        const { id } = req.params;
        const note = await getNote(id);

        if (!note) {
            return sendError(res, 404, 'NOTE_NOT_FOUND', 'Note not found');
        }

        if (note.expiresAt && Date.now() >= note.expiresAt) {
            await deleteNote(id);
            return sendError(res, 404, 'NOTE_EXPIRED', 'Note expired');
        }

        res.json({
            id,
            exists: true,
            requiresPassword: Boolean(note.passwordHash),
            burnOnRead: note.burnOnRead,
            expiresAt: note.expiresAt
        });
    } catch (error) {
        logger.error({ err: error }, 'Metadata check failed');
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Read note content
apiRouter.post('/notes/:id/read', readLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        const note = await getNote(id);

        if (!note) {
            return sendError(res, 404, 'NOTE_NOT_FOUND', 'Note not found or already destroyed');
        }

        if (note.expiresAt && Date.now() >= note.expiresAt) {
            await deleteNote(id);
            return sendError(res, 404, 'NOTE_EXPIRED', 'Note expired');
        }

        if (note.lockUntil && Date.now() < note.lockUntil) {
            return sendError(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
        }

        if (note.passwordHash) {
            const providedHash = password ? hashPassword(password, note.passwordSalt) : null;
            if (providedHash !== note.passwordHash) {
                note.failedAttempts += 1;
                if (note.failedAttempts >= 5) {
                    note.lockUntil = Date.now() + (5 * 60 * 1000);
                }
                await updateNote(id, note);
                return sendError(res, 403, 'WRONG_PASSWORD', 'Wrong password');
            }
            note.failedAttempts = 0;
            note.lockUntil = null;
        }

        let content = note.content;
        if (note.passwordHash && password) {
            content = decrypt(content, password);
        }

        const wasBurned = note.burnOnRead;

        if (note.burnOnRead) {
            await deleteNote(id);
            logger.info({ noteId: id }, 'Note destroyed after reading');
        } else {
            note.views += 1;
            await updateNote(id, note);
            logger.info({ noteId: id, views: note.views }, 'Note viewed');
        }

        res.json({
            content,
            burned: wasBurned,
            views: note.views || 0
        });
    } catch (error) {
        logger.error({ err: error }, 'Read note failed');
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Destroy note immediately
apiRouter.delete('/notes/:id', deleteLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        const note = await getNote(id);

        if (!note) {
            return sendError(res, 404, 'NOTE_NOT_FOUND', 'Note not found');
        }

        await deleteNote(id);
        logger.info({ noteId: id }, 'Note manually destroyed');

        res.json({ success: true });
    } catch (error) {
        logger.error({ err: error }, 'Destroy note failed');
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Stats endpoint (for debugging/admin)
apiRouter.get('/stats', async (req, res) => {
    try {
        const info = await redis.info('stats');
        res.json({
            uptime: process.uptime(),
            redisInfo: info
        });
    } catch (error) {
        logger.error({ err: error }, 'Stats fetch failed');
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// OpenAPI spec (minimal)
apiRouter.get('/openapi.json', (req, res) => {
    res.json({
        openapi: '3.0.0',
        info: {
            title: 'ShadowNotes API',
            version: '1.0.0'
        },
        paths: {
            '/api/v1/notes': {
                post: {
                    summary: 'Create a note'
                }
            },
            '/api/v1/notes/{id}/metadata': {
                get: {
                    summary: 'Get note metadata'
                }
            },
            '/api/v1/notes/{id}/read': {
                post: {
                    summary: 'Read a note'
                }
            },
            '/api/v1/notes/{id}': {
                delete: {
                    summary: 'Delete a note'
                }
            }
        }
    });
});

app.use('/api/v1', apiRouter);
app.use('/api', apiRouter);

// Error handler for JSON payload too large
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Content too long (max 10KB)');
    }
    return next(err);
});

// SPA fallback - serve index.html for all non-API routes
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        return next();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
    await redis.connect();
    app.listen(PORT, () => {
        logger.info({ port: PORT }, 'ShadowNotes Server Running');
    });
}

startServer().catch((error) => {
    logger.error({ err: error }, 'Server failed to start');
    process.exit(1);
});
