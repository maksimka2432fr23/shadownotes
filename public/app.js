/**
 * ShadowNotes Client Application
 * Vanilla JS SPA with hash-based routing
 */

(function() {
    'use strict';

    // ===== State =====
    const state = {
        currentView: 'create',
        noteId: null,
        requiresPassword: false,
        burnOnRead: false,
        expiresAt: null
    };

    // ===== DOM Elements =====
    const elements = {};

    // Cache DOM elements for performance
    function cacheElements() {
        elements.views = {
            create: document.getElementById('view-create'),
            created: document.getElementById('view-created'),
            password: document.getElementById('view-password'),
            reveal: document.getElementById('view-reveal'),
            content: document.getElementById('view-content'),
            error: document.getElementById('view-error'),
            loading: document.getElementById('view-loading')
        };
        
        elements.forms = {
            create: document.getElementById('create-form'),
            password: document.getElementById('password-form')
        };
        
        elements.inputs = {
            content: document.getElementById('note-content'),
            ttl: document.getElementById('ttl-select'),
            burnOnRead: document.getElementById('burn-on-read'),
            password: document.getElementById('password'),
            readPassword: document.getElementById('read-password'),
            noteLink: document.getElementById('note-link')
        };
        
        elements.buttons = {
            create: document.getElementById('create-btn'),
            copy: document.getElementById('copy-btn'),
            destroy: document.getElementById('destroy-btn'),
            reveal: document.getElementById('reveal-btn')
        };
        
        elements.charCount = document.getElementById('char-count');
        elements.passwordError = document.getElementById('password-error');
        elements.noteText = document.getElementById('note-text');
        elements.expiresTime = document.getElementById('expires-time');
        elements.burnedBadge = document.getElementById('burned-badge');
        elements.burnModeText = document.getElementById('burn-mode-text');
        elements.destroyMessage = document.getElementById('destroy-message');
    }

    // ===== Views Management =====
    function showView(viewName) {
        // Hide all views
        Object.values(elements.views).forEach(view => {
            view.classList.remove('active');
        });
        
        // Show target view
        const targetView = elements.views[viewName];
        if (targetView) {
            targetView.classList.add('active');
            state.currentView = viewName;
        }
    }

    // ===== Router =====
    function handleRoute() {
        const hash = window.location.hash;
        
        if (hash.startsWith('#/')) {
            const path = hash.slice(2);
            
            if (path.startsWith('note/')) {
                const noteId = path.slice(5);
                if (noteId) {
                    loadNote(noteId);
                    return;
                }
            }
        }
        
        // Default: show create view
        showView('create');
    }

    // ===== API Functions =====
    function createRequestError(message, code) {
        const requestError = new Error(message);
        requestError.code = code;
        return requestError;
    }

    async function apiCreateNote(data) {
        const response = await fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        // Check if response is JSON before parsing
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            // Check if it looks like HTML (server error page)
            if (text.trim().startsWith('<') && (text.includes('<!DOCTYPE') || text.includes('<html'))) {
                throw new Error('Backend server is not running. Please deploy the Node.js server.');
            }
            throw new Error('Invalid server response');
        }
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw createRequestError(error.error || 'Failed to create note', error.code);
        }
        
        return response.json();
    }

    async function apiGetMetadata(noteId) {
        const response = await fetch(`/api/notes/${noteId}/metadata`);
        
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            if (text.trim().startsWith('<') && (text.includes('<!DOCTYPE') || text.includes('<html'))) {
                throw new Error('Backend server is not running. Please deploy the Node.js server.');
            }
            throw new Error('Invalid server response');
        }
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Note not found' }));
            throw createRequestError(error.error || 'Note not found', error.code);
        }
        
        return response.json();
    }

    async function apiReadNote(noteId, password = null) {
        const body = password ? { password } : {};
        const response = await fetch(`/api/notes/${noteId}/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            if (text.trim().startsWith('<') && (text.includes('<!DOCTYPE') || text.includes('<html'))) {
                throw new Error('Backend server is not running. Please deploy the Node.js server.');
            }
            throw new Error('Invalid server response');
        }
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw createRequestError(error.error || 'Failed to read note', error.code);
        }
        
        return response.json();
    }

    async function apiDestroyNote(noteId) {
        const response = await fetch(`/api/notes/${noteId}`, {
            method: 'DELETE'
        });
        
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await response.text();
            if (text.trim().startsWith('<') && (text.includes('<!DOCTYPE') || text.includes('<html'))) {
                throw new Error('Backend server is not running. Please deploy the Node.js server.');
            }
            throw new Error('Invalid server response');
        }
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw createRequestError(error.error || 'Failed to destroy note', error.code);
        }
        
        return response.json();
    }

    // ===== Load Note =====
    async function loadNote(noteId) {
        showView('loading');
        state.noteId = noteId;
        
        try {
            const metadata = await apiGetMetadata(noteId);
            state.requiresPassword = metadata.requiresPassword;
            state.burnOnRead = metadata.burnOnRead;
            state.expiresAt = metadata.expiresAt;
            
            // Update expires time display
            updateExpiresTime(metadata.expiresAt);
            
            // Update burn mode text
            if (state.burnOnRead) {
                elements.burnModeText.textContent = 'Эта заметка будет удалена сразу после первого просмотра';
            } else {
                elements.burnModeText.textContent = 'После просмотра заметка продолжит действовать до истечения времени';
            }
            
            // Show appropriate view
            if (state.requiresPassword) {
                showView('password');
                elements.inputs.readPassword.focus();
            } else {
                showView('reveal');
            }
            
        } catch (error) {
            showError(error.message);
        }
    }

    // ===== Update Expires Time =====
    function updateExpiresTime(timestamp) {
        if (!timestamp) {
            elements.expiresTime.textContent = 'Не ограничено';
            return;
        }
        
        const date = new Date(timestamp);
        const now = Date.now();
        
        if (now >= timestamp) {
            elements.expiresTime.textContent = 'Истекло';
        } else {
            const diff = timestamp - now;
            const minutes = Math.floor(diff / 60000);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);
            
            let text = '';
            if (days > 0) text += `${days}д `;
            if (hours > 0) text += `${hours % 24}ч `;
            text += `${minutes % 60}м`;
            
            elements.expiresTime.textContent = text.trim();
        }
    }

    // ===== Show Content =====
    async function revealContent(password = null) {
        try {
            const result = await apiReadNote(state.noteId, password);
            
            // Display content
            elements.noteText.textContent = result.content;
            
            // Show burned badge if note was destroyed
            if (result.burned) {
                elements.burnedBadge.style.display = 'inline-block';
                elements.destroyMessage.textContent = 'Эта заметка была безвозвратно удалена и больше недоступна';
            } else {
                elements.burnedBadge.style.display = 'none';
                elements.destroyMessage.textContent = 'Заметка будет автоматически удалена по истечении времени';
            }
            
            showView('content');
            
        } catch (error) {
            if (error.code === 'WRONG_PASSWORD') {
                elements.passwordError.textContent = 'Неверный пароль';
                elements.passwordError.classList.remove('hidden');
                elements.inputs.readPassword.value = '';
                elements.inputs.readPassword.focus();
            } else if (error.code === 'TOO_MANY_ATTEMPTS') {
                elements.passwordError.textContent = 'Слишком много попыток. Повторите позже.';
                elements.passwordError.classList.remove('hidden');
            } else {
                showError(error.message);
            }
        }
    }

    // ===== Show Error =====
    function showError(message) {
        document.getElementById('error-message').textContent = message || 'Возможно, ссылка устарела или заметка уже была удалена';
        showView('error');
    }

    // ===== Copy to Clipboard =====
    async function copyLink() {
        const link = elements.inputs.noteLink.value;
        
        try {
            await navigator.clipboard.writeText(link);
            
            // Visual feedback
            const copyBtn = elements.buttons.copy;
            const copyText = copyBtn.querySelector('span');
            const originalText = copyText.textContent;
            
            copyBtn.classList.add('copied');
            copyText.textContent = 'Скопировано!';
            
            setTimeout(() => {
                copyBtn.classList.remove('copied');
                copyText.textContent = originalText;
            }, 2000);
            
        } catch (error) {
            // Fallback for older browsers
            elements.inputs.noteLink.select();
            document.execCommand('copy');
            
            const copyBtn = elements.buttons.copy;
            copyBtn.classList.add('copied');
            setTimeout(() => copyBtn.classList.remove('copied'), 2000);
        }
    }

    // ===== Destroy Note =====
    async function destroyNote() {
        if (!confirm('Вы уверены? Заметка будет удалена безвозвратно.')) {
            return;
        }
        
        try {
            await apiDestroyNote(state.noteId);
            showError('Заметка была успешно уничтожена');
        } catch (error) {
            showError('Не удалось уничтожить заметку');
        }
    }

    // ===== Event Handlers =====
    function initEventListeners() {
        // Character count for textarea
        elements.inputs.content.addEventListener('input', () => {
            const count = elements.inputs.content.value.length;
            elements.charCount.textContent = count;
        });
        
        // Create form submission
        elements.forms.create.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const content = elements.inputs.content.value.trim();
            if (!content) {
                elements.inputs.content.focus();
                return;
            }
            
            const btn = elements.buttons.create;
            const btnText = btn.querySelector('.btn-text');
            const btnLoader = btn.querySelector('.btn-loader');
            
            // Show loading state
            btn.disabled = true;
            btnText.classList.add('hidden');
            btnLoader.classList.remove('hidden');
            
            try {
                const data = {
                    content,
                    ttl: parseInt(elements.inputs.ttl.value),
                    burnOnRead: elements.inputs.burnOnRead.checked,
                    password: elements.inputs.password.value || null
                };
                
                const result = await apiCreateNote(data);
                
                // Show success view
                elements.inputs.noteLink.value = result.url;
                showView('created');
                
            } catch (error) {
                if (error.code === 'PAYLOAD_TOO_LARGE') {
                    alert('Текст слишком длинный. Максимум 10KB.');
                } else {
                    alert('Ошибка: ' + error.message);
                }
            } finally {
                btn.disabled = false;
                btnText.classList.remove('hidden');
                btnLoader.classList.add('hidden');
            }
        });
        
        // Copy button
        elements.buttons.copy.addEventListener('click', copyLink);
        
        // Destroy button
        elements.buttons.destroy.addEventListener('click', destroyNote);
        
        // Password form submission
        elements.forms.password.addEventListener('submit', (e) => {
            e.preventDefault();
            const password = elements.inputs.readPassword.value;
            revealContent(password);
        });
        
        // Reveal button
        elements.buttons.reveal.addEventListener('click', () => {
            revealContent();
        });
        
        // Password visibility toggle
        const passwordToggles = document.querySelectorAll('.password-toggle');
        passwordToggles.forEach(toggle => {
            toggle.addEventListener('click', () => {
                const input = toggle.previousElementSibling;
                const isPassword = input.type === 'password';
                input.type = isPassword ? 'text' : 'password';
                toggle.setAttribute('aria-label', isPassword ? 'Скрыть пароль' : 'Показать пароль');
            });
        });
        
        // Hash change listener
        window.addEventListener('hashchange', handleRoute);
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Enter to create note
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.currentView === 'create') {
                elements.forms.create.dispatchEvent(new Event('submit'));
            }
            
            // Ctrl/Cmd + C to copy (when link is visible)
            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && state.currentView === 'created') {
                e.preventDefault();
                copyLink();
            }
        });
    }

    // ===== Initialize =====
    function init() {
        cacheElements();
        initEventListeners();
        handleRoute();
        
        console.log('ShadowNotes initialized');
    }

    // Start app when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
