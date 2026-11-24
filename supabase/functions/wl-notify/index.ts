// ワンタッチ作業報告：開始・終了を管理者のスマホに通知する Edge Function
//  - アプリが打刻した直後に { punch_id } で呼ぶ → その会社の管理者全員に通知
//  - 招待コードで参加した直後に { joined: true } で呼ぶ → 管理者に「〇〇さんが参加しました」
//  - { test: true } で呼ぶと、呼んだ本人の端末にテスト通知を送る
//  通知用の鍵はデータベースの wl_secrets にある（サーバーだけが読める）
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = 'https://yumizeru.github.io/worklog-app/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

let vapidReady = false;
async function setupVapid() {
  if (vapidReady) return;
  const { data, error } = await db.from('wl_secrets').select('name,value').in('name', ['vapid_public', 'vapid_private']);
  if (error) throw error;
  const v = Object.fromEntries((data ?? []).map((r) => [r.name, r.value]));
  webpush.setVapidDetails('https://yumizeru.github.io', v.vapid_public, v.vapid_private);
  vapidReady = true;
}

type Sub = { endpoint: string; p256dh: string; auth: string };
async function sendTo(userIds: string[], payload: Record<string, string>) {
  if (!userIds.length) return { ok: 0, errors: [] as string[] };
  const { data, error } = await db.from('wl_push_subs').select('endpoint,p256dh,auth').in('user_id', userIds);
  if (error) throw error;
  let ok = 0;
  const errors: string[] = [];
  await Promise.all(((data ?? []) as Sub[]).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: 'high' },
      );
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('wl_push_subs').delete().eq('endpoint', s.endpoint);
      errors.push(`${code ?? ''} ${(e as Error).message ?? e}`.trim());
    }
  }));
  return { ok, errors };
}

const hm = (iso: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await db.auth.getUser(token);
    if (ue || !u.user) return json({ ok: false, error: 'not_logged_in' }, 401);
    const uid = u.user.id;
    const body = await req.json().catch(() => ({}));
    await setupVapid();

    if (body.test) {
      const r = await sendTo([uid], { title: 'ワンタッチ報告', body: 'テスト通知です。この端末で受け取れます。', tag: 'test', url: APP_URL });
      return json({ ok: r.ok > 0, sent: r.ok, errors: r.errors, error: r.ok ? undefined : 'no_device' });
    }

    // 新しいメンバーが参加した → 管理者に知らせる（参加から10分以内の1回だけ）
    if (body.joined) {
      const { data: m, error: me } = await db.from('wl_members').select('*').eq('user_id', uid).maybeSingle();
      if (me) throw me;
      if (!m) return json({ ok: false, error: 'not_member' }, 404);
      if (Date.now() - new Date(m.created_at).getTime() > 10 * 60 * 1000) return json({ ok: false, error: 'too_old' }, 400);
      const { data: admins, error: ae } = await db.from('wl_members').select('user_id')
        .eq('org_id', m.org_id).eq('role', 'admin').eq('active', true).neq('user_id', uid);
      if (ae) throw ae;
      const { count } = await db.from('wl_members').select('user_id', { count: 'exact', head: true })
        .eq('org_id', m.org_id).eq('active', true);
      const r = await sendTo((admins ?? []).map((a) => a.user_id), {
        title: `${m.display_name}さんが参加しました`,
        body: `メンバーは${count ?? '?'}人になりました（${u.user.email ?? ''}）`,
        tag: `join-${uid}`,
        url: APP_URL,
      });
      return json({ ok: true, sent: r.ok, errors: r.errors });
    }

    const { data: p, error: pe } = await db.from('wl_punches').select('*')
      .eq('id', String(body.punch_id ?? '')).eq('user_id', uid).maybeSingle();
    if (pe) throw pe;
    if (!p) return json({ ok: false, error: 'not_found' }, 404);
    // 古い記録で何度も通知させない
    if (Date.now() - new Date(p.created_at).getTime() > 10 * 60 * 1000) return json({ ok: false, error: 'too_old' }, 400);

    const { data: admins, error: ae } = await db.from('wl_members').select('user_id')
      .eq('org_id', p.org_id).eq('role', 'admin').eq('active', true).neq('user_id', uid);
    if (ae) throw ae;
    const word = p.kind === 'start' ? '開始' : '終了';
    const r = await sendTo((admins ?? []).map((a) => a.user_id), {
      title: `${p.display_name}さんが作業を${word}しました`,
      body: [p.site_name, `${hm(p.created_at)}に${word}`, p.lat != null ? '位置あり' : null, p.photo_path ? '写真あり' : null]
        .filter(Boolean).join('・'),
      tag: `punch-${p.id}`,
      url: APP_URL,
    });
    return json({ ok: true, sent: r.ok, errors: r.errors });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message ?? String(e) }, 500);
  }
});
