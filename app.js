import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, setDoc, onSnapshot, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyAMFbVga-cgKTDbUb3nLMHltODGeJ18GoQ",
  authDomain: "nfs-apperals.firebaseapp.com",
  projectId: "nfs-apperals",
  storageBucket: "nfs-apperals.firebasestorage.app",
  messagingSenderId: "272975822519",
  appId: "1:272975822519:web:9b3f00f362534b167e1732"
};

const ALLOWED_EMAIL = 'nfsapperals@gmail.com';

// Recipes: how many finished pieces ONE roll of each raw material makes.
// Products using several raw materials get one line per material.
const RECIPES = {
  'Wheel Side Curtain': [
    { raw: 'CC 0.4 GSM', piecesPerRoll: 11 }
  ],
  'Three Wheel Curtain': [
    { raw: 'CC 0.4 GSM', piecesPerRoll: 11 }
  ],
  'Small Bag': [
    { raw: 'Cambrella 80 GSM', piecesPerRoll: 220 }
  ],
  'Big Bag': [
    { raw: 'Cambrella 80 GSM', piecesPerRoll: 162 }
  ]
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = id => document.getElementById(id);
const slug = s => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
const showMsg = (text, ok = false) => {
  const m = $('msg');
  m.textContent = text;
  m.className = ok ? 'msg ok' : 'msg';
};

// ---------- Sign-in ----------
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

$('signin').onclick = async () => {
  $('loginError').textContent = '';
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    $('loginError').textContent = 'Sign-in failed: ' + e.message;
  }
};

$('signout').onclick = () => signOut(auth);

let listening = false;

onAuthStateChanged(auth, async user => {
  if (!user) {
    $('login').classList.remove('hidden');
    $('app').classList.add('hidden');
    return;
  }
  if (user.email !== ALLOWED_EMAIL) {
    $('loginError').textContent = 'This Google account is not authorised for NFS Apperals.';
    await signOut(auth);
    return;
  }
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  if (!listening) { startListeners(); listening = true; }
});

// ---------- Navigation ----------
document.querySelectorAll('nav button[data-page]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('nav button[data-page]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    $(btn.dataset.page).classList.remove('hidden');
  };
});

// ---------- Live data ----------
let raw = [];
let finished = [];

function startListeners() {
  onSnapshot(collection(db, 'raw'), snap => {
    raw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRaw();
    renderDashboard();
  });
  onSnapshot(collection(db, 'finished'), snap => {
    finished = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFinished();
    renderDashboard();
  });

  $('productSelect').innerHTML = Object.keys(RECIPES)
    .map(p => `<option value="${p}">${p}</option>`)
    .join('');
}

const fmt = n => Number(n || 0).toFixed(2);

function renderRaw() {
  $('rawTable').innerHTML = raw.map(r => `
    <tr>
      <td>${r.name}</td>
      <td>${r.gsm || ''}</td>
      <td>${fmt(r.rollMetres)}</td>
      <td>${fmt(r.stockMetres)}</td>
      <td>${fmt(r.stockMetres / r.rollMetres)}</td>
    </tr>`).join('') || '<tr><td colspan="5">No raw items yet</td></tr>';
}

function renderFinished() {
  $('finTable').innerHTML = finished.map(f => `
    <tr><td>${f.name}</td><td>${f.pieces || 0}</td></tr>`).join('')
    || '<tr><td colspan="2">No ready made items yet</td></tr>';
}

function renderDashboard() {
  $('rawCount').textContent = raw.length;
  $('finCount').textContent = finished.length;
  $('piecesTotal').textContent = finished.reduce((s, f) => s + (f.pieces || 0), 0);
}

// ---------- Add item bar ----------
$('addItemBar').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = String(f.get('name')).trim();
  const id = slug(name);
  try {
    if (f.get('type') === 'raw') {
      const rollMetres = Number(f.get('rollMetres'));
      if (!rollMetres) return showMsg('Enter the metres per roll for a raw item.');
      const addMetres = Number(f.get('openingRolls') || 0) * rollMetres;
      const ref = doc(db, 'raw', id);
      const snap = await getDoc(ref);
      const current = snap.exists() ? snap.data().stockMetres : 0;
      await setDoc(ref, {
        name,
        gsm: String(f.get('gsm') || ''),
        rollMetres,
        stockMetres: current + addMetres
      }, { merge: true });
    } else {
      const addPieces = Number(f.get('openingPieces') || 0);
      const ref = doc(db, 'finished', id);
      const snap = await getDoc(ref);
      const current = snap.exists() ? snap.data().pieces : 0;
      await setDoc(ref, { name, pieces: current + addPieces }, { merge: true });
    }
    e.target.reset();
    showMsg('Item saved.', true);
  } catch (err) {
    showMsg('Could not save: ' + err.message);
  }
};

// ---------- Produce (automatic raw deduction) ----------
// Metres of a raw roll used to make `pieces` finished pieces.
function metresNeeded(line, rollMetres, pieces) {
  return (pieces / line.piecesPerRoll) * rollMetres;
}

async function produce(product, pieces, wasteMetres) {
  const recipe = RECIPES[product];
  if (!recipe || recipe.length === 0) {
    throw new Error(`No recipe set for ${product} yet.`);
  }
  const finRef = doc(db, 'finished', slug(product));

  await runTransaction(db, async tx => {
    const finSnap = await tx.get(finRef);
    const rawSnaps = await Promise.all(recipe.map(line => tx.get(doc(db, 'raw', slug(line.raw)))));

    const usage = recipe.map((line, i) => {
      const rs = rawSnaps[i];
      if (!rs.exists()) throw new Error(`Raw item not found: ${line.raw}. Add it first.`);
      const d = rs.data();
      const used = metresNeeded(line, d.rollMetres, pieces) + (i === 0 ? wasteMetres : 0);
      if (d.stockMetres + 1e-9 < used) {
        throw new Error(`Not enough ${line.raw}: need ${used.toFixed(2)} m, have ${d.stockMetres.toFixed(2)} m.`);
      }
      return { ref: rs.ref, name: line.raw, used, newStock: d.stockMetres - used };
    });

    usage.forEach(u => tx.update(u.ref, { stockMetres: u.newStock }));

    tx.set(finRef, {
      name: product,
      pieces: (finSnap.exists() ? finSnap.data().pieces : 0) + pieces
    }, { merge: true });

    tx.set(doc(collection(db, 'productions')), {
      product,
      pieces,
      wasteMetres,
      rawUsed: usage.map(u => ({ raw: u.name, metres: Number(u.used.toFixed(2)) })),
      by: auth.currentUser.email,
      createdAt: serverTimestamp()
    });
  });
}

$('produceForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const product = f.get('product');
  const pieces = Number(f.get('pieces'));
  const waste = Number(f.get('waste') || 0);
  try {
    await produce(product, pieces, waste);
    e.target.reset();
    showMsg(`Produced ${pieces} × ${product}. Raw stock updated.`, true);
  } catch (err) {
    showMsg(err.message);
  }
};
