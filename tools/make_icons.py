"""アプリアイコン(PNG)を生成する。外部ライブラリ不要。
使い方: python tools/make_icons.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")

BG = (15, 118, 110)       # 深い緑
WHITE = (255, 255, 255)


def render(size):
    s = size / 512.0
    px = [[BG] * size for _ in range(size)]
    cx = cy = size / 2
    r = 170 * s
    # 白い丸ボタン
    for y in range(size):
        for x in range(size):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                px[y][x] = WHITE
    # 再生マーク（三角形）
    ax, ay = 215 * s, 170 * s
    bx, by = 215 * s, 342 * s
    tx, ty = 355 * s, 256 * s

    def side(x1, y1, x2, y2, x, y):
        return (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    for y in range(size):
        for x in range(size):
            d1 = side(ax, ay, bx, by, x, y)
            d2 = side(bx, by, tx, ty, x, y)
            d3 = side(tx, ty, ax, ay, x, y)
            neg = d1 < 0 or d2 < 0 or d3 < 0
            pos = d1 > 0 or d2 > 0 or d3 > 0
            if not (neg and pos):
                px[y][x] = BG
    return px


def write_png(path, px):
    h = len(px)
    w = len(px[0])
    raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, size in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
        write_png(os.path.join(OUT, name), render(size))
        print("wrote", name)
