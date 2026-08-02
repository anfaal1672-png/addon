#!/usr/bin/env python3
"""Generates the add-on's PNG assets from code so no binaries need to live in git.

Run:  python3 tools/gen_textures.py
"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = os.path.join(ROOT, "packs", "PvPPracticeBP")
RP = os.path.join(ROOT, "packs", "PvPPracticeRP")


def write_png(path, width, height, pixels):
    """pixels: list of rows, each row a list of (r, g, b, a) tuples."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0 (None)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)
    print("wrote", os.path.relpath(path, ROOT))


# ---------------------------------------------------------------- pack icon --
# A 128x128 icon: dark slate background, a crossed-swords glyph, and a level bar.
CLEAR = (0, 0, 0, 0)


def pack_icon(accent):
    w = h = 128
    bg_top = (34, 38, 48, 255)
    bg_bottom = (18, 20, 26, 255)
    steel = (206, 212, 224, 255)
    steel_dark = (140, 148, 166, 255)
    hilt = (122, 84, 48, 255)

    px = []
    for y in range(h):
        t = y / (h - 1)
        row = []
        for x in range(w):
            # vignette-free vertical gradient
            c = tuple(
                int(bg_top[i] + (bg_bottom[i] - bg_top[i]) * t) for i in range(3)
            ) + (255,)
            row.append(c)
        px.append(row)

    def put(x, y, c):
        if 0 <= x < w and 0 <= y < h:
            px[y][x] = c

    def blade(x0, y0, x1, y1, colour, edge):
        """Draws a thick diagonal blade from (x0,y0) to (x1,y1)."""
        steps = max(abs(x1 - x0), abs(y1 - y0))
        for s in range(steps + 1):
            f = s / steps
            cx = round(x0 + (x1 - x0) * f)
            cy = round(y0 + (y1 - y0) * f)
            for dx in range(-4, 5):
                for dy in range(-4, 5):
                    if abs(dx) + abs(dy) <= 4:
                        put(cx + dx, cy + dy, edge if abs(dx) + abs(dy) > 2 else colour)

    def guard(cx, cy, dx, dy, colour):
        for s in range(-14, 15):
            for t_ in range(-2, 3):
                put(cx + dx * s + dy * t_, cy + dy * s - dx * t_, colour)

    # two crossed swords
    blade(30, 98, 92, 30, steel, steel_dark)
    blade(98, 98, 36, 30, steel, steel_dark)
    guard(30, 98, 1, 1, hilt)
    guard(98, 98, 1, -1, hilt)

    # accent level bar along the bottom
    for y in range(112, 122):
        for x in range(14, 114):
            put(x, y, accent if (x - 14) < 100 else CLEAR)

    return w, h, px


write_png(os.path.join(BP, "pack_icon.png"), *pack_icon((94, 214, 158, 255)))
write_png(os.path.join(RP, "pack_icon.png"), *pack_icon((110, 168, 246, 255)))


# ------------------------------------------------------------- remote icon --
# 16x16 "PvP remote": a dark handle with a bright emerald screen and antenna.
def remote_icon():
    w = h = 16
    px = [[CLEAR] * w for _ in range(h)]

    body = (46, 50, 62, 255)
    body_hi = (72, 78, 94, 255)
    body_lo = (26, 28, 36, 255)
    screen = (94, 214, 158, 255)
    screen_hi = (186, 246, 218, 255)
    metal = (196, 202, 214, 255)
    button = (232, 96, 96, 255)

    def rect(x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if 0 <= x < w and 0 <= y < h:
                    px[y][x] = c

    # antenna
    rect(10, 0, 10, 3, metal)
    rect(11, 1, 11, 1, metal)
    # body
    rect(4, 3, 11, 15, body)
    rect(4, 3, 4, 15, body_hi)
    rect(11, 3, 11, 15, body_lo)
    rect(4, 15, 11, 15, body_lo)
    # screen
    rect(5, 5, 10, 8, screen)
    rect(5, 5, 10, 5, screen_hi)
    # buttons
    rect(5, 10, 6, 11, button)
    rect(9, 10, 10, 11, metal)
    rect(5, 13, 6, 13, metal)
    rect(9, 13, 10, 13, button)
    return w, h, px


write_png(os.path.join(RP, "textures", "items", "pvp_remote.png"), *remote_icon())
