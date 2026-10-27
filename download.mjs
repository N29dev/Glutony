// TikTok slash command: Cloudflare only queues work. The separate media service
// downloads, normalizes with FFmpeg, and edits the Discord interaction message.
const DISCORD_API = 'https://discord.com/api/v10';

export const DOWNLOAD_COMMAND = {
  name: 'download',
  description: 'Download a TikTok video as a mobile-compatible MP4',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [{
    name: 'url',
    description: 'TikTok video link (regular, vm.tiktok.com or vt.tiktok.com)',
    type: 3,
    required: true,
  }],
};

export function cleanTikTokURL(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const regular = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(host);
    const short = ['vm.tiktok.com', 'vt.tiktok.com'].includes(host);
    if (!regular && !short) return null;
    if (short ? !/^\/[a-z0-9_-]+\/?$/i.test(url.pathname)
              : !(/^\/@[\w.]+\/video\/\d+\/?$/i.test(url.pathname) ||
                  /^\/t\/[a-z0-9_-]+\/?$/i.test(url.pathname))) return null;
    url.hash = '';
    // Tracking parameters are not needed by the extractor.
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function updateResponse(interaction, content) {
  const endpoint = `${DISCORD_API}/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`;
  const res = await fetch(endpoint, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({content, allowed_mentions: {parse: []}}),
  });
  if (!res.ok) console.error('TikTok Discord edit failed:', res.status);
}

async function submitJob(interaction, url, env) {
  try {
    await updateResponse(interaction, '⏳ Downloading and repairing TikTok video for Discord mobile…');
    const endpoint = new URL('/jobs', env.TIKTOK_SERVICE_URL);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
      throw new Error('Invalid TIKTOK_SERVICE_URL (HTTPS required).');
    const res = await fetch(endpoint.toString(), {
      method: 'POST',
      redirect: 'error', // Never forward the service token to redirects.
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.TIKTOK_SERVICE_TOKEN}`,
      },
      body: JSON.stringify({
        url,
        application_id: String(interaction.application_id),
        interaction_token: String(interaction.token),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 202) return;
    if (res.status === 429) throw new Error('The video queue is busy. Try again shortly.');
    throw new Error(`The media service rejected the request (HTTP ${res.status}).`);
  } catch (error) {
    console.error('TikTok job submission failed:', String(error?.message || error));
    try {
      await updateResponse(interaction, '❌ Could not start the video download. Please try again later.');
    } catch (editError) {
      console.error('TikTok error edit failed:', String(editError?.message || editError));
    }
  }
}

export function handleDownload(interaction, env, ctx) {
  const input = interaction.data?.options?.find(o => o.name === 'url')?.value;
  const url = cleanTikTokURL(input);
  if (!url) return Response.json({type: 4, data: {content: '❌ Enter a valid TikTok **video** URL.', flags: 64}});
  if (!env.TIKTOK_SERVICE_URL || !env.TIKTOK_SERVICE_TOKEN)
    return Response.json({type: 4, data: {content: '⚠️ TikTok downloading is not configured yet. The bot owner needs to set up the media processor.', flags: 64}});
  ctx.waitUntil(submitJob(interaction, url, env));
  return Response.json({type: 5}); // Public deferred reply (not ephemeral).
}
