const express = require('express');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || './wa-session';
const GROUP_JID = process.env.GROUP_JID || ''; // se configura después de /setup
const INVITE_CODE = (process.env.GROUP_INVITE || 'FnrWqHjgdT3IAIqmJlqcmO').replace('https://chat.whatsapp.com/', '');

let sock = null;
let isConnected = false;
let pendingQR = null;

// ── WhatsApp connection ──────────────────────────────────────────────────────

async function connectWA() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Ya comió el perro', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60_000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      pendingQR = qr;
      isConnected = false;
      console.log('QR disponible → visitá /setup en el browser');
    }

    if (connection === 'open') {
      isConnected = true;
      pendingQR = null;
      console.log('✅ WhatsApp conectado!');

      // Si no tenemos GROUP_JID, intentar unirse al grupo con el invite
      if (!GROUP_JID && INVITE_CODE) {
        try {
          const gid = await sock.groupAcceptInvite(INVITE_CODE);
          console.log('Grupo encontrado:', gid);
          console.log('→ Agregá GROUP_JID=' + gid + ' como variable de entorno en Render');
        } catch (e) {
          console.log('Ya eras miembro del grupo (normal). Buscá el ID en /grupos');
        }
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode : 0;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconectando...');
        setTimeout(connectWA, 3000);
      } else {
        console.log('Sesión cerrada — necesitás volver a conectar en /setup');
      }
    }
  });
}

connectWA();

// ── Helpers ──────────────────────────────────────────────────────────────────

function hora() {
  return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function successHTML(name, time) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="theme-color" content="#16a34a"/>
  <title>¡Registrado!</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:#f0fdf4;min-height:100dvh;display:flex;align-items:center;
      justify-content:center;padding:24px}
    .card{background:white;border-radius:28px;padding:40px 32px;max-width:340px;
      width:100%;text-align:center;box-shadow:0 4px 40px rgba(0,0,0,0.08)}
    .emoji{font-size:80px;margin-bottom:16px;display:block;
      animation:bounce 0.5s ease}
    @keyframes bounce{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}
    h1{font-size:26px;font-weight:800;color:#15803d;margin-bottom:8px}
    .sub{font-size:15px;color:#78716c;margin-bottom:28px}
    .pill{display:inline-flex;align-items:center;gap:8px;
      background:#dcfce7;color:#15803d;border-radius:999px;
      padding:10px 20px;font-size:16px;font-weight:700;margin-bottom:8px}
    .time{font-size:42px;font-weight:900;color:#1c1917;letter-spacing:-2px;
      margin:12px 0 4px}
    .timelabel{font-size:13px;color:#a8a29e}
    .btn{display:block;margin-top:28px;padding:14px;border-radius:14px;
      border:2px solid #e7e5e4;background:white;color:#57534e;
      font-size:15px;font-weight:700;text-decoration:none;text-align:center;
      font-family:inherit;cursor:pointer;width:100%}
  </style>
</head>
<body>
<div class="card">
  <span class="emoji">🐕✅</span>
  <h1>¡Mensaje enviado!</h1>
  <p class="sub">El grupo ya sabe que le diste de comer.</p>
  <div class="pill">📲 WhatsApp notificado</div>
  <div class="time">${time}</div>
  <div class="timelabel">hora del registro · ${name}</div>
  <button class="btn" onclick="window.close()">Cerrar</button>
</div>
</body>
</html>`;
}

function errorHTML(msg) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Error</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff1f2}
  .c{background:white;border-radius:20px;padding:32px;max-width:320px;text-align:center}
  h1{color:#dc2626;font-size:22px}p{color:#78716c;margin-top:8px;font-size:14px}</style>
  </head><body><div class="c"><div style="font-size:60px">😕</div>
  <h1>Algo falló</h1><p>${msg}</p>
  <button onclick="location.reload()" style="margin-top:20px;padding:12px 24px;border-radius:12px;border:none;background:#f97316;color:white;font-weight:700;cursor:pointer;font-size:15px">Reintentar</button>
  </div></body></html>`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// 🟠 RUTA PRINCIPAL — la que apunta el QR
app.get('/fed', async (req, res) => {
  const name = req.query.por || 'Alguien';
  const t = hora();

  if (!isConnected) {
    return res.status(503).send(errorHTML('WhatsApp no está conectado. Avisale al admin que entre a /setup.'));
  }

  const gid = GROUP_JID || process.env.GROUP_JID;
  if (!gid) {
    return res.status(500).send(errorHTML('Grupo no configurado. El admin tiene que completar el setup.'));
  }

  try {
    await sock.sendMessage(gid, {
      text: `🐕 ¡Ya le di de comer al perro!\n🕐 ${t} hs — ${name}`
    });
    res.send(successHTML(name, t));
  } catch (e) {
    console.error('Error al mandar mensaje:', e);
    res.status(500).send(errorHTML('No se pudo enviar el mensaje: ' + e.message));
  }
});

// 🔐 Setup — conectar WhatsApp (visitar una sola vez)
app.get('/setup', async (req, res) => {
  if (isConnected) {
    return res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Setup</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0fdf4}
      .c{background:white;border-radius:20px;padding:36px;max-width:360px;text-align:center}
      h1{color:#15803d}p{color:#57534e;margin-top:8px;font-size:14px}</style>
      </head><body><div class="c">
      <div style="font-size:64px">✅</div>
      <h1>WhatsApp conectado</h1>
      <p>El servidor está funcionando. El QR de la heladera ya envía mensajes automáticamente.</p>
      <p style="margin-top:16px"><a href="/grupos">Ver grupos disponibles →</a></p>
      </div></body></html>`);
  }

  if (!pendingQR) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
      <meta http-equiv="refresh" content="4"/>
      <title>Iniciando...</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
      <p>Iniciando WhatsApp... recargando en 4 segundos</p>
      </body></html>`);
  }

  try {
    const qrImg = await QRCode.toDataURL(pendingQR, { width: 280, margin: 2 });
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="refresh" content="25"/>
  <title>Conectar WhatsApp</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:#fff7ed;display:flex;align-items:center;justify-content:center;
      min-height:100vh;padding:24px}
    .card{background:white;border-radius:24px;padding:36px 28px;max-width:360px;
      width:100%;text-align:center;box-shadow:0 4px 32px rgba(0,0,0,0.1)}
    h1{font-size:22px;font-weight:800;margin-bottom:8px}
    p{font-size:14px;color:#78716c;margin-bottom:24px;line-height:1.5}
    img{border-radius:12px;border:2px solid #f5f5f4}
    .step{background:#f5f5f4;border-radius:12px;padding:12px 16px;
      font-size:13px;text-align:left;margin-top:20px;color:#44403c;line-height:1.8}
    .note{font-size:12px;color:#a8a29e;margin-top:16px}
  </style>
</head>
<body>
<div class="card">
  <div style="font-size:52px;margin-bottom:12px">📱</div>
  <h1>Conectar WhatsApp</h1>
  <p>Hacé esto una sola vez. Después el servidor manda los mensajes solo.</p>
  <img src="${qrImg}" width="260" height="260" alt="QR WhatsApp"/>
  <div class="step">
    1️⃣ Abrí WhatsApp en tu celu<br>
    2️⃣ Menú → <strong>Dispositivos vinculados</strong><br>
    3️⃣ <strong>Vincular dispositivo</strong><br>
    4️⃣ Escaneá este QR
  </div>
  <p class="note">Esta página se actualiza sola cada 25 seg. El QR expira en ~60 seg.</p>
</div>
</body>
</html>`);
  } catch (e) {
    res.status(500).send('Error generando QR: ' + e.message);
  }
});

// 📋 Listar grupos (para encontrar el GROUP_JID)
app.get('/grupos', async (req, res) => {
  if (!isConnected) return res.status(503).send('WhatsApp no conectado. Primero visitá /setup');
  try {
    const groups = await sock.groupFetchAllParticipating();
    const lista = Object.values(groups)
      .map(g => `<tr><td style="padding:8px 16px 8px 0"><strong>${g.subject}</strong></td><td style="font-family:monospace;color:#78716c">${g.id}</td></tr>`)
      .join('');
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Grupos</title>
      <style>body{font-family:sans-serif;padding:32px;max-width:700px;margin:0 auto}
      h1{margin-bottom:20px}table{border-collapse:collapse;width:100%}
      tr:nth-child(even){background:#f5f5f4}
      .note{background:#fff7ed;border-radius:12px;padding:16px;margin-top:24px;font-size:14px;color:#57534e}
      code{background:#f5f5f4;padding:2px 6px;border-radius:4px;font-size:13px}</style>
      </head><body>
      <h1>🐕 Grupos de WhatsApp</h1>
      <table>${lista}</table>
      <div class="note">
        <strong>Próximo paso:</strong> Copiá el ID del grupo familiar y en Render.com
        andá a tu servicio → <em>Environment</em> → agregá:<br><br>
        <code>GROUP_JID = 1234567890-1234567@g.us</code>
      </div>
      </body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: isConnected ? 'connected' : 'disconnected', setup: '/setup', grupos: '/grupos' });
});

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
