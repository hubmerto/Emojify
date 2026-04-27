#!/usr/bin/env python3
import argparse
import math
import os
import random
import shutil
import subprocess
from pathlib import Path

from PIL import Image
import numpy as np


def ffmpeg_path(repo_root: Path) -> str:
    local = repo_root / "bin" / "ffmpeg"
    if local.exists():
        return str(local)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    return "ffmpeg"


def run(cmd, label):
    print(f"{label}...")
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"{label} failed: {' '.join(cmd)}")


def average_color(img: Image.Image) -> np.ndarray:
    arr = np.array(img)
    if arr.shape[-1] == 4:
        rgb = arr[..., :3]
        alpha = arr[..., 3] / 255.0
        mask = alpha > 0
        if not np.any(mask):
            return np.array([0, 0, 0], dtype=np.float32)
        rgb = rgb[mask]
        return rgb.mean(axis=0)
    return arr.reshape(-1, 3).mean(axis=0)


def build_emoji_palette(emojis_dir: Path, size: int = 0):
    """Build palette of emoji colors and images.

    If size > 0, emojis are pre-resized to that size (legacy behaviour).
    If size == 0, emojis are kept at full resolution for sharp rendering.
    """
    colors = []
    images = []
    for path in sorted(emojis_dir.glob("*.png")):
        img = Image.open(path).convert("RGBA")
        color = average_color(img)
        if size > 0:
            img = img.resize((size, size), Image.LANCZOS)
        colors.append(color)
        images.append(img)
    return np.array(colors, dtype=np.float32), images


def nearest_emoji_index(color, palette_colors):
    # Vectorized nearest-neighbor match against palette average colors.
    distances = np.sum((palette_colors - color) ** 2, axis=1)
    return int(np.argmin(distances))


_pick_rng = random.Random(1337)


def _pick(color, palette_colors, usage, max_uses, forbidden):
    """Return a close emoji that satisfies the usage cap and avoids the
    `forbidden` set. Randomly chooses among the top few candidates to break
    up regular patterns when spread is active."""
    distances = np.sum((palette_colors - color) ** 2, axis=1)
    order = np.argsort(distances)
    use_cap = max_uses > 0
    candidates = []
    for idx in order:
        i = int(idx)
        if use_cap and usage[i] >= max_uses:
            continue
        if forbidden and i in forbidden:
            continue
        candidates.append(i)
        if len(candidates) >= 5:
            break
    if candidates:
        return _pick_rng.choice(candidates)
    if forbidden:
        for idx in order:
            i = int(idx)
            if not use_cap or usage[i] < max_uses:
                return i
    return int(order[0])


def build_emoji_grid(img: Image.Image, size: int, palette_colors, max_uses: int = 0, no_adjacent: bool = False):
    width, height = img.size
    cols = math.ceil(width / size)
    rows = math.ceil(height / size)
    pixels = np.array(img, dtype=np.float32)
    grid = np.empty((rows, cols), dtype=np.int32)

    use_cap = max_uses > 0
    usage = np.zeros(len(palette_colors), dtype=np.int32) if use_cap else None

    for y in range(rows):
        top = y * size
        bottom = min(top + size, height)
        for x in range(cols):
            left = x * size
            right = min(left + size, width)
            tile_pixels = pixels[top:bottom, left:right]
            color = tile_pixels.reshape(-1, 3).mean(axis=0)
            if use_cap or no_adjacent:
                forbidden = set()
                if no_adjacent:
                    # Strict spread: same emoji cannot appear within D cells
                    # (Chebyshev). Larger D = more dramatic dispersion.
                    D = 4
                    for dy in range(-D, 1):
                        y0 = y + dy
                        if y0 < 0:
                            continue
                        x_start = max(0, x - D)
                        x_end = min(cols, x + D + 1)
                        if dy == 0:
                            x_end = x
                        for x0 in range(x_start, x_end):
                            forbidden.add(int(grid[y0, x0]))
                idx = _pick(color, palette_colors, usage, max_uses, forbidden)
                if use_cap:
                    usage[idx] += 1
            else:
                idx = nearest_emoji_index(color, palette_colors)
            grid[y, x] = idx

    return grid


def _largest_uniform_square(grid, covered, row, col, emoji_index, max_side):
    max_possible = min(max_side, grid.shape[0] - row, grid.shape[1] - col)
    for side in range(max_possible, 0, -1):
        block = grid[row : row + side, col : col + side]
        if np.all(block == emoji_index) and not np.any(covered[row : row + side, col : col + side]):
            return side
    return 1


def mosaic_image(img: Image.Image, palette_colors, palette_images, size: int, zoom: int, bg_color=(0, 0, 0), max_emoji_block: int = 1, overlap: float = 0.0, size_jitter: float = 0.0, seed: int = 42, max_uses: int = 0, no_adjacent: bool = False):
    grid = build_emoji_grid(img, size, palette_colors, max_uses=max_uses, no_adjacent=no_adjacent)
    rows, cols = grid.shape
    tile_px = size * zoom
    transparent = bg_color is None

    if overlap > 0.0 or size_jitter > 0.0 or transparent:
        # Scattered rendering: each emoji drawn larger than its cell and/or
        # randomly resized, using alpha compositing so edges blend naturally.
        fill = (0, 0, 0, 0) if transparent else bg_color + (255,)
        canvas = Image.new("RGBA", (cols * tile_px, rows * tile_px), fill)
        rng = random.Random(seed)
        base_scale = 1.0 + max(0.0, min(overlap, 1.5))
        jitter = max(0.0, min(size_jitter, 0.6))
        pos_jitter_px = int(tile_px * min(overlap, 0.5) * 0.5)
        _resize_cache = {}
        # Render in shuffled order so overlap relationships vary across the image.
        order = [(r, c) for r in range(rows) for c in range(cols)]
        rng.shuffle(order)
        for row, col in order:
            emoji_index = int(grid[row, col])
            scale = base_scale * (1.0 + rng.uniform(-jitter, jitter))
            emoji_px = max(4, int(round(tile_px * scale)))
            cache_key = (emoji_index, emoji_px)
            em = _resize_cache.get(cache_key)
            if em is None:
                src = palette_images[emoji_index]
                em = src if src.size[0] == emoji_px else src.resize((emoji_px, emoji_px), Image.LANCZOS)
                _resize_cache[cache_key] = em
            cx = col * tile_px + tile_px // 2 + rng.randint(-pos_jitter_px, pos_jitter_px) if pos_jitter_px else col * tile_px + tile_px // 2
            cy = row * tile_px + tile_px // 2 + rng.randint(-pos_jitter_px, pos_jitter_px) if pos_jitter_px else row * tile_px + tile_px // 2
            canvas.alpha_composite(em, (cx - emoji_px // 2, cy - emoji_px // 2))
        return canvas if transparent else canvas.convert("RGB")

    out = Image.new("RGB", (cols * tile_px, rows * tile_px), bg_color)

    _resize_cache = {}

    if max_emoji_block <= 1:
        # Fast path: every tile is uniform size
        for row in range(rows):
            for col in range(cols):
                emoji_index = grid[row, col]
                if emoji_index not in _resize_cache:
                    emoji = palette_images[emoji_index]
                    if emoji.size[0] != tile_px:
                        emoji = emoji.resize((tile_px, tile_px), Image.LANCZOS)
                    _resize_cache[emoji_index] = emoji
                emoji = _resize_cache[emoji_index]
                out.paste(emoji, (col * tile_px, row * tile_px), emoji)
    else:
        # Quadtree-style merging: flat regions collapse into a single large
        # emoji, detailed regions recurse down to 1x1 tiles. Produces a
        # natural mix of sizes in the same image.
        pixels = np.array(img, dtype=np.float32)
        cell_colors = np.zeros((rows, cols, 3), dtype=np.float32)
        for r in range(rows):
            for c in range(cols):
                tile = pixels[r * size : min((r + 1) * size, pixels.shape[0]),
                              c * size : min((c + 1) * size, pixels.shape[1])]
                cell_colors[r, c] = tile.reshape(-1, 3).mean(axis=0)
        merge_threshold = 45.0

        def paste_block(r, c, s):
            region = cell_colors[r : r + s, c : c + s]
            mean = region.reshape(-1, 3).mean(axis=0)
            idx = nearest_emoji_index(mean, palette_colors)
            target_px = s * tile_px
            cache_key = (idx, target_px)
            em = _resize_cache.get(cache_key)
            if em is None:
                src = palette_images[idx]
                em = src if src.size[0] == target_px else src.resize((target_px, target_px), Image.LANCZOS)
                _resize_cache[cache_key] = em
            out.paste(em, (c * tile_px, r * tile_px), em)

        def recurse(r, c, s):
            s = min(s, rows - r, cols - c)
            if s <= 0:
                return
            if s == 1:
                paste_block(r, c, 1)
                return
            region = cell_colors[r : r + s, c : c + s]
            mean = region.reshape(-1, 3).mean(axis=0)
            dev = np.sqrt(np.sum((region - mean) ** 2, axis=-1)).mean()
            if dev < merge_threshold:
                paste_block(r, c, s)
                return
            half = max(1, s // 2)
            recurse(r, c, half)
            recurse(r, c + half, s - half)
            recurse(r + half, c, half)
            recurse(r + half, c + half, s - half)

        top_s = max(1, max_emoji_block)
        for r in range(0, rows, top_s):
            for c in range(0, cols, top_s):
                recurse(r, c, top_s)

    return out


ASCII_RAMP = " .`'-,:;!i~+=*x&#%@"

# Broad emoji set. Colors computed at runtime from the system color-emoji
# font so the palette adapts to the renderer.
EMOJI_CHARS = [
    "⬛", "⬜", "🟥", "🟧", "🟨", "🟩", "🟦", "🟪", "🟫",
    "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "⚫", "⚪", "🟤",
    "❤️", "🧡", "💛", "💚", "💙", "💜", "🤎", "🖤", "🤍",
    "🍎", "🍏", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐",
    "🍒", "🥝", "🥭", "🥥", "🍑", "🍍", "🥑", "🥕", "🌽",
    "🥒", "🍆", "🫑", "🧅", "🥔",
    "🌳", "🌲", "🌴", "🌵", "🌻", "🌹", "🌷", "🌼", "🌸",
    "☀️", "🌑", "🌕", "🌙", "⭐", "✨", "🔥", "💧", "🌊",
    "🦁", "🐯", "🐼", "🐨", "🐸", "🐷", "🐮", "🐵", "🐰",
    "🐶", "🐱", "🐻", "🦊",
    "🍞", "🧀", "🥞", "🍕", "🌮", "🍣", "🍫", "🍭", "🍬",
    "🏀", "⚽", "🎾", "🏈", "⚾",
]

_EMOJI_PALETTE_CACHE = None


def _compute_emoji_palette():
    """Render each emoji with the system color-emoji font and take the
    average RGB of opaque pixels. Cached after first call. Returns list of
    (char, (r, g, b)). Skips emojis that fail to render (no fallback)."""
    global _EMOJI_PALETTE_CACHE
    if _EMOJI_PALETTE_CACHE is not None:
        return _EMOJI_PALETTE_CACHE
    from PIL import ImageDraw, ImageFont
    candidates = [
        "/System/Library/Fonts/Apple Color Emoji.ttc",
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    ]
    font = None
    for path in candidates:
        try:
            font = ImageFont.truetype(path, 160)
            break
        except Exception:
            continue
    if font is None:
        _EMOJI_PALETTE_CACHE = [
            ("⬛", (20, 20, 20)), ("🟥", (220, 60, 60)), ("🟧", (230, 135, 60)),
            ("🟨", (240, 210, 70)), ("🟩", (100, 180, 95)), ("🟦", (80, 125, 220)),
            ("🟪", (160, 100, 200)), ("🟫", (130, 85, 55)), ("⬜", (240, 240, 240)),
        ]
        return _EMOJI_PALETTE_CACHE
    palette = []
    for ch in EMOJI_CHARS:
        canvas = Image.new("RGBA", (180, 180), (0, 0, 0, 0))
        try:
            ImageDraw.Draw(canvas).text((0, 0), ch, font=font, embedded_color=True)
        except Exception:
            continue
        arr = np.array(canvas)
        mask = arr[:, :, 3] > 0
        if not mask.any():
            continue
        rgb = arr[:, :, :3][mask].reshape(-1, 3).mean(axis=0)
        palette.append((ch, (int(rgb[0]), int(rgb[1]), int(rgb[2]))))
    _EMOJI_PALETTE_CACHE = palette
    return palette


def ascii_image(img: Image.Image, size: int, ramp: str = ASCII_RAMP, use_emoji: bool = True) -> str:
    """Render the image as text art.
    Each `size`-pixel square becomes one character/emoji. When use_emoji is
    True the nearest-color emoji is picked; otherwise a luminance ramp is
    used. Columns use the full tile; rows are doubled for ASCII (chars are
    ~2x tall) but kept 1:1 for emoji (wide rendering in most fonts)."""
    pixels_rgb = np.array(img.convert("RGB"), dtype=np.float32)
    height, width = pixels_rgb.shape[:2]
    cols = math.ceil(width / size)
    row_step = size if use_emoji else size * 2
    rows = math.ceil(height / row_step)
    palette = _compute_emoji_palette() if use_emoji else None
    palette_rgb = np.array([c for _, c in palette], dtype=np.float32) if use_emoji else None
    emoji_chars = [ch for ch, _ in palette] if use_emoji else None
    lines = []
    for y in range(rows):
        top = y * row_step
        bottom = min(top + row_step, height)
        row_chars = []
        for x in range(cols):
            left = x * size
            right = min(left + size, width)
            tile = pixels_rgb[top:bottom, left:right]
            if tile.size == 0:
                row_chars.append(" " if not use_emoji else "⬛")
                continue
            mean = tile.reshape(-1, 3).mean(axis=0)
            if use_emoji:
                idx = int(np.argmin(np.sum((palette_rgb - mean) ** 2, axis=1)))
                row_chars.append(emoji_chars[idx])
            else:
                lum = 0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2]
                idx = min(len(ramp) - 1, int(lum / 255.0 * (len(ramp) - 1)))
                row_chars.append(ramp[idx])
        lines.append("".join(row_chars))
    return "\n".join(lines)


def mosaic_frame(frame_path: Path, palette_colors, palette_images, size: int, zoom: int, out_path: Path):
    img = Image.open(frame_path).convert("RGB")
    out = mosaic_image(img, palette_colors, palette_images, size, zoom)
    out.save(out_path)


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--video")
    source.add_argument("--image")
    parser.add_argument("--fps", type=int, default=10)
    parser.add_argument("--size", type=int, default=8)
    parser.add_argument("--zoom", type=int, default=0, help="Emoji render px = size*zoom. 0 = auto (4 for image, 1 for video).")
    parser.add_argument("--overlap", type=float, default=0.0, help="0.0 = none, 0.3 = emojis drawn 30% larger than cell and overlap.")
    parser.add_argument("--jitter", type=float, default=0.0, help="Per-emoji random size variation fraction, e.g. 0.15.")
    parser.add_argument("--max-uses", type=int, default=0, help="Cap how many times each emoji can be used (0 = unlimited).")
    parser.add_argument("--max-block", type=int, default=1, help="Merge adjacent identical tiles into blocks up to NxN (1 = off).")
    parser.add_argument("--no-adjacent", action="store_true", help="Prevent the same emoji from appearing in neighboring cells.")
    parser.add_argument("--bg", choices=["black", "white", "transparent", "image"], default="black", help="Background behind the emojis. 'image' shows the original photo through gaps (PNG recommended).")
    parser.add_argument("--ascii", action="store_true", help="Render image as text art (writes .txt). Uses emoji characters by default.")
    parser.add_argument("--ascii-plain", action="store_true", help="With --ascii, use plain ASCII characters instead of emoji.")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent
    emojis_dir = repo_root / "emojis"
    tmp_dir = repo_root / "tmp_py"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True)

    if args.image:
        image_path = Path(args.image).resolve()
        img = Image.open(image_path).convert("RGB")
        if args.ascii:
            out_path = args.out or str(image_path.with_name(f"{image_path.stem}-mosaic.txt"))
            text = ascii_image(img, args.size, use_emoji=not args.ascii_plain)
            Path(out_path).write_text(text, encoding="utf-8")
            print(f"Done: {out_path}")
            return
        zoom = args.zoom if args.zoom > 0 else 4
        palette_colors, palette_images = build_emoji_palette(emojis_dir, 0)
        out_path = args.out or str(image_path.with_name(f"{image_path.stem}-mosaic.png"))
        if args.bg == "white":
            bg_color = (255, 255, 255)
        elif args.bg in ("transparent", "image"):
            bg_color = None
        else:
            bg_color = (0, 0, 0)
        mosaic = mosaic_image(
            img,
            palette_colors,
            palette_images,
            size=args.size,
            zoom=zoom,
            bg_color=bg_color,
            overlap=args.overlap,
            size_jitter=args.jitter,
            max_uses=args.max_uses,
            max_emoji_block=args.max_block,
            no_adjacent=args.no_adjacent,
        )
        if args.bg == "image":
            # Composite the transparent mosaic on top of the original image,
            # resized to match. Original shows through any gaps.
            bg_img = img.resize(mosaic.size, Image.LANCZOS).convert("RGBA")
            bg_img.alpha_composite(mosaic.convert("RGBA"))
            mosaic = bg_img
        mosaic.save(Path(out_path))
        print(f"Done: {out_path}")
        return

    zoom = args.zoom if args.zoom > 0 else 1
    palette_colors, palette_images = build_emoji_palette(emojis_dir, args.size)

    video_path = Path(args.video).resolve()
    base = video_path.stem
    frame_pattern = tmp_dir / f"{base}-%05d.png"
    mosaic_pattern = tmp_dir / f"{base}-%05d-mosaic.png"

    run(
        [ffmpeg_path(repo_root), "-y", "-i", str(video_path), "-vf", f"fps={args.fps}", str(frame_pattern)],
        "Extracting frames",
    )

    frames = sorted(tmp_dir.glob(f"{base}-*.png"))
    frames = [f for f in frames if not f.name.endswith("-mosaic.png")]
    total = len(frames)
    for i, frame in enumerate(frames, start=1):
        print(f"Frame {i}/{total}")
        mosaic_out = tmp_dir / f"{frame.stem}-mosaic.png"
        mosaic_frame(frame, palette_colors, palette_images, args.size, zoom, mosaic_out)

    out_path = args.out
    if out_path is None:
        out_path = str(video_path.with_name(f"{base}-mosaic.mp4"))

    run(
        [
            ffmpeg_path(repo_root),
            "-y",
            "-framerate",
            str(args.fps),
            "-i",
            str(mosaic_pattern),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-r",
            str(args.fps),
            out_path,
        ],
        "Encoding video",
    )
    print(f"Done: {out_path}")


if __name__ == "__main__":
    main()
