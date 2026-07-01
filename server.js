const express = require('express');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DIR = process.env.SESSION_DIR || './wa-session';
const GROUP_JID = process.env.GROUP_JID || '';
const INVITE_CODE = (process.env.GROUP_INVITE || 'FnrWqHjgdT3IAIqmJlqcmO').replace('https://chat.whatsapp.com/', '');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
let sock = null, isConnected = false, pendingQR = null, isConnecting = false;

// Evita que un error suelto de Baileys (stream/timeout/etc) mate todo el proceso.
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err && err.message); });
process.on('unhandledRejection', (err) => { console.error('unhandledRejection:', err && (err.message || err)); });
async function redisCmd(commands) {
  const res = await fetch(REDIS_URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
  return res.json();
}
async function redisGet(key) { const r = await redisCmd([['GET', key]]); const val = r[0] && r[0].result; return val ? JSON.parse(val) : null; }
async function redisSet(key, value) { await redisCmd([['SET', key, JSON.stringify(value)]]); }
async function useRedisAuthState() {
  let creds = await redisGet('wa:creds');
  if (!creds) creds = initAuthCreds();
  return { state: { creds, keys: { get: async (type, ids) => { const results = await redisCmd(ids.map(id => ['GET', 'wa:' + type + ':' + id])); const data = {}; ids.forEach((id, i) => { const val = results[i] && results[i].result; data[id] = val ? JSON.parse(val) : undefined; }); return data; }, set: async (data) => { const cmds = []; for (const cat of Object.keys(data)) for (const id of Object.keys(data[cat])) { const value = data[cat][id]; cmds.push(value ? ['SET', 'wa:' + cat + ':' + id, JSON.stringify(value)] : ['DEL', 'wa:' + cat + ':' + id]); } if (cmds.length) await redisCmd(cmds); } } }, saveCreds: async () => { await redisSet('wa:creds', creds); } };
}
async function clearSession() {
  try {
    if (REDIS_URL && REDIS_TOKEN) {
      const r = await redisCmd([['KEYS', 'wa:*']]);
      const keys = (r[0] && r[0].result) || [];
      if (keys.length) await redisCmd([['DEL', ...keys]]);
    } else if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
    console.log('Sesion limpiada, se generara un QR nuevo');
  } catch (e) { console.error('Error limpiando sesion:', e && e.message); }
}
function scheduleReconnect(ms) { setTimeout(() => { connectWA().catch(e => console.error('reconnect fallo:', e && e.message)); }, ms); }
async function connectWA() {
  if (isConnecting) return;
  isConnecting = true;
  try {
    let state, saveCreds;
    if (REDIS_URL && REDIS_TOKEN) { console.log('Redis session'); const r = await useRedisAuthState(); state = r.state; saveCreds = r.saveCreds; }
    else { console.log('Filesystem session'); if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true }); const r = await useMultiFileAuthState(SESSION_DIR); state = r.state; saveCreds = r.saveCreds; }
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: true, browser: ['Ya comio el perro', 'Chrome', '1.0.0'], connectTimeoutMs: 60000 });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { pendingQR = qr; isConnected = false; }
      if (connection === 'open') { isConnected = true; pendingQR = null; console.log('WhatsApp conectado!'); if (!GROUP_JID && INVITE_CODE) { try { await sock.groupAcceptInvite(INVITE_CODE); } catch(e) {} } }
      if (connection === 'close') {
        isConnected = false;
        const code = (lastDisconnect && lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
        console.log('Conexion cerrada, codigo:', code);
        if (code === DisconnectReason.loggedOut) { await clearSession(); scheduleReconnect(3000); }
        else { scheduleReconnect(3000); }
      }
    });
  } catch (e) {
    console.error('connectWA fallo:', e && e.message);
    scheduleReconnect(5000);
  } finally {
    isConnecting = false;
  }
}
connectWA().catch(e => console.error('connectWA inicial fallo:', e && e.message));
function hora() { return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false }); }
app.get('/fed', async (req, res) => { const name = req.query.por || 'Alguien'; const t = hora(); if (!isConnected) return res.status(503).send('<h1>WhatsApp no conectado. Entra a /setup</h1>'); const gid = GROUP_JID || process.env.GROUP_JID; if (!gid) return res.status(500).send('<h1>Grupo no configurado</h1>'); try { await sock.sendMessage(gid, { text: 'Bolt ya comio! ' + t + ' hs - ' + name }); res.send('<!DOCTYPE html><html><head><meta charset=UTF-8><title>Enviado</title><style>body{font-family:sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.c{background:white;border-radius:24px;padding:40px;text-align:center;max-width:300px;box-shadow:0 4px 40px rgba(0,0,0,.08)}h1{color:#15803d}p{color:#78716c;margin-top:8px}</style></head><body><div class=c><div style=font-size:72px>&#x1F415;&#x2705;</div><h1>Mensaje enviado!</h1><p>' + t + ' hs</p><button onclick=window.close() style=margin-top:20px;padding:12px 24px;border-radius:12px;border:none;background:#16a34a;color:white;font-size:16px;font-weight:700;cursor:pointer>Cerrar</button></div></body></html>'); } catch(e) { res.status(500).send('<h1>Error: ' + e.message + '</h1>'); } });
app.get('/setup', async (req, res) => { if (isConnected) return res.send('<html><body style=font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4><div style=font-size:64px>&#x2705;</div><h1 style=color:#15803d>WhatsApp conectado</h1></body></html>'); if (!pendingQR) return res.send('<html><head><meta http-equiv=refresh content=4></head><body style=font-family:sans-serif;text-align:center;padding:40px><p>Iniciando... recargando en 4s</p></body></html>'); try { const qrImg = await QRCode.toDataURL(pendingQR, { width: 280, margin: 2 }); res.send('<html><head><meta charset=UTF-8><meta http-equiv=refresh content=25><title>Conectar WhatsApp</title><style>body{font-family:sans-serif;background:#fff7ed;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:white;border-radius:24px;padding:36px;max-width:360px;width:100%;text-align:center;box-shadow:0 4px 32px rgba(0,0,0,.1)}h1{font-size:22px;font-weight:800;margin-bottom:8px}p{font-size:14px;color:#78716c;margin-bottom:24px}img{border-radius:12px;border:2px solid #f5f5f4}.steps{background:#f5f5f4;border-radius:12px;padding:12px 16px;font-size:13px;text-align:left;margin-top:20px;line-height:1.8}</style></head><body><div class=card><div style=font-size:52px;margin-bottom:12px>&#x1F4F1;</div><h1>Conectar WhatsApp</h1><p>Hace esto una sola vez.</p><img src="' + qrImg + '" width=260 height=260><div class=steps>1 Abri WhatsApp en tu celu<br>2 Menu - Dispositivos vinculados<br>3 Vincular dispositivo<br>4 Escanea este QR</div></div></body></html>'); } catch(e) { res.status(500).send('Error: ' + e.message); } });
app.get('/grupos', async (req, res) => { if (!isConnected) return res.status(503).send('No conectado'); try { const groups = await sock.groupFetchAllParticipating(); const rows = Object.values(groups).map(g => '<tr><td>' + g.subject + '</td><td><code>' + g.id + '</code></td></tr>').join(''); res.send('<html><body style=font-family:sans-serif;padding:32px><h1>Grupos</h1><table>' + rows + '</table></body></html>'); } catch(e) { res.status(500).send('Error: ' + e.message); } });
app.get('/', (req, res) => { res.json({ status: isConnected ? 'connected' : 'disconnected', redis: !!(REDIS_URL && REDIS_TOKEN) }); });
app.listen(PORT, () => console.log('Servidor en puerto ' + PORT + ' | Redis: ' + !!(REDIS_URL && REDIS_TOKEN)));
