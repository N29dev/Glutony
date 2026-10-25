# Glutony ⚽

A Discord **user-installable** slash-command app for browsing **Blue Lock: Rivals** public servers. Hosted on **Cloudflare Workers** (no always-on bot process needed).

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
