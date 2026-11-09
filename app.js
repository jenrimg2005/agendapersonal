import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, getDocs, onSnapshot, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import { firebaseConfig } from "./firebase-config.js";
import { vapidKey } from "./notif-config.js";

const fb = initializeApp(firebaseConfig), auth = getAuth(fb), db = getFirestore(fb);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

// ---------- utilidades ----------
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monday = d => addDays(d, -((d.getDay() + 6) % 7));
const weekNum = d => Math.round((monday(d) - new Date(2024, 0, 1)) / 6048e5);
const mod = (a, n) => ((a % n) + n) % n;
const fmt = (d, o) => d.toLocaleDateString('es-ES', o);

const S = { tab: 'hoy', reg: false, err: '', user: null, pid: null, piso: null, done: {}, events: [],
  date: iso(new Date()), week: iso(monday(new Date())) };
let subs = [], pisoSubs = [];

// Tareas del piso de la semana que contiene `dateStr` (rotación: tarea i → miembro (i + semana) % n)
function pisoTasks(dateStr) {
  const p = S.piso; if (!p || !p.members.length) return [];
  const d = parse(dateStr), wk = iso(monday(d)), w = weekNum(d);
  return p.tasks.map((t, i) => ({ ...t, wk, uid: p.members[mod(i + w, p.members.length)], done: !!S.done[`${wk}_${t.id}`] }));
}
const nameOf = uid => esc(S.piso?.names?.[uid] || 'Alguien');


// ---------- avisos (notificaciones push) ----------
async function enablePush() {
  try {
    if (!('Notification' in window)) { S.pushMsg = 'En iPhone, primero añade la app a la pantalla de inicio y ábrela desde ahí.'; return render(); }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') { S.pushMsg = 'Permiso denegado. Actívalo en Ajustes → Notificaciones → Agenda.'; return render(); }
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(fb), { vapidKey, serviceWorkerRegistration: reg });
    await setDoc(doc(db, 'users', S.user.uid), { tokens: arrayUnion(token), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, { merge: true });
    S.pushMsg = 'on';
  } catch (x) { console.error(x); S.pushMsg = 'No se pudieron activar los avisos. Revisa la clave VAPID.'; }
  render();
}
const pushBlock = () => {
  const on = S.pushMsg === 'on' || (S.pushMsg === undefined && 'Notification' in window && Notification.permission === 'granted');
  return on ? '<p>Avisos activados ✓</p>' : `<p><button class="link" data-act="push">Activar avisos</button></p>${S.pushMsg ? `<p class="err">${esc(S.pushMsg)}</p>` : ''}`;
};

// ---------- vistas ----------
function authView() {
  return `<main class="auth"><h1>Agenda</h1><p>Las tareas de la casa y tu día, en un solo sitio.</p>
  <form id="auth">${S.reg ? '<input name="name" placeholder="Tu nombre" required autocomplete="name">' : ''}
  <input name="email" type="email" placeholder="Correo" required autocomplete="email">
  <input name="pass" type="password" placeholder="Contraseña (mínimo 6)" required minlength="6" autocomplete="${S.reg ? 'new-password' : 'current-password'}">
  <button class="primary">${S.reg ? 'Crear cuenta' : 'Entrar'}</button></form>
  <button class="link" data-act="toggleReg">${S.reg ? 'Ya tengo cuenta' : 'Crear una cuenta'}</button>
  <p class="err">${esc(S.err)}</p></main>`;
}

function hoyView() {
  const d = parse(S.date), evs = S.events.filter(e => e.date === S.date).sort((a, b) => a.time.localeCompare(b.time));
  const mine = pisoTasks(S.date).filter(t => t.uid === S.user.uid);
  return `<h1>Hoy</h1>
  <div class="nav"><button data-act="day" data-n="-1" aria-label="Día anterior">‹</button>
  <strong class="sub">${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
  <button data-act="day" data-n="1" aria-label="Día siguiente">›</button></div>
  ${mine.length ? `<h2>Te toca en el piso esta semana</h2>` + mine.map(t => taskRow(t)).join('') : ''}
  <h2>Tu agenda</h2>
  ${evs.length ? evs.map(e => `<div class="row ${e.done ? 'done' : ''}"><span class="time">${esc(e.time)}</span>
    <span class="t">${esc(e.title)}</span>
    <button class="bellb ${e.alert ? 'on' : ''}" data-act="evBell" data-id="${e.id}" aria-pressed="${!!e.alert}" aria-label="Avisarme a su hora">${e.alert ? '🔔' : '🔕'}</button>
    <button class="chk ${e.done ? 'on' : ''}" data-act="evDone" data-id="${e.id}" aria-label="Marcar hecho">${e.done ? '✓' : ''}</button>
    <button class="x" data-act="evDel" data-id="${e.id}" aria-label="Borrar">×</button></div>`).join('')
    : '<div class="empty">No tienes nada apuntado este día.</div>'}
  <form class="add ev" id="addEv"><input name="time" type="time" required value="09:00"><input name="title" placeholder="¿Qué quieres hacer?" required><label class="bell" title="Avisarme a su hora"><input type="checkbox" name="alert"><span class="off">🔕</span><span class="on">🔔</span></label><button>Añadir</button></form>`;
}

function taskRow(t) {
  const mine = t.uid === S.user.uid;
  return `<div class="row ${mine ? 'mine' : ''} ${t.done ? 'done' : ''}"><span class="t">${esc(t.name)}<small>${mine ? 'Te toca a ti' : nameOf(t.uid)}</small></span>
  <button class="chk ${t.done ? 'on' : ''}" data-act="taskDone" data-id="${t.id}" data-wk="${t.wk}" aria-label="Marcar hecha">${t.done ? '✓' : ''}</button></div>`;
}

function pisoView() {
  const p = S.piso;
  if (!p) return `<h1>Piso</h1><p>Crea tu piso o únete con el código que te pase un compañero.</p>
    <h2>Crear un piso</h2><form class="add one" id="mkPiso"><input name="name" placeholder="Nombre del piso" required><button>Crear</button></form>
    <h2>Unirme con un código</h2><form class="add one" id="joinPiso"><input name="code" placeholder="Código de 6 letras" required maxlength="6" autocapitalize="characters"><button>Unirme</button></form>
    <p class="err">${esc(S.err)}</p>`;
  const ws = parse(S.week), tasks = pisoTasks(S.week);
  return `<h1>${esc(p.name)}</h1><p>Código para invitar: <span class="code">${esc(p.code)}</span></p>
  <div class="nav"><button data-act="wk" data-n="-7" aria-label="Semana anterior">‹</button>
  <strong>${fmt(ws, { day: 'numeric', month: 'short' })} – ${fmt(addDays(ws, 6), { day: 'numeric', month: 'short' })}</strong>
  <button data-act="wk" data-n="7" aria-label="Semana siguiente">›</button></div>
  ${tasks.length ? tasks.map(t => taskRow(t).replace('</div>', `<button class="x" data-act="taskDel" data-id="${t.id}" aria-label="Quitar tarea">×</button></div>`)).join('')
    : '<div class="empty">Aún no hay tareas. Añade la primera abajo.</div>'}
  <form class="add one" id="addTask"><input name="name" placeholder="Nueva tarea (ej. Fregar baño)" required><button>Añadir</button></form>
  <h2>En el piso (${p.members.length})</h2><p>${p.members.map(nameOf).join(', ')}</p>`;
}

function render() {
  const keep = [...app.querySelectorAll('input')].map(i => [i.name, i.value, i.checked]), focus = document.activeElement?.name;
  if (!S.user) app.innerHTML = authView();
  else app.innerHTML = (S.tab === 'hoy' ? hoyView() : pisoView()) +
    pushBlock() + `<p><button class="link" data-act="out">Cerrar sesión</button></p>
    <nav class="tabs"><button data-act="tab" data-t="hoy" class="${S.tab === 'hoy' ? 'on' : ''}">Hoy</button>
    <button data-act="tab" data-t="piso" class="${S.tab === 'piso' ? 'on' : ''}">Piso</button></nav>`;
  keep.forEach(([n, v, c]) => { const i = n && app.querySelector(`input[name="${n}"]`); if (!i) return; if (i.type === 'checkbox') i.checked = c; else if (v) i.value = v; });
  if (focus) app.querySelector(`input[name="${focus}"]`)?.focus();
}

// ---------- datos en tiempo real ----------
function watchPiso(pid) {
  pisoSubs.forEach(f => f()); pisoSubs = []; S.piso = null; S.done = {};
  if (!pid) return render();
  pisoSubs.push(onSnapshot(doc(db, 'pisos', pid), s => { S.piso = s.exists() ? { id: s.id, ...s.data() } : null; render(); }));
  pisoSubs.push(onSnapshot(collection(db, 'pisos', pid, 'done'), s => { S.done = {}; s.docs.forEach(d => S.done[d.id] = 1); render(); }));
}
function watchUser(u) {
  subs.push(onSnapshot(doc(db, 'users', u.uid), s => { const pid = s.data()?.pisoId || null; if (pid !== S.pid) { S.pid = pid; watchPiso(pid); } }));
  subs.push(onSnapshot(collection(db, 'users', u.uid, 'events'), s => { S.events = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }));
}
onAuthStateChanged(auth, u => {
  subs.forEach(f => f()); pisoSubs.forEach(f => f()); subs = []; pisoSubs = [];
  Object.assign(S, { user: u, pid: null, piso: null, done: {}, events: [], err: '' });
  if (u) watchUser(u);
  if (u && 'Notification' in window && Notification.permission === 'granted') enablePush();
  render();
});

// ---------- acciones ----------
const errMsg = e => ({ 'auth/invalid-credential': 'Correo o contraseña incorrectos.', 'auth/email-already-in-use': 'Ese correo ya tiene cuenta.', 'auth/weak-password': 'La contraseña es muy corta.' }[e.code] || 'Algo ha fallado. Inténtalo de nuevo.');
const me = () => S.user.uid, myName = () => S.user.displayName || 'Sin nombre';

app.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const { act, id, n, t, wk } = b.dataset;
  try {
    if (act === 'toggleReg') { S.reg = !S.reg; S.err = ''; }
    else if (act === 'tab') S.tab = t;
    else if (act === 'day') S.date = iso(addDays(parse(S.date), +n));
    else if (act === 'wk') S.week = iso(addDays(parse(S.week), +n));
    else if (act === 'push') return enablePush();
    else if (act === 'out') return signOut(auth);
    else if (act === 'evDone') { const ev = S.events.find(x => x.id === id); return updateDoc(doc(db, 'users', me(), 'events', id), { done: !ev.done }); }
    else if (act === 'evBell') { const ev = S.events.find(x => x.id === id); return updateDoc(doc(db, 'users', me(), 'events', id), { alert: !ev.alert, notified: false }); }
    else if (act === 'evDel') return deleteDoc(doc(db, 'users', me(), 'events', id));
    else if (act === 'taskDone') { const ref = doc(db, 'pisos', S.pid, 'done', `${wk}_${id}`); return S.done[`${wk}_${id}`] ? deleteDoc(ref) : setDoc(ref, { by: me() }); }
    else if (act === 'taskDel') return updateDoc(doc(db, 'pisos', S.pid), { tasks: arrayRemove(S.piso.tasks.find(x => x.id === id)) });
  } catch (x) { S.err = errMsg(x); }
  render();
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target)), id = e.target.id;
  try {
    if (id === 'auth') {
      if (S.reg) { const c = await createUserWithEmailAndPassword(auth, f.email, f.pass); await updateProfile(c.user, { displayName: f.name.trim() }); await setDoc(doc(db, 'users', c.user.uid), { name: f.name.trim() }); }
      else await signInWithEmailAndPassword(auth, f.email, f.pass);
    } else if (id === 'addEv') {
      await addDoc(collection(db, 'users', me(), 'events'), { date: S.date, time: f.time, title: f.title.trim(), done: false, alert: f.alert === 'on', notified: false }); e.target.title.value = '';
    } else if (id === 'mkPiso') {
      const ref = await addDoc(collection(db, 'pisos'), { name: f.name.trim(), code: Math.random().toString(36).slice(2, 8).toUpperCase(), members: [me()], names: { [me()]: myName() }, tasks: [] });
      await setDoc(doc(db, 'users', me()), { pisoId: ref.id }, { merge: true });
    } else if (id === 'joinPiso') {
      const q = await getDocs(query(collection(db, 'pisos'), where('code', '==', f.code.trim().toUpperCase())));
      if (q.empty) { S.err = 'No existe ningún piso con ese código.'; return render(); }
      await updateDoc(q.docs[0].ref, { members: arrayUnion(me()), [`names.${me()}`]: myName() });
      await setDoc(doc(db, 'users', me()), { pisoId: q.docs[0].id }, { merge: true });
    } else if (id === 'addTask') {
      await updateDoc(doc(db, 'pisos', S.pid), { tasks: arrayUnion({ id: crypto.randomUUID().slice(0, 8), name: f.name.trim() }) }); e.target.name.value = '';
    }
    S.err = '';
  } catch (x) { S.err = errMsg(x); }
  render();
});
