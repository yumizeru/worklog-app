"""Lucide の SVG から、アプリ用の icons.js を作る。
使い方: python -I build_icons.py <svgフォルダ> <出力 icons.js>
図形（path/circle/rect/line/polyline/polygon/ellipse）以外が入っていたら止める。
"""
import json
import os
import re
import sys

src, out = sys.argv[1], sys.argv[2]
ALLOWED = {"path", "circle", "rect", "line", "polyline", "polygon", "ellipse"}
icons = {}
for name in sorted(os.listdir(src)):
    if not name.endswith(".svg"):
        continue
    text = open(os.path.join(src, name), encoding="utf-8").read()
    m = re.search(r"<svg[^>]*>(.*)</svg>", text, re.S)
    if not m:
        raise SystemExit(f"no svg body: {name}")
    inner = re.sub(r"\s+", " ", m.group(1)).strip()
    inner = re.sub(r">\s+<", "><", inner)
    tags = set(re.findall(r"<\s*([a-zA-Z0-9]+)", inner))
    bad = tags - ALLOWED
    if bad:
        raise SystemExit(f"unexpected tags in {name}: {bad}")
    if re.search(r"on\w+\s*=|javascript:|href", inner, re.I):
        raise SystemExit(f"unsafe attribute in {name}")
    icons[name[:-4]] = inner

header = """'use strict';
/* =====================================================================
 * アイコン（Lucide Icons v1.66.0 / ISC License / https://lucide.dev）
 *  無料で商用利用もできるアイコン素材。ライセンス全文は LICENSE-lucide.txt
 *  このファイルは tools/build_icons.py で自動生成（手で編集しない）
 * ===================================================================== */
"""
body = "const ICON_PATHS = " + json.dumps(icons, ensure_ascii=False, indent=1) + ";\n"
footer = """
// icon('bell') → <svg ...> の文字列。class を足すときは icon('bell', 'big')
function icon(name, cls = '') {
  const p = ICON_PATHS[name];
  if (!p) return '';
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
// HTML に書いた <i data-icon="bell"></i> を、本物のアイコンに置き換える
function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach(el => {
    el.outerHTML = icon(el.dataset.icon, el.className);
  });
}
"""
open(out, "w", encoding="utf-8", newline="\n").write(header + body + footer)
print(f"wrote {len(icons)} icons -> {out}")
