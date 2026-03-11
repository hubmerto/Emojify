#!/usr/bin/env python3
"""Standalone fullscreen emoji webcam server on port 5051."""

import io
import sys
import threading
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request
from PIL import Image

try:
    from video_emojisaic import build_emoji_palette, mosaic_image
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from video_emojisaic import build_emoji_palette, mosaic_image

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024

REPO_ROOT = Path(__file__).resolve().parents[1]
EMOJIS_DIR = REPO_ROOT / "emojis"

palette_cache = {}
palette_lock = threading.Lock()


def clamp_int(value, minimum, maximum, default):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def get_palette_for_size(size: int):
    with palette_lock:
        cached = palette_cache.get(size)
        if cached is None:
            cached = build_emoji_palette(EMOJIS_DIR, size)
            palette_cache[size] = cached
        return cached


@app.route("/")
def index():
    return render_template("webcam.html")


@app.route("/process_frame", methods=["POST"])
def process_frame():
    frame_file = request.files.get("frame")
    if frame_file is None:
        return jsonify({"error": "No frame"}), 400

    size = clamp_int(request.form.get("size"), 4, 48, 12)
    max_block = clamp_int(request.form.get("max_block"), 1, 20, 8)

    pil_frame = Image.open(frame_file.stream).convert("RGB")

    max_dim = 960
    w, h = pil_frame.size
    if max(w, h) > max_dim:
        scale = max_dim / float(max(w, h))
        pil_frame = pil_frame.resize(
            (int(w * scale), int(h * scale)), Image.LANCZOS
        )

    palette_colors, palette_images = get_palette_for_size(size)
    mosaic = mosaic_image(
        pil_frame,
        palette_colors,
        palette_images,
        size=size,
        zoom=1,
        max_emoji_block=max_block,
    )

    buffer = io.BytesIO()
    mosaic.save(buffer, format="JPEG", quality=88)
    buffer.seek(0)
    return Response(buffer.getvalue(), mimetype="image/jpeg")


if __name__ == "__main__":
    print("Emoji Webcam running at http://localhost:5051")
    app.run(host="127.0.0.1", port=5051, debug=False)
