# Glutony ⚽

A Discord **user-installable** slash-command app for browsing **Blue Lock: Rivals** public servers. Hosted on **Cloudflare Workers** (no always-on bot process needed).

## About command

- `/info` shows a public Discord Components V2 project card with developer **N29**, Discord ID `1479778096834941099` and a Discord profile link.
- The card summarizes Glutony's features and commands and offers links to the [server browser](https://blr.n29.kz/servers/) and [source code](https://github.com/N29dev/Glutony).
- The command runs without D1 access or external API calls. It uses an allowed-mentions restriction to avoid pinging the developer.
- Re-run your existing authenticated `POST /admin/register` endpoint after deployment to add `/info` to the slash-command menu.

## Statistics command (new)

- `/stats` is a **private** Discord command (ephemeral, visible only to the person running it). Default view tracks command usage for Glutony: **all-time and past-7-UTC-day command counts**, **distinct users and guilds in the past 7 days**, command breakdown and `/blr` mode breakdown.
- `/stats view:8v8`, `/stats view:pro` and `/stats view:main` show **live sampled server activity**: joinable sampled server count, players, free slots, occupancy and average Roblox-reported ping. Samples exclude full servers and unscanned API pages; they are **not** global player counts.
- Command tracking runs only after verifying Discord's signature. No raw user IDs, guild IDs, message content, TikTok URLs, or IP addresses are stored by the analytics code. Daily unique users/guilds are HMAC-pseudonymized with the existing Cloudflare `SETUP_KEY` secret (or optional `STATS_HASH_KEY`). Without a secret, command counts still work, but unique IDs are not collected.
- Tracking starts **only after deployment**. Previous Cloudflare log history cannot be backfilled by this feature. Component-button clicks are not included in command counts.
- The existing `CUSTOMS_DB` D1 binding is reused. **Before enabling this branch**, apply the new migration to the production D1 database:

```bash
npx wrangler d1 migrations apply glutony-customs --remote
```

- Deploy the Worker and re-register slash commands using the existing authorized `POST /admin/register` endpoint. The registration now includes `/stats` alongside `/blr` and `/download`. Changing `/stats` options later also requires registration.
- Daily aggregates persist. Individual interaction IDs are kept only for retry deduplication (normally 14 days) and anonymous daily unique entries are pruned after 30 days. These cleanup jobs run opportunistically when new commands arrive, not via a scheduled cron.

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

## Shared region cache for Thirst, website and Discord

The Worker now supports a **short-lived D1 cache of RoValra region observations** so that the three N29 clients can reuse a previously resolved Roblox server location. This extends the existing shared `server_snapshots` mechanism; it does not change the public server sampling or Discord command schema.

- **Thirst** now checks `GET /api/servers/regions/lookup?mode=8v8&ids=UUID[,UUID...]` for BL:R Main/8v8/Pro servers. This **cache-miss lookup** accepts **1–25** public UUIDs even when they are missing from Glutony's own sampled server list. It reads D1 first; on a miss, the Worker asks RoValra and stores sanitized, short-lived results for the website and Discord bot. Thirst retains direct RoValra fallback when Glutony cannot answer.
- **Protection:** The new endpoint accepts only the three configured BL:R modes, never arbitrary URLs or place IDs. Missing entries are limited to **25 IDs per 60 seconds per source**, using a D1 atomic quota keyed by an HMAC pseudonym of the request IP, generated with the existing `SETUP_KEY` or optional `REGION_LOOKUP_HASH_KEY`. Raw IPs are never persisted, and the pseudonyms are cleaned up after a day. Requests without a valid caller IP or configured secret cannot trigger uncached upstream lookups. This is best-effort abuse protection; add Cloudflare WAF rate limits if public traffic grows.
- The existing `GET /api/servers/regions/shared` endpoint remains **sample-only** for lightweight legacy reads.
- **Website:** its existing `GET /api/servers` and `GET /api/servers/regions` paths call the same cached region lookup; no website source changes are required.
- **Discord bot:** its existing region enrichment uses the same function and shared cache. Old Discord messages do not automatically update, but newly opened/refreshed results benefit from cached observations.
- **Cache:** only sanitized city, state/region, country, optional version/first-seen metadata, a diagnostic reason, public Roblox place/server IDs, and observation/expiry timestamps are persisted. Positive region entries expire after **3 minutes**, missing results after **45 seconds**. No Roblox cookies, player tokens, account identifiers, full upstream response bodies, IP addresses or datacenter IDs are stored.
- **Provider:** RoValra is independent and credited in existing website/bot UI. Sharing a cache does not grant extra rights to redistribute or use its data; review [RoValra's API terms](https://www.rovalra.com/tou/) and disable `ROVALRA_REGIONS_ENABLED` if access is denied or they request removal.

**Required one-time deployment step:** Both `0007_shared_server_regions.sql` and `0008_shared_region_lookup_quota.sql` must be applied to the existing Cloudflare D1 database. This is not automatic when GitHub deploys the Worker. If only one region appears in Thirst, first verify that the live Worker actually has both tables.

Check the live Worker after deploying:

[Glutony region-cache status](https://glutony.scp343hey.workers.dev/api/servers/regions/status)

This public, read-only endpoint returns `cacheReady`, `quotaReady`, and `quotaSecretReady` without exposing secrets. **Both cache and quota must be true** before new regions can be saved; the secret readiness must also be true for protected cache misses. If it reports `migrations_required`, apply migrations to the Cloudflare D1 database and redeploy if necessary.

The `GET /api/servers/regions/lookup` endpoint now includes a `cache` summary with `requestedCount`, `foundCount`, `unknownCount`, `persistedCount`, `allPersisted`, and `missesRetried`. This explicitly distinguishes data merely returned by RoValra from data persisted for the website and bot. A missing migration produces a clear HTTP 503 rather than a misleading successful region lookup. GitHub deployment of `worker.mjs` alone does **not** apply migrations:

```bash
npx wrangler d1 migrations apply glutony-customs --remote
```

Use a Cloudflare-authenticated terminal or your existing secure CI deployment. **Do not copy a Cloudflare API token into Thirst, the website, Discord, a URL or this public repository.** A native desktop application cannot safely keep a shared secret. The lookup endpoint is read-only but can trigger a tightly quota-limited, fixed-host RoValra lookup; it never accepts client-provided region values and sends no Roblox or Discord credentials to RoValra.

Until both migrations are applied, Thirst's uncached shared lookup fails closed and falls back directly to RoValra; the website/Discord region enrichment continues using its old in-memory cache and upstream lookup. D1 read/write failures are non-fatal and are not surfaced as Roblox login errors. A successfully applied migration enables cross-isolate reuse, subject to cache expiry.

## Website server browser API

The public website at [blr.n29.kz/servers/](https://blr.n29.kz/servers/) uses the same Worker as the Discord bot. Endpoints:

- `GET /api/servers?mode=8v8`
- `GET /api/servers?mode=pro`
- `GET /api/servers/avatars?mode=pro&id=<public-job-uuid>` (optional player preview images)
- `GET /api/servers/regions?mode=8v8&ids=<comma-separated-Job-IDs>` — lightweight passive recheck for 1–8 active public instances; returns any newly known regions and metadata
- `GET /api/servers/regions/shared?mode=8v8&ids=<comma-separated-Job-IDs>` — bounded recheck of up to 25 currently sampled public BL:R instances (legacy sample-only endpoint)
- `GET /api/servers/regions/status` — public read-only migration/quota readiness (no credentials or sensitive details)
- `GET /api/servers/regions/lookup?mode=8v8&ids=<comma-separated-Job-IDs>` — bounded shared D1 cache-miss lookup for up to 25 **arbitrary public BL:R instance UUIDs**. For uncached valid IDs, the Worker fetches RoValra metadata and stores sanitized results with short TTL. It requires a valid Cloudflare-provided source IP, existing Worker HMAC secret, and the quota-table migration; never send an authorization token.

The website only retries **unknown** regions, approximately once every 75 seconds while open and visible, up to five background checks per page load.
- If RoValra's `/v1/servers/details` knows a `datacenter_id` but doesn't yet provide a city or country, Glutony now optionally looks up that **exact** ID in RoValra's public `/v1/datacenters/list` map (cached for 10 minutes). Unknown and ambiguous IDs remain unresolved.

- Each public server entry and bounded region refresh now carries `regionDiagnostic`, a fixed, non-sensitive reason code: `resolved`, `resolved_datacenter`, `rovalra_error`, `no_server_record`, `no_datacenter_id`, `datacenter_unmapped`, `datacenter_lookup_failed`, `disabled`, or `not_checked`. This intentionally excludes IP addresses, datacenter IDs, credentials and raw upstream error messages. Failures are cached with their reason so refreshes do not accidentally report a different cause.- These public requests use no Discord/Roblox credentials, and datacenter IDs/IP addresses are not returned to the website. This improves possible coverage; it **cannot guarantee** locations for servers that RoValra does not recognize.
 The Worker caches positive region details for 3 minutes; unknown locations for 45 seconds so newly available RoValra locations can appear without a manual page refresh. This is best-effort only: RoValra may not have a location for every public instance, so `Unknown region` can remain correct.
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

## Experimental alt-account region check (manual only)

A separate, **non-production** [Chrome region observer](tools/region-observer/README.md) can inspect one human-initiated Roblox join response in an isolated alt-account Chrome profile, then resolve its datacenter through RoValra's public map.

This is **not** a background Roblox bot or a Cloudflare feature. It does not upload credentials, extract browser cookies, or change existing Glutony API routes. See its README for testing and policy limitations.

## BL:R tech rules admin editor

The static public website at [blr.n29.kz/tech/](https://blr.n29.kz/tech/) shows the source moderation list compiled by N29 and loads **only admin overrides** from Glutony's D1 database. The public page still shows the original snapshot if the API is temporarily unavailable.

The private editor lives at [blr.n29.kz/tech/admin/](https://blr.n29.kz/tech/admin/). It allows N29 to create, edit, reclassify, add a YouTube video to, or hide an entry. New style names entered with a tech also appear in the public directory. Changes do **not** require a GitHub commit.

### One-time setup

1. **Before using admin edits**, apply the new existing-D1 migration:

```bash
npx wrangler d1 migrations apply glutony-customs --remote
```

   This creates only the new `tech_overrides` table. Existing customs, analytics, and Discord data stay unchanged.

2. Configure a **separate, random** `TECH_ADMIN_KEY` (at least 32 characters) in **Cloudflare → Workers & Pages → glutony → Settings → Variables and Secrets** as a **Secret**. Do **not** use your Discord `SETUP_KEY` or Roblox credentials. To generate one locally:

```bash
openssl rand -base64 36
```

   Copy the generated value only into the Cloudflare Secret and your admin panel's password field; **never share the value in chat, screenshots, or GitHub**. Cloudflare also supports `npx wrangler secret put TECH_ADMIN_KEY` from your authorized local project.

3. Deploy/redeploy `N29dev/Glutony` main via the existing Cloudflare GitHub integration, then open `https://blr.n29.kz/tech/admin/`. Paste the same key and choose **Connect**.

**Endpoint behavior:** `GET /api/tech` returns only the public additions/overrides/tombstones (no secrets). `GET /api/tech/admin/session` verifies the key; `PUT /api/tech/admin/entry/{id}` creates/updates; `DELETE /api/tech/admin/entry/{id}` hides. Admin requests require the separate secret as a Bearer token, CORS is restricted to `https://blr.n29.kz`, and all edits are validated. The admin key stays only in the currently open browser tab's JavaScript memory; refreshing or closing the page locks the editor again. The server does not return your key or other secrets.

The static original policy snapshot remains in `N29dev/blr/tech/data.js`. Removing an original listing with the admin editor stores a tombstone; it does not rewrite or destroy the original source file. The official moderation FAQ may change: keep the manually curated entries synchronized and never treat unlisted techniques as automatically permitted.

### Safety and limits

- The admin URL is **not** secure merely because it's separate; access is enforced on the Worker with `TECH_ADMIN_KEY`.
- The page intentionally does not request GitHub, Roblox, or Discord authentication.
- This is a manually curated unofficial index, not an automated moderation rules feed.
- A missing migration/database or missing admin secret disables editing but does **not** affect server finder or Discord commands.
- Admin edits are not shared to Roblox or RoValra.

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


## On-demand 8v8 and Pro match search

The 8v8 and Pro server browser now fetches Roblox **only when someone uses** the website, `/blr`, or server stats and the shared D1 snapshot is older than three minutes. Each refresh fetches **one public-server page**. A global D1 lease prevents separate users, regions, and modes from launching overlapping requests, and one shared cooldown protects against repeated Roblox HTTP 429 responses. The once-per-minute Cron is disabled; Main retains its pre-existing on-demand behavior.

- Samples no older than five minutes may be listed as verified; an older sample returns 503 with a safe error reason and a retry-after estimate, not a misleading live match.
- After a 429 or other upstream failure, all Worker isolates share exponential backoff (3 minutes, 6 minutes, 12 minutes, ... capped at one hour), respecting longer Roblox `Retry-After` values. Visitors during cooldown do not hit Roblox.
- The browser and Discord share the same D1 result. A fresh sample is written to D1 **before** the scanner releases the global lock.
- **Before deploying:** apply `0009_server_scan_gate.sql` (as well as any pending earlier migrations) to production `glutony-customs` with `npx wrangler d1 migrations apply glutony-customs --remote`. Without this table, public scans fail closed rather than multiplying requests.
- `wrangler.jsonc` declares an empty Cron schedule. Deploy the new Worker to remove the old scheduled trigger; confirm in Cloudflare → Workers → glutony → Settings → Triggers.
- `npm test` covers on-demand scans, D1 gate coordination, cache expiry and recovery from repeated Roblox 429 responses.


## RoValra regional BL:R discovery (opt-in deployment flag)

With the Cloudflare Worker variable `ROVALRA_MATCH_DISCOVERY_ENABLED=true`, website requests and Discord `/blr` use bounded RoValra regional discovery for **8v8 and Pro** instead of the rate-limited public Roblox server-list endpoint. Thirst remains unchanged: its native server browser can still obtain real Roblox player counts.

- **Six country codes per 30-second global discovery batch**, sequentially queried for both game modes (up to twelve total provider reads). A single D1 lease, persistent cooldown, and 15-minute backoff on errors prevent parallel traffic from multiplying requests. Countries cycle through US, DE, SG, BR, GB, JP, AU, FR, CA, NL, AE, KR, IN, PL, TR, HK, ID, ZA; coverage is **incremental and incomplete** during a warm-up.
- Each country snapshot is stored in D1 with an observation time and expires after 25 minutes. Each API response includes `source: "rovalra"`, `countsVerified: false`, and coverage. Per-instance `playing`, `maxPlayers`, `free`, and `ping` are **null**, not invented. Old instances might have closed; users can attempt joins but Roblox may redirect.
- RoValra returns optional `next_cursor`, but Glutony deliberately does **not** paginate through more results: this keeps provider usage bounded. Avoid claiming global, exhaustive or verified live coverage.
- Before enabling the flag, apply `migrations/0010_rovalra_discovery.sql` to production D1. If RoValra blocks, disables, or rate-limits requests, stop and honor their terms. To roll back, set `ROVALRA_MATCH_DISCOVERY_ENABLED=false` without removing the older Roblox scanner or cached snapshots.
- This is a BL:R-focused experimental integration. RoValra's API [terms](https://www.rovalra.com/tou/) prohibit scraping and replacement of their extension; [credit RoValra](https://www.rovalra.com/) and request permission if broader redistribution is needed.


## Optional Roblox occupancy overlay

When `ROVALRA_MATCH_DISCOVERY_ENABLED=true` and `ROBLOX_HYBRID_ENRICH_ENABLED=true`, RoValra remains the primary BL:R 8v8/Pro Job-ID discovery source. A **best-effort** Roblox public-server scan is launched in a Cloudflare `waitUntil` task on occasional website or Discord list reads, **no more than once every 20 minutes globally** for both game modes (shared D1 scan gate). It fetches a single page and honors Roblox HTTP 429 backoff. Requests do not block the server list and never retry immediately during a provider cooldown.

Only exact Job-ID matches from a successful `server_snapshots` sample that is **at most five minutes old** acquire `playing`, `maxPlayers`, `free`, `ping`, `occupancyVerified` and `occupancyUpdatedAt`. All unmatched IDs retain null counts. The response exposes `enrichedCount` and `enrichmentSampleAt` for diagnostics. Server player counts may change immediately and this is not a per-instance endpoint; a one-page scan is likely to match only a subset. It does not prove continued server availability.

Disable the overlay instantly by setting `ROBLOX_HYBRID_ENRICH_ENABLED=false`; this has no impact on RoValra discovery or its D1 cache. No additional D1 migration is needed: reuse `server_scan_gate` (migration 0009) and `server_snapshots` (migration 0005). Use only public API responses and do not bypass Roblox restrictions.
