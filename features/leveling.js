module.exports = {
  name: 'leveling',
  async onMessage(message, client, database, cache) {
    const db = await database;
    const now = Date.now();
    const cooldownKey = `xp_cooldown_${message.author.id}`;
    const lastXp = cache.get(cooldownKey);

    if (lastXp && now - lastXp < 60000) return;

    const xpGain = Math.floor(Math.random() * 11) + 15;
    const user = await db.get('SELECT * FROM users WHERE discord_id = ?', [message.author.id]);

    const currentXp = (user?.xp || 0) + xpGain;
    const currentLevel = Math.floor(Math.sqrt(currentXp) / 10);
    const previousLevel = user?.level || 0;

    await db.run(
      `INSERT INTO users (discord_id, username, xp, level, last_message)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET xp = ?, level = ?, last_message = ?`,
      [message.author.id, message.author.username, currentXp, currentLevel, new Date().toISOString(), currentXp, currentLevel, new Date().toISOString()],
    );

    cache.set(cooldownKey, now);

    if (currentLevel > previousLevel) {
      await message.react('🎉');
      const channel = message.channel;
      if (channel.isTextBased()) {
        await channel
          .send(`🎊 **${message.author.username}** leveled up to **Level ${currentLevel}**!`)
          .catch(() => null);
      }
    }
  },
};

