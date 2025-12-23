/**
 * ShadowNotes Server
 * Anonymous self-destructing notes with in-memory storage
 */

const express = require('express');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage for notes
// Structure: Map<noteId, { content, passwordHash, createdAt, expiresAt, burnOnRead, views }>
const notes = new Map();

// Cleanup interval - remove expired notes every minute
const CLEANUP_INTERVAL = 60000;

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, note] of notes.entries()) {
        if (note.expiresAt && now >= note.expiresAt) {
            notes.delete(id);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`[GC] Cleaned ${cleaned} expired notes`);
    }
}, CLEANUP_INTERVAL);

// Helper functions
function encrypt(text, key) {
    return CryptoJS.AES.encrypt(text, key).toString();
}

function decrypt(ciphertext, key) {
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    return bytes.toString(CryptoJS.enc.Utf8);
}

function hashPassword(password) {
    return CryptoJS.SHA256(password).toString();
}

function validateTTL(ttl) {
    const validOptions = [10, 60, 1440]; // minutes: 10min, 1hour, 24hours
    if (typeof ttl === 'number' && ttl > 0 && ttl <= 10080) { // max 7 days
        return ttl;
    }
    return 60; // default 1 hour
}

// API Routes

// Create a new note
app.post('/api/notes', (req, res) => {
    try {
        const { content, ttl = 60, burnOnRead = false, password = null } = req.body;
        
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'Content is required' });
        }
        
        if (content.length > 10000) {
            return res.status(400).json({ error: 'Content too long (max 10KB)' });
        }
        
        const noteId = crypto.randomUUID();
        const now = Date.now();
        const ttlMinutes = validateTTL(ttl);
        const expiresAt = now + (ttlMinutes * 60 * 1000);
        
        // Encrypt content if password provided, otherwise store as-is
        let storedContent = content;
        let passwordHash = null;
        
        if (password) {
            storedContent = encrypt(content, password);
            passwordHash = hashPassword(password);
        }
        
        const note = {
            id: noteId,
            content: storedContent,
            passwordHash,
            createdAt: now,
            expiresAt,
            burnOnRead: Boolean(burnOnRead),
            views: 0
        };
        
        notes.set(noteId, note);
        
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
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Check if note exists and get metadata (without revealing content)
app.get('/api/notes/:id/metadata', (req, res) => {
    try {
        const { id } = req.params;
        const note = notes.get(id);
        
        if (!note) {
            return res.status(404).json({ error: 'Note not found' });
        }
        
        if (note.expiresAt && Date.now() >= note.expiresAt) {
            notes.delete(id);
            return res.status(404).json({ error: 'Note expired' });
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
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Read note content
app.post('/api/notes/:id/read', (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        
        const note = notes.get(id);
        
        if (!note) {
            return res.status(404).json({ error: 'Note not found or already destroyed' });
        }
        
        if (note.expiresAt && Date.now() >= note.expiresAt) {
            notes.delete(id);
            return res.status(404).json({ error: 'Note expired' });
        }
        
        // Check password if required
        if (note.passwordHash) {
            const providedHash = password ? hashPassword(password) : null;
            if (providedHash !== note.passwordHash) {
                return res.status(403).json({ error: 'Wrong password' });
            }
        }
        
        // Get the actual content (decrypt if needed)
        let content = note.content;
        if (note.passwordHash && password) {
            content = decrypt(content, password);
        }
        
        // Handle burn on read
        const wasBurned = note.burnOnRead;
        
        if (note.burnOnRead) {
            notes.delete(id);
            console.log(`[BURN] Note ${id} destroyed after reading`);
        } else {
            note.views++;
            console.log(`[READ] Note ${id} viewed (${note.views} total)`);
        }
        
        res.json({
            content,
            burned: wasBurned,
            views: note.views || 0
        });
        
    } catch (error) {
        console.error('[ERROR] Read note failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Destroy note immediately
app.delete('/api/notes/:id', (req, res) => {
    try {
        const { id } = req.params;
        const note = notes.get(id);
        
        if (!note) {
            return res.status(404).json({ error: 'Note not found' });
        }
        
        notes.delete(id);
        console.log(`[DESTROY] Note ${id} manually destroyed`);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('[ERROR] Destroy note failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Stats endpoint (for debugging/admin)
app.get('/api/stats', (req, res) => {
    res.json({
        totalNotes: notes.size,
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
