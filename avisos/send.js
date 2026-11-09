const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore(), FV = admin.firestore.FieldValue;

// --- mismas funciones de fechas que la app ---
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monday = d => addDays(d, -((d.getDay() + 6) % 7));
const weekNum = d => Math.round((monday(d) - new Date(2024, 0, 1)) / 6048e5);
const mod = (a, n) => ((a % n) + n) % n;
// Reparto semanal: los grupos de tareas rotan al azar entre las personas, de forma justa
// (en cada ciclo de n semanas todos pasan por todos los grupos). El admin puede cambiar a mano
// a quién le toca un grupo en una semana concreta (overrides). Mismo cálculo en la app y en el servidor.
function hash(str) { let h = 1779033703 ^ str.length; for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return h >>> 0; }
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function shiftFor(pid, w, n) {
  const r = rng(hash(pid + ':' + Math.floor(w / n))), a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a[mod(w, n)];
}
const gIndex = (p, gid) => { const i = (p.groups || []).findIndex(g => g.id === gid); return i < 0 ? (p.groups || []).length : i; };
function assignee(p, gid, w) {
  const o = p.overrides?.['w' + w]?.[gid], n = p.members.length;
  return o && p.members.includes(o) ? o : p.members[mod(gIndex(p, gid) + shiftFor(p.id, w, n), n)];
}

const toMin = t => { const [h, m] = (t || '08:00').split(':').map(Number); return h * 60 + m; };
const occurs = (e, d) => e.date === d || (e.repeat && d >= e.date && (e.repeat === 'daily' || parse(d).getDay() === parse(e.date).getDay()));

function nowIn(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

let sent = 0;
async function push(u, tokens, title, body) {
  for (const token of tokens) {
    try {
      await admin.messaging().send({ token, data: { title, body }, webpush: { headers: { Urgency: 'high', TTL: '3600' } } });
      sent++;
    } catch (err) {
      if (err.code === 'messaging/registration-token-not-registered') await u.ref.update({ tokens: FV.arrayRemove(token) });
      else console.error(err.code || err);
    }
  }
}

const pisos = new Map();
async function getPiso(id) {
  if (!pisos.has(id)) { const s = await db.collection('pisos').doc(id).get(); pisos.set(id, s.exists ? { id: s.id, ref: s.ref, ...s.data() } : null); }
  return pisos.get(id);
}

(async () => {
  for (const u of (await db.collection('users').get()).docs) {
    const { tokens = [], tz = 'Europe/Madrid', pisoId, housetime } = u.data();
    if (!tokens.length) continue;
    const { date, min } = nowIn(tz);

    // 1) Tareas de la agenda personal con campanita (incluye las que se repiten)
    const col = u.ref.collection('events');
    const found = new Map();
    for (const q of [col.where('date', '==', date), col.where('repeat', 'in', ['daily', 'weekly'])])
      (await q.get()).docs.forEach(d => found.set(d.id, d));
    for (const e of found.values()) {
      const ev = e.data();
      if (!occurs(ev, date) || !ev.alert || !ev.time) continue;
      const done = ev.repeat ? (ev.doneDates || []).includes(date) : ev.done;
      const already = ev.repeat ? (ev.notifiedDates || []).includes(date) : ev.notified;
      const t = toMin(ev.time);
      if (done || already || t > min || min - t > 120) continue; // aún no es la hora, o pasaron más de 2 h
      await push(u, tokens, `⏰ ${ev.time}`, `Es tu hora: ${ev.title}`);
      await e.ref.update(ev.repeat ? { notifiedDates: FV.arrayUnion(date) } : { notified: true });
    }

    // 2) Tareas del colectivo: "hoy te toca" a la hora elegida (por defecto 08:00)
    const p = pisoId && await getPiso(pisoId);
    if (p && min >= toMin(housetime)) {
      const d = parse(date), w = weekNum(d), wk = iso(monday(d)), wd = (d.getDay() + 6) % 7;
      for (const [i, t] of (p.tasks || []).entries()) {
        if (t.day !== wd || assignee(p, t.gid || 'none', w) !== u.id) continue;
        const key = `${wk}_${t.id}`;
        const [dn, sn] = await Promise.all([p.ref.collection('done').doc(key).get(), p.ref.collection('sent').doc(key).get()]);
        if (dn.exists || sn.exists) continue;
        await push(u, tokens, '🏠 Hoy te toca', t.name);
        await p.ref.collection('sent').doc(key).set({ at: Date.now() });
      }
    }
  }
  console.log('Avisos enviados:', sent);
})().catch(e => { console.error(e); process.exit(1); });
