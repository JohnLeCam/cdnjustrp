require('dotenv').config();

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY;
const STORAGE_DIR = process.env.STORAGE_DIR;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// Deux plafonds distincts : une image et une video n'ont pas le meme poids
const MAX_IMAGE_MB = Number(process.env.MAX_SIZE_MB) || 10;
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB) || 500;
// multer ne sait imposer qu'UNE limite : on lui donne la plus grande,
// puis on verifie le vrai plafond par type dans la route /upload
const MAX_TOUT_MB = Math.max(MAX_IMAGE_MB, MAX_VIDEO_MB);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_ROLE_IDS = (process.env.DISCORD_ROLE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DISCORD_ADMIN_IDS = (process.env.DISCORD_ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET;

const manquants = Object.entries({
  API_KEY, STORAGE_DIR, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI, DISCORD_GUILD_ID, SESSION_SECRET,
}).filter(([, v]) => !v).map(([k]) => k);

if (manquants.length || DISCORD_ROLE_IDS.length === 0) {
  console.error('[CDN] Variables manquantes dans le .env :', manquants.join(', ') || 'DISCORD_ROLE_IDS');
  process.exit(1);
}

fs.mkdirSync(STORAGE_DIR, { recursive: true });

const API_DISCORD = 'https://discord.com/api/v10';

// ---------------------------------------------------------------------------
// Index des proprietaires
// Volontairement place HORS de STORAGE_DIR : sinon il serait servi
// publiquement sur /f/index.json avec la liste de tous tes utilisateurs.
// ---------------------------------------------------------------------------
const INDEX_PATH = path.join(STORAGE_DIR, '..', 'index.json');

function lireIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return {}; // fichier absent au premier demarrage : c'est normal
  }
}

function ecrireIndex(index) {
  // Ecriture atomique : on ecrit a cote, puis on renomme.
  // Evite un index.json tronque si le process meurt en pleine ecriture.
  const tmp = INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, INDEX_PATH);
}

function estAdmin(utilisateur) {
  return !!utilisateur && DISCORD_ADMIN_IDS.includes(utilisateur.id);
}

// ---------------------------------------------------------------------------
// Types de fichiers autorises
// (SVG exclu : il peut contenir du JavaScript malveillant)
// Chaque entree donne l'extension a utiliser sur le disque + la famille,
// qui sert a choisir le bon plafond de taille.
// ---------------------------------------------------------------------------
const EXT_AUTORISEES = {
  'image/png':        { ext: '.png',  famille: 'image' },
  'image/jpeg':       { ext: '.jpg',  famille: 'image' },
  'image/webp':       { ext: '.webp', famille: 'image' },
  'image/gif':        { ext: '.gif',  famille: 'image' },

  'video/mp4':        { ext: '.mp4',  famille: 'video' }, // recommande (embed Discord)
  'video/webm':       { ext: '.webm', famille: 'video' }, // recommande (embed Discord)
  'video/quicktime':  { ext: '.mov',  famille: 'video' }, // iPhone
  'video/x-matroska': { ext: '.mkv',  famille: 'video' }, // OBS par defaut
};

// Extensions video, pour retrouver la famille d'un fichier deja sur le disque
const EXT_VIDEO = new Set(
  Object.values(EXT_AUTORISEES).filter((v) => v.famille === 'video').map((v) => v.ext)
);

function familleDepuisNom(nom) {
  return EXT_VIDEO.has(path.extname(nom).toLowerCase()) ? 'video' : 'image';
}

function plafondOctets(famille) {
  return (famille === 'video' ? MAX_VIDEO_MB : MAX_IMAGE_MB) * 1024 * 1024;
}

function dossierDuMois() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const stockage = multer.diskStorage({
  destination(req, file, cb) {
    const dossier = path.join(STORAGE_DIR, dossierDuMois());
    fs.mkdir(dossier, { recursive: true }, (err) => cb(err, dossier));
  },
  filename(req, file, cb) {
    cb(null, crypto.randomBytes(16).toString('hex') + EXT_AUTORISEES[file.mimetype].ext);
  },
});

const upload = multer({
  storage: stockage,
  limits: { fileSize: MAX_TOUT_MB * 1024 * 1024, files: 10 },
  fileFilter(req, file, cb) {
    if (!EXT_AUTORISEES[file.mimetype]) {
      return cb(new Error(`Format refuse : ${file.mimetype}`));
    }
    cb(null, true);
  },
});

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Les fichiers : PUBLICS et servis avant tout le reste
// (pas de session a analyser => plus rapide, et FiveM/Discord peuvent y acceder)
//
// express.static gere tout seul les requetes "Range" (HTTP 206), qui permettent
// de lire une video en streaming et d'avancer dans la barre de lecture sans
// telecharger le fichier entier. Rien de plus a faire ici.
// ---------------------------------------------------------------------------
app.use(
  '/f',
  express.static(STORAGE_DIR, {
    maxAge: '365d',
    immutable: true,
    index: false,
    acceptRanges: true, // (deja par defaut, mais explicite = plus clair)
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  })
);

app.use(express.json());
app.use(
  session({
    name: 'cdn.sid',
    // Sessions ecrites sur le disque : elles survivent aux redemarrages
    store: new FileStore({
      path: path.join(__dirname, '..', 'sessions'),
      ttl: 30 * 24 * 60 * 60,   // duree de vie : 30 jours (en secondes)
      reapInterval: 60 * 60,    // menage des sessions expirees toutes les heures
      retries: 0,
      logFn: () => {},          // pas de bruit dans les logs
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,              // chaque visite repousse l'expiration de 30 jours
    cookie: {
      httpOnly: true,
      secure: PUBLIC_URL.startsWith('https'),
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 jours (en millisecondes)
    },
  })
);

// ---------------------------------------------------------------------------
// Controles d'acces
// ---------------------------------------------------------------------------
function cleValide(req) {
  const cle = req.get('x-api-key') || '';
  const a = Buffer.from(cle);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Session Discord obligatoire (pages du site)
function exigerSession(req, res, next) {
  if (req.session.utilisateur) return next();
  res.status(401).json({ ok: false, erreur: 'Connexion requise' });
}

// Session Discord OU cle API (upload depuis un bot, un script...)
function exigerAcces(req, res, next) {
  if (req.session.utilisateur) return next();
  if (req.get('x-api-key')) {
    if (cleValide(req)) return next();
    return res.status(401).json({ ok: false, erreur: 'Cle API invalide' });
  }
  res.status(401).json({ ok: false, erreur: 'Connexion requise' });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (req, res) => {
  if (req.session.utilisateur) {
    return res.sendFile(path.join(__dirname, 'views', 'app.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Connexion Discord
// ---------------------------------------------------------------------------
app.get('/auth/login', (req, res) => {
  // "state" : jeton anti-CSRF, verifie au retour
  req.session.oauthState = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state: req.session.oauthState,
    prompt: 'none',
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || state !== req.session.oauthState) {
    return res.redirect('/?erreur=state');
  }
  delete req.session.oauthState;

  try {
    // 1. Echanger le code contre un jeton d'acces
    const repToken = await fetch(`${API_DISCORD}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    if (!repToken.ok) throw new Error(`Echange du code refuse (${repToken.status})`);
    const jeton = await repToken.json();

    // 2. Identite du compte
    const repUser = await fetch(`${API_DISCORD}/users/@me`, {
      headers: { Authorization: `Bearer ${jeton.access_token}` },
    });
    if (!repUser.ok) throw new Error('Lecture du profil impossible');
    const compte = await repUser.json();

    // 3. Ses roles sur TON serveur
    const repMembre = await fetch(
      `${API_DISCORD}/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
      { headers: { Authorization: `Bearer ${jeton.access_token}` } }
    );
    if (repMembre.status === 404) return res.redirect('/?erreur=serveur');
    if (!repMembre.ok) throw new Error(`Lecture du membre impossible (${repMembre.status})`);
    const membre = await repMembre.json();

    // 4. Verdict
    const autorise = (membre.roles || []).some((r) => DISCORD_ROLE_IDS.includes(r));
    if (!autorise) {
      console.log(`[CDN] Acces refuse : ${compte.username} (${compte.id}) - role manquant`);
      return res.redirect('/?erreur=role');
    }

    req.session.utilisateur = {
      id: compte.id,
      pseudo: membre.nick || compte.global_name || compte.username,
      avatar: compte.avatar
        ? `https://cdn.discordapp.com/avatars/${compte.id}/${compte.avatar}.png?size=64`
        : null,
    };

    console.log(`[CDN] Connexion : ${req.session.utilisateur.pseudo} (${compte.id})`);
    res.redirect('/');
  } catch (e) {
    console.error('[CDN] OAuth :', e.message);
    res.redirect('/?erreur=oauth');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/moi', exigerSession, (req, res) => {
  res.json({
    ok: true,
    utilisateur: req.session.utilisateur,
    admin: estAdmin(req.session.utilisateur),
    // Le site s'en sert pour refuser un fichier trop lourd AVANT de l'envoyer
    limites: { image_mo: MAX_IMAGE_MB, video_mo: MAX_VIDEO_MB },
  });
});

// ---------------------------------------------------------------------------
// Fichiers
//
// Chacun ne voit que ce qu'il a envoye. Les admins voient tout par defaut,
// et peuvent se limiter aux leurs avec ?portee=mes.
//
// A noter : ce filtrage ne concerne QUE la liste. Les URL /f/... restent
// publiques, sinon FiveM et Discord ne pourraient plus afficher les images.
// ---------------------------------------------------------------------------
const MAX_RENVOYES = 200;

app.get('/api/fichiers', exigerSession, (req, res) => {
  const index = lireIndex();
  const moi = req.session.utilisateur;
  const admin = estAdmin(moi);

  // Un non-admin est toujours ramene a "mes", quoi qu'il demande
  const portee = admin ? (req.query.portee === 'mes' ? 'mes' : 'tous') : 'mes';

  const trouves = [];

  const mois = fs
    .readdirSync(STORAGE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const m of mois) {
    for (const nom of fs.readdirSync(path.join(STORAGE_DIR, m))) {
      const chemin = `${m}/${nom}`;
      const proprio = index[chemin] || null; // null = fichier sans proprietaire connu
      const aMoi = proprio ? proprio.id === moi.id : false;

      // Le filtre s'applique AVANT le plafond : sinon un utilisateur ayant
      // peu de fichiers parmi beaucoup d'autres n'en verrait aucun.
      if (portee === 'mes' && !aMoi) continue;

      const infos = fs.statSync(path.join(STORAGE_DIR, m, nom));

      trouves.push({
        chemin,
        url: `${PUBLIC_URL}/f/${chemin}`,
        taille: infos.size,
        date: infos.mtimeMs,
        famille: familleDepuisNom(nom), // 'image' ou 'video' -> le site choisit la balise
        auteur: proprio ? proprio.pseudo : 'commun',
        // Un fichier sans proprietaire n'est supprimable que par un admin
        supprimable: admin || aMoi,
      });
    }
    if (trouves.length >= MAX_RENVOYES) break;
  }

  trouves.sort((a, b) => b.date - a.date);

  res.json({
    ok: true,
    portee,
    admin,
    fichiers: trouves.slice(0, MAX_RENVOYES),
  });
});

app.post('/upload', exigerAcces, upload.array('fichiers', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ ok: false, erreur: 'Aucun fichier recu' });
  }

  // multer a applique la limite la plus large (MAX_TOUT_MB).
  // On applique maintenant le vrai plafond selon le type, et on supprime
  // du disque ce qui depasse.
  const gardes = [];
  const refuses = [];

  for (const f of req.files) {
    const { famille } = EXT_AUTORISEES[f.mimetype];
    if (f.size > plafondOctets(famille)) {
      fs.unlink(f.path, () => {});
      const max = famille === 'video' ? MAX_VIDEO_MB : MAX_IMAGE_MB;
      refuses.push(`${f.originalname} (max ${max} Mo pour une ${famille})`);
    } else {
      gardes.push(f);
    }
  }

  if (gardes.length === 0) {
    return res.status(413).json({ ok: false, erreur: `Trop lourd : ${refuses.join(', ')}` });
  }

  const index = lireIndex();

  const fichiers = gardes.map((f) => {
    const chemin = path.relative(STORAGE_DIR, f.path).split(path.sep).join('/');

    // On note qui a envoye quoi. Un upload par cle API n'a pas de session :
    // le fichier reste sans proprietaire, donc reserve aux admins.
    if (req.session.utilisateur) {
      index[chemin] = {
        id: req.session.utilisateur.id,
        pseudo: req.session.utilisateur.pseudo,
      };
    }

    return {
      nom_origine: f.originalname,
      chemin,
      taille: f.size,
      famille: EXT_AUTORISEES[f.mimetype].famille,
      url: `${PUBLIC_URL}/f/${chemin}`,
    };
  });

  try {
    ecrireIndex(index);
  } catch (e) {
    console.error('[CDN] Ecriture index.json :', e.message);
  }

  const auteur = req.session.utilisateur ? req.session.utilisateur.pseudo : 'cle API';
  console.log(`[CDN] ${fichiers.length} fichier(s) ajoute(s) par ${auteur}`);
  res.json({ ok: true, fichiers, refuses });
});

app.post('/supprimer', exigerAcces, (req, res) => {
  const chemin = String(req.body.chemin || '');
  const cible = path.resolve(STORAGE_DIR, chemin);

  // Empeche un chemin du genre "../../etc/passwd"
  if (!cible.startsWith(path.resolve(STORAGE_DIR) + path.sep)) {
    return res.status(400).json({ ok: false, erreur: 'Chemin invalide' });
  }

  const index = lireIndex();
  const proprio = index[chemin] || null;
  const moi = req.session.utilisateur;

  // La cle API (sans session) a tous les droits : c'est un acces machine.
  // Un utilisateur connecte ne supprime que ses fichiers, sauf s'il est admin.
  if (moi && !estAdmin(moi)) {
    if (!proprio || proprio.id !== moi.id) {
      return res.status(403).json({ ok: false, erreur: 'Ce fichier ne t\'appartient pas' });
    }
  }

  fs.unlink(cible, (err) => {
    if (err) return res.status(404).json({ ok: false, erreur: 'Fichier introuvable' });

    if (index[chemin]) {
      delete index[chemin];
      try { ecrireIndex(index); } catch (e) {
        console.error('[CDN] Ecriture index.json :', e.message);
      }
    }
    res.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[CDN] Erreur :', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, erreur: `Fichier trop lourd (max ${MAX_TOUT_MB} Mo)` });
  }
  res.status(400).json({ ok: false, erreur: err.message });
});

const serveur = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[CDN] Demarre sur http://127.0.0.1:${PORT}`);
  console.log(`[CDN] Stockage : ${STORAGE_DIR}`);
  console.log(`[CDN] Index    : ${INDEX_PATH}`);
  console.log(`[CDN] Plafonds : image ${MAX_IMAGE_MB} Mo / video ${MAX_VIDEO_MB} Mo`);
  console.log(`[CDN] Roles autorises : ${DISCORD_ROLE_IDS.join(', ')}`);
  console.log(`[CDN] Admins : ${DISCORD_ADMIN_IDS.join(', ') || '(aucun)'}`);
});

// Sans ca, Node coupe toute requete au bout de 5 minutes : largement
// insuffisant pour envoyer une video de plusieurs centaines de Mo.
serveur.requestTimeout = 30 * 60 * 1000; // 30 minutes
serveur.headersTimeout = 65 * 1000;      // doit rester superieur a 60 s
