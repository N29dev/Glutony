# Enable Glutony Customs — one-time setup

**Code is committed; Customs is not ready for public submissions until the database and secrets below are configured.** The existing 8v8 and Pro browser works without them. The Customs browser displays an empty/pending state when the database binding is missing.

## 1. Create a Cloudflare D1 database

Run in a terminal in the `N29dev/Glutony` project (Cloudflare Wrangler installed through `npm install`):

```bash
npx wrangler login
npx wrangler d1 create glutony-customs
```

Wrangler prints a `database_id` UUID. **This ID is not a secret.** Add a `d1_databases` section to the existing `wrangler.jsonc` using the real ID:

```jsonc
"d1_databases": [
  {
    "binding": "CUSTOMS_DB",
    "database_name": "glutony-customs",
    "database_id": "YOUR-REAL-D1-DATABASE-UUID"
  }
]
```

**Important:** The database binding must be saved in **GitHub's `wrangler.jsonc`**, not only in the Cloudflare dashboard, because GitHub-driven Wrangler deployment should recreate it consistently. Do **not** commit a made-up UUID. Ask ChatGPT to update `wrangler.jsonc` once you have the real ID.

Apply the included schema:

```bash
npx wrangler d1 migrations apply glutony-customs --remote
```

This installs `customs`, `customs_reports`, and `customs_bans`.

## 2. Discord website sign-in

Open [Discord Developer Portal](https://discord.com/developers/applications) → Glutony → OAuth2 and add the **exact** redirect:

```
https://glutony.scp343hey.workers.dev/auth/discord/callback
```

Under OAuth2 find the Client Secret. In Cloudflare → glutony → Settings → Variables and Secrets add:

- `DISCORD_OAUTH_CLIENT_SECRET` — **Secret**: your Discord OAuth2 Client Secret
- `CUSTOMS_SESSION_SECRET` — **Secret**: a long independent random string (32+ characters)

The public `DISCORD_APPLICATION_ID=1563907646757666926` is already configured in `wrangler.jsonc`. Do not reuse your `SETUP_KEY` as the session signing secret.

Users grant only the **identify** scope to sign in on the website; Glutony does not ask for permission to join Discord servers.

## 3. Cloudflare Turnstile for website posting and reporting

Go to Cloudflare → Turnstile, create a new widget for hostname `blr.n29.kz`.

Store these in Cloudflare → glutony → Variables and Secrets:

- `CUSTOMS_TURNSTILE_SITEKEY` — plain Text (public site key)
- `CUSTOMS_TURNSTILE_SECRET` — **Secret** (server-side validation secret)

Both are required for website submissions/reports. Discord actions do not need Turnstile, because Discord has already authenticated and signed every interaction.

Cloudflare docs: https://developers.cloudflare.com/turnstile/get-started/ . The Worker calls Siteverify for **every** protected submission, and rejects expired/reused tokens.

Optional: `CUSTOMS_MODERATOR_IDS` (Text) — comma-separated trusted Discord user IDs that may remove abusive listings via Discord.

## Admin cooldown exemption

To grant your Discord account admin privileges in **both** Glutony's website and Discord app, add this **Cloudflare Worker runtime variable**:

- Name: `CUSTOMS_ADMIN_IDS`
- Type: **Text** (Discord user IDs are not secrets)
- Value: your personal Discord **User ID**, e.g. `123456789012345678` (example only)

To find your ID, enable **Discord User Settings → Advanced → Developer Mode**, then right-click your own profile and choose **Copy User ID**. Multiple administrators can be configured with comma-separated IDs. **Use user IDs, not the bot's application ID or Discord usernames.**

The Worker grants exemptions only after identity verification (Discord interaction signature or signed website OAuth session). No client-supplied `admin=true` parameter or username is trusted.

Admin exemptions:
- No 10-minute cooldown after removing/expiring an old listing.
- No 3-posts-per-day quota.
- Can remove abusive listings, just like `CUSTOMS_MODERATOR_IDS`.
- **Still limited to one active listing**, can't reuse an active share code, and must provide a valid Roblox invite. Website Turnstile, bans, and reports remain enforced.

Regular players and accounts in `CUSTOMS_MODERATOR_IDS` alone keep the normal posting limits. This is a separate admin privilege.

The Cloudflare dashboard variable persists with `keep_vars: true` in `wrangler.jsonc`. After adding it, check `/api/customs/me` while signed in: the JSON should include `"isAdmin":true` for your account. You do not need to re-register the `/blr` Discord command.

## 4. Verify

After the newest commits deploy on both repositories:

- Website: https://blr.n29.kz/servers/customs/
- Discord: `/blr mode:customs` → **Post match** (this mode already exists in the slash command choices; no new registration required)
- API status: https://glutony.scp343hey.workers.dev/api/customs/config → should have `available:true`, `authReady:true`, `canPost:true`.
- Public listings: https://glutony.scp343hey.workers.dev/api/customs

If `available:false`, the D1 binding hasn't been deployed. If `authReady:false`, OAuth secrets are absent. If `canPost:false`, Turnstile isn't configured.

## Abuse protection

- A listing requires a verified Discord account (Discord signed interaction or website OAuth2 `identify`).
- Public website **post** and **report** require a new successful Turnstile token.
- **One active match per Discord ID**; a **10-minute cooldown** and **three posts per 24 hours** (even if old listings are removed).
- **Four-hour listing expiry**, no public archive.
- Duplicate active share codes are blocked, with atomic SQL conditional inserts.
- Only canonical Roblox `https://www.roblox.com/share?code=...&type=Server` URLs are accepted; no arbitrary external sites or URL fetches of user-supplied input.
- The original poster can remove a listing; moderators can remove any listing.
- One report per reporter per listing; five reports per reporter per day. Four distinct reports place a listing into the hidden-for-review state.
- Administrators may manually block abusive accounts in D1 `customs_bans` (owner_id is a Discord snowflake).
- The listing database stores **Discord account ID and display name**, invitation URL and user-supplied text for moderation; it does not store OAuth access tokens or Roblox authentication data.
- RoValra doesn't verify private servers. New-style Roblox share codes do not reliably disclose which experience they target, so **community invitations are unverified** and may be wrong or malicious. Never enter passwords into any linked content.

Potential future safeguards before large public rollout: moderation dashboard, per-IP anomaly tracking, human review queue instead of automatic hiding, and validated BL:R private-server ownership when an appropriate Roblox API exists.

## Why GitHub alone is not enough

GitHub Pages serves static files. The shared persistent data is stored in Cloudflare D1 and controlled by the same Glutony Worker that serves Discord interactions. No bot token or Cloudflare secret goes into the public website repo.
