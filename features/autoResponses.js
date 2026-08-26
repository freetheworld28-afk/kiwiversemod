'use strict';

module.exports = {
  name: 'autoResponses',
  async onMessage(message, client, database) {
    const db = await database;
    const rows = await db.all('SELECT trigger, response FROM autoresponses WHERE guild_id = ? LIMIT 100', message.guild.id);
    if (!rows.length) return;

    const content = (message.content || '').trim().toLowerCase();
    const match = rows.find((row) => content === String(row.trigger || '').toLowerCase());
    if (!match) return;

    await message.reply({ content: String(match.response || '').slice(0, 2000), allowedMentions: { repliedUser: false } }).catch(() => null);
  },
};
