const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new DatabaseSync('market_community.db');

app.use(express.json());

const sm = session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 604800000 }
});

app.use(sm);
io.engine.use(sm);

// Database Schema Setup
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    content TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS members (
    group_id INTEGER,
    user_id INTEGER,
    UNIQUE(group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    user_id INTEGER,
    content TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Admin and Default Group Initialization
const ah = bcrypt.hashSync('112122', 12);
if (!db.prepare('SELECT id FROM users WHERE username = ?').get('admin')) {
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES(?, ?, ?)').run('admin', ah, 'admin');
} else {
  db.prepare('UPDATE users SET password_hash = ?, role = "admin" WHERE username = "admin"').run(ah);
}

if (!db.prepare('SELECT id FROM groups LIMIT 1').get()) {
  db.prepare('INSERT INTO groups(name, description) VALUES(?, ?)').run('Market Lounge', 'Ruang komunikasi utama komunitas market.');
}

// Helpers & Middleware
const user = req => req.session.userId && db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.session.userId);
const login = (req, res, next) => user(req) ? next() : res.status(401).json({ error: 'Login terlebih dahulu.' });
const admin = (req, res, next) => user(req)?.role === 'admin' ? next() : res.status(403).json({ error: 'Akses admin diperlukan.' });

// Auth Routes
app.post('/api/register', (q, r) => {
  let u = String(q.body.username || '').trim().toLowerCase();
  let p = String(q.body.password || '');
  if (!/^[a-z0-9_]{3,24}$/.test(u) || p.length < 6) {
    return r.status(400).json({ error: 'Username 3-24 karakter dan password minimal 6 karakter.' });
  }
  try {
    let x = db.prepare('INSERT INTO users(username, password_hash) VALUES(?, ?)').run(u, bcrypt.hashSync(p, 12));
    q.session.userId = x.lastInsertRowid;
    r.json({ user: user(q) });
  } catch (e) {
    r.status(409).json({ error: 'Username sudah digunakan.' });
  }
});

app.post('/api/login', (q, r) => {
  let u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(q.body.username || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(q.body.password || ''), u.password_hash)) {
    return r.status(401).json({ error: 'Username atau password salah.' });
  }
  q.session.userId = u.id;
  r.json({ user: user(q) });
});

app.post('/api/logout', (q, r) => q.session.destroy(() => r.json({ ok: true })));
app.get('/api/me', (q, r) => r.json({ user: user(q) }));

// Statuses Routes
app.get('/api/statuses', login, (q, r) => {
  r.json(db.prepare('SELECT statuses.*, users.username FROM statuses JOIN users ON users.id = statuses.user_id ORDER BY statuses.id DESC LIMIT 80').all());
});

app.post('/api/statuses', login, (q, r) => {
  let c = String(q.body.content || '').trim();
  if (!c || c.length > 280) return r.status(400).json({ error: 'Status 1-280 karakter.' });
  let x = db.prepare('INSERT INTO statuses(user_id, content) VALUES(?, ?)').run(user(q).id, c);
  let s = db.prepare('SELECT statuses.*, users.username FROM statuses JOIN users ON users.id = statuses.user_id WHERE statuses.id = ?').get(x.lastInsertRowid);
  io.emit('status:new', s);
  r.json(s);
});

app.delete('/api/statuses/:id', admin, (q, r) => {
  db.prepare('DELETE FROM statuses WHERE id = ?').run(q.params.id);
  io.emit('status:deleted', {});
  r.json({ ok: true });
});

// Groups Routes
app.get('/api/groups', login, (q, r) => {
  let u = user(q);
  r.json(db.prepare('SELECT groups.*, EXISTS(SELECT 1 FROM members WHERE group_id = groups.id AND user_id = ?) AS joined FROM groups ORDER BY id DESC').all(u.id));
});

app.post('/api/groups', admin, (q, r) => {
  let n = String(q.body.name || '').trim();
  let d = String(q.body.description || '').trim();
  if (!n) return r.status(400).json({ error: 'Nama grup wajib diisi.' });
  let x = db.prepare('INSERT INTO groups(name, description) VALUES(?, ?)').run(n, d);
  let g = db.prepare('SELECT * FROM groups WHERE id = ?').get(x.lastInsertRowid);
  io.emit('group:new', g);
  r.json(g);
});

app.post('/api/groups/:id/join', login, (q, r) => {
  db.prepare('INSERT OR IGNORE INTO members(group_id, user_id) VALUES(?, ?)').run(q.params.id, user(q).id);
  r.json({ ok: true });
});

app.delete('/api/groups/:id', admin, (q, r) => {
  db.prepare('DELETE FROM members WHERE group_id = ?').run(q.params.id);
  db.prepare('DELETE FROM messages WHERE group_id = ?').run(q.params.id);
  db.prepare('DELETE FROM groups WHERE id = ?').run(q.params.id);
  io.emit('group:deleted', {});
  r.json({ ok: true });
});

// Messages Routes
app.get('/api/groups/:id/messages', login, (q, r) => {
  r.json(db.prepare('SELECT messages.*, users.username FROM messages JOIN users ON users.id = messages.user_id WHERE group_id = ? ORDER BY id LIMIT 300').all(q.params.id));
});

// Socket.IO
io.on('connection', s => {
  let uid = s.request.session.userId;
  if (!uid) return;

  s.on('group:join', gid => s.join('g' + gid));
  
  s.on('message:send', d => {
    let u = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(uid);
    let gid = Number(d.groupId);
    let c = String(d.content || '').trim();
    if (!u || !c || c.length > 1000) return;
    if (u.role !== 'admin' && !db.prepare('SELECT 1 FROM members WHERE group_id = ? AND user_id = ?').get(gid, uid)) return;
    
    let x = db.prepare('INSERT INTO messages(group_id, user_id, content) VALUES(?, ?, ?)').run(gid, uid, c);
    let m = db.prepare('SELECT messages.*, users.username FROM messages JOIN users ON users.id = messages.user_id WHERE messages.id = ?').get(x.lastInsertRowid);
    io.to('g' + gid).emit('message:new', m);
  });
});

// Static Files & Catch-all
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (q, r) => r.sendFile(path.join(__dirname, 'public/index.html')));

server.listen(process.env.PORT || 3000, () => console.log('ZM Community: http://localhost:3000'));