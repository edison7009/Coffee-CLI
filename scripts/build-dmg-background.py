#!/usr/bin/env python3
# Coffee CLI — macOS DMG window background.
#
# Draws the drag-to-install backdrop Finder shows when the DMG opens: the app
# icon on the left, the Applications folder on the right, an arrow between
# them. No text, so it reads the same in every language. Finder draws the two
# icons and their labels itself (positions in scripts/dmg-settings.py); this image is only the canvas
# behind them, so the coordinates below MUST stay in step with that file.
#
# Writes icons/dmg/background.png (1x) and background@2x.png (Retina); dmgbuild
# merges the pair into one multi-resolution TIFF.
#
# Requires Pillow. Run: python3 scripts/build-dmg-background.py

import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons", "dmg")

# Window content size in points — keep in step with dmg-settings.py.
W, H = 660, 400
APP_X, FOLDER_X, ICON_Y = 170, 490, 186  # icon centres

TOP = (252, 249, 245)
BOTTOM = (243, 236, 227)
ACCENT = (166, 112, 72)


def draw(scale):
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        row = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = row

    # Soft glow under each icon so they sit on the canvas instead of floating.
    glow = Image.new("L", (w, h), 0)
    g = ImageDraw.Draw(glow)
    for cx in (APP_X, FOLDER_X):
        r = 82 * scale
        g.ellipse(
            [(cx * scale - r, ICON_Y * scale - r * 0.92), (cx * scale + r, ICON_Y * scale + r * 0.92)],
            fill=60,
        )
    glow = glow.filter(ImageFilter.GaussianBlur(28 * scale))
    img = Image.composite(Image.new("RGB", (w, h), (255, 255, 255)), img, glow)

    d = ImageDraw.Draw(img)

    # Curved dashed arrow from the app towards the folder.
    x0, x1 = (APP_X + 86) * scale, (FOLDER_X - 92) * scale
    y = (ICON_Y - 2) * scale
    lift = 26 * scale
    pts = []
    steps = 240
    for i in range(steps + 1):
        t = i / steps
        bx = x0 + (x1 - x0) * t
        by = y - lift * 4 * t * (1 - t)
        pts.append((bx, by))
    dash, gap = 9 * scale, 7 * scale
    stroke = max(2, round(3 * scale))
    run, on, seg = 0.0, True, [pts[0]]
    for a, b in zip(pts, pts[1:]):
        run += math.dist(a, b)
        seg.append(b)
        if run >= (dash if on else gap):
            if on and len(seg) > 1:
                d.line(seg, fill=ACCENT, width=stroke, joint="curve")
            on, run, seg = not on, 0.0, [b]
    if on and len(seg) > 1:
        d.line(seg, fill=ACCENT, width=stroke, joint="curve")

    # Arrow head along the curve's final tangent.
    (ax, ay), (bx, by) = pts[-8], pts[-1]
    ang = math.atan2(by - ay, bx - ax)
    size = 14 * scale
    head = [
        (bx + 4 * scale * math.cos(ang), by + 4 * scale * math.sin(ang)),
        (bx - size * math.cos(ang - 0.5), by - size * math.sin(ang - 0.5)),
        (bx - size * 0.55 * math.cos(ang), by - size * 0.55 * math.sin(ang)),
        (bx - size * math.cos(ang + 0.5), by - size * math.sin(ang + 0.5)),
    ]
    d.polygon(head, fill=ACCENT)

    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    big = draw(2)
    big.save(os.path.join(OUT, "background@2x.png"), dpi=(144, 144), optimize=True)
    small = draw(1)
    small.save(os.path.join(OUT, "background.png"), dpi=(72, 72), optimize=True)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
