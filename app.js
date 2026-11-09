import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, getDocs, onSnapshot, arrayUnion, arrayRemove, deleteField } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import { firebaseConfig } from "./firebase-config.js";
import { vapidKey } from "./notif-config.js";

const fb = initializeApp(firebaseConfig), auth = initializeAuth(fb, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] }), db = getFirestore(fb);
navigator.storage?.persist?.(); // pide al navegador no borrar la sesión guardada
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
const BELL = '<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 1.5h-15z"/><path d="M10 21h4"/></svg>';
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
  <form id="auth"><div class="list">${S.reg ? '<input name="name" placeholder="Tu nombre" required autocomplete="name">' : ''}
  <input name="email" type="email" placeholder="Correo" required autocomplete="email">
  <input name="pass" type="password" placeholder="Contraseña (mínimo 6)" required minlength="6" autocomplete="${S.reg ? 'new-password' : 'current-password'}">
  </div><button class="primary">${S.reg ? 'Crear cuenta' : 'Entrar'}</button></form>
  <button class="link" data-act="toggleReg">${S.reg ? 'Ya tengo cuenta' : 'Crear una cuenta'}</button>
  <p class="err">${esc(S.err)}</p></main>`;
}

const COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA'];
const colorOf = uid => COLORS[[...String(uid)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const avatar = (uid, name, cls = '') => `<span class="av ${cls}" style="background:${colorOf(uid)}" aria-hidden="true">${esc((name || '?').trim().charAt(0).toUpperCase())}</span>`;
const topbar = title => `<header class="top"><h1>${title}</h1><button class="me" data-act="tab" data-t="perfil" aria-label="Mi perfil">${avatar(S.user.uid, S.user.displayName)}</button></header>`;
const pushOn = () => S.pushMsg === 'on' || (S.pushMsg === undefined && 'Notification' in window && Notification.permission === 'granted');
const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
const GROUP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 3-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="9.5" r="2.5"/><path d="M16 14.2c2.6-.2 4.2 1.2 4.7 4"/></svg>';

function weekStrip() {
  const m = monday(parse(S.date)), today = iso(new Date());
  return `<div class="strip">${[0, 1, 2, 3, 4, 5, 6].map(i => { const x = addDays(m, i), k = iso(x);
    return `<button class="day ${k === S.date ? 'sel' : ''} ${k === today ? 'today' : ''}" data-act="pick" data-d="${k}" aria-label="${fmt(x, { weekday: 'long', day: 'numeric', month: 'long' })}"><small>${fmt(x, { weekday: 'narrow' }).toUpperCase()}</small><b>${x.getDate()}</b><i class="${S.events.some(e => e.date === k) ? 'dot' : ''}"></i></button>`; }).join('')}</div>`;
}

function agendaView() {
  const d = parse(S.date), evs = S.events.filter(e => e.date === S.date).sort((a, b) => a.time.localeCompare(b.time));
  const mine = pisoTasks(S.date).filter(t => t.uid === S.user.uid), done = evs.filter(e => e.done).length;
  return topbar('Agenda') +
    `<div class="nav"><strong class="sub">${fmt(d, { month: 'long', year: 'numeric' })}</strong><span><button data-act="day" data-n="-7" aria-label="Semana anterior">‹</button><button data-act="day" data-n="7" aria-label="Semana siguiente">›</button></span></div>` + weekStrip() +
    `<div class="sum"><div><b>${evs.length - done}</b><span>pendientes</span></div><div><b>${done}</b><span>completadas</span></div></div>` +
    (mine.length ? `<h2>Te toca en el colectivo</h2><div class="list">${mine.map(t => taskRow(t)).join('')}</div>` : '') +
    `<h2 class="sub">${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>` +
    (evs.length ? `<div class="list">${evs.map(e => `<div class="row ${e.done ? 'done' : ''}"><span class="time">${esc(e.time)}</span><span class="t">${esc(e.title)}</span>
      <button class="bellb ${e.alert ? 'on' : ''}" data-act="evBell" data-id="${e.id}" aria-pressed="${!!e.alert}" aria-label="Avisarme a su hora">${BELL}</button>
      <button class="chk ${e.done ? 'on' : ''}" data-act="evDone" data-id="${e.id}" aria-label="Marcar hecha">${e.done ? '✓' : ''}</button>
      <button class="x" data-act="evDel" data-id="${e.id}" aria-label="Borrar">×</button></div>`).join('')}</div>` : '<div class="empty">Nada apuntado este día.</div>') +
    `<form class="add ev" id="addEv"><input name="time" type="time" required value="09:00"><input name="title" placeholder="Nueva tarea" required><label class="bell" title="Avisarme a su hora" aria-label="Avisarme a su hora"><input type="checkbox" name="alert"><span>${BELL}</span></label><button>Añadir</button></form>`;
}

function taskRow(t) {
  const mine = t.uid === S.user.uid;
  return `<div class="row ${mine ? 'mine' : ''} ${t.done ? 'done' : ''}">${avatar(t.uid, S.piso?.names?.[t.uid])}<span class="t">${esc(t.name)}<small>${mine ? 'Te toca a ti' : nameOf(t.uid)}</small></span>
  <button class="chk ${t.done ? 'on' : ''}" data-act="taskDone" data-id="${t.id}" data-wk="${t.wk}" aria-label="Marcar hecha">${t.done ? '✓' : ''}</button></div>`;
}

function colectivoView() {
  const p = S.piso;
  if (!p) return topbar('Colectivo') + `<p>Crea el colectivo de tu piso o únete con el código que te pase un compañero.</p>
    <h2>Crear un colectivo</h2><form class="add one" id="mkPiso"><input name="name" placeholder="Nombre del piso" required><button>Crear</button></form>
    <h2>Unirme con un código</h2><form class="add one" id="joinPiso"><input name="code" placeholder="Código de 6 letras" required maxlength="6" autocapitalize="characters"><button>Unirme</button></form>
    <p class="err">${esc(S.err)}</p>`;
  const ws = parse(S.week), tasks = pisoTasks(S.week), n = tasks.filter(t => t.done).length;
  return topbar('Colectivo') + `<p>${esc(p.name)}</p>
  <div class="nav"><strong>${fmt(ws, { day: 'numeric', month: 'short' })} – ${fmt(addDays(ws, 6), { day: 'numeric', month: 'short' })}</strong><span><button data-act="wk" data-n="-7" aria-label="Semana anterior">‹</button><button data-act="wk" data-n="7" aria-label="Semana siguiente">›</button></span></div>
  <div class="card"><div><b>${n}</b> de ${tasks.length} tareas hechas</div><div class="bar"><i style="width:${tasks.length ? Math.round(n / tasks.length * 100) : 0}%"></i></div></div>` +
  (tasks.length ? `<div class="list">${tasks.map(t => taskRow(t).replace(/<\/div>$/, `<button class="x" data-act="taskDel" data-id="${t.id}" aria-label="Quitar tarea">×</button></div>`)).join('')}</div>` : '<div class="empty">Aún no hay tareas. Añade la primera abajo.</div>') +
  `<form class="add one" id="addTask"><input name="name" placeholder="Nueva tarea (ej. Fregar baño)" required><button>Añadir</button></form>
  <h2>Miembros</h2><div class="card members">${p.members.map(u => `<div class="mem">${avatar(u, p.names?.[u])}<small>${nameOf(u)}</small></div>`).join('')}</div>
  <h2>Código para invitar</h2><div class="card"><span class="code">${esc(p.code)}</span></div>`;
}

function perfilView() {
  const u = S.user, p = S.piso, name = u.displayName || '';
  return `<header class="top"><h1>Perfil</h1></header>
  <div class="prof">${avatar(u.uid, name, 'big')}<b>${esc(name)}</b><span>${esc(u.email)}</span></div>
  <h2>Cuenta</h2><div class="list"><form class="row" id="rename"><span class="v">Nombre</span><input name="name" value="${esc(name)}" required maxlength="30"><button class="link">Guardar</button></form></div>
  <h2>Avisos</h2><div class="list"><div class="row"><span class="t">Notificaciones</span>${pushOn() ? '<span class="v">Activadas ✓</span>' : '<button class="link" data-act="push">Activar</button>'}</div></div>
  ${S.pushMsg && S.pushMsg !== 'on' ? `<p class="err">${esc(S.pushMsg)}</p>` : ''}
  ${p ? `<h2>Colectivo</h2><div class="list"><div class="row"><span class="t">${esc(p.name)}<small>Código ${esc(p.code)}</small></span></div><button class="row danger" data-act="leave">Salir del colectivo</button></div>` : ''}
  <div class="list" style="margin-top:22px"><button class="row danger" data-act="out">Cerrar sesión</button></div>`;
}

const tabs = () => `<nav class="tabs"><button data-act="tab" data-t="hoy" class="${S.tab === 'hoy' ? 'on' : ''}">${CAL}<span>Agenda</span></button><button data-act="tab" data-t="piso" class="${S.tab === 'piso' ? 'on' : ''}">${GROUP}<span>Colectivo</span></button></nav>`;

function render() {
  const keep = S.lastTab === S.tab ? [...app.querySelectorAll('input')].map(i => [i.name, i.value, i.checked]) : [], focus = document.activeElement?.name;
  S.lastTab = S.tab;
  app.innerHTML = !S.user ? authView() : (S.tab === 'hoy' ? agendaView() : S.tab === 'piso' ? colectivoView() : perfilView()) + tabs();
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
  const { act, id, n, t, wk, d } = b.dataset;
  try {
    if (act === 'toggleReg') { S.reg = !S.reg; S.err = ''; }
    else if (act === 'tab') S.tab = t;
    else if (act === 'pick') S.date = d;
    else if (act === 'leave') { if (!confirm('¿Salir del colectivo?')) return; await updateDoc(doc(db, 'pisos', S.pid), { members: arrayRemove(me()), [`names.${me()}`]: deleteField() }); await updateDoc(doc(db, 'users', me()), { pisoId: deleteField() }); }
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
    } else if (id === 'rename') {
      const nm = f.name.trim(); await updateProfile(auth.currentUser, { displayName: nm }); await setDoc(doc(db, 'users', me()), { name: nm }, { merge: true });
      if (S.pid) await updateDoc(doc(db, 'pisos', S.pid), { [`names.${me()}`]: nm });
    } else if (id === 'addTask') {
      await updateDoc(doc(db, 'pisos', S.pid), { tasks: arrayUnion({ id: crypto.randomUUID().slice(0, 8), name: f.name.trim() }) }); e.target.name.value = '';
    }
    S.err = '';
  } catch (x) { S.err = errMsg(x); }
  render();
});
