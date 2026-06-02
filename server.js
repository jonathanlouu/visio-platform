require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const DATA_DIR = path.join(__dirname, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');

// Créer les dossiers si nécessaires
[DATA_DIR, PHOTOS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Initialiser le fichier visits.json si absent
if (!fs.existsSync(VISITS_FILE)) {
  fs.writeFileSync(VISITS_FILE, JSON.stringify([], null, 2));
}

// Charger les utilisateurs depuis .env
const USERS = { 'admin': 'Ecopartners2026' };

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8h
}));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadVisits() {
  try { return JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')); }
  catch { return []; }
}

function saveVisits(visits) {
  fs.writeFileSync(VISITS_FILE, JSON.stringify(visits, null, 2));
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non authentifié' });
  res.redirect('/');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (USERS[username] && USERS[username] === password) {
    req.session.user = username;
    return res.redirect('/dashboard.html');
  }
  res.redirect('/?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── Pages protégées ──────────────────────────────────────────────────────────

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/call-tech.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'call-tech.html'));
});

// Page client (pas d'auth requise - lien SMS)
app.get('/c/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'call-client.html'));
});

// ─── API Visites ──────────────────────────────────────────────────────────────

app.get('/api/visits', requireAuth, (req, res) => {
  const visits = loadVisits();
  res.json(visits.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/visits', requireAuth, (req, res) => {
  const { clientName, clientPhone, clientAddress } = req.body;
  if (!clientName || !clientPhone) {
    return res.status(400).json({ error: 'Nom et téléphone requis' });
  }
  const visits = loadVisits();
  const visit = {
    id: uuidv4(),
    clientName,
    clientPhone,
    clientAddress: clientAddress || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdBy: req.session.user,
    photos: [],
    equipment: {},
    notes: ''
  };
  visits.push(visit);
  saveVisits(visits);
  res.json(visit);
});

app.get('/api/visits/:id', (req, res) => {
  const visits = loadVisits();
  const visit = visits.find(v => v.id === req.params.id);
  if (!visit) return res.status(404).json({ error: 'Visite introuvable' });
  res.json(visit);
});

app.patch('/api/visits/:id', requireAuth, (req, res) => {
  const visits = loadVisits();
  const idx = visits.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Visite introuvable' });
  const allowed = ['status', 'equipment', 'notes', 'clientName', 'clientPhone', 'clientAddress'];
  allowed.forEach(key => {
    if (req.body[key] !== undefined) visits[idx][key] = req.body[key];
  });
  saveVisits(visits);
  res.json(visits[idx]);
});

// ─── API SMS ──────────────────────────────────────────────────────────────────

app.post('/api/visits/:id/sms', requireAuth, async (req, res) => {
  const visits = loadVisits();
  const visit = visits.find(v => v.id === req.params.id);
  if (!visit) return res.status(404).json({ error: 'Visite introuvable' });

  const link = `${APP_URL}/c/${visit.id}`;
  const message = `Bonjour ${visit.clientName}, votre technicien vous invite à une visite technique à distance.\n\nCliquez ici pour activer votre caméra :\n${link}\n\nAucune installation requise.`;

  // Si Twilio configuré, envoyer le SMS
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID !== 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') {
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: visit.clientPhone
      });
      const idx = visits.findIndex(v => v.id === req.params.id);
      visits[idx].smsSentAt = new Date().toISOString();
      saveVisits(visits);
      return res.json({ success: true, link });
    } catch (err) {
      return res.status(500).json({ error: 'Erreur SMS: ' + err.message });
    }
  }

  // Mode démo : retourner le lien sans envoyer
  res.json({ success: true, link, demo: true, message });
});

// ─── API Photos ───────────────────────────────────────────────────────────────

app.post('/api/visits/:id/photos', requireAuth, (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'Pas de données image' });

  const visits = loadVisits();
  const idx = visits.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Visite introuvable' });

  const photoDir = path.join(PHOTOS_DIR, req.params.id);
  if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

  const filename = `photo_${Date.now()}.jpg`;
  const filepath = path.join(photoDir, filename);
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

  visits[idx].photos.push(filename);
  saveVisits(visits);
  res.json({ filename });
});

// Servir les photos
app.get('/api/visits/:id/photos/:filename', requireAuth, (req, res) => {
  const filepath = path.join(PHOTOS_DIR, req.params.id, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// ─── API PDF ──────────────────────────────────────────────────────────────────

app.get('/api/visits/:id/pdf', requireAuth, (req, res) => {
  const visits = loadVisits();
  const visit = visits.find(v => v.id === req.params.id);
  if (!visit) return res.status(404).json({ error: 'Visite introuvable' });

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const filename = `visite_${visit.clientName.replace(/\s+/g, '_')}_${visit.id.slice(0, 8)}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const colors = { primary: '#1a4f8a', light: '#e8f0fa', gray: '#666666', dark: '#1a1a1a' };
  const pageWidth = 595 - 100;

  // ── En-tête ──
  doc.rect(0, 0, 595, 80).fill(colors.primary);
  doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
    .text(process.env.COMPANY_NAME || 'Visite Technique', 50, 25);
  doc.fontSize(10).font('Helvetica')
    .text('Rapport de visite technique à distance', 50, 52);
  doc.fillColor(colors.dark).moveDown(2);

  // ── Infos société ──
  const company = [
    process.env.COMPANY_ADDRESS,
    process.env.COMPANY_PHONE,
    process.env.COMPANY_EMAIL
  ].filter(Boolean);
  if (company.length) {
    doc.fontSize(9).fillColor(colors.gray).text(company.join('  |  '), 50, 95, { align: 'right', width: pageWidth });
  }

  doc.y = 120;

  // ── Infos visite ──
  const visitDate = new Date(visit.createdAt).toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  doc.rect(50, doc.y, pageWidth, 22).fill(colors.primary);
  doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
    .text('INFORMATIONS CLIENT', 60, doc.y - 17);
  doc.fillColor(colors.dark).moveDown(0.5);

  doc.rect(50, doc.y, pageWidth, 80).fill(colors.light).stroke('#dce8f5');
  const infoY = doc.y + 10;
  doc.fillColor(colors.dark).fontSize(10).font('Helvetica-Bold').text('Client :', 60, infoY);
  doc.font('Helvetica').text(visit.clientName, 140, infoY);
  doc.font('Helvetica-Bold').text('Téléphone :', 60, infoY + 18);
  doc.font('Helvetica').text(visit.clientPhone, 140, infoY + 18);
  doc.font('Helvetica-Bold').text('Adresse :', 60, infoY + 36);
  doc.font('Helvetica').text(visit.clientAddress || '—', 140, infoY + 36);
  doc.font('Helvetica-Bold').text('Date :', 60, infoY + 54);
  doc.font('Helvetica').text(visitDate, 140, infoY + 54);
  doc.y = infoY + 90;

  // ── Équipements ──
  doc.moveDown(0.5);
  doc.rect(50, doc.y, pageWidth, 22).fill(colors.primary);
  doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
    .text('ÉQUIPEMENTS RELEVÉS', 60, doc.y - 17);
  doc.fillColor(colors.dark).moveDown(0.5);

  const eq = visit.equipment || {};
  const equipFields = [
    ['Surface habitable', eq.surface ? `${eq.surface} m²` : '—'],
    ['Type de logement', eq.typeLogement || '—'],
    ['Année de construction', eq.anneeConstruction || '—'],
    ['DPE actuel', eq.dpe || '—'],
    ['Chauffage existant', eq.chauffage || '—'],
    ['Chauffe-eau existant', eq.chauffeEau || '—'],
    ['Isolation combles', eq.isolationCombles || '—'],
    ['Isolation murs', eq.isolationMurs || '—'],
  ];

  const eqStartY = doc.y;
  doc.rect(50, eqStartY, pageWidth, equipFields.length * 22 + 10).fill(colors.light).stroke('#dce8f5');

  equipFields.forEach(([label, value], i) => {
    const y = eqStartY + 8 + i * 22;
    if (i % 2 === 0) doc.rect(50, y, pageWidth, 22).fill('#f5f8fd');
    doc.fillColor(colors.gray).fontSize(9).font('Helvetica-Bold').text(label, 60, y + 6);
    doc.fillColor(colors.dark).font('Helvetica').text(value, 250, y + 6);
  });

  doc.y = eqStartY + equipFields.length * 22 + 18;

  // ── Notes ──
  if (visit.notes && visit.notes.trim()) {
    doc.moveDown(0.5);
    doc.rect(50, doc.y, pageWidth, 22).fill(colors.primary);
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
      .text('NOTES', 60, doc.y - 17);
    doc.fillColor(colors.dark).moveDown(0.5);
    doc.rect(50, doc.y, pageWidth, 60).fill(colors.light).stroke('#dce8f5');
    doc.fillColor(colors.dark).fontSize(10).font('Helvetica')
      .text(visit.notes, 60, doc.y + 8, { width: pageWidth - 20 });
    doc.y += 70;
  }

  // ── Photos ──
  const photoDir = path.join(PHOTOS_DIR, visit.id);
  const photos = (visit.photos || []).filter(p => fs.existsSync(path.join(photoDir, p)));

  if (photos.length > 0) {
    doc.addPage();
    doc.rect(0, 0, 595, 45).fill(colors.primary);
    doc.fillColor('white').fontSize(14).font('Helvetica-Bold').text('PHOTOS DE LA VISITE', 50, 15);
    doc.fillColor(colors.dark).y = 60;

    const cols = 2;
    const imgWidth = 220;
    const imgHeight = 165;
    const marginX = 50;
    const gapX = 30;
    const gapY = 20;

    photos.forEach((photoFile, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = marginX + col * (imgWidth + gapX);
      const y = 65 + row * (imgHeight + gapY + 20);

      if (y + imgHeight > 780) { doc.addPage(); }

      const imgPath = path.join(photoDir, photoFile);
      try {
        doc.rect(x - 2, y - 2, imgWidth + 4, imgHeight + 4).fill('#dce8f5');
        doc.image(imgPath, x, y, { width: imgWidth, height: imgHeight, fit: [imgWidth, imgHeight] });
        doc.fillColor(colors.gray).fontSize(8).font('Helvetica')
          .text(`Photo ${i + 1}`, x, y + imgHeight + 4, { width: imgWidth, align: 'center' });
      } catch (e) {
        doc.fillColor(colors.gray).fontSize(9).text(`[Photo ${i + 1} — erreur de chargement]`, x, y + imgHeight / 2);
      }
    });
  }

  // ── Pied de page ──
  const pages = doc.bufferedPageRange ? doc.bufferedPageRange() : { count: 1 };
  doc.fillColor(colors.gray).fontSize(8).font('Helvetica')
    .text(`Rapport généré le ${new Date().toLocaleDateString('fr-FR')} — ${process.env.COMPANY_NAME || ''}`,
      50, 810, { align: 'center', width: pageWidth });

  doc.end();
});

// ─── WebRTC Signaling via Socket.io ──────────────────────────────────────────

const rooms = {}; // roomId -> { tech: socketId, client: socketId }

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, role }) => {
    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][role] = socket.id;

    // Notifier l'autre participant que quelqu'un a rejoint
    socket.to(roomId).emit('peer-joined', { role });
    socket.emit('room-status', rooms[roomId]);
  });

  socket.on('offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('offer', { offer });
  });

  socket.on('answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', { candidate });
  });

  socket.on('disconnecting', () => {
    socket.rooms.forEach(roomId => {
      if (roomId !== socket.id) {
        socket.to(roomId).emit('peer-left');
        if (rooms[roomId]) {
          Object.keys(rooms[roomId]).forEach(role => {
            if (rooms[roomId][role] === socket.id) delete rooms[roomId][role];
          });
        }
      }
    });
  });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n✅ Plateforme démarrée : ${APP_URL}`);
  console.log(`   Dashboard : ${APP_URL}/`);
  console.log(`   Utilisateurs configurés : ${Object.keys(USERS).join(', ')}\n`);
});
