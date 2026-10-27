"""Offline tests: no TikTok account, Discord token or network required."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from app import Job, create_job, encode_video, validate_tiktok, edit_discord, slots


class ProcessorTests(unittest.TestCase):
    def setUp(self):
        self.job = Job(
            url="https://www.tiktok.com/@example/video/7701407832926637333",
            application_id="123456789012345678",
            interaction_token="fake-interaction-token-for-testing",
        )

    def test_allowed_video_links(self):
        for url in (
            "https://www.tiktok.com/@example/video/7701407832926637333",
            "https://vt.tiktok.com/Ab12cd/",
            "https://vm.tiktok.com/Ab12cd/",
            "https://www.tiktok.com/t/ZAbcd123/",
        ):
            self.assertTrue(validate_tiktok(url), url)

    def test_reject_other_links(self):
        for url in (
            "http://www.tiktok.com/@example/video/123",
            "https://tiktok.com.evil.test/@example/video/123",
            "https://www.tiktok.com@127.0.0.1/@example/video/123",
            "https://www.tiktok.com/@example",
            "https://www.tiktok.com/@example/photo/123",
            "https://127.0.0.1/",
        ):
            self.assertFalse(validate_tiktok(url), url)

    def test_authorization_and_job_queue(self):
        with patch.dict(os.environ, {
            "TIKTOK_SERVICE_TOKEN": "local-media-secret",
            "DISCORD_APPLICATION_ID": self.job.application_id,
        }):
            with self.assertRaises(HTTPException) as exc:
                create_job(self.job, BackgroundTasks(), "Bearer wrong")
            self.assertEqual(exc.exception.status_code, 401)
            tasks = BackgroundTasks()
            try:
                result = create_job(self.job, tasks, "Bearer local-media-secret")
                self.assertEqual(result, {"queued": True})
                self.assertEqual(len(tasks.tasks), 1)
            finally:
                slots.release()

    def test_discord_upload_is_an_attachment(self):
        class FakeResponse:
            ok = True
            status_code = 200

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "fixed.mp4"
            path.write_bytes(b"fake mp4")
            with patch.dict(os.environ, {"DISCORD_APPLICATION_ID": self.job.application_id}):
                with patch("app.requests.patch", return_value=FakeResponse()) as mocked:
                    edit_discord(self.job, "Video ready", path)
                    args, kwargs = mocked.call_args
                    self.assertIn("/messages/@original", args[0])
                    self.assertEqual(kwargs["files"]["files[0]"][0], "tiktok-fixed.mp4")
                    payload = json.loads(kwargs["data"]["payload_json"])
                    self.assertEqual(payload["attachments"][0]["filename"], "tiktok-fixed.mp4")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg unavailable")
    def test_repaired_file_is_h264_aac_faststart(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "input.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                "-t", "1", "-c:v", "mpeg4", "-c:a", "aac", str(source)
            ], check=True)
            fixed = encode_video(source, directory)
            result = subprocess.run([
                "ffprobe", "-v", "error", "-show_entries",
                "stream=codec_name,pix_fmt", "-of", "json", str(fixed)
            ], capture_output=True, text=True, check=True)
            streams = json.loads(result.stdout)["streams"]
            self.assertTrue(any(s.get("codec_name") == "h264" and s.get("pix_fmt") == "yuv420p" for s in streams))
            self.assertTrue(any(s.get("codec_name") == "aac" for s in streams))
            data = fixed.read_bytes()
            self.assertLess(data.index(b"moov"), data.index(b"mdat"))


if __name__ == "__main__":
    unittest.main()
