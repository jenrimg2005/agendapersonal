import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, getDocs, getDoc, onSnapshot, arrayUnion, arrayRemove, deleteField } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
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
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const wday = d => (d.getDay() + 6) % 7;
const occurs = (e, d) => e.date === d || (e.repeat && d >= e.date && (e.repeat === 'daily' || parse(d).getDay() === parse(e.date).getDay()));
const isDone = (e, d) => e.repeat ? (e.doneDates || []).includes(d) : !!e.done;
const BELL = '<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 1.5h-15z"/><path d="M10 21h4"/></svg>';
const mod = (a, n) => ((a % n) + n) % n;
const fmt = (d, o) => d.toLocaleDateString('es-ES', o);

const S = { tab: 'hoy', reg: false, err: '', user: null, pid: null, piso: null, done: {}, events: [], friends: [], plans: [],
  date: iso(new Date()), week: iso(monday(new Date())) };
let subs = [], pisoSubs = [];

// Tareas del piso de la semana que contiene `dateStr` (rotación: tarea i → miembro (i + semana) % n)
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

function pisoTasks(dateStr) {
  const p = S.piso; if (!p || !p.members.length) return [];
  const d = parse(dateStr), wk = iso(monday(d)), w = weekNum(d);
  return (p.tasks || []).map(t => ({ ...t, wk, uid: assignee(p, t.gid || 'none', w), done: !!S.done[`${wk}_${t.id}`] }));
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
    return `<button class="day ${k === S.date ? 'sel' : ''} ${k === today ? 'today' : ''}" data-act="pick" data-d="${k}" aria-label="${fmt(x, { weekday: 'long', day: 'numeric', month: 'long' })}"><small>${fmt(x, { weekday: 'narrow' }).toUpperCase()}</small><b>${x.getDate()}</b><i class="${(S.events.some(e => occurs(e, k)) || S.plans.some(p => p.date === k)) ? 'dot' : ''}"></i></button>`; }).join('')}</div>`;
}

function itemRow(it) {
  const e = it.e, pl = it.k === 'pl', pre = pl ? 'pl' : 'ev', me = S.user.uid;
  const sub = pl ? `Con ${e.members.filter(u => u !== me).map(u => esc(e.names?.[u] || 'Amigo')).join(', ')}` : (e.repeat ? `Se repite ${e.repeat === 'daily' ? 'cada día' : 'cada semana'}` : '');
  return `<div class="row ${it.done ? 'done' : ''}"><span class="time">${esc(e.time)}</span><span class="t">${esc(e.title)}${sub ? `<small>${sub}</small>` : ''}</span>
    <button class="bellb ${e.alert ? 'on' : ''}" data-act="${pre}Bell" data-id="${e.id}" aria-pressed="${!!e.alert}" aria-label="Avisarme a su hora">${BELL}</button>
    <button class="chk ${it.done ? 'on' : ''}" data-act="${pre}Done" data-id="${e.id}" aria-label="Marcar hecha">${it.done ? '✓' : ''}</button>
    ${!pl || e.by === me ? `<button class="x" data-act="${pre}Del" data-id="${e.id}" aria-label="Borrar">×</button>` : ''}</div>`;
}

function agendaView() {
  const d = parse(S.date);
  const items = [...S.events.filter(e => occurs(e, S.date)).map(e => ({ k: 'ev', e, done: isDone(e, S.date) })), ...S.plans.filter(p => p.date === S.date).map(e => ({ k: 'pl', e, done: !!e.done }))].sort((a, b) => a.e.time.localeCompare(b.e.time));
  const mine = pisoTasks(S.date).filter(t => t.uid === S.user.uid && (t.day == null || t.day === wday(d))), done = items.filter(i => i.done).length;
  const who = S.friends.length ? `<div class="who"><small>Hacerlo con:</small>${S.friends.map(f => `<label><input type="checkbox" name="with" value="${f.uid}"><span>${esc(f.name)}</span></label>`).join('')}</div>` : '';
  return topbar('Agenda') +
    `<div class="nav"><strong class="sub">${fmt(d, { month: 'long', year: 'numeric' })}</strong><span><button data-act="day" data-n="-7" aria-label="Semana anterior">‹</button><button data-act="day" data-n="7" aria-label="Semana siguiente">›</button></span></div>` + weekStrip() +
    `<div class="sum"><div><b>${items.length - done}</b><span>pendientes</span></div><div><b>${done}</b><span>completadas</span></div></div>` +
    (mine.length ? `<h2>Te toca en el colectivo</h2><div class="list">${mine.map(t => taskRow(t)).join('')}</div>` : '') +
    `<h2 class="sub">${fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>` +
    (items.length ? `<div class="list">${items.map(itemRow).join('')}</div>` : '<div class="empty">Nada apuntado este día.</div>') +
    `<form class="add ev" id="addEv"><input name="time" type="time" required value="09:00"><input name="title" placeholder="Nueva tarea" required>${who}<label class="bell"><input type="checkbox" name="alert"><span>${BELL}<em>Avisarme a su hora</em></span></label><select name="repeat" aria-label="Repetir"><option value="">No se repite</option><option value="daily">Se repite cada día</option><option value="weekly">Se repite cada semana</option></select><button>Añadir</button></form>`;
}

function taskRow(t) {
  const mine = t.uid === S.user.uid;
  return `<div class="row ${mine ? 'mine' : ''} ${t.done ? 'done' : ''}">${avatar(t.uid, S.piso?.names?.[t.uid])}<span class="t">${esc(t.name)}<small>${t.day != null ? DAYS[t.day] + ' · ' : ''}${mine ? 'Te toca a ti' : nameOf(t.uid)}</small></span>
  <button class="chk ${t.done ? 'on' : ''}" data-act="taskDone" data-id="${t.id}" data-wk="${t.wk}" aria-label="Marcar hecha">${t.done ? '✓' : ''}</button></div>`;
}

function colectivoView() {
  const p = S.piso;
  if (!p) return topbar('Colectivo') + `<p>Crea el colectivo de tu piso o únete con el código que te pase un compañero.</p>
    <h2>Crear un colectivo</h2><form class="add one" id="mkPiso"><input name="name" placeholder="Nombre del piso" required><button>Crear</button></form>
    <h2>Unirme con un código</h2><form class="add one" id="joinPiso"><input name="code" placeholder="Código de 6 letras" required maxlength="6" autocapitalize="characters"><button>Unirme</button></form>
    <p class="err">${esc(S.err)}</p>`;
  const ws = parse(S.week), w = weekNum(ws), tasks = pisoTasks(S.week), n = tasks.filter(t => t.done).length;
  const owner = p.owner || p.members[0], isOwner = owner === S.user.uid;
  const grs = [...(p.groups || []), ...(tasks.some(t => !t.gid) ? [{ id: 'none', name: 'Sin grupo' }] : [])];
  const asg = g => assignee(p, g.id, w), ov = g => p.overrides?.['w' + w]?.[g.id] || '';
  const taskLine = t => `<div class="row ${t.done ? 'done' : ''}"><span class="t">${esc(t.name)}<small>${t.day != null ? DAYS[t.day] : 'Cualquier día'}</small></span><button class="chk ${t.done ? 'on' : ''}" data-act="taskDone" data-id="${t.id}" data-wk="${t.wk}" aria-label="Marcar hecha">${t.done ? '✓' : ''}</button>${isOwner ? `<button class="x" data-act="taskDel" data-id="${t.id}" aria-label="Quitar tarea">×</button>` : ''}</div>`;
  const cards = grs.map(g => {
    const ts = tasks.filter(t => (t.gid || 'none') === g.id).sort((a, b) => (a.day ?? 9) - (b.day ?? 9)), uid = asg(g), mine = uid === S.user.uid;
    return `<div class="list"><div class="row gh ${mine ? 'mine' : ''}">${avatar(uid, p.names?.[uid])}<span class="t">${esc(g.name)}<small>${mine ? 'Te toca a ti' : nameOf(uid)}</small></span>` +
      (isOwner ? `<select class="pick" data-ov="${g.id}" aria-label="Asignar a"><option value="">Automático</option>${p.members.map(u => `<option value="${u}" ${ov(g) === u ? 'selected' : ''}>${nameOf(u)}</option>`).join('')}</select>` : '') + '</div>' +
      (ts.length ? ts.map(taskLine).join('') : '<div class="row"><span class="t"><small>Sin tareas</small></span></div>') + '</div>';
  }).join('');
  const resumen = `<h2>Esta semana</h2><div class="list">${p.members.map(u => `<div class="row">${avatar(u, p.names?.[u])}<span class="t">${nameOf(u)}${u === owner ? ' · admin' : ''}<small>${grs.filter(g => asg(g) === u).map(g => esc(g.name)).join(', ') || 'Descansa'}</small></span></div>`).join('')}</div>`;
  const admin = isOwner ? `<h2>Añadir tarea</h2>` + ((p.groups || []).length
      ? `<form class="add task" id="addTask"><input name="name" placeholder="Nueva tarea (ej. Fregar baño)" required><select name="day" aria-label="Día en que toca"><option value="">Cualquier día</option>${DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select><select name="gid" aria-label="Grupo">${p.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select><button>Añadir</button></form>`
      : '<p>Crea primero un grupo para poder añadir tareas.</p>') +
    `<h2>Grupos</h2><p>Un grupo es un conjunto de tareas que hace la misma persona esa semana. Cada semana los grupos cambian de persona al azar, y puedes cambiarlo a mano con el selector de cada grupo.</p>` +
    ((p.groups || []).length ? `<div class="list">${p.groups.map(g => `<div class="row"><span class="t">${esc(g.name)}</span><button class="link" data-act="grRename" data-id="${g.id}">Renombrar</button><button class="x" data-act="grDel" data-id="${g.id}" aria-label="Borrar grupo">×</button></div>`).join('')}</div>` : '') +
    `<form class="add one" id="addGroup"><input name="name" placeholder="Nuevo grupo (ej. Cocina)" required maxlength="30"><button>Crear</button></form>`
    : `<p>Solo ${nameOf(owner)} puede editar las tareas.</p>`;
  return topbar('Colectivo') + `<p>${esc(p.name)}</p>
  <div class="nav"><strong>${fmt(ws, { day: 'numeric', month: 'short' })} – ${fmt(addDays(ws, 6), { day: 'numeric', month: 'short' })}</strong><span><button data-act="wk" data-n="-7" aria-label="Semana anterior">‹</button><button data-act="wk" data-n="7" aria-label="Semana siguiente">›</button></span></div>
  <div class="card"><div><b>${n}</b> de ${tasks.length} tareas hechas</div><div class="bar"><i style="width:${tasks.length ? Math.round(n / tasks.length * 100) : 0}%"></i></div></div>` + resumen +
  `<h2>Tareas por grupo</h2>` + (cards || `<div class="empty">${isOwner ? 'Crea un grupo (por ejemplo "Cocina") y añade sus tareas.' : 'El administrador aún no ha creado tareas.'}</div>`) + admin +
  `<h2>Código para invitar</h2><div class="card"><span class="code">${esc(p.code)}</span></div>`;
}

function perfilView() {
  const u = S.user, p = S.piso, name = u.displayName || '';
  const amigos = `<h2>Amigos</h2><div class="list"><div class="row"><span class="t">Tu código<small>Compártelo para que te añadan</small></span><span class="code sm">${esc(S.friendCode || '…')}</span></div>${S.friends.map(f => `<div class="row">${avatar(f.uid, f.name)}<span class="t">${esc(f.name)}</span><button class="x" data-act="frDel" data-id="${f.id}" aria-label="Quitar amigo">×</button></div>`).join('')}<form class="row" id="addFriend"><input name="code" placeholder="Código de un amigo" maxlength="6" required autocapitalize="characters"><button class="link">Añadir</button></form></div>${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}`;
  return `<header class="top"><h1>Perfil</h1></header>
  <div class="prof">${avatar(u.uid, name, 'big')}<b>${esc(name)}</b><span>${esc(u.email)}</span></div>
  <h2>Cuenta</h2><div class="list"><form class="row" id="rename"><span class="v">Nombre</span><input name="name" value="${esc(name)}" required maxlength="30"><button class="link">Guardar</button></form></div>
  <h2>Avisos</h2><div class="list"><div class="row"><span class="t">Notificaciones</span>${pushOn() ? '<span class="v">Activadas ✓</span>' : '<button class="link" data-act="push">Activar</button>'}</div><form class="row" id="housetime"><span class="t">Aviso del colectivo</span><input type="time" name="housetime" value="${esc(S.housetime || '08:00')}" required><button class="link">Guardar</button></form></div>
  ${S.pushMsg && S.pushMsg !== 'on' ? `<p class="err">${esc(S.pushMsg)}</p>` : ''}
  ${amigos}
  ${p ? `<h2>Colectivo</h2><div class="list"><div class="row"><span class="t">${esc(p.name)}<small>Código ${esc(p.code)}</small></span></div><button class="row danger" data-act="leave">Salir del colectivo</button></div>` : ''}
  <div class="list" style="margin-top:22px"><button class="row danger" data-act="out">Cerrar sesión</button></div>`;
}

const tabs = () => `<nav class="tabs"><button data-act="tab" data-t="hoy" class="${S.tab === 'hoy' ? 'on' : ''}">${CAL}<span>Agenda</span></button><button data-act="tab" data-t="piso" class="${S.tab === 'piso' ? 'on' : ''}">${GROUP}<span>Colectivo</span></button></nav>`;

function render() {
  const keep = S.lastTab === S.tab ? [...app.querySelectorAll('input')].map(i => [i.name, i.value, i.checked]) : [], focus = document.activeElement?.name;
  S.lastTab = S.tab;
  app.innerHTML = !S.user ? authView() : (S.tab === 'hoy' ? agendaView() : S.tab === 'piso' ? colectivoView() : perfilView()) + tabs();
  const els = [...app.querySelectorAll('input')]; keep.forEach(([n, v, c], i) => { const el = els[i]; if (!el || el.name !== n) return; if (el.type === 'checkbox') el.checked = c; else if (v) el.value = v; });
  if (focus) app.querySelector(`input[name="${focus}"]`)?.focus();
}

// Código personal para que tus amigos te añadan
async function makeFriendCode() {
  try {
    for (let i = 0; i < 5; i++) {
      const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
      if ((await getDoc(doc(db, 'friendCodes', code))).exists()) continue;
      await setDoc(doc(db, 'friendCodes', code), { uid: S.user.uid, name: S.user.displayName || 'Amigo' });
      await setDoc(doc(db, 'users', S.user.uid), { friendCode: code }, { merge: true });
      return;
    }
  } catch (x) { console.error(x); } finally { S.codeBusy = false; }
}

// ---------- datos en tiempo real ----------
function watchPiso(pid) {
  pisoSubs.forEach(f => f()); pisoSubs = []; S.piso = null; S.done = {};
  if (!pid) return render();
  pisoSubs.push(onSnapshot(doc(db, 'pisos', pid), s => { S.piso = s.exists() ? { id: s.id, ...s.data() } : null; render(); }));
  pisoSubs.push(onSnapshot(collection(db, 'pisos', pid, 'done'), s => { S.done = {}; s.docs.forEach(d => S.done[d.id] = 1); render(); }));
}
function watchUser(u) {
  subs.push(onSnapshot(query(collection(db, 'friendships'), where('members', 'array-contains', u.uid)), s => { S.friends = s.docs.map(d => { const x = d.data(), uid = x.members.find(m => m !== u.uid); return { id: d.id, uid, name: x.names?.[uid] || 'Amigo' }; }); render(); }));
  subs.push(onSnapshot(query(collection(db, 'plans'), where('members', 'array-contains', u.uid)), s => { S.plans = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }));
  subs.push(onSnapshot(doc(db, 'users', u.uid), s => { S.housetime = s.data()?.housetime; S.friendCode = s.data()?.friendCode; if (!S.friendCode && !S.codeBusy) { S.codeBusy = true; makeFriendCode(); } const pid = s.data()?.pisoId || null; if (pid !== S.pid) { S.pid = pid; watchPiso(pid); } }));
  subs.push(onSnapshot(collection(db, 'users', u.uid, 'events'), s => { S.events = s.docs.map(d => ({ id: d.id, ...d.data() })); render(); }));
}
onAuthStateChanged(auth, u => {
  subs.forEach(f => f()); pisoSubs.forEach(f => f()); subs = []; pisoSubs = [];
  Object.assign(S, { user: u, pid: null, piso: null, done: {}, events: [], friends: [], plans: [], err: '' });
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
    else if (act === 'tab') { S.tab = t; S.err = ''; }
    else if (act === 'pick') S.date = d;
    else if (act === 'plDone') { const pl = S.plans.find(x => x.id === id); return updateDoc(doc(db, 'plans', id), { done: !pl.done }); }
    else if (act === 'plBell') { const pl = S.plans.find(x => x.id === id); return updateDoc(doc(db, 'plans', id), { alert: !pl.alert, notifiedBy: [] }); }
    else if (act === 'plDel') return deleteDoc(doc(db, 'plans', id));
    else if (act === 'frDel') { if (!confirm('¿Quitar a este amigo?')) return; return deleteDoc(doc(db, 'friendships', id)); }
    else if (act === 'grRename') { const g = S.piso.groups.find(x => x.id === id), nm = prompt('Nombre del grupo', g.name); if (!nm || !nm.trim()) return; await updateDoc(doc(db, 'pisos', S.pid), { groups: S.piso.groups.map(x => x.id === id ? { ...x, name: nm.trim().slice(0, 30) } : x) }); }
    else if (act === 'grDel') { if (!confirm('¿Borrar el grupo y todas sus tareas?')) return; await updateDoc(doc(db, 'pisos', S.pid), { groups: S.piso.groups.filter(x => x.id !== id), tasks: S.piso.tasks.filter(x => x.gid !== id) }); }
    else if (act === 'leave') { if (!confirm('¿Salir del colectivo?')) return; await updateDoc(doc(db, 'pisos', S.pid), { members: arrayRemove(me()), [`names.${me()}`]: deleteField(), ...((S.piso.owner || S.piso.members[0]) === me() && S.piso.members.length > 1 ? { owner: S.piso.members.find(x => x !== me()) } : {}) }); await updateDoc(doc(db, 'users', me()), { pisoId: deleteField() }); }
    else if (act === 'day') S.date = iso(addDays(parse(S.date), +n));
    else if (act === 'wk') S.week = iso(addDays(parse(S.week), +n));
    else if (act === 'push') return enablePush();
    else if (act === 'out') return signOut(auth);
    else if (act === 'evDone') { const ev = S.events.find(x => x.id === id); const r = doc(db, 'users', me(), 'events', id); return ev.repeat ? updateDoc(r, { doneDates: isDone(ev, S.date) ? arrayRemove(S.date) : arrayUnion(S.date) }) : updateDoc(r, { done: !ev.done }); }
    else if (act === 'evBell') { const ev = S.events.find(x => x.id === id); return updateDoc(doc(db, 'users', me(), 'events', id), { alert: !ev.alert, notified: false, notifiedDates: [] }); }
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
      const withs = new FormData(e.target).getAll('with');
      if (withs.length) {
        const names = { [me()]: myName() }; S.friends.forEach(fr => { if (withs.includes(fr.uid)) names[fr.uid] = fr.name; });
        await addDoc(collection(db, 'plans'), { title: f.title.trim(), date: S.date, time: f.time, members: [me(), ...withs], names, by: me(), done: false, alert: f.alert === 'on', notifiedBy: [] });
      } else await addDoc(collection(db, 'users', me(), 'events'), { date: S.date, time: f.time, title: f.title.trim(), done: false, alert: f.alert === 'on', notified: false, repeat: f.repeat || null });
      e.target.title.value = ''; e.target.querySelectorAll('input[name="with"]').forEach(c => { c.checked = false; });
    } else if (id === 'mkPiso') {
      const ref = await addDoc(collection(db, 'pisos'), { name: f.name.trim(), code: Math.random().toString(36).slice(2, 8).toUpperCase(), owner: me(), members: [me()], names: { [me()]: myName() }, tasks: [] });
      await setDoc(doc(db, 'users', me()), { pisoId: ref.id }, { merge: true });
    } else if (id === 'joinPiso') {
      const q = await getDocs(query(collection(db, 'pisos'), where('code', '==', f.code.trim().toUpperCase())));
      if (q.empty) { S.err = 'No existe ningún piso con ese código.'; return render(); }
      await updateDoc(q.docs[0].ref, { members: arrayUnion(me()), [`names.${me()}`]: myName() });
      await setDoc(doc(db, 'users', me()), { pisoId: q.docs[0].id }, { merge: true });
    } else if (id === 'addGroup') {
      await updateDoc(doc(db, 'pisos', S.pid), { groups: arrayUnion({ id: 'g' + crypto.randomUUID().slice(0, 6), name: f.name.trim() }) }); e.target.name.value = '';
    } else if (id === 'addFriend') {
      const code = f.code.trim().toUpperCase(), snap = await getDoc(doc(db, 'friendCodes', code));
      if (!snap.exists()) { S.err = 'Ese código no existe.'; return render(); }
      const fu = snap.data().uid, fname = snap.data().name || 'Amigo';
      if (fu === me()) { S.err = 'Ese es tu propio código.'; return render(); }
      if (S.friends.some(x => x.uid === fu)) { S.err = 'Ya sois amigos.'; return render(); }
      await setDoc(doc(db, 'friendships', [me(), fu].sort().join('_')), { members: [me(), fu], names: { [me()]: myName(), [fu]: fname } }); e.target.code.value = '';
    } else if (id === 'housetime') {
      await setDoc(doc(db, 'users', me()), { housetime: f.housetime }, { merge: true });
    } else if (id === 'rename') {
      const nm = f.name.trim(); await updateProfile(auth.currentUser, { displayName: nm }); await setDoc(doc(db, 'users', me()), { name: nm }, { merge: true });
      if (S.friendCode) await updateDoc(doc(db, 'friendCodes', S.friendCode), { name: nm });
      if (S.pid) await updateDoc(doc(db, 'pisos', S.pid), { [`names.${me()}`]: nm });
    } else if (id === 'addTask') {
      await updateDoc(doc(db, 'pisos', S.pid), { tasks: arrayUnion({ id: crypto.randomUUID().slice(0, 8), name: f.name.trim(), day: f.day === '' ? null : +f.day, gid: f.gid }) }); e.target.name.value = '';
    }
    S.err = '';
  } catch (x) { S.err = errMsg(x); }
  render();
});

// El admin cambia a mano a quién le toca un grupo esa semana ("Automático" vuelve al reparto al azar)
app.addEventListener('change', async e => {
  const sel = e.target.closest('select[data-ov]'); if (!sel) return;
  try { await updateDoc(doc(db, 'pisos', S.pid), { [`overrides.w${weekNum(parse(S.week))}.${sel.dataset.ov}`]: sel.value || deleteField() }); } catch (x) { S.err = errMsg(x); }
  render();
});
