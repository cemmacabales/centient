"""Generate logo-derived assets for Centient.

Inputs: assets/logo-source.png (2048x2048, RGBA, transparent bg).
Outputs (public/):
  - logo.png            1024x1024 transparent master
  - logo-192.png        192x192 PWA icon
  - logo-512.png        512x512 PWA icon
  - apple-touch-icon.png 180x180 iOS home-screen
  - favicon.ico         16/32/48 multi-res
  - og-image.png        1200x630 wordmark + tagline + mark on brand surface
"""

import os
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "logo-source.png")
PUBLIC = os.path.join(ROOT, "public")

BRAND_SURFACE = (248, 249, 251, 255)  # #f8f9fb
BRAND_PRIMARY = (0, 109, 61, 255)  # #006d3d
BRAND_ON_SURFACE = (25, 28, 30, 255)  # #191c1e
BRAND_ON_SURFACE_VARIANT = (61, 74, 63, 255)  # #3d4a3f


def load_master() -> Image.Image:
    im = Image.open(SRC).convert("RGBA")
    if im.size != (2048, 2048):
        print(f"warning: source is {im.size}, expected 2048x2048", file=sys.stderr)
    return im


def save_png(im: Image.Image, path: str, quantize: bool = False) -> None:
    if quantize and im.mode == "RGBA":
        im = im.quantize(
            colors=256,
            method=Image.Quantize.FASTOCTREE,
            dither=Image.Dither.FLOYDSTEINBERG,
        )
    im.save(path, format="PNG", optimize=True, compress_level=9)
    print(f"wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) // 1024} KB)")


def resize(im: Image.Image, size: int) -> Image.Image:
    return im.resize((size, size), Image.LANCZOS)


def compose_on_surface(mark: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BRAND_SURFACE)
    canvas.alpha_composite(resize(mark, size))
    return canvas


def best_font(size: int, weight: str = "bold") -> ImageFont.FreeTypeFont:
    candidates = [
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    if weight != "bold":
        candidates = [
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def build_og(mark: Image.Image) -> Image.Image:
    W, H = 1200, 630
    canvas = Image.new("RGBA", (W, H), BRAND_SURFACE)
    draw = ImageDraw.Draw(canvas)

    mark_size = 280
    mark_resized = resize(mark, mark_size)
    mark_x = 100
    mark_y = (H - mark_size) // 2
    canvas.alpha_composite(mark_resized, (mark_x, mark_y))

    text_x = mark_x + mark_size + 60

    wordmark_font = best_font(128, "bold")
    wordmark_text = "Centient"
    wm_bbox = draw.textbbox((0, 0), wordmark_text, font=wordmark_font)
    wm_height = wm_bbox[3] - wm_bbox[1]

    tagline_font = best_font(40, "regular")
    tagline_text = "Train AI, cent by cent."
    tl_bbox = draw.textbbox((0, 0), tagline_text, font=tagline_font)
    tl_height = tl_bbox[3] - tl_bbox[1]

    gap = 20
    total_h = wm_height + gap + tl_height
    text_y = (H - total_h) // 2 - wm_bbox[1]

    draw.text((text_x, text_y), wordmark_text, fill=BRAND_PRIMARY, font=wordmark_font)
    draw.text(
        (text_x, text_y + wm_height + gap - tl_bbox[1]),
        tagline_text,
        fill=BRAND_ON_SURFACE_VARIANT,
        font=tagline_font,
    )

    domain_font = best_font(24, "bold")
    draw.text(
        (W - 100 - draw.textlength("centient.work", font=domain_font), H - 60),
        "centient.work",
        fill=BRAND_PRIMARY,
        font=domain_font,
    )

    return canvas


def main() -> None:
    os.makedirs(PUBLIC, exist_ok=True)
    master = load_master()

    save_png(resize(master, 1024), os.path.join(PUBLIC, "logo.png"), quantize=True)
    save_png(resize(master, 192), os.path.join(PUBLIC, "logo-192.png"))
    save_png(resize(master, 512), os.path.join(PUBLIC, "logo-512.png"), quantize=True)
    save_png(
        compose_on_surface(master, 180),
        os.path.join(PUBLIC, "apple-touch-icon.png"),
    )

    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    favicon_base = compose_on_surface(master, 48)
    favicon_path = os.path.join(PUBLIC, "favicon.ico")
    favicon_base.save(favicon_path, format="ICO", sizes=ico_sizes)
    print(f"wrote {os.path.relpath(favicon_path, ROOT)} ({os.path.getsize(favicon_path) // 1024} KB)")

    og = build_og(master)
    save_png(og, os.path.join(PUBLIC, "og-image.png"))


if __name__ == "__main__":
    main()
