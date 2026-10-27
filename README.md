# Glutony ⚽

A Discord **user-installable** slash-command app for browsing **Blue Lock: Rivals** public servers. Hosted on **Cloudflare Workers** (no always-on bot process needed).

## Main lobby and interactive globe

- The public BL:R root place `18668065416` is now available as `/api/servers?mode=main` and website tab **Main**, and can be selected through Discord `/blr mode:main` after command re-registration.
- Main is deliberately limited to **24 joinable servers**, spread across **one Roblox public-server API page** per refresh. For 8v8/Pro, at most 60 joinable servers are selected evenly from the pages already scanned, improving geographic coverage without more Roblox/RoValra requests. No scan guarantees all possible server regions are represented.
- The website [region globe](https://blr.n29.kz/servers/?mode=main) groups every distinct RoValra-resolved city/region in the bounded sample under NA, SA, Brazil, Europe, Asia, Oceania, and Africa/Middle East. City pins use approximate city coordinates, falling back to country centers when needed. Select an individual city or an entire continental group to filter the visible server list. Unsupported/unknown locations have no invented markers.
- Geography outlines are bundled in the website repo with an MIT attribution file, and D3 is loaded on demand from a CDN only when the globe opens. The globe is independent of Customs private-server listings.
- After deploying this Worker update, **re-register** the Discord `/blr` command to expose the new **Main** choice. Existing registered choices won't change from a Worker deploy alone. The existing `POST /admin/register` route (Bearer `SETUP_KEY`) handles it; do not share or commit the key.

## Community Customs (new)

- Website: [blr.n29.kz/servers/customs/](https://blr.n29.kz/servers/customs/)
- Discord: `/blr mode:customs` → browse, **Post match** modal, report, remove your own listing
- Shared Cloudflare D1 storage keeps both interfaces synchronized; listings expire after four hours
- Optional **host-reported current player count** (0–20); capacity is fixed at **20 players** for every private server. Owners can refresh the count once per minute (website and Discord). Requires D1 migration `0002_customs_player_counts.sql`
- Host-selected region is **not** guaranteed to be the server's actual datacenter. Private invite URLs don't provide trustworthy live occupancy/location metadata
- Spam limits: verified Discord identity, one active post per user, 10-minute cooldown, three posts per day, duplicate-link blocking, reports, optional moderator bans
- Website posts/reports also require a verified Cloudflare Turnstile token

**Setup is intentionally required** before submissions are enabled. Follow [CUSTOMS_SETUP.md](CUSTOMS_SETUP.md) to create a D1 database, add the production binding to `wrangler.jsonc`, apply migrations, and configure Discord OAuth + Turnstile. Until then the 8v8 and Pro browser continues to work and Customs shows a disabled/pending state. Do not commit Discord OAuth secrets or Turnstile secret.

## Commands

| Command | Description | Roblox place |
| --- | --- | --- |
| `/blr mode:8v8` | Browse 8v8 public servers (16 players max) | `124087144919678` |
| `/blr mode:pro` | Browse Pro public servers (10 players max) | `99999183305180` |
| `/blr mode:customs` | Planned private-server matchmaking | Coming later |

Optional `sort`: most players, most free slots, or lowest **Roblox-reported** ping.

Features: compact paginated server list, region flags, server selector, detailed server cards, free slots, estimated uptime, place version, optional player-headshot previews, and PC/mobile Join links.

## Deploy the existing Glutony Worker from GitHub

This project is intended to connect to the **existing** Worker named **`glutony`**. Do **not** create a second Worker or replace the Discord Interactions Endpoint URL unnecessarily.

1. In [Cloudflare Dashboard](https://dash.cloudflare.com/) open **Workers & Pages → glutony → Settings → Builds**.
2. Select **Connect**, authorize Cloudflare to use GitHub, and choose **`N29dev/Glutony`**.
3. Set production branch **`main`** and root directory to repository root (default).
4. Build command: **leave empty** (plain JS Worker; no compilation). Deploy command: **`npx wrangler deploy`**.
5. Save settings. If Cloudflare doesn't deploy immediately, push another commit or manually trigger/retry a build.

The repository includes `wrangler.jsonc` with **`name: "glutony"`** and **`main: "worker.mjs"`**. The name must match the existing Worker in Cloudflare; rename the configuration if your actual Worker has a different name.

**GitHub deploy variable preservation:** `wrangler.jsonc` declares the public `DISCORD_APPLICATION_ID` and enables `keep_vars: true` so new GitHub deploys won't remove dashboard-managed plaintext variables. The Bot Token, Public Key and Setup Key remain dashboard-managed secrets—never add their real values to the repository.

**Secrets:** Keep these in **Cloudflare → glutony → Settings → Variables and Secrets**:

| Name | Type | Description |
| --- | --- | --- |
| `DISCORD_APPLICATION_ID` | Text/secret | Your Discord application ID |
| `DISCORD_PUBLIC_KEY` | Secret | Discord Ed25519 public key |
| `DISCORD_BOT_TOKEN` | Secret | Discord bot token, used only for `/admin/register` |
| `SETUP_KEY` | Secret | Long random key (at least 20 characters) for registration |
| `BLR_8V8_PLACE_ID` | Optional text | Defaults to `124087144919678` |
| `BLR_PRO_PLACE_ID` | Optional text | Defaults to `99999183305180` |
| `ROBLOX_MAX_PAGES` | Optional text | API page scan cap; default 3, maximum 5 |
| `ROVALRA_REGIONS_ENABLED` | Optional text | Set `false` to skip optional RoValra lookups |

**Never commit real tokens, secrets, or `.dev.vars` files to GitHub.** The repo is currently public.

## First deployment after connecting GitHub

For an **existing** Worker, simply connecting GitHub does not deploy the repo immediately. Cloudflare requires a **new commit pushed to the production branch** to trigger a build. A documentation-only commit works as a smoke test of the automatic deployment pipeline.

To check the outcome:

1. Open **Cloudflare → Workers & Pages → glutony → Deployments**.
2. Click **View build history** (this is separate from the active deployment list).
3. Find the latest `main` build and check **Success / Failed**.
4. If it failed, open its build logs. The active deployment can remain an older, manually deployed version until the new build succeeds.
5. Once succeeded, a new active deployment/version should appear.

Cloudflare documentation: https://developers.cloudflare.com/workers/ci-cd/builds/

## Discord setup

In the [Discord Developer Portal](https://discord.com/developers/applications), select Glutony:

- Interactions Endpoint URL: `https://<your-existing-worker>.workers.dev/interactions`.
- Enable **User Install**, including the `applications.commands` scope.
- Keep the existing application ID and public key in Cloudflare.

If you haven't registered the latest mode choices, run **once** in macOS zsh (replace the URL with your actual Worker URL):

```zsh
read -rs "GLUTONY_KEY?Glutony setup key: "
echo
curl -sS -X POST \
  "https://glutony.YOUR-SUBDOMAIN.workers.dev/admin/register" \
  -H "Authorization: Bearer $GLUTONY_KEY"
unset GLUTONY_KEY
```

You should see `"ok":true` and `"registered":"blr"`. Re-run registration whenever the slash-command schema changes (e.g., adding a new mode). Regular code or UI changes do **not** require it.

## Development

Requires Node.js 20 or later:

```bash
npm install
npm test
npm run dev
```

To deploy manually with a Cloudflare-authenticated local account: `npm run deploy`.

## Exact-instance join links (PC and mobile)

Roblox has a reported bug where `https://www.roblox.com/games/start?placeId=...&gameInstanceId=...` silently ignores `gameInstanceId` and puts the player in a random server. Glutony now uses a **Glutony-hosted HTTPS landing page** at `/join` for both buttons. This page requires the player to click **Open exact server in Roblox**, targeting the direct `roblox://experiences/start?placeId=...&gameInstanceId=...` protocol. Mobile also has an AppsFlyer fallback with `deep_link_value` for Android support.

The landing page validates the configured BL:R place and UUID-shaped Job ID. It never asks for login details. **No exact-server link can guarantee that Roblox respects the requested instance**, so warn users if Roblox redirects to another location. The GitHub-to-Cloudflare deployment does not require new secrets or command re-registration.

Relevant docs: https://create.roblox.com/docs/production/promotion/deeplinks and reported bug https://devforum.roblox.com/t/deep-link-ignores-gameinstanceid-argument/3815549

## Website server browser API

The public website at [blr.n29.kz/servers/](https://blr.n29.kz/servers/) uses the same Worker as the Discord bot. Endpoints:

- `GET /api/servers?mode=8v8`
- `GET /api/servers?mode=pro`
- `GET /api/servers/avatars?mode=pro&id=<public-job-uuid>` (optional player preview images)
- `GET /api/servers/regions?mode=8v8&ids=<comma-separated-Job-IDs>` — lightweight passive recheck for 1–8 active public instances; returns any newly known regions and metadata

The website only retries **unknown** regions, approximately once every 75 seconds while open and visible, up to five background checks per page load. The Worker caches positive region details for 3 minutes; unknown locations for 45 seconds so newly available RoValra locations can appear without a manual page refresh. This is best-effort only: RoValra may not have a location for every public instance, so `Unknown region` can remain correct.
- `GET /join?placeId=<place-id>&gameInstanceId=<public-job-uuid>&device=pc` (click-to-launch page)

The server list responds with place ID, mode, scanned pages, update time and up to 60 public instances: Job ID, players, capacity, Roblox-reported ping, RoValra region/version/first-seen metadata when available, and PC/mobile links. **Never expose user tokens or Discord credentials.** Browsers are allowed to read this data only from the website origin `https://blr.n29.kz` using CORS.

Static website source: [N29dev/blr](https://github.com/N29dev/blr/tree/main/servers).

## Message visibility

`/blr mode:8v8` and `/blr mode:pro` publish **non-ephemeral** Discord messages, visible to other participants in the channel/DM. To get the new behavior, run a **new** slash command after the updated Worker deploys; older ephemeral messages cannot be converted to public ones.

Discord servers can restrict public responses from user-installed apps with the **Use External Apps** permission (Server Settings → Roles → Apps Permissions). In that case the command may still appear privately. The server can alternatively install Glutony as a server app.

**Shared components:** Server selection, Refresh, Previous, Next, and Back update the **same public message**. This means one person's clicks change the view for everyone. For individual browsing use a fresh command or add per-user ephemeral details in a future update.

## Data and limitations

- **Public game servers:** Roblox `games.roblox.com`, sampled over a limited number of pages. Server population can change between browsing and joining.
- **Region, version, uptime:** optionally from [RoValra](https://www.rovalra.com/); attribution retained in Discord. Fields may be missing or stale. Uptime reflects **estimated time since first seen**, not guaranteed true uptime.
- **Avatar previews:** opportunistic Roblox public-thumbnail lookups from anonymized server-player tokens; may return no images.
- **Ping:** Roblox-reported value, **not** personal latency.
- **Exact-server joining:** PC/mobile launcher deep links can be ignored by some Roblox clients; verify on real devices.

Glutony is an unofficial fan project; not affiliated with Roblox, Discord, RoValra, or Blue Lock: Rivals. This project never needs another user's Roblox password, session cookie, or Discord authorization.

## Files

- `worker.mjs`: Cloudflare Worker HTTP interactions handler
- `wrangler.jsonc`: deployment config for existing `glutony`
- `package.json`: Wrangler scripts
- `test.mjs`: offline simulated-API checks


## TikTok `/download` (optional)

The `/download url:<TikTok video URL>` command sends a **real MP4 attachment**
with mobile-friendly H.264 video, AAC audio, regenerated timestamps and MP4
faststart (not merely a TikTok embed fix). It requires an external FFmpeg/
yt-dlp media service; Cloudflare Workers cannot transcode videos themselves.

See **[media-service/README.md](media-service/README.md)** for deployment,
shared-secret configuration, upload limits and `/admin/register` steps.
The existing `/blr` command is unchanged. Without the media service,
`/download` responds with a configuration notice instead of pretending to work.
