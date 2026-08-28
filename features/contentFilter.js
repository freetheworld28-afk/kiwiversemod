'use strict';

const { logEvent, markSuppressed } = require('../services/loggingService');
const { getCachedSettingsByPrefix } = require('../services/settingsService');

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

function containsForbiddenContent(rawText, { blockInvites }) {
  const text = normalizeText(rawText);
  if (blockInvites && INVITE_PATTERN.test(text)) return 'invite-link';

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
  async onMessage(message, client, database) {
    const settings = await getCachedSettingsByPrefix(database, message.guild.id, 'automod');
    if (settings.enabled === false) return;

    const violation = containsForbiddenContent(message.content || '', { blockInvites: settings.blockInvites !== false });
    if (!violation) return;

    // Mark this message ID before deleting it so the generic messageDelete
    // log handler skips it - this richer, violation-specific embed is the
    // log of record for filter-triggered deletions.
    markSuppressed(`message-delete:${message.id}`);
    await message.delete().catch(() => null);

    await logEvent(message.guild, database, 'automodAction', { message, violation });
  },
};
