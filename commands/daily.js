'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getSetting } = require('../services/settingsService');

module.exports = {
  data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily KiwiVerse currency reward'),

  async execute(interaction, client, database) {
    const db = await database;
    const row = await db.get('SELECT balance, last_daily FROM users WHERE discord_id = ?', interaction.user.id);
    const now = Date.now();
    const last = row?.last_daily ? new Date(row.last_daily).getTime() : 0;
    const cooldown = 24 * 60 * 60 * 1000;
    if (last && now - last < cooldown) {
      const next = Math.floor((last + cooldown) / 1000);
      return interaction.reply({ content: `⏰ You already claimed your daily reward. Come back <t:${next}:R>.`, flags: MessageFlags.Ephemeral });
    }

    const reward = Number(await getSetting(database, interaction.guild.id, 'economy.dailyReward', 250)) || 250;
    const starting = Number(await getSetting(database, interaction.guild.id, 'economy.startingBalance', 1000)) || 1000;
    const balance = row ? Number(row.balance || 0) : starting;
    const nextBalance = balance + reward;
    await db.run(
      `INSERT INTO users (discord_id, username, balance, last_daily) VALUES (?, ?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, balance = excluded.balance, last_daily = excluded.last_daily`,
      interaction.user.id,
      interaction.user.username,
      nextBalance,
      new Date(now).toISOString(),
    );

    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🎁 Daily Reward Claimed')
      .setDescription(`You received **${reward.toLocaleString()}** 🪙`)
      .addFields({ name: 'New balance', value: `**${nextBalance.toLocaleString()}** 🪙` })
      .setTimestamp()] });
  },
};
