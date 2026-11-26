#!/usr/bin/env python3
"""Generate the Storefront Code brand assets from fork/assets/storefront-mark.svg.

    python3 -I fork/scripts/brand-assets.py

Writes, all derived from the one S mark:
- fork/assets/storefront-code.icon/: the iOS 26 Icon Composer project (gradient background, white
  glass S), so iOS renders the light, dark, tinted and clear looks itself.
- fork/assets/storefront-ios-1024.png: the same icon flat, for places that take a PNG.
- fork/assets/storefront-splash-1024.png: the gradient S on transparency, for the splash screen.
- apps/mobile/assets/widget/T3Mark.svg: the S as a template image for the widget and Live Activity
  (the asset keeps upstream's name, so upstream's widget code finds it).
It also prints the path for apps/mobile/src/components/T3Wordmark.tsx (105-unit box).
Needs rsvg-convert for the PNGs.
"""
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
ASSETS = ROOT / "fork" / "assets"
MARK = (ASSETS / "storefront-mark.svg").read_text()

PURPLE = "#9019fe"
CYAN = "#02d7f4"

# The mark draws a unit-sized path through matrix(-104.719,0,0,104.719,104.719,52.421).
UNIT_PATH = re.search(r' d="([^"]+)"', MARK).group(1)
A, D, E, F = -104.719, 104.719, 104.719, 52.421


def flatten(scale: float, dx: float, dy: float) -> str:
    """The path in plain coordinates: the mark's 105-unit box scaled by `scale`, moved by dx, dy."""
    tokens = re.findall(r"[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?", UNIT_PATH)
    out, numbers = [], []

    def flush():
        for i in range(0, len(numbers), 2):
            x = (A * numbers[i] + E) * scale + dx
            y = (D * numbers[i + 1] + F) * scale + dy
            out.append(f"{x:.3f},{y:.3f}")
        numbers.clear()

    for token in tokens:
        if token in "MLCZ":
            flush()
            out.append(token)
        else:
            numbers.append(float(token))
    flush()
    return " ".join(out)


def write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print("wrote", path.relative_to(ROOT))


def svg_to_png(svg: str, png: pathlib.Path, size: int) -> None:
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(png)],
        input=svg.encode(),
        check=True,
    )
    print("wrote", png.relative_to(ROOT))


# Icon Composer layers are 128-point SVGs scaled up (upstream uses 8.5 for its glyph, 8.1 for a
# full background). The S fills 72 of 128 points: about 60% of the icon, Apple's usual glyph size.
S_SIZE, BOX = 72.0, 128.0
s_layer = flatten(S_SIZE / 105, (BOX - S_SIZE) / 2, (BOX - S_SIZE) / 2)
gradient = (
    f'<linearGradient id="b" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">'
    f'<stop offset="0" stop-color="{PURPLE}"/><stop offset="1" stop-color="{CYAN}"/></linearGradient>'
)
icon_dir = ASSETS / "storefront-code.icon"
write(
    icon_dir / "Assets" / "background.svg",
    f'<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
    f"<defs>{gradient}</defs>"
    f'<rect width="128" height="128" fill="url(#b)"/></svg>\n',
)
write(
    icon_dir / "Assets" / "s.svg",
    f'<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">'
    f'<path d="{s_layer}" fill="white"/></svg>\n',
)
layer = lambda name, image, scale, glass: {
    "glass": glass,
    "image-name": image,
    "name": name,
    "position": {"scale": scale, "translation-in-points": [0, 0]},
}
write(
    icon_dir / "icon.json",
    json.dumps(
        {
            # Shown where the background layer is not (tinted and clear looks start from it).
            "fill": {"solid": "display-p3:0.33000,0.42000,1.00000,1.00000"},
            "groups": [
                {
                    "layers": [layer("S", "s.svg", 8.5, True)],
                    "shadow": {"kind": "neutral", "opacity": 0.5},
                    "translucency": {"enabled": True, "value": 0.2},
                },
                {
                    "layers": [layer("Background", "background.svg", 8.1, False)],
                    "shadow": {"kind": "neutral", "opacity": 0.5},
                    "translucency": {"enabled": False, "value": 0.5},
                },
            ],
            "supported-platforms": {"circles": ["watchOS"], "squares": "shared"},
        },
        indent=2,
    )
    + "\n",
)

# The flat PNG: same proportions, on the full square (iOS rounds the corners itself).
flat = (
    f'<svg width="1024" height="1024" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
    f"<defs>{gradient}</defs>"
    f'<rect width="128" height="128" fill="url(#b)"/><path d="{s_layer}" fill="white"/></svg>'
)
svg_to_png(flat, ASSETS / "storefront-ios-1024.png", 1024)

# Splash: the gradient S alone, a little smaller, on transparency.
splash_path = flatten(64 / 105, 32, 32)
splash = (
    f'<svg width="1024" height="1024" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">'
    f'<defs><linearGradient id="s" x1="32" y1="0" x2="96" y2="0" gradientUnits="userSpaceOnUse">'
    f'<stop offset="0" stop-color="{PURPLE}"/><stop offset="1" stop-color="{CYAN}"/></linearGradient></defs>'
    f'<path d="{splash_path}" fill="url(#s)"/></svg>'
)
svg_to_png(splash, ASSETS / "storefront-splash-1024.png", 1024)

# Widget and Live Activity: a template image (only its shape counts) in upstream's 1.5:1 frame,
# the S at the left like upstream's "T3".
widget_path = flatten(1.0, 0, 0)
write(
    ROOT / "apps" / "mobile" / "assets" / "widget" / "T3Mark.svg",
    f'<svg width="158" height="105" viewBox="0 0 158 105" fill="none" xmlns="http://www.w3.org/2000/svg">'
    f'<path d="{widget_path}" fill="black"/></svg>\n',
)

print("T3Wordmark path (105-unit box):")
print(flatten(1.0, 0, 0))
