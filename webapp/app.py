import os
import sys
import re
import io
import subprocess
import tempfile
import threading
import queue
import time
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_file
from PIL import Image

try:
    from video_emojisaic import build_emoji_palette, mosaic_image
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from video_emojisaic import build_emoji_palette, mosaic_image

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20MB

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "video_emojisaic.py"
JOBS_DIR = Path(tempfile.gettempdir()) / "emojisaic_jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
EMOJIS_DIR = REPO_ROOT / "emojis"

job_queue = queue.Queue()
jobs = {}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
palette_cache = {}
palette_lock = threading.Lock()


class Job:
    def __init__(self, input_path, fps, size, out_format, media_kind):
        self.id = uuid.uuid4().hex
        self.input_path = input_path
        self.fps = fps
        self.size = size
        self.out_format = out_format
        self.media_kind = media_kind
        self.status = "queued"
        self.progress = 0
        self.message = ""
        self.output_path = None
        self.created_at = time.time()


def ffmpeg_path() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    return "ffmpeg"


def parse_duration_seconds(ffmpeg_output: str) -> float:
    match = re.search(r"Duration:\s(\d+):(\d+):(\d+(?:\.\d+)?)", ffmpeg_output)
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def get_duration_seconds(video_path: Path) -> float:
    result = subprocess.run(
        [ffmpeg_path(), "-i", str(video_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return parse_duration_seconds(result.stderr)


def clamp_int(value, minimum, maximum, default):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def detect_media_kind(input_path: Path, mime_type: str) -> str:
    ext = input_path.suffix.lower()
    mime_type = (mime_type or "").lower()
    if ext in IMAGE_EXTENSIONS or mime_type.startswith("image/"):
        return "image"
    if ext in VIDEO_EXTENSIONS or mime_type.startswith("video/"):
        return "video"
    return "unknown"


def run_job(job: Job):
    job.status = "processing"
    job.progress = 10
    job.message = "Starting..."

    output_mp4 = Path(job.input_path).with_name("output.mp4")
    output_gif = Path(job.input_path).with_name("output.gif")
    output_png = Path(job.input_path).with_name("output.png")
    output_jpg = Path(job.input_path).with_name("output.jpg")

    job.progress = 30
    job.message = "Rendering mosaic..."
    if job.media_kind == "image":
        result = subprocess.run(
            [
                os.fspath(Path(sys.executable)),
                str(SCRIPT),
                "--image",
                str(job.input_path),
                "--size",
                str(job.size),
                "--out",
                str(output_png),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode != 0:
            job.status = "error"
            job.message = "Image processing failed"
            return
        job.progress = 85
        if job.out_format in ("jpg", "jpeg"):
            Image.open(output_png).convert("RGB").save(output_jpg, "JPEG", quality=95)
            job.output_path = str(output_jpg)
        else:
            job.output_path = str(output_png)
    else:
        cmd = [
            os.fspath(Path(sys.executable)),
            str(SCRIPT),
            "--video",
            str(job.input_path),
            "--fps",
            str(job.fps),
            "--size",
            str(job.size),
            "--out",
            str(output_mp4),
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode != 0:
            job.status = "error"
            job.message = "Video processing failed"
            return

        if job.out_format == "gif":
            job.progress = 80
            job.message = "Encoding GIF..."
            palette = Path(job.input_path).with_name("palette.png")
            subprocess.run(
                [ffmpeg_path(), "-y", "-i", str(output_mp4), "-vf", "fps=10,palettegen", str(palette)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            result = subprocess.run(
                [
                    ffmpeg_path(),
                    "-y",
                    "-i",
                    str(output_mp4),
                    "-i",
                    str(palette),
                    "-lavfi",
                    "fps=10,paletteuse",
                    str(output_gif),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if result.returncode != 0:
                job.status = "error"
                job.message = "GIF encoding failed"
                return
            job.output_path = str(output_gif)
        else:
            job.progress = 80
            job.message = "Encoding MP4..."
            job.output_path = str(output_mp4)

    job.status = "done"
    job.progress = 100
    job.message = "Done"


def get_palette():
    """Return full-resolution emoji palette (cached)."""
    with palette_lock:
        cached = palette_cache.get("full")
        if cached is None:
            cached = build_emoji_palette(EMOJIS_DIR, 0)
            palette_cache["full"] = cached
        return cached




def worker():
    while True:
        job = job_queue.get()
        try:
            run_job(job)
        finally:
            job_queue.task_done()


threading.Thread(target=worker, daemon=True).start()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/camera")
def camera():
    return render_template("camera.html")


@app.route("/process", methods=["POST"])
def process():
    media = request.files.get("media") or request.files.get("video")
    if media is None:
        return jsonify({"error": "Missing file"}), 400

    if not media.filename:
        return jsonify({"error": "No file selected"}), 400

    fps = clamp_int(request.form.get("fps"), 1, 30, 8)
    size = clamp_int(request.form.get("size"), 4, 48, 12)

    job_dir = JOBS_DIR / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    input_path = job_dir / media.filename
    media.save(input_path)

    media_kind = detect_media_kind(input_path, media.mimetype)
    if media_kind == "unknown":
        return jsonify({"error": "Unsupported file type. Use video or image files."}), 400

    if media_kind == "video":
        out_format = request.form.get("format", "mp4").lower()
        if out_format not in ("mp4", "gif"):
            return jsonify({"error": "Invalid format for video"}), 400
        duration = get_duration_seconds(input_path)
        if duration > 15.0:
            return jsonify({"error": "Video must be 15 seconds or less"}), 400
    else:
        out_format = request.form.get("format", "png").lower()
        if out_format not in ("png", "jpg", "jpeg"):
            return jsonify({"error": "Invalid format for image"}), 400

    job = Job(str(input_path), fps, size, out_format, media_kind)
    jobs[job.id] = job
    job_queue.put(job)

    return jsonify({"job_id": job.id, "media_kind": media_kind})


@app.route("/status/<job_id>")
def status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Not found"}), 404
    return jsonify(
        {
            "status": job.status,
            "progress": job.progress,
            "message": job.message,
        }
    )


@app.route("/download/<job_id>")
def download(job_id):
    job = jobs.get(job_id)
    if not job or job.status != "done":
        return jsonify({"error": "Not ready"}), 400
    if job.media_kind == "image":
        ext = "jpg" if job.out_format in ("jpg", "jpeg") else "png"
        filename = f"emojisaic.{ext}"
    else:
        filename = "emojisaic.gif" if job.out_format == "gif" else "emojisaic.mp4"
    return send_file(job.output_path, as_attachment=True, download_name=filename)


@app.route("/preview/<job_id>")
def preview(job_id):
    job = jobs.get(job_id)
    if not job or job.status != "done":
        return jsonify({"error": "Not ready"}), 400
    mime_map = {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "mp4": "video/mp4",
    }
    mimetype = mime_map.get(job.out_format, "application/octet-stream")
    return send_file(job.output_path, mimetype=mimetype)


@app.route("/process_frame", methods=["POST"])
def process_frame():
    frame_file = request.files.get("frame")
    if frame_file is None:
        return jsonify({"error": "No frame"}), 400

    size = clamp_int(request.form.get("size"), 4, 48, 12)
    zoom = clamp_int(request.form.get("zoom"), 1, 8, 4)
    bg = request.form.get("bg", "black")
    bg_color = (255, 255, 255) if bg == "white" else (0, 0, 0)

    pil_frame = Image.open(frame_file.stream).convert("RGB")

    # Client already scales down; just clamp as safety net
    max_dim = 480
    w, h = pil_frame.size
    if max(w, h) > max_dim:
        scale = max_dim / float(max(w, h))
        pil_frame = pil_frame.resize(
            (int(w * scale), int(h * scale)), Image.BILINEAR
        )

    palette_colors, palette_images = get_palette()
    mosaic = mosaic_image(
        pil_frame,
        palette_colors,
        palette_images,
        size=size,
        zoom=zoom,
        bg_color=bg_color,
    )

    buffer = io.BytesIO()
    mosaic.save(buffer, format="JPEG", quality=75)
    buffer.seek(0)
    return Response(buffer.getvalue(), mimetype="image/jpeg")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    app.run(host="0.0.0.0", port=port, debug=False)
