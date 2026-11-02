# Glutony: one-server region observer (experimental)

This is a **manual diagnostic**, **not** a production bot and **not** an automatic server scanner.

## Why this exists

RoValra can sometimes identify a Roblox public instance from its authenticated browser join response (the `joinScript.DataCenterId` field). That response can be inaccessible to a generic Cloudflare Worker. This experiment checks whether a **normal, human-initiated Join** from a separate Chrome profile exposes that datacenter ID on your machine. If available, it resolves the ID using RoValra's public `/v1/datacenters/list`.

**No credentials are requested or uploaded to Glutony.** The code does not read the Roblox session cookie or browser storage. Browser cookies remain in the dedicated Chrome profile directory, managed by Chrome. The script inspects the join response **locally**, logs only the selected public server ID and region result, and closes after one usable result. It never posts region reports to a third party.

## Prerequisites

- macOS, Windows, or Linux with Google Chrome installed
- Node.js 20+
- A separate Roblox alt account you control
- One **public** BL:R server whose region you want to verify

## Run locally (never in the Cloudflare Worker)

From the repository root:

```bash
cd tools/region-observer
npm install
npm test
npm start
```

An isolated Chrome browser window opens at the BL:R Pro experience page. Log into your own alt account there. Open a server list in that window and **manually click Join on one public instance**. You may navigate to another Roblox page in that same window if the default URL doesn't show a joinable server.

Optionally restrict the observer to one public server UUID:

```bash
npm start -- --server 11111111-2222-3333-4444-555555555555
```

The sample UUID above is only an example; replace it with a current server ID.

The observer listens to a **browser-generated** POST response for `https://gamejoin.roblox.com/v2/join-game-instance` and attempts to read `joinScript.DataCenterId`. If the ID matches RoValra's public datacenter map, it prints a city/region/country. It does **not** print full `joinScript`, account cookies, authentication headers, or server IP addresses.

Press **Ctrl+C** or close the browser to quit. The browser profile is stored locally at `~/.glutony-alt-region-profile` (unless `--profile` is used). Remove that directory if you no longer want the login/session retained.

## Interpretation

- **Location found**: a manual join response contained a usable datacenter ID, and RoValra's public map knew that ID.
- **DataCenterId missing**: the browser response didn't contain the expected field; this is not evidence that Roblox has no location.
- **No response observed**: Roblox may use another join flow, launch the desktop app, or restrict observation. The experiment is inconclusive.
- **Map unavailable / no match**: the datacenter ID was seen, but RoValra's public map could not identify it.
- **HTTP error**: Roblox may reject the request, or the session could be restricted. No automatic retry is attempted.

This observer does **not** prove that automatic remote Roblox join API calls will work. RoValra's current code can generate `x-bound-auth-token` from a browser-bound authentication context. Roblox's [April 2026 cookie-API guidance](https://devforum.roblox.com/t/roblox-data-stewardship-principles-cookie-based-api-update/4579220) states that cookie-authenticated APIs are meant for human website/app usage and are not recommended for production automation. A spare account does not remove those restrictions.

## Safety constraints

- Do not send Roblox credentials, `.ROBLOSECURITY` cookies, or session tokens through Discord, GitHub, or ChatGPT.
- Do not upload the Chrome profile directory or allow it into a Git repository.
- Do not repurpose this as a scheduled API scanner without checking current Roblox authorization requirements and compliance.
- There is deliberately **no** Glutony API ingestion, persistent server tracking, unattended scanning, or Cloudflare deployment.
- Running a browser observer cannot guarantee that the GameJoin response contains a datacenter ID.

If the one-server experiment succeeds, the next step is to evaluate a **consent-based, minimally scoped region-reporting design** with expiration, validation, and strictly no Roblox session data leaving the user's browser.
