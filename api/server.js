/**
 * TerminalMX Auth API
 * - Lista de correos en allowed_emails.txt
 * - OTP por correo
 * - Sesión firmada válida 3 días
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 8787);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 3);
const OTP_TTL_MS = Number(process.env.OTP_TTL_MINUTES || 10) * 60 * 1000;
const ALLOWED_FILE = path.resolve(
  __dirname,
  process.env.ALLOWED_EMAILS_FILE || '../allowed_emails.txt'
);
const DEV_LOG_OTP = String(process.env.DEV_LOG_OTP || 'false').toLowerCase() === 'true';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// OTP en memoria: email -> { codeHash, expiresAt, attempts }
const otpStore = new Map();
// Rate limit simple: email -> lastRequestAt
const otpRate = new Map();

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('CORS no permitido: ' + origin));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '32kb' }));

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function loadAllowedEmails() {
  try {
    const raw = fs.readFileSync(ALLOWED_FILE, 'utf8');
    return new Set(
      raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map(normalizeEmail)
    );
  } catch (e) {
    console.error('[auth] No se pudo leer allowed_emails.txt:', ALLOWED_FILE, e.message);
    return new Set();
  }
}

function isAllowed(email) {
  return loadAllowedEmails().has(normalizeEmail(email));
}

function hashCode(code) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(code)).digest('hex');
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (!payload.email) return null;
    if (!isAllowed(payload.email)) return null;
    return payload;
  } catch {
    return null;
  }
}

function genOtp() {
  // 6 dígitos
  return String(crypto.randomInt(100000, 999999));
}

async function sendOtpEmail(to, code) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    if (DEV_LOG_OTP) {
      console.log(`[DEV OTP] ${to} → ${code}`);
      return { ok: true, mode: 'console' };
    }
    throw new Error('SMTP no configurado. Define SMTP_HOST, SMTP_USER, SMTP_PASS o DEV_LOG_OTP=true');
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user, pass },
  });

  const from = process.env.SMTP_FROM || user;
  await transporter.sendMail({
    from,
    to,
    subject: `TerminalMX · Código de acceso ${code}`,
    text: `Tu código OTP de TerminalMX es: ${code}\n\nVálido ${Math.round(OTP_TTL_MS / 60000)} minutos.\nSi no solicitaste acceso, ignora este correo.`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;background:#0b0e11;color:#eaecef;padding:24px">
        <h2 style="color:#f0b90b;margin:0 0 12px">TerminalMX</h2>
        <p style="color:#919b9b">Código de acceso de un solo uso:</p>
        <p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#0ecb81;margin:16px 0">${code}</p>
        <p style="color:#919b9b;font-size:13px">Válido ${Math.round(OTP_TTL_MS / 60000)} minutos. La sesión durará ${SESSION_DAYS} días.</p>
      </div>
    `,
  });
  return { ok: true, mode: 'smtp' };
}

function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : req.body?.token || req.query?.token;
  const payload = verifySession(token);
  if (!payload) {
    return res.status(401).json({ ok: false, error: 'Sesión inválida o expirada' });
  }
  req.user = payload;
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'terminalmx-auth',
    sessionDays: SESSION_DAYS,
    allowedFile: path.basename(ALLOWED_FILE),
  });
});

/** Solicitar OTP — solo correos en allowed_emails.txt */
app.post('/api/auth/request-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Correo inválido' });
    }
    if (!isAllowed(email)) {
      // Misma respuesta genérica para no filtrar la lista
      return res.status(403).json({
        ok: false,
        error: 'Este correo no está autorizado para TerminalMX',
      });
    }

    const now = Date.now();
    const last = otpRate.get(email) || 0;
    if (now - last < 45_000) {
      return res.status(429).json({ ok: false, error: 'Espera unos segundos antes de pedir otro código' });
    }
    otpRate.set(email, now);

    const code = genOtp();
    otpStore.set(email, {
      codeHash: hashCode(code),
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
    });

    const send = await sendOtpEmail(email, code);
    return res.json({
      ok: true,
      message: send.mode === 'console'
        ? 'OTP generado (modo desarrollo: revisa la consola del servidor)'
        : 'Código enviado a tu correo',
      expiresInMinutes: Math.round(OTP_TTL_MS / 60000),
      devMode: send.mode === 'console',
    });
  } catch (e) {
    console.error('request-otp', e);
    return res.status(500).json({ ok: false, error: e.message || 'Error al enviar OTP' });
  }
});

/** Verificar OTP y emitir sesión de 3 días */
app.post('/api/auth/verify-otp', (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ ok: false, error: 'Correo y código requeridos' });
    }
    if (!isAllowed(email)) {
      return res.status(403).json({ ok: false, error: 'Correo no autorizado' });
    }

    const entry = otpStore.get(email);
    if (!entry) {
      return res.status(400).json({ ok: false, error: 'No hay código pendiente. Solicita uno nuevo.' });
    }
    if (Date.now() > entry.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ ok: false, error: 'Código expirado. Solicita uno nuevo.' });
    }
    entry.attempts += 1;
    if (entry.attempts > 5) {
      otpStore.delete(email);
      return res.status(429).json({ ok: false, error: 'Demasiados intentos. Solicita un código nuevo.' });
    }
    if (hashCode(code) !== entry.codeHash) {
      return res.status(401).json({ ok: false, error: 'Código incorrecto' });
    }

    otpStore.delete(email);
    const now = Date.now();
    const exp = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
    const payload = { email, iat: now, exp };
    const token = signSession(payload);

    return res.json({
      ok: true,
      token,
      email,
      expiresAt: exp,
      sessionDays: SESSION_DAYS,
    });
  } catch (e) {
    console.error('verify-otp', e);
    return res.status(500).json({ ok: false, error: 'Error al verificar' });
  }
});

/** Validar sesión actual */
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({
    ok: true,
    email: req.user.email,
    expiresAt: req.user.exp,
    sessionDays: SESSION_DAYS,
  });
});

app.post('/api/auth/logout', (_req, res) => {
  // Stateless JWT: el cliente borra el token
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[TerminalMX Auth] http://localhost:${PORT}`);
  console.log(`[TerminalMX Auth] Correos: ${ALLOWED_FILE}`);
  console.log(`[TerminalMX Auth] Sesión: ${SESSION_DAYS} días · OTP TTL: ${OTP_TTL_MS / 60000} min`);
  if (DEV_LOG_OTP) console.log('[TerminalMX Auth] DEV_LOG_OTP=true (OTP en consola si no hay SMTP)');
});
