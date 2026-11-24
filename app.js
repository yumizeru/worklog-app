'use strict';
/* =====================================================================
 * ワンタッチ報告
 *  - 作業する人：ボタン1つで開始・終了を記録（時刻・位置・現場・写真）
 *  - 管理者：今だれが作業中か、日ごとの履歴、開始・終了の通知
 *  データは Supabase（ワンタッチ報告専用のプロジェクト。ひびログとはログインも別）
 * ===================================================================== */
const SUPABASE_URL = 'https://jwrtsrmkrcqgogtebcjf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_R3NQrdZ2vcIU4wnHFjtjCg_hDajqbRN';
const VAPID_PUBLIC_KEY = 'BO4espzceP3Rb2WQI8nK_uxSwQYSHUQByFTEhA2gbsCGIEZOa7jK2_IDJgsyq3W2hxmRm0BIxswAaRdFqtYPTlE';
const NOTIFY_URL = `${SUPABASE_URL}/functions/v1/wl-notify`;
const APP_URL = 'https://yumizeru.github.io/worklog-app/';
const LAST_SITE_KEY = 'worklog:lastSite';
const HINT_KEY = 'worklog:hintHidden';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// パスワード再設定メールのリンクから来たか（URLの # に type=recovery が付く）
const urlHash = new URLSearchParams(location.hash.slice(1));
const fromRecovery = urlHash.get('type') === 'recovery';
const linkError = urlHash.get('error_code');

// 保存名は v6 で変更（前のプロジェクトのログイン情報を使わない）
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'worklog-auth-v2' },
});

const state = {
  session: null,
  me: null,        // wl_members の自分の行
  org: null,
  sites: [],
  members: [],
  myLast: null,    // 自分の最後の打刻
  photo: null,     // 付ける写真（Blob）
  view: 'vPunch',
};

/* ---------- 小物 ---------- */
const p2 = n => String(n).padStart(2, '0');
const hm = d => { d = new Date(d); return `${d.getHours()}:${p2(d.getMinutes())}`; };
const ymd = d => { d = new Date(d); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const mdText = d => { d = new Date(d); return `${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}）`; };
const startOfDay = d => { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };
function dur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}時間${m % 60}分` : `${m}分`;
}
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const ERRORS = {
  'Invalid login credentials': 'メールアドレスかパスワードが違います',
  'User already registered': 'このメールアドレスはもう登録されています。「ログイン」から入ってください',
  bad_code: '招待コードが見つかりません。もう一度確かめてください',
  already_member: 'すでに会社に参加しています',
  not_member: '会社に参加していないか、停止されています。管理者に確認してください',
  last_admin: '管理者が1人もいなくなるため、変更できません',
  bad_site: 'その現場は見つかりません。画面を更新してください',
  not_admin: '管理者だけができる操作です',
};
function errText(e) {
  const m = (e && (e.message || e.error_description || e.error)) || String(e);
  for (const k of Object.keys(ERRORS)) if (m.includes(k)) return ERRORS[k];
  if (/Failed to fetch|NetworkError|network/i.test(m)) return '通信できませんでした。電波のよい所でもう一度押してください';
  if (/Password should be/i.test(m)) return 'パスワードは6文字以上にしてください';
  if (/different from the old/i.test(m)) return '前と違うパスワードにしてください';
  if (/rate limit|security purposes/i.test(m)) return '少し時間をおいてから、もう一度送ってください';
  if (/valid email|invalid format/i.test(m)) return 'メールアドレスの形が正しくありません';
  return m;
}
function show(id) {
  $$('.view').forEach(v => { v.hidden = v.id !== id; });
  const inApp = ['vPunch', 'vStatus', 'vHistory', 'vSettings'].includes(id);
  $('#tabs').hidden = !inApp;
  if (inApp) {
    state.view = id;
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === id));
    $('#title').textContent = { vPunch: '打刻', vStatus: '状況', vHistory: '履歴', vSettings: '設定' }[id];
  } else {
    $('#title').textContent = 'ワンタッチ報告';
  }
  window.scrollTo(0, 0);
}

/* =====================================================================
 * ログイン・登録
 * ===================================================================== */
function setMode(prefix, mode) {
  $(`#${prefix}CodeRow`).hidden = mode !== 'join';
  $(`#${prefix}OrgRow`).hidden = mode !== 'create';
  $(`#${prefix}Code`).required = mode === 'join';
  $(`#${prefix}Org`).required = mode === 'create';
}
$$('[data-auth]').forEach(b => b.addEventListener('click', () => {
  $$('[data-auth]').forEach(x => x.classList.toggle('on', x === b));
  $('#loginForm').hidden = b.dataset.auth !== 'login';
  $('#signupForm').hidden = b.dataset.auth !== 'signup';
  $('#forgotForm').hidden = true;
  $('#authMsg').textContent = '';
  $('#authMsg').classList.remove('ok');
}));

/* ---------- パスワードを忘れたとき ---------- */
function showForgot(on) {
  $('#loginForm').hidden = on;
  $('#forgotForm').hidden = !on;
  $('#authMsg').textContent = '';
  $('#authMsg').classList.remove('ok');
  if (on) { $('#fgEmail').value = $('#liEmail').value.trim(); $('#fgEmail').focus(); }
}
$('#forgotOpen').addEventListener('click', () => showForgot(true));
$('#forgotClose').addEventListener('click', () => showForgot(false));
$('#forgotForm').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.submitter || $('#forgotForm button'), async () => {
    const msg = $('#authMsg');
    msg.textContent = '';
    msg.classList.remove('ok');
    const { error } = await sb.auth.resetPasswordForEmail($('#fgEmail').value.trim(), { redirectTo: APP_URL });
    if (error) { msg.textContent = errText(error); return; }
    msg.textContent = 'メールを送りました。届いたメールのリンクを、このスマホで開いてください（届かないときは迷惑メールも見てください）';
    msg.classList.add('ok');
  });
});

$('#resetForm').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.submitter || $('#resetForm button'), async () => {
    const msg = $('#resetMsg');
    msg.textContent = '';
    if ($('#rsPass').value !== $('#rsPass2').value) { msg.textContent = '2つのパスワードが違います'; return; }
    const { error } = await sb.auth.updateUser({ password: $('#rsPass').value });
    if (error) { msg.textContent = errText(error); return; }
    $('#rsPass').value = $('#rsPass2').value = '';
    await boot();
    toast('パスワードを変更しました');
  });
});
$$('input[name=suMode]').forEach(r => r.addEventListener('change', () => setMode('su', r.value)));
$$('input[name=jnMode]').forEach(r => r.addEventListener('change', () => setMode('jn', r.value)));

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

$('#loginForm').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.submitter || $('#loginForm button'), async () => {
    $('#authMsg').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: $('#liEmail').value.trim(), password: $('#liPass').value });
    if (error) { $('#authMsg').textContent = errText(error); return; }
    await boot();
  });
});

async function joinOrCreate(mode, name, code, orgName) {
  if (mode === 'create') {
    const { error } = await sb.rpc('wl_create_org', { p_org_name: orgName, p_display_name: name });
    if (error) throw error;
  } else {
    const { error } = await sb.rpc('wl_join_org', { p_code: code, p_display_name: name });
    if (error) throw error;
    notifyAdmins({ joined: true });
  }
}

$('#signupForm').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.submitter || $('#signupForm button'), async () => {
    const msg = $('#authMsg');
    msg.textContent = '';
    const name = $('#suName').value.trim();
    const mode = $('input[name=suMode]:checked').value;
    if (!name) { msg.textContent = '名前を入れてください'; return; }
    const { data, error } = await sb.auth.signUp({
      email: $('#suEmail').value.trim(),
      password: $('#suPass').value,
      options: { data: { display_name: name } },
    });
    if (error) { msg.textContent = errText(error); return; }
    if (!data.session) {
      msg.textContent = '確認メールを送りました。メールのリンクを開いてから「ログイン」してください';
      msg.classList.add('ok');
      return;
    }
    try {
      await joinOrCreate(mode, name, $('#suCode').value, $('#suOrg').value.trim());
    } catch (err) {
      // 登録はできたので、続きの画面で直してもらう
      await boot();
      $('#joinMsg').textContent = errText(err);
      return;
    }
    await boot();
    toast(mode === 'create' ? '会社を作りました。設定から招待コードを送れます' : '参加しました');
  });
});

$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.submitter || $('#joinForm button'), async () => {
    $('#joinMsg').textContent = '';
    const name = $('#jnName').value.trim();
    if (!name) { $('#joinMsg').textContent = '名前を入れてください'; return; }
    const mode = $('input[name=jnMode]:checked').value;
    try {
      await joinOrCreate(mode, name, $('#jnCode').value, $('#jnOrg').value.trim());
    } catch (err) { $('#joinMsg').textContent = errText(err); return; }
    await boot();
  });
});

document.addEventListener('click', async e => {
  if (!e.target.closest('[data-logout]')) return;
  if (!confirm('ログアウトしますか？')) return;
  await Push.disable().catch(() => {});
  await sb.auth.signOut();
  location.reload();
});

/* =====================================================================
 * 起動
 * ===================================================================== */
async function loadMe() {
  const uid = state.session.user.id;
  const { data: me, error } = await sb.from('wl_members').select('*').eq('user_id', uid).maybeSingle();
  if (error) throw error;
  state.me = me;
  if (!me) return;
  const [org, sites] = await Promise.all([
    sb.from('wl_orgs').select('*').eq('id', me.org_id).maybeSingle(),
    sb.from('wl_sites').select('*').eq('org_id', me.org_id).order('sort').order('created_at'),
  ]);
  if (org.error) throw org.error;
  if (sites.error) throw sites.error;
  state.org = org.data;
  state.sites = sites.data || [];
  if (me.role === 'admin') {
    const { data: ms, error: me2 } = await sb.from('wl_members').select('*').eq('org_id', me.org_id).order('created_at');
    if (me2) throw me2;
    state.members = ms || [];
  } else {
    state.members = [me];
  }
}

async function boot() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (!state.session) { show('vAuth'); return; }
  try {
    await loadMe();
  } catch (e) {
    show('vLoading');
    $('#vLoading p').textContent = `読み込めませんでした：${errText(e)}`;
    return;
  }
  if (!state.me) {
    const meta = state.session.user.user_metadata || {};
    if (!$('#jnName').value) $('#jnName').value = meta.display_name || '';
    show('vJoin');
    return;
  }
  if (!state.me.active) {
    show('vLoading');
    $('#vLoading p').innerHTML = '管理者によって停止されています。<br><button class="btn link" data-logout>ログアウト</button>';
    return;
  }
  document.body.classList.toggle('is-admin', state.me.role === 'admin');
  $('#who').textContent = `${state.me.display_name}${state.me.role === 'admin' ? '（管理者）' : ''}`;
  renderSettings();
  show(state.view);
  await refreshView();
}

/* =====================================================================
 * 打刻
 * ===================================================================== */
async function loadMyToday() {
  const uid = state.session.user.id;
  const [last, today] = await Promise.all([
    sb.from('wl_punches').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(1),
    sb.from('wl_punches').select('*').eq('user_id', uid).gte('created_at', startOfDay(new Date()).toISOString())
      .order('created_at', { ascending: false }),
  ]);
  if (last.error) throw last.error;
  if (today.error) throw today.error;
  state.myLast = (last.data || [])[0] || null;
  return today.data || [];
}

function working() { return state.myLast && state.myLast.kind === 'start'; }

function renderPunchState() {
  const w = working();
  const card = $('#stateCard');
  card.classList.toggle('working', !!w);
  if (w) {
    const st = new Date(state.myLast.created_at);
    const sameDay = ymd(st) === ymd(new Date());
    $('#stateLabel').textContent = '作業中';
    $('#stateSub').textContent = `${state.myLast.site_name ? state.myLast.site_name + '・' : ''}${sameDay ? '' : mdText(st) + ' '}${hm(st)}から（${dur(Date.now() - st)}）`;
  } else {
    $('#stateLabel').textContent = '作業していません';
    $('#stateSub').textContent = state.myLast ? `前回の終了：${mdText(state.myLast.created_at)} ${hm(state.myLast.created_at)}` : 'はじめての記録です';
  }
  const btn = $('#punchBtn');
  btn.className = `punch ${w ? 'end' : 'start'}`;
  btn.querySelector('svg')?.remove();
  btn.insertAdjacentHTML('afterbegin', icon(w ? 'square' : 'play'));
  $('#punchText').textContent = w ? '作業終了' : '作業開始';

  // 現場は開始のときだけ。登録済みから選ぶか、自分で入力する
  const active = state.sites.filter(s => s.active);
  $('#siteRow').hidden = w;
  const sel = $('#siteSel');
  const keep = sel.value || ls.get(LAST_SITE_KEY);
  sel.innerHTML = '<option value="">選んでください</option>' +
    active.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('') +
    `<option value="${FREE}">その他（自分で入力する）</option>`;
  sel.value = active.some(s => s.id === keep) || keep === FREE ? keep : '';
  $('#siteSel').hidden = $('#siteSelLabel').hidden = !active.length;
  $('#siteHistory').innerHTML = siteHistory().map(n => `<option value="${esc(n)}"></option>`).join('');
  syncSiteText();
}
// 自分で入力した現場名（新しい順に10件まで、この端末に覚える）
const FREE = '__free';
const SITE_HISTORY_KEY = 'worklog:siteHistory';
function siteHistory() {
  try { const a = JSON.parse(ls.get(SITE_HISTORY_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; }
}
function rememberSite(name) {
  ls.set(SITE_HISTORY_KEY, JSON.stringify([name, ...siteHistory().filter(n => n !== name)].slice(0, 10)));
}
// 登録済みの現場がないとき、または「その他」を選んだときだけ入力欄を出す
function freeMode() { return $('#siteSel').hidden || $('#siteSel').value === FREE; }
function syncSiteText() {
  const free = freeMode();
  $('#siteText').hidden = !free;
  $('#siteTextLabel').hidden = !free;
  $('#siteTextLabel').firstChild.textContent = $('#siteSel').hidden ? '現場名' : '現場名を入力';
}
$('#siteSel').addEventListener('change', () => {
  syncSiteText();
  if ($('#siteSel').value === FREE) $('#siteText').focus();
});

function recItem(p, opts = {}) {
  const map = p.lat != null
    ? `<a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noopener">${icon('map-pin')}地図${p.accuracy ? `（誤差${Math.round(p.accuracy)}m）` : ''}</a>`
    : `<span>${icon('map-pin')}位置なし${p.geo_error ? `（${esc(p.geo_error)}）` : ''}</span>`;
  const thumb = p.photo_path ? `<img class="thumb" data-photo="${esc(p.photo_path)}" alt="写真" loading="lazy">` : '';
  return `<li><div class="rec">
    <div class="time">${hm(p.created_at)}</div>
    <div class="body">
      <div><span class="tag ${p.kind}">${p.kind === 'start' ? '開始' : '終了'}</span>
        ${opts.name ? `<b>${esc(p.display_name)}</b>` : ''} ${p.site_name ? esc(p.site_name) : ''}</div>
      <div class="meta">${map}${opts.extra || ''}</div>
    </div>${thumb}</div></li>`;
}

// 写真は非公開の置き場にあるので、見るときだけ期限付きURLをもらう
const photoUrls = new Map();
async function photoUrl(path) {
  const c = photoUrls.get(path);
  if (c && c.exp > Date.now()) return c.url;
  const { data, error } = await sb.storage.from('wl-photos').createSignedUrl(path, 3600);
  if (error) throw error;
  photoUrls.set(path, { url: data.signedUrl, exp: Date.now() + 55 * 60 * 1000 });
  return data.signedUrl;
}
function hydratePhotos(root) {
  root.querySelectorAll('img[data-photo]').forEach(img => {
    photoUrl(img.dataset.photo).then(u => { img.src = u; }).catch(() => { img.alt = '写真を読み込めません'; });
  });
}
document.addEventListener('click', e => {
  const img = e.target.closest('img[data-photo]');
  if (!img || !img.src) return;
  openDetail('写真', `<img class="full" src="${esc(img.src)}" alt="写真">`);
});

async function renderPunch() {
  const list = await loadMyToday();
  renderPunchState();
  const ul = $('#todayList');
  ul.innerHTML = list.length ? list.map(p => recItem(p)).join('') : '<li class="empty">まだ記録はありません</li>';
  hydratePhotos(ul);
  renderInstallHint();
}

// 位置情報（取れなくても記録は止めない）
function getPosition() {
  return new Promise(resolve => {
    if (!('geolocation' in navigator)) { resolve({ error: '端末が非対応' }); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      err => resolve({ error: err.code === 1 ? '許可されていません' : err.code === 3 ? '時間切れ' : '取得できません' }),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  });
}

// 写真は長い辺1280pxのJPEGに縮める（通信量を減らす）
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
  } finally { URL.revokeObjectURL(url); }
}
$('#photoInput').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    state.photo = await shrinkPhoto(f);
    $('#photoImg').src = URL.createObjectURL(state.photo);
    $('#photoPreview').hidden = false;
    $('#photoBtn span').textContent = '写真を撮り直す';
  } catch { toast('写真を読み込めませんでした'); }
});
function clearPhoto() {
  state.photo = null;
  $('#photoPreview').hidden = true;
  $('#photoBtn span').textContent = '写真を付ける';
}
$('#photoClear').addEventListener('click', clearPhoto);

$('#punchBtn').addEventListener('click', async () => {
  const btn = $('#punchBtn');
  if (btn.disabled) return;
  const kind = working() ? 'end' : 'start';
  let siteId = null, siteName = null;
  if (kind === 'start') {
    if (freeMode()) {
      siteName = $('#siteText').value.replace(/\s+/g, ' ').trim();
      if (!siteName) { toast('先に現場名を入力してください'); $('#siteText').focus(); return; }
    } else {
      siteId = $('#siteSel').value;
      if (!siteId) { toast('先に現場・作業を選んでください'); $('#siteSel').focus(); return; }
    }
  }
  btn.disabled = true;
  $('#punchText').textContent = '記録中…';
  try {
    const pos = await getPosition();
    let photoPath = null;
    if (state.photo) {
      $('#punchText').textContent = '写真を送信中…';
      photoPath = `${state.me.org_id}/${state.me.user_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error: ue } = await sb.storage.from('wl-photos').upload(photoPath, state.photo, { contentType: 'image/jpeg' });
      if (ue) throw ue;
    }
    const { data, error } = await sb.rpc('wl_record', {
      p_kind: kind, p_site: siteId || null, p_site_name: siteName,
      p_lat: pos.lat ?? null, p_lng: pos.lng ?? null, p_accuracy: pos.accuracy ?? null,
      p_geo_error: pos.error ?? null, p_photo: photoPath,
    });
    if (error) throw error;
    if (kind === 'start') ls.set(LAST_SITE_KEY, siteId || FREE);
    if (siteName) rememberSite(siteName);
    // 終了したら現場の選択・入力を空に戻す（次の現場で入れ直す）
    if (kind === 'end') {
      try { localStorage.removeItem(LAST_SITE_KEY); } catch {}
      $('#siteText').value = '';
      $('#siteSel').value = '';
    }
    clearPhoto();
    notifyAdmins({ punch_id: data.id });
    toast(`${kind === 'start' ? '開始' : '終了'}を記録しました（${hm(data.created_at)}）${pos.error ? '／位置：' + pos.error : ''}`, 3500);
    if (navigator.vibrate) navigator.vibrate(60);
  } catch (e) {
    toast(`記録できませんでした：${errText(e)}`, 5000);
  } finally {
    btn.disabled = false;
    await renderPunch().catch(() => renderPunchState());
  }
});

// 管理者への通知（打刻・新しいメンバーの参加。失敗しても記録には影響しない）
async function notifyAdmins(payload) {
  try {
    const { data } = await sb.auth.getSession();
    await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}`, apikey: SUPABASE_KEY },
      body: JSON.stringify(payload),
    });
  } catch {}
}

// 経過時間を更新
setInterval(() => { if (!document.hidden && state.view === 'vPunch' && state.me) renderPunchState(); }, 30000);

/* ---------- ホーム画面に追加の案内 ---------- */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function renderInstallHint() {
  const mobile = isIOS || /Android/.test(navigator.userAgent);
  $('#installHint').hidden = standalone || !mobile || ls.get(HINT_KEY) === '1';
  $('#installHow').textContent = isIOS
    ? 'Safariの共有ボタン（四角から矢印）→「ホーム画面に追加」'
    : 'Chromeの右上︙ →「ホーム画面に追加」または「アプリをインストール」';
}
$('#installHide').addEventListener('click', () => { ls.set(HINT_KEY, '1'); $('#installHint').hidden = true; });

/* =====================================================================
 * 状況（管理者）
 * ===================================================================== */
async function renderStatus() {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb.from('wl_punches').select('*').eq('org_id', state.me.org_id)
    .gte('created_at', since).order('created_at', { ascending: false }).limit(1000);
  if (error) throw error;
  const latest = new Map();
  for (const p of data || []) if (!latest.has(p.user_id)) latest.set(p.user_id, p);
  const today = ymd(new Date());
  const rows = state.members.filter(m => m.active).map(m => ({ m, p: latest.get(m.user_id) }));
  // 作業中の人を上に
  rows.sort((a, b) => (b.p?.kind === 'start') - (a.p?.kind === 'start') || (b.p ? +new Date(b.p.created_at) : 0) - (a.p ? +new Date(a.p.created_at) : 0));
  const on = rows.filter(r => r.p?.kind === 'start').length;
  $('#statusTime').textContent = `作業中 ${on}人 / ${rows.length}人（${hm(new Date())} 時点）`;
  $('#statusList').innerHTML = rows.map(({ m, p }) => {
    const w = p?.kind === 'start';
    let sub = '直近3日の記録なし';
    if (p) {
      const day = ymd(p.created_at) === today ? '' : mdText(p.created_at) + ' ';
      sub = w ? `${p.site_name ? p.site_name + '・' : ''}${day}${hm(p.created_at)}から（${dur(Date.now() - new Date(p.created_at))}）`
        : `${day}${hm(p.created_at)}に終了`;
    }
    return `<li class="tap" data-member="${m.user_id}"><div class="person">
      <span class="dot ${w ? 'on' : ''}"></span>
      <div class="grow"><div class="name">${esc(m.display_name)}</div><div class="muted small">${esc(sub)}</div></div>
      <span class="tag ${w ? 'start' : 'off'}">${w ? '作業中' : '—'}</span>${icon('chevron-right')}
    </div></li>`;
  }).join('') || '<li class="empty">メンバーがいません。設定の「招待コード」から招待してください</li>';
}
$('#statusList').addEventListener('click', e => {
  const li = e.target.closest('[data-member]');
  if (!li) return;
  $('#hMember').value = li.dataset.member;
  $('#hDate').value = ymd(new Date());
  show('vHistory');
  refreshView();
});
$('#statusReload').addEventListener('click', () => refreshView());

/* =====================================================================
 * 履歴
 * ===================================================================== */
function fillMemberFilter() {
  const sel = $('#hMember');
  const keep = sel.value;
  sel.innerHTML = '<option value="">全員</option>' + state.members.map(m => `<option value="${m.user_id}">${esc(m.display_name)}${m.active ? '' : '（停止中）'}</option>`).join('');
  sel.value = state.members.some(m => m.user_id === keep) ? keep : '';
}
async function renderHistory() {
  const admin = state.me.role === 'admin';
  $('#hMemberRow').hidden = !admin;
  if (!$('#hDate').value) $('#hDate').value = ymd(new Date());
  const [y, mo, d] = $('#hDate').value.split('-').map(Number);
  const from = new Date(y, mo - 1, d), to = new Date(y, mo - 1, d + 1);
  let q = sb.from('wl_punches').select('*').eq('org_id', state.me.org_id)
    .gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).order('created_at');
  const uid = admin ? $('#hMember').value : state.session.user.id;
  if (uid) q = q.eq('user_id', uid);
  const { data, error } = await q.limit(2000);
  if (error) throw error;
  const list = data || [];

  // 人ごとの作業時間（開始→終了の組。日をまたぐ作業は終了の日だけ数えない）
  const per = new Map();
  for (const p of list) {
    const r = per.get(p.user_id) || { name: p.display_name, ms: 0, open: null };
    if (p.kind === 'start') r.open = p;
    else if (r.open) { r.ms += new Date(p.created_at) - new Date(r.open.created_at); r.open = null; }
    per.set(p.user_id, r);
  }
  const sum = $('#hSummary');
  sum.hidden = !per.size;
  sum.innerHTML = [...per.values()].map(r =>
    `<div><b>${esc(r.name)}</b>：${dur(r.ms)}${r.open ? `（${hm(r.open.created_at)}から作業中・未終了）` : ''}</div>`).join('');

  const ul = $('#historyList');
  ul.innerHTML = list.length ? list.slice().reverse().map(p => recItem(p, { name: admin })).join('')
    : `<li class="empty">${mdText(from)}の記録はありません</li>`;
  hydratePhotos(ul);
}
$('#hDate').addEventListener('change', () => refreshView());
$('#hMember').addEventListener('change', () => refreshView());

/* =====================================================================
 * 設定
 * ===================================================================== */
function renderSettings() {
  const me = state.me;
  $('#myName').value = me.display_name;
  $('#myEmail').textContent = state.session.user.email || '';
  $('#sumAccount').textContent = me.display_name;
  $('#orgName').textContent = state.org ? state.org.name : '';
  $('#sumAbout').textContent = `バージョン ${Updater.version}`;
  if (me.role !== 'admin') return;
  $('#inviteCode').textContent = state.org.invite_code;
  $('#sumCode').textContent = state.org.invite_code;
  const actives = state.sites.filter(s => s.active).length;
  $('#sumSites').textContent = state.sites.length ? `${actives}件` : 'まだありません';
  $('#siteList').innerHTML = state.sites.map(s => `<li data-site="${s.id}">
      <span class="grow">${esc(s.name)} ${s.active ? '' : '<span class="tag off">非表示</span>'}</span>
      <button class="btn small ghost" data-act="rename">${icon('pencil')}名前</button>
      <button class="btn small ghost" data-act="toggle">${s.active ? '隠す' : '戻す'}</button>
    </li>`).join('') || '<li class="empty">まだありません</li>';
  const n = state.members.filter(m => m.active).length;
  $('#sumMembers').textContent = `${n}人`;
  const myId = state.session.user.id;
  $('#memberList').innerHTML = state.members.map(m => `<li data-uid="${m.user_id}">
      <span class="grow"><b>${esc(m.display_name)}</b>${m.user_id === myId ? '（自分）' : ''}
        ${m.role === 'admin' ? '<span class="tag admin">管理者</span>' : ''} ${m.active ? '' : '<span class="tag off">停止中</span>'}</span>
      <button class="btn small ghost" data-act="role">${m.role === 'admin' ? '管理者を外す' : '管理者にする'}</button>
      <button class="btn small ghost" data-act="active">${m.active ? '停止' : '再開'}</button>
    </li>`).join('');
  fillMemberFilter();
  Push.render();
}

$('#saveName').addEventListener('click', e => busy(e.currentTarget, async () => {
  const name = $('#myName').value.trim();
  if (!name) { toast('名前を入れてください'); return; }
  const { error } = await sb.rpc('wl_set_my_name', { p_name: name });
  if (error) { toast(errText(error)); return; }
  await boot();
  toast('名前を保存しました');
}));

$('#copyInvite').addEventListener('click', async () => {
  const text = `作業報告アプリ「ワンタッチ報告」への招待です。\n1. ${APP_URL} を開く\n2.「はじめて使う」を押す\n3. 名前（フルネーム）・メール・パスワードを入れ、招待コード ${state.org.invite_code} を入れて登録\nホーム画面に追加すると1タップで開けます。`;
  try {
    if (navigator.share && /iPhone|Android/.test(navigator.userAgent)) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('案内文をコピーしました'); }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    prompt('この文をコピーしてください', text);
  }
});
$('#rotateCode').addEventListener('click', e => busy(e.currentTarget, async () => {
  if (!confirm('招待コードを作り直しますか？古いコードは使えなくなります。')) return;
  const { data, error } = await sb.rpc('wl_rotate_code');
  if (error) { toast(errText(error)); return; }
  state.org.invite_code = data;
  renderSettings();
  toast('新しいコードにしました');
}));

$('#siteForm').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.submitter || $('#siteForm button'), async () => {
    const name = $('#siteName').value.trim();
    if (!name) return;
    const { error } = await sb.from('wl_sites').insert({ org_id: state.me.org_id, name, sort: state.sites.length });
    if (error) { toast(errText(error)); return; }
    $('#siteName').value = '';
    await loadMe(); renderSettings();
    toast('追加しました');
  });
});
$('#siteList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const s = state.sites.find(x => x.id === b.closest('[data-site]').dataset.site);
  let patch;
  if (b.dataset.act === 'rename') {
    const name = (prompt('現場・作業の名前', s.name) || '').trim();
    if (!name || name === s.name) return;
    patch = { name };
  } else patch = { active: !s.active };
  const { error } = await sb.from('wl_sites').update(patch).eq('id', s.id);
  if (error) { toast(errText(error)); return; }
  await loadMe(); renderSettings();
});
$('#memberList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const m = state.members.find(x => x.user_id === b.closest('[data-uid]').dataset.uid);
  let patch, ask;
  if (b.dataset.act === 'role') {
    patch = { role: m.role === 'admin' ? 'staff' : 'admin' };
    ask = m.role === 'admin' ? `${m.display_name}さんを管理者から外しますか？` : `${m.display_name}さんを管理者にしますか？全員の記録が見られるようになります。`;
  } else {
    patch = { active: !m.active };
    ask = m.active ? `${m.display_name}さんを停止しますか？記録できなくなります（過去の記録は残ります）。` : `${m.display_name}さんを再開しますか？`;
  }
  if (!confirm(ask)) return;
  const { error } = await sb.from('wl_members').update(patch).eq('org_id', m.org_id).eq('user_id', m.user_id);
  if (error) { toast(errText(error)); return; }
  await boot();
});

// 開いた項目以外は閉じる（画面をすっきりさせる）
$$('#vSettings details.acc').forEach(d => d.addEventListener('toggle', () => {
  if (d.open) $$('#vSettings details.acc[open]').forEach(x => { if (x !== d) x.open = false; });
}));

/* =====================================================================
 * 通知（管理者の端末で受け取る）
 * ===================================================================== */
const Push = (() => {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  const current = async () => (supported ? (await navigator.serviceWorker.ready).pushManager.getSubscription() : null);

  async function enable() {
    if (await Notification.requestPermission() !== 'granted') throw new Error('通知が許可されませんでした。端末の設定から許可してください');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await sb.from('wl_push_subs').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    if (error) throw error;
  }
  async function disable() {
    const sub = await current();
    if (!sub) return;
    if (state.session) await sb.from('wl_push_subs').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe().catch(() => {});
  }
  async function test() {
    const { data } = await sb.auth.getSession();
    const r = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}`, apikey: SUPABASE_KEY },
      body: JSON.stringify({ test: true }),
    });
    const b = await r.json().catch(() => ({}));
    if (!b.ok) throw new Error(b.error === 'no_device' ? 'この端末が登録されていません' : (b.error || `HTTP ${r.status}`));
  }
  async function render() {
    const set = (on, off, t, sum, msg) => {
      $('#pushOn').hidden = !on; $('#pushOff').hidden = !off; $('#pushTest').hidden = !t;
      $('#sumPush').textContent = sum; $('#pushStatus').textContent = msg;
    };
    if (!supported || (isIOS && !standalone)) {
      set(false, false, false, '使えません（くわしくはタップ）', isIOS
        ? '通知を使うには、Safariの共有ボタン →「ホーム画面に追加」で追加したアプリから開いてください（iOS 16.4以降）。'
        : 'このブラウザは通知に対応していません。Chromeで開いてください。');
      return;
    }
    const sub = await current().catch(() => null);
    if (sub && Notification.permission === 'granted') set(false, true, true, 'この端末でオン', 'この端末に通知が届きます。');
    else set(true, false, false, 'オフ', Notification.permission === 'denied' ? '通知がブロックされています。端末の設定でこのアプリの通知を許可してください。' : '');
  }
  $('#pushOn').addEventListener('click', e => busy(e.currentTarget, async () => {
    try { await enable(); toast('通知をオンにしました'); } catch (err) { toast(errText(err), 5000); }
    render();
  }));
  $('#pushOff').addEventListener('click', e => busy(e.currentTarget, async () => { await disable(); render(); toast('通知をオフにしました'); }));
  $('#pushTest').addEventListener('click', e => busy(e.currentTarget, async () => {
    try { await test(); toast('テスト通知を送りました'); } catch (err) { toast(errText(err), 5000); }
  }));
  return { render, disable };
})();

/* =====================================================================
 * 画面の切り替え・ダイアログ
 * ===================================================================== */
async function refreshView() {
  if (!state.me) return;
  try {
    if (state.view === 'vPunch') await renderPunch();
    else if (state.view === 'vStatus') await renderStatus();
    else if (state.view === 'vHistory') await renderHistory();
    else if (state.view === 'vSettings') renderSettings();
  } catch (e) { toast(`読み込めませんでした：${errText(e)}`, 4000); }
}
$$('#tabs button').forEach(b => b.addEventListener('click', () => { show(b.dataset.view); refreshView(); }));

function openDetail(title, html) {
  $('#detailTitle').textContent = title;
  $('#detailBody').innerHTML = html;
  $('#detail').showModal();
}
$('#detailClose').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', e => { if (e.target === $('#detail')) $('#detail').close(); });

// 戻ってきたら最新にする（状況は30秒ごとにも更新）
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshView(); Updater.check(); } });
setInterval(() => { if (!document.hidden && state.view === 'vStatus') refreshView(); }, 30000);

/* =====================================================================
 * 更新（新しい版を公開したら自動で読み直す）
 *  版を上げるときは index.html の app-version・version.json・sw.js の VERSION をそろえる
 * ===================================================================== */
const Updater = (() => {
  const meta = document.querySelector('meta[name="app-version"]');
  const version = meta ? meta.content : '0';
  const FLAG = 'worklog:updatedAt';
  let reg = null, busyU = false;
  async function check(manual) {
    if (busyU || location.protocol === 'file:') return;
    try {
      const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      const v = String((await r.json()).version);
      if (v === version) { if (manual) toast('最新版です'); return; }
      const last = Number(sessionStorage.getItem(FLAG)) || 0;
      if (!manual && Date.now() - last < 5 * 60 * 1000) return;
      busyU = true;
      toast('新しいバージョンに更新しています…');
      try { sessionStorage.setItem(FLAG, String(Date.now())); } catch {}
      try { if (reg) await reg.update(); } catch {}
      try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch {}
      setTimeout(() => location.reload(), 700);
    } catch { if (manual) toast('確認できませんでした（オフラインかもしれません）'); }
  }
  function start() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => { reg = r; }).catch(() => {});
    }
    $('#checkUpdate').addEventListener('click', () => check(true));
    check(false);
  }
  return { version, check, start };
})();

hydrateIcons();
setMode('su', 'join');
setMode('jn', 'join');
Updater.start();
sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') { state.session = null; state.me = null; show('vAuth'); } });
(async () => {
  // getSession は URL のリンク情報を読み終えてから返る
  const { data } = await sb.auth.getSession();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (fromRecovery && data.session) { show('vReset'); return; }
  await boot();
  if (linkError) {
    $('#authMsg').textContent = 'リンクの期限が切れています。もう一度「パスワードを忘れた」から送ってください';
  }
})();
