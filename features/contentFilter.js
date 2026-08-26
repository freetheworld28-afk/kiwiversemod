const { EmbedBuilder } = require('discord.js');
const { getLogChannel } = require('../services/loggingService');

const SLUR_FILTER = [
  'nigger',
  'nigga',
  'faggot',
  'kike',
  'tranny',
  'chink',
  'spic',
  'wetback',
  'retard',
];

const INVITE_PATTERN = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s]+/i;
const LEET_MAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

function normalizeText(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function containsForbiddenContent(rawText) {
  const text = normalizeText(rawText);
  if (INVITE_PATTERN.test(text)) return 'invite-link';

  const stripped = Array.from(text)
    .map((ch) => LEET_MAP[ch] ?? ch)
    .filter((ch) => /[a-z]/.test(ch))
    .join('');

  if (SLUR_FILTER.some((word) => stripped.includes(word))) {
    return 'slur';
  }

  return null;
}

module.exports = {
  name: 'contentFilter',
  async onMessage(message, client, database, cache) {
    const violation = containsForbiddenContent(message.content || '');
    if (!violation) return;

    await message.delete().catch(() => null);

    const logsChannel = await getLogChannel(message.guild, database, 'member');

    if (logsChannel) {
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🛑 Content Filter Triggered')
        .setDescription(`Intercepted and deleted a message from ${message.channel}.`)
        .addFields(
          { name: 'Member', value: `${message.author.tag} (${message.author.id})`, inline: true },
          { name: 'Channel', value: `${message.channel}`, inline: true },
          { name: 'Violation Type', value: violation === 'slur' ? 'Prohibited language' : 'Invite link', inline: true },
          { name: 'Content', value: message.content.substring(0, 500) || '*empty*' },
        )
        .setFooter({ text: 'Deleted automatically' })
        .setTimestamp();

      await logsChannel.send({ embeds: [embed] }).catch(() => null);
    }
  },
};

