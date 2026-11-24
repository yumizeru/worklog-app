"""本物のサーバーで打刻・通知・見える範囲を確かめる（テスト用の会社だけを使う）

使い方:  python tools/e2e.py
必要なもの: 環境変数 SUPABASE_ACCESS_TOKEN（ユーザー単位で保存してあればよい）
 - テスト用アカウントにはパスワードがない。サーバーの管理用の鍵でログイン用リンクを作り、その場でセッションに変える
 - 管理用の鍵は毎回取りに行き、ファイルにも画面にも出さない
 - 最後にテストで作った打刻を消す
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REF = 'jwrtsrmkrcqgogtebcjf'
URL = f'https://{REF}.supabase.co'
PUBLISHABLE = 'sb_publishable_R3NQrdZ2vcIU4wnHFjtjCg_hDajqbRN'
TEST_ORG = '00000000-0000-4000-8000-00000000c1a0'
ADMIN = 'claude-test-admin@worklog.test'
STAFF = 'claude-test-staff@worklog.test'


def access_token():
    t = os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not t and sys.platform == 'win32':
        t = subprocess.run(
            ['powershell', '-NoProfile', '-Command',
             "[Environment]::GetEnvironmentVariable('SUPABASE_ACCESS_TOKEN','User')"],
            capture_output=True, text=True).stdout.strip()
    if not t:
        sys.exit('SUPABASE_ACCESS_TOKEN がありません')
    return t


def call(method, url, headers=None, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Content-Type': 'application/json', 'User-Agent': 'worklog-e2e', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors='replace')


def service_key():
    st, keys = call('GET', f'https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true',
                    {'Authorization': f'Bearer {access_token()}'})
    if st != 200:
        sys.exit(f'管理用の鍵を取れませんでした: {st}')
    for k in keys:
        if k.get('type') == 'secret' or k.get('name') == 'service_role':
            return k['api_key']
    sys.exit('管理用の鍵が見つかりません')


def session_for(email, sk):
    st, link = call('POST', f'{URL}/auth/v1/admin/generate_link',
                    {'apikey': sk, 'Authorization': f'Bearer {sk}'}, {'type': 'magiclink', 'email': email})
    if st != 200:
        sys.exit(f'{email}: リンクを作れませんでした {st} {link}')
    h = link.get('hashed_token') or link.get('properties', {}).get('hashed_token')
    st, ses = call('POST', f'{URL}/auth/v1/verify', {'apikey': PUBLISHABLE},
                   {'type': 'magiclink', 'token_hash': h})
    if st != 200:
        sys.exit(f'{email}: ログインできませんでした {st} {ses}')
    return ses['access_token']


def as_user(tok):
    return {'apikey': PUBLISHABLE, 'Authorization': f'Bearer {tok}'}


results = []


def check(name, ok, detail=''):
    results.append(ok)
    print(('OK  ' if ok else 'NG  ') + name + (f'  ({detail})' if detail and not ok else ''))


def main():
    sk = service_key()
    staff = session_for(STAFF, sk)
    admin = session_for(ADMIN, sk)
    created = []
    try:
        # 作業者：開始
        st, p = call('POST', f'{URL}/rest/v1/rpc/wl_record', as_user(staff), {
            'p_kind': 'start', 'p_site': None, 'p_site_name': '  テスト店   本店 ', 'p_lat': 35.68,
            'p_lng': 139.76, 'p_accuracy': 10, 'p_geo_error': None, 'p_photo': None})
        check('作業者が開始を記録できる', st == 200, f'{st} {p}')
        if st == 200:
            created.append(p['id'])
            check('現場名の空白が整えられる', p['site_name'] == 'テスト店 本店', p['site_name'])
            check('名前はサーバー側で入る', p['display_name'] == 'テスト作業者', p['display_name'])
            st, n = call('POST', f'{URL}/functions/v1/wl-notify', as_user(staff), {'punch_id': p['id']})
            check('通知の処理が動く（管理者へ送る）', st == 200 and n.get('ok') is True, f'{st} {n}')

        # 作業者に見える範囲
        st, rows = call('GET', f'{URL}/rest/v1/wl_members?select=user_id,org_id', as_user(staff))
        check('作業者に見えるメンバーは自分だけ', st == 200 and len(rows) == 1, f'{st} {rows}')
        st, rows = call('GET', f'{URL}/rest/v1/wl_orgs?select=id', as_user(staff))
        check('作業者に見える会社は自分の会社だけ', st == 200 and [r['id'] for r in rows] == [TEST_ORG], f'{st} {rows}')
        st, rows = call('GET', f'{URL}/rest/v1/wl_punches?select=user_id', as_user(staff))
        check('作業者に見える打刻は自分の分だけ', st == 200 and len({r['user_id'] for r in rows}) <= 1, f'{st}')
        st, r = call('PATCH', f'{URL}/rest/v1/wl_members?org_id=eq.{TEST_ORG}', as_user(staff), {'role': 'admin'})
        st2, me = call('GET', f'{URL}/rest/v1/wl_members?select=role', as_user(staff))
        check('作業者は自分を管理者にできない', st2 == 200 and me and me[0]['role'] == 'staff', f'{st} {r} {me}')

        # 管理者に見える範囲
        st, rows = call('GET', f'{URL}/rest/v1/wl_members?select=org_id', as_user(admin))
        check('管理者には自分の会社のメンバーだけが見える',
              st == 200 and len(rows) == 2 and all(r['org_id'] == TEST_ORG for r in rows), f'{st} {rows}')
        st, rows = call('GET', f'{URL}/rest/v1/wl_punches?select=org_id,user_id', as_user(admin))
        check('管理者には会社の打刻が見えて、ほかの会社のは見えない',
              st == 200 and rows and all(r['org_id'] == TEST_ORG for r in rows), f'{st}')

        # 作業者：終了
        st, p = call('POST', f'{URL}/rest/v1/rpc/wl_record', as_user(staff), {
            'p_kind': 'end', 'p_site': None, 'p_site_name': 'テスト店', 'p_lat': None, 'p_lng': None,
            'p_accuracy': None, 'p_geo_error': 'denied', 'p_photo': None})
        check('作業者が終了を記録できる', st == 200, f'{st} {p}')
        if st == 200:
            created.append(p['id'])

        # ログイン前の人には何も見えない
        st, rows = call('GET', f'{URL}/rest/v1/wl_punches?select=id', {'apikey': PUBLISHABLE})
        check('ログインしていない人には打刻が見えない', st in (401, 403) or rows == [], f'{st}')
    finally:
        # テストで作った打刻を消す（テスト用の会社の分だけ）
        call('DELETE', f'{URL}/rest/v1/wl_punches?org_id=eq.{TEST_ORG}',
             {'apikey': sk, 'Authorization': f'Bearer {sk}'})

    print(f'\n{sum(results)}/{len(results)} OK')
    sys.exit(0 if all(results) else 1)


if __name__ == '__main__':
    main()
