// ワンタッチ作業報告：管理者だけができる操作
//  - { action: 'set_password', user_id, password } → 同じ会社のメンバーのパスワードを決め直す
//    （メールが届かない人のため。管理者が仮のパスワードを決めて本人に伝える）
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await db.auth.getUser(token);
    if (ue || !u.user) return json({ ok: false, error: 'not_logged_in' }, 401);
    const body = await req.json().catch(() => ({}));

    // 呼んだ人が、停止されていない管理者か
    const { data: me, error: me1 } = await db.from('wl_members').select('org_id,role,active')
      .eq('user_id', u.user.id).maybeSingle();
    if (me1) throw me1;
    if (!me || !me.active || me.role !== 'admin') return json({ ok: false, error: 'not_admin' }, 403);

    if (body.action === 'set_password') {
      const target = String(body.user_id ?? '');
      const password = String(body.password ?? '');
      if (target === u.user.id) return json({ ok: false, error: 'use_own_settings' }, 400);
      if (password.length < 6 || password.length > 72) return json({ ok: false, error: 'weak_password' }, 400);
      const { data: m, error: me2 } = await db.from('wl_members').select('org_id')
        .eq('user_id', target).maybeSingle();
      if (me2) throw me2;
      if (!m || m.org_id !== me.org_id) return json({ ok: false, error: 'not_same_org' }, 404);
      const { error: pe } = await db.auth.admin.updateUserById(target, { password });
      if (pe) return json({ ok: false, error: pe.message }, 400);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'bad_request' }, 400);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message ?? String(e) }, 500);
  }
});
