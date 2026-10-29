// Public information about the Glutony bot and its creator.
// Static content: no DB, Roblox or Discord API request required.
export const INFO_COMMAND = {
  name: 'info',
  description: 'Learn about Glutony, its creator, and useful links',
  type: 1,
  integration_types: [0, 1], // Guild and user installs
  contexts: [0, 1, 2],       // Servers and DMs
};

export const CREATOR_DISCORD_ID = '1479778096834941099';

export function infoMessage() {
  return {
    flags: 1 << 15, // Discord Components V2
    allowed_mentions: {parse: []}, // Resolve creator mention without pinging
    components: [
      {
        type: 17,
        accent_color: 0x32c99a,
        components: [
          {
            type: 10,
            content: [
              '## ⚽ Glutony · About the bot',
              'An unofficial **Blue Lock: Rivals** community tool for finding servers and sharing custom matches.',
              '',
              '**Developer:** N29 (<@' + CREATOR_DISCORD_ID + '>)',
              '**Discord ID:** `' + CREATOR_DISCORD_ID + '`',
              '',
              '**Features**',
              '• `/blr` — Browse Main, 8v8, Pro, and Customs',
              '• `/stats` — Bot usage and sampled BL:R server statistics',
              '• `/download` — Download and convert supported TikTok videos',
              '• `/info` — About the project and its creator',
              '',
              '**Platform:** Cloudflare Workers + D1',
              '-# Unofficial project. Not affiliated with Roblox or Blue Lock: Rivals.',
              '-# Server-region details may use RoValra data when available.',
            ].join('\n'),
          },
        ],
      },
      {
        type: 1,
        components: [
          {type: 2, style: 5, label: '🌐 Server Browser', url: 'https://blr.n29.kz/servers/'},
          {type: 2, style: 5, label: 'GitHub', url: 'https://github.com/N29dev/Glutony'},
          {type: 2, style: 5, label: 'Creator Profile', url: 'https://discord.com/users/' + CREATOR_DISCORD_ID},
        ],
      },
    ],
  };
}
