"""Asynchronous TikTok -> Discord MP4 repair service for Glutony.

Run behind HTTPS. Keep this service always on: jobs live in this process and
Discord interaction tokens expire after 15 minutes.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit

import requests
import yt_dlp
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Glutony TikTok processor", docs_url=None, redoc_url=None)
log = logging.getLogger("glutony.media")
logging.basicConfig(level=logging.INFO)
slots = threading.BoundedSemaphore(value=2)

MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
MAX_UPLOAD_BYTES = 19 * 1024 * 1024  # Conservative default for Discord.
MAX_DURATION_SECONDS = 300
DISCORD_API = "https://discord.com/api/v10"


class Job(BaseModel):
    url: str = Field(min_length=12, max_length=2048)
    application_id: str = Field(pattern=r"^\d{15,22}$")
    interaction_token: str = Field(min_length=10, max_length=350)


class VideoError(Exception):
    """User-safe failure to fetch/repair a video."""


def validate_tiktok(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port:
            return False
        host = (parsed.hostname or "").lower()
        if host in ("vm.tiktok.com", "vt.tiktok.com"):
            return bool(re.fullmatch(r"/[a-zA-Z0-9_-]+/?", parsed.path))
        if host in ("tiktok.com", "www.tiktok.com", "m.tiktok.com"):
            return bool(
                re.fullmatch(r"/@[\w.]+/video/\d+/?", parsed.path)
                or re.fullmatch(r"/t/[a-zA-Z0-9_-]+/?", parsed.path)
            )
    except ValueError:
        pass
    return False


def download_video(url: str, directory: Path) -> Path:
    # Never pass arbitrary user URLs to yt-dlp; /jobs validates TikTok hosts.
    def reject_long_video(info, incomplete):
        duration = info.get("duration")
        if duration and duration > MAX_DURATION_SECONDS:
            return "This video exceeds the five-minute limit."
        return None

    opts = {
        "format": "bv*+ba/b",
        "outtmpl": str(directory / "source.%(ext)s"),
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 20,
        "retries": 2,
        "fragment_retries": 2,
        "max_filesize": MAX_DOWNLOAD_BYTES,
        "match_filter": reject_long_video,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception as exc:
        log.warning("TikTok extraction failed: %s", type(exc).__name__)
        raise VideoError("TikTok could not be downloaded (private, removed or blocked video).") from exc
    candidates = [
        file for file in directory.glob("source.*")
        if file.is_file() and file.suffix.lower() in (".mp4", ".mov", ".webm", ".mkv")
    ]
    if not candidates:
        raise VideoError("TikTok did not provide a downloadable video.")
    source = max(candidates, key=lambda file: file.stat().st_size)
    if source.stat().st_size > MAX_DOWNLOAD_BYTES:
        raise VideoError("This TikTok is too large to process.")
    return source


def inspect_video(source: Path) -> None:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration", "-of", "json", str(source)],
            capture_output=True, text=True, check=True, timeout=15,
        )
        duration = float(json.loads(result.stdout)["format"]["duration"])
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, TypeError, KeyError) as exc:
        raise VideoError("The downloaded file is not a valid video.") from exc
    if not 0 < duration <= MAX_DURATION_SECONDS:
        raise VideoError("Only videos up to five minutes are supported.")


def encode_video(source: Path, directory: Path) -> Path:
    # Always re-encode: remuxing alone may preserve the broken timestamps or
    # nonstandard streams responsible for the Discord mobile 0:00 problem.
    for index, (max_dimension, crf, audio_kbps) in enumerate(
        [(1920, 20, 160), (1280, 26, 128), (960, 30, 96)]
    ):
        target = directory / f"fixed-{index}.mp4"
        scale = (
            f"scale=trunc(iw*min(1\\,{max_dimension}/max(iw\\,ih))/2)*2:-2,"
            "setsar=1"
        )
        command = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-fflags", "+genpts", "-i", str(source),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-map_metadata", "-1", "-map_chapters", "-1",
            "-vf", scale, "-r", "30",
            "-c:v", "libx264", "-preset", "veryfast",
            "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", f"{audio_kbps}k",
            "-af", "aresample=async=1:first_pts=0",
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+faststart", str(target),
        ]
        try:
            subprocess.run(command, capture_output=True, check=True, timeout=180)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            log.warning("FFmpeg encode failed (pass %s): %s", index, type(exc).__name__)
            raise VideoError("Could not repair this video's audio or video stream.") from exc
        if target.exists() and 0 < target.stat().st_size <= MAX_UPLOAD_BYTES:
            return target
        target.unlink(missing_ok=True)
    raise VideoError("The repaired video is too large for a Discord attachment.")


def edit_discord(job: Job, content: str, video: Path | None = None) -> None:
    # Discord webhook tokens are short-lived; do not log URLs or token values.
    app_id = os.environ["DISCORD_APPLICATION_ID"]
    endpoint = f"{DISCORD_API}/webhooks/{app_id}/{job.interaction_token}/messages/@original"
    payload = {"content": content, "allowed_mentions": {"parse": []}}
    if video:
        payload["attachments"] = [{"id": 0, "filename": "tiktok-fixed.mp4"}]
        with video.open("rb") as stream:
            response = requests.patch(
                endpoint, data={"payload_json": json.dumps(payload)},
                files={"files[0]": ("tiktok-fixed.mp4", stream, "video/mp4")},
                timeout=(10, 120),
            )
    else:
        response = requests.patch(endpoint, json=payload, timeout=(10, 20))
    if not response.ok:
        # Deliberately do not log the URL: it includes the interaction token.
        log.error("Discord message update failed (HTTP %s)", response.status_code)
        raise RuntimeError(f"Discord rejected message update: HTTP {response.status_code}")


def run_job(job: Job) -> None:
    try:
        with tempfile.TemporaryDirectory(prefix="glutony-tiktok-") as tmp:
            directory = Path(tmp)
            source = download_video(job.url, directory)
            inspect_video(source)
            fixed = encode_video(source, directory)
            edit_discord(job, "🎬 TikTok video • fixed for Discord mobile", fixed)
    except VideoError as exc:
        log.info("Video processing failed: %s", str(exc))
        try:
            edit_discord(job, f"❌ {exc}")
        except Exception:
            log.error("Failed to send video error to Discord")
    except Exception as exc:
        # Avoid tracebacks from HTTP clients: exception strings can contain the
        # webhook URL and therefore the secret Discord interaction token.
        log.error("Unexpected video processing error: %s", type(exc).__name__)
        try:
            edit_discord(job, "❌ Could not process this TikTok video. Please try another link.")
        except Exception:
            log.error("Failed to report video processing error to Discord")
    finally:
        slots.release()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/jobs", status_code=202)
def create_job(
    job: Job,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
):
    shared_token = os.getenv("TIKTOK_SERVICE_TOKEN", "")
    application_id = os.getenv("DISCORD_APPLICATION_ID", "")
    if not shared_token or not application_id:
        raise HTTPException(status_code=503, detail="Processor is not configured")
    if not authorization or not hmac.compare_digest(
        authorization, f"Bearer {shared_token}"
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if job.application_id != application_id or not validate_tiktok(job.url):
        raise HTTPException(status_code=400, detail="Invalid TikTok job")
    if not slots.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Video processor is busy")
    background_tasks.add_task(run_job, job)
    return {"queued": True}
