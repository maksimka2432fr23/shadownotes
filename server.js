/**
 * ShadowNotes Server
 * Anonymous self-destructing notes with in-memory storage
 */

const express = require('express');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const path = require('path');

const cors = () => (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    return next();
};

const helmet = () => (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    return next();
};

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const notes = new Map();
let redisClient = null;

if (process.env.REDIS_URL) {
    const { createClient } = require('redis');
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (error) => {
        console.error('[REDIS] Client error:', error);
    });
    redisClient.connect().catch((error) => {
        console.error('[REDIS] Connection failed:', error);
    });
}

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

function sendError(res, status, code, error, details) {
    const payload = { error };
    if (code) {
        payload.code = code;
    }
    if (details) {
        payload.details = details;
    }
    return res.status(status).json(payload);
}

function getNoteKey(id) {
    return `note:${id}`;
}

async function saveNote(note) {
    if (redisClient) {
        const ttlSeconds = Math.max(1, Math.floor((note.expiresAt - Date.now()) / 1000));
        await redisClient.set(getNoteKey(note.id), JSON.stringify(note), {
            EX: ttlSeconds
        });
        return;
    }
    notes.set(note.id, note);
}

async function getNote(id) {
    if (redisClient) {
        const payload = await redisClient.get(getNoteKey(id));
        return payload ? JSON.parse(payload) : null;
    }
    return notes.get(id) || null;
}

async function deleteNote(id) {
    if (redisClient) {
        await redisClient.del(getNoteKey(id));
        return;
    }
    notes.delete(id);
}

// API Routes

// Create a new note
app.post('/api/notes', async (req, res) => {
    try {
        const { content, ttl = 60, burnOnRead = false, password = null } = req.body;
        
        if (!content || typeof content !== 'string') {
            return sendError(res, 400, 'INVALID_CONTENT', 'Content is required');
        }
        
        if (content.length > 10000) {
            return sendError(res, 400, 'CONTENT_TOO_LONG', 'Content too long (max 10KB)');
        }
        
        const noteId = crypto.randomUUID();
        const now = Date.now();
        const ttlMinutes = validateTTL(ttl);
        const expiresAt = now + (ttlMinutes * 60 * 1000);
        
        // Encrypt content if password provided, otherwise store as-is
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
        
        await saveNote(note);
        
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        
        res.json({
            id: noteId,
            url: `${baseUrl}/#/note/${noteId}`,
            expiresAt,
            createdAt: now
        });
        
        console.log(`[CREATE] Note ${noteId} created, expires in ${ttlMinutes} min`);
        
    } catch (error) {
        console.error('[ERROR] Create note failed:', error);
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Check if note exists and get metadata (without revealing content)
app.get('/api/notes/:id/metadata', async (req, res) => {
    try {
        const { id } = req.params;
        const note = await getNote(id);
        
        if (!note) {
            return sendError(res, 404, 'NOT_FOUND', 'Note not found');
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
        console.error('[ERROR] Metadata check failed:', error);
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Read note content
app.post('/api/notes/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        
        const note = await getNote(id);
        
        if (!note) {
            return sendError(res, 404, 'NOT_FOUND', 'Note not found or already destroyed');
        }
        
        if (note.expiresAt && Date.now() >= note.expiresAt) {
            await deleteNote(id);
            return sendError(res, 404, 'NOTE_EXPIRED', 'Note expired');
        }

        if (note.lockUntil && Date.now() < note.lockUntil) {
            return sendError(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.');
        }
        
        // Check password if required
        if (note.passwordHash) {
            const providedHash = password ? hashPassword(password, note.passwordSalt) : null;
            if (providedHash !== note.passwordHash) {
                note.failedAttempts += 1;
                if (note.failedAttempts >= 5) {
                    note.lockUntil = Date.now() + (5 * 60 * 1000);
                }
                await saveNote(note);
                return sendError(res, 403, 'WRONG_PASSWORD', 'Wrong password');
            }
            note.failedAttempts = 0;
            note.lockUntil = null;
        }
        
        // Get the actual content (decrypt if needed)
        let content = note.content;
        if (note.passwordHash && password) {
            content = decrypt(content, password);
        }
        
        // Handle burn on read
        const wasBurned = note.burnOnRead;
        
        if (note.burnOnRead) {
            await deleteNote(id);
            console.log(`[BURN] Note ${id} destroyed after reading`);
        } else {
            note.views++;
            await saveNote(note);
            console.log(`[READ] Note ${id} viewed (${note.views} total)`);
        }
        
        res.json({
            content,
            burned: wasBurned,
            views: note.views || 0
        });
        
    } catch (error) {
        console.error('[ERROR] Read note failed:', error);
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Error handler for JSON payload too large
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Content too long (max 10KB)');
    }
    return next(err);
});

// Destroy note immediately
app.delete('/api/notes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const note = await getNote(id);
        
        if (!note) {
            return sendError(res, 404, 'NOT_FOUND', 'Note not found');
        }
        
        await deleteNote(id);
        console.log(`[DESTROY] Note ${id} manually destroyed`);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('[ERROR] Destroy note failed:', error);
        sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
});

// Stats endpoint (for debugging/admin)
app.get('/api/stats', async (req, res) => {
    const totalNotes = redisClient ? await redisClient.dbSize() : notes.size;
    res.json({
        totalNotes,
        uptime: process.uptime()
    });
});

// SPA fallback - serve index.html for all non-API routes
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        return next();
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ShadowNotes Server Running                              ║
║   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                           ║
║                                                           ║
║   Local:    http://localhost:${PORT}                        ║
║   Mode:     In-Memory Storage                             ║
║   Security: AES Encryption (with password)                ║
║   Features: Auto-cleanup, Burn-on-read, TTL               ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
