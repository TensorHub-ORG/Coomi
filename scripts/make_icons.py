#!/usr/bin/env python3
"""Generate Coomi launcher icons + in-app logos from assets/coomi-agent.png.

The source art is a blue quatrefoil mark on a solid white canvas. We rebuild it as:

  * mipmap-*/ic_launcher.png          legacy icon, white rounded square
  * mipmap-*/ic_launcher_round.png    legacy round icon, white circle
  * mipmap-*/ic_launcher_foreground.png  adaptive foreground, transparent
  * drawable-nodpi/coomi_logo.png     in-app logo, transparent, 512px
  * apps/web/public/coomi-logo.png    web/WebView logo, 256px

Alpha is recovered by thresholding "not white" at the source resolution and
downsampling that mask with LANCZOS, which yields clean anti-aliased edges.
Edge pixels keep their white-blended RGB, so the result composites exactly over
the white backgrounds we always place it on.

Run from anywhere:  python scripts/make_icons.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "coomi-agent.png"
RES = ROOT / "apps" / "coomi-app" / "app" / "src" / "main" / "res"
WEB_PUBLIC = ROOT / "apps" / "web" / "public"

# density -> (legacy launcher px, adaptive 108dp canvas px)
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

WHITE_TOLERANCE = 12   # channel distance from #FFFFFF that still counts as background
LEGACY_LOGO_RATIO = 0.72   # logo width inside the legacy square
ROUND_LOGO_RATIO = 0.66    # logo width inside the round icon
ADAPTIVE_LOGO_RATIO = 0.58  # logo width inside the 108dp adaptive canvas (72dp safe zone)


def load_trimmed() -> tuple[Image.Image, Image.Image]:
    """Return (rgb, mask) of the logo trimmed to its content bounding box."""
    if not SRC.exists():
        sys.exit(f"source icon not found: {SRC}")
    rgb = Image.open(SRC).convert("RGB")
    # Binary "is ink" mask at full source resolution.
    r, g, b = rgb.split()
    mask = Image.new("L", rgb.size, 0)
    px_rgb = rgb.load()
    px_mask = mask.load()
    w, h = rgb.size
    for y in range(h):
        for x in range(w):
            cr, cg, cb = px_rgb[x, y]
            if (255 - cr) > WHITE_TOLERANCE or (255 - cg) > WHITE_TOLERANCE or (255 - cb) > WHITE_TOLERANCE:
                px_mask[x, y] = 255
    box = mask.getbbox()
    if box is None:
        sys.exit("source icon appears to be blank")
    # Square the bbox so the mark never gets stretched.
    l, t, r_, b_ = box
    cx, cy = (l + r_) / 2, (t + b_) / 2
    side = max(r_ - l, b_ - t)
    half = side / 2
    l2, t2 = int(round(cx - half)), int(round(cy - half))
    r2, b2 = int(round(cx + half)), int(round(cy + half))
    l2, t2 = max(0, l2), max(0, t2)
    r2, b2 = min(w, r2), min(h, b2)
    return rgb.crop((l2, t2, r2, b2)), mask.crop((l2, t2, r2, b2))


def logo_rgba(rgb: Image.Image, mask: Image.Image, size: int) -> Image.Image:
    """Scale the trimmed mark to `size` px square with recovered alpha."""
    small_rgb = rgb.resize((size, size), Image.LANCZOS)
    small_mask = mask.resize((size, size), Image.LANCZOS)
    out = small_rgb.convert("RGBA")
    out.putalpha(small_mask)
    return out


def rounded_square(size: int, radius_ratio: float, fill: tuple[int, int, int, int]) -> Image.Image:
    """Anti-aliased rounded square via 4x supersampling."""
    ss = 4
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle(
        (0, 0, size * ss - 1, size * ss - 1),
        radius=int(size * ss * radius_ratio),
        fill=fill,
    )
    return big.resize((size, size), Image.LANCZOS)


def circle(size: int, fill: tuple[int, int, int, int]) -> Image.Image:
    ss = 4
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.ellipse((0, 0, size * ss - 1, size * ss - 1), fill=fill)
    return big.resize((size, size), Image.LANCZOS)


def paste_centered(base: Image.Image, logo: Image.Image) -> Image.Image:
    x = (base.width - logo.width) // 2
    y = (base.height - logo.height) // 2
    base.alpha_composite(logo, (x, y))
    return base


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"  {path.relative_to(ROOT)}  {img.width}x{img.height}")


def main() -> None:
    rgb, mask = load_trimmed()
    print(f"source {SRC.name}: trimmed to {rgb.width}x{rgb.height}")

    white = (255, 255, 255, 255)
    for density, (legacy, adaptive) in DENSITIES.items():
        mip = RES / f"mipmap-{density}"

        # Legacy square icon.
        logo = logo_rgba(rgb, mask, max(1, int(round(legacy * LEGACY_LOGO_RATIO))))
        save(paste_centered(rounded_square(legacy, 0.22, white), logo), mip / "ic_launcher.png")

        # Legacy round icon.
        logo = logo_rgba(rgb, mask, max(1, int(round(legacy * ROUND_LOGO_RATIO))))
        save(paste_centered(circle(legacy, white), logo), mip / "ic_launcher_round.png")

        # Adaptive foreground (transparent, logo inside the safe zone).
        logo = logo_rgba(rgb, mask, max(1, int(round(adaptive * ADAPTIVE_LOGO_RATIO))))
        canvas = Image.new("RGBA", (adaptive, adaptive), (0, 0, 0, 0))
        save(paste_centered(canvas, logo), mip / "ic_launcher_foreground.png")

    # In-app logo for Android layouts.
    save(logo_rgba(rgb, mask, 512), RES / "drawable-nodpi" / "coomi_logo.png")

    # Web / WebView logo + favicon.
    save(logo_rgba(rgb, mask, 256), WEB_PUBLIC / "coomi-logo.png")
    save(paste_centered(rounded_square(180, 0.22, white), logo_rgba(rgb, mask, 130)),
         WEB_PUBLIC / "apple-touch-icon.png")
    save(paste_centered(rounded_square(64, 0.22, white), logo_rgba(rgb, mask, 46)),
         WEB_PUBLIC / "favicon.png")

    print("done")


if __name__ == "__main__":
    main()
