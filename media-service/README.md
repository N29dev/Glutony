# TikTok /download for Glutony

This feature uploads a **real MP4 attachment**, not a TikTok embed or URL rewrite.
The Worker cannot run FFmpeg, so the command requires a separate always-on media
service. The service downloads a TikTok with yt-dlp, re-encodes to standard
H.264 / yuv420p + AAC, removes old metadata, regenerates timestamps and uses
MP4 faststart. This helps fix Discord mobile videos stuck at 0:00 (no fix is
guaranteed for damaged inputs).

## 1. Deploy the media service

Deploy the `media-service/` directory as a **Docker web service** on a host
such as Railway, Fly.io, or a VPS. Set these private environment variables
on that service:

- `TIKTOK_SERVICE_TOKEN`: a long, random, secret string you create; **never**
  commit this or paste it into Discord.
- `DISCORD_APPLICATION_ID`: your existing Glutony Discord application ID,
  identical to the Worker setting.

Use an always-running instance with FFmpeg and enough CPU and ephemeral disk.
BackgroundTasks are in-process: a host that sleeps, restarts or scales to
zero during processing will drop jobs. You do **not** need a Discord bot
token in the media service. A public HTTPS URL should expose
`GET /health` and `POST /jobs`; /jobs is Bearer-token protected.

The Dockerfile installs Python, yt-dlp and FFmpeg. If running without Docker:

```sh
cd media-service
pip install -r requirements.txt
# Also install ffmpeg and ffprobe from your OS package manager.
export TIKTOK_SERVICE_TOKEN='your-long-random-secret'
export DISCORD_APPLICATION_ID='your-application-id'
uvicorn app:app --host 0.0.0.0 --port 8000
```

## 2. Configure the existing Cloudflare Worker

Keep all current variables/secrets. Add:

```sh
npx wrangler secret put TIKTOK_SERVICE_TOKEN
```

Use **the exact same secret** as in the media service.
Configure `TIKTOK_SERVICE_URL` as an ordinary Worker variable,
e.g. `https://your-media-service.example` (root URL, HTTPS).

You can configure it in **Cloudflare Workers > Glutony > Settings >
Variables and Secrets**, or with an appropriate local Wrangler environment.
Keep using the existing Worker and routes; do not replace it.

Deploy the updated Glutony Worker:

```sh
npm install
npm test
npm run deploy
```

## 3. Register both commands

Use your existing `POST /admin/register` with your private `SETUP_KEY`.
It now upserts **both /blr and /download**, and preserves existing /blr
subcommands. No extra Discord permissions are required.

```sh
curl -X POST 'https://YOUR-GLUTONY-WORKER/admin/register' \
  -H "Authorization: Bearer YOUR_SETUP_KEY"
```

The reply includes `commands` with both names.

## Usage

```
/download url:https://www.tiktok.com/@0nlyhunger/video/7701407832926637333
/download url:https://vt.tiktok.com/SHORT_CODE/
```

The response is public. The processor uploads `tiktok-fixed.mp4` as a
Discord attachment by **editing the original deferred interaction response**.
The interaction token expires in 15 minutes, so this is not a durable queue.

## Operational notes

- No TikTok credentials/cookies are configured. Private, removed, restricted
  or extractor-blocked videos may fail.
- Max duration: 5 minutes. Max source file: 100 MiB. The service attempts
  a high-quality encode, then 2 smaller variants, aiming below 19 MiB for
  default Discord limits. It may downscale/recompress; the original
  anti-compression patch is **not preserved**.
- Processing uses CPU and bandwidth, and third-party hosting may cost money.
  Only two jobs run concurrently per media-service process.
- This is intended for videos you have the right to download and repost.
- Do not print interaction tokens in logs or expose the service bearer secret.
- Restarting the media service may drop active jobs. For heavy usage or
  reliable job delivery, replace in-process BackgroundTasks with a durable
  external queue.
