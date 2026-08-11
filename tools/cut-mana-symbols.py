#!/usr/bin/env python3
"""
Cuts the five mana symbols out of the source sheet into individual PNGs.

    python3 tools/cut-mana-symbols.py

Input is docs/brand/mana-symbols.webp — one row of five discs on white, WUBRG order.
Output is public/mana/{w,u,b,r,g}.png, 96px, transparent outside the disc.

Kept as a script rather than a one-off because the sheet is the source of truth: if it
is ever replaced at a different size or spacing, this finds the discs again instead of
depending on coordinates someone measured once by eye.
"""

from PIL import Image, ImageDraw
import os
import sys

SHEET = 'docs/brand/mana-symbols.webp'
OUT_DIR = 'public/mana'
KEYS = ['w', 'u', 'b', 'r', 'g']   # canonical WUBRG, the order they sit in on the sheet
SIZE = 96                          # 3x the largest on-screen use (19px), with headroom
SUPERSAMPLE = 4                    # mask is drawn this much larger, then downsampled


def find_discs(img):
    """Column runs of non-white pixels, one per disc."""
    px = img.load()
    w, h = img.size

    def ink(x, y):
        r, g, b = px[x, y]
        return r < 245 or g < 245 or b < 245

    runs, start = [], None
    for x in range(w):
        marked = any(ink(x, y) for y in range(0, h, 3))
        if marked and start is None:
            start = x
        elif not marked and start is not None:
            if x - start > 20:
                runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, w))

    boxes = []
    for x0, x1 in runs:
        ys = [y for y in range(h) if any(ink(x, y) for x in range(x0, x1, 2))]
        boxes.append((x0, min(ys), x1, max(ys) + 1))
    return boxes


def cut(img, box, size):
    x0, y0, x1, y1 = box
    n = max(x1 - x0, y1 - y0)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    disc = img.crop((cx - n // 2, cy - n // 2, cx - n // 2 + n, cy - n // 2 + n))

    # Flood the corners with the disc's own edge colour BEFORE masking. Downsampling an
    # RGBA whose transparent pixels are white drags white into the rim as a halo;
    # continuous colour underneath the alpha keeps the edge clean.
    edge = disc.getpixel((n // 2, 3))
    flood = Image.new('RGB', (n, n), edge)

    ring = Image.new('L', (n * SUPERSAMPLE, n * SUPERSAMPLE), 0)
    ImageDraw.Draw(ring).ellipse((0, 0, n * SUPERSAMPLE - 1, n * SUPERSAMPLE - 1), fill=255)
    ring = ring.resize((n, n), Image.LANCZOS)

    flood.paste(disc, (0, 0), ring)
    out = flood.convert('RGBA')
    out.putalpha(ring)
    return out.resize((size, size), Image.LANCZOS)


def main():
    if not os.path.exists(SHEET):
        sys.exit(f'missing {SHEET}')
    img = Image.open(SHEET).convert('RGB')
    boxes = find_discs(img)
    if len(boxes) != len(KEYS):
        sys.exit(f'expected {len(KEYS)} discs, found {len(boxes)} — is the sheet still one row of five?')

    os.makedirs(OUT_DIR, exist_ok=True)
    for key, box in zip(KEYS, boxes):
        path = os.path.join(OUT_DIR, f'{key}.png')
        cut(img, box, SIZE).save(path, optimize=True)
        print(f'{key}: {box} -> {path}')


if __name__ == '__main__':
    main()
