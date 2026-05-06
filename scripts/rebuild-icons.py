#!/usr/bin/env python3
# Coffee CLI — Icon Pipeline (SVG-based)
#
# Renders every output size DIRECTLY from icons/icon-master.svg via resvg,
# so each rasterized PNG is pixel-perfect at its target resolution. No
# downscale blur — the previous PNG-based pipeline cascaded a single high-res
# raster through Lanczos to every size and the small ones (16/24/32) ended up
# soft, especially in the Windows taskbar where Windows can't tell us
# rendering choices.
#
# Requires resvg-cli on PATH (`cargo install resvg`).
#
# Run: python scripts/rebuild-icons.py [icons/icon-master.svg]

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ICONS = REPO / "icons"

# Sizes Tauri's bundle.icon list expects (see tauri.conf.json).
PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "256x256.png": 256,
    "512x512.png": 512,
    "icon.png": 512,
}

# Microsoft Store / UWP tile sizes (existing in icons/, keep refreshed).
MS_TILE_SIZES = {
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

# Microsoft's full recommended .ico size set. Smaller sizes (20, 24, 40) are
# NOT optional — Windows taskbar requests 24 at 100% DPI, 30 at 125%, 36 at
# 150%, 48 at 200%. If the closest match is missing, Windows downscales from
# the next-larger entry with a low-quality bilinear pass — the classic
# "blurry taskbar icon" symptom.
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
# Sizes embedded into the macOS .icns container — Pillow's writer expects
# these exact powers of two.
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def check_resvg():
    if shutil.which("resvg") is None:
        print(
            "error: `resvg` not found on PATH. Install with `cargo install resvg`.",
            file=sys.stderr,
        )
        sys.exit(1)


def render_svg(svg_path: Path, size: int, out_path: Path):
    """Rasterize the SVG at exact target pixel size. resvg's `--width N` and
    `--height N` together force the output dimensions; without `--height`
    resvg infers from the SVG's viewBox aspect — fine for our 1:1 master
    but explicit is safer."""
    subprocess.run(
        [
            "resvg",
            "--width", str(size),
            "--height", str(size),
            str(svg_path),
            str(out_path),
        ],
        check=True,
    )


def render_to_image(svg_path: Path, size: int) -> Image.Image:
    """Render SVG → in-memory PIL image. Used when we need to compose the
    raster (e.g. for ICO/ICNS multi-size containers)."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        render_svg(svg_path, size, tmp_path)
        return Image.open(tmp_path).convert("RGBA").copy()
    finally:
        tmp_path.unlink(missing_ok=True)


def main():
    args = sys.argv[1:]
    svg_path = Path(args[0]) if args else (ICONS / "icon-master.svg")
    if not svg_path.exists():
        print(f"error: SVG not found: {svg_path}", file=sys.stderr)
        sys.exit(1)
    check_resvg()
    print(f"source: {svg_path}")

    print("rendering png sizes (direct from SVG, no downscale)…")
    for fname, size in {**PNG_SIZES, **MS_TILE_SIZES}.items():
        render_svg(svg_path, size, ICONS / fname)
        print(f"  {fname} ({size}x{size})")

    print("building .ico (Windows)…")
    ico_imgs = [render_to_image(svg_path, s) for s in ICO_SIZES]
    # PIL's ICO writer takes the largest as base + sizes= for the embedded list.
    # Each embedded entry will be re-encoded from this base — which would be a
    # downscale we want to avoid — but the writer DOES use the closest already-
    # provided sub-image when one matches, so we save a multi-frame ICO by
    # passing append_images.
    ico_imgs[-1].save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=ico_imgs[:-1],
    )
    print(f"  icon.ico {ICO_SIZES} (10 frames embedded)")

    print("building .icns (macOS)…")
    icns_master = render_to_image(svg_path, 1024)
    icns_master.save(
        ICONS / "icon.icns",
        format="ICNS",
        sizes=[(s, s) for s in ICNS_SIZES],
    )
    print(f"  icon.icns {ICNS_SIZES}")

    print("done.")


if __name__ == "__main__":
    main()
