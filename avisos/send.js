const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

function nowIn(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

(async () => {
  let sent = 0;
  for (const u of (await db.collection('users').get()).docs) {
    const { tokens = [], tz = 'Europe/Madrid' } = u.data();
    if (!tokens.length) continue;
    const { date, min } = nowIn(tz);
    for (const e of (await u.ref.collection('events').where('date', '==', date).get()).docs) {
      const ev = e.data();
      if (!ev.alert || ev.done || ev.notified || !ev.time) continue; // solo tareas con la campanita activada
      const [h, m] = ev.time.split(':').map(Number), t = h * 60 + m;
      if (t > min || min - t > 120) continue; // aún no es la hora, o ya pasaron más de 2 h
      for (const token of tokens) {
        try {
          await admin.messaging().send({ token, data: { title: `⏰ ${ev.time}`, body: `Es tu hora: ${ev.title}` }, webpush: { headers: { Urgency: 'high', TTL: '3600' } } });
          sent++;
        } catch (err) {
          if (err.code === 'messaging/registration-token-not-registered') await u.ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(token) });
          else console.error(err.code || err);
        }
      }
      await e.ref.update({ notified: true });
    }
  }
  console.log('Avisos enviados:', sent);
})().catch(e => { console.error(e); process.exit(1); });
