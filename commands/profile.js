'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getStartingBalance } = require('../services/economyService');
const levelingService = require('../services/levelingService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a member’s KiwiVerse profile')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to view')),

  async execute(interaction, client, database) {
    const target = interaction.options.getUser('user') || interaction.user;
    const db = await database;

    // xp/level/rank: cache first, SQLite fallback for anyone not currently
    // active. balance/warnings/created_at aren't part of the leveling cache,
    // so those still come straight from SQLite as before.
    const [record, row] = await Promise.all([
      levelingService.getCurrentUser(database, interaction.guild.id, target.id, target.username),
      db.get('SELECT balance, warnings, created_at FROM users WHERE discord_id = ?', target.id),
    ]);

    const xp = record.xp;
    const rank = await levelingService.getEffectiveRank(database, target.id, xp);
    const balance = row?.balance ?? (await getStartingBalance(database, interaction.guild.id));

    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setAuthor({ name: `${target.username}'s KiwiVerse Profile`, iconURL: target.displayAvatarURL({ size: 128 }) })
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '⭐ Level', value: String(record.level), inline: true },
        { name: '✨ XP', value: xp.toLocaleString(), inline: true },
        { name: '🏆 XP Rank', value: `#${rank}`, inline: true },
        { name: '💰 Balance', value: `${Number(balance).toLocaleString()} 🪙`, inline: true },
        { name: '⚠️ Warnings', value: String(row?.warnings || 0), inline: true },
        { name: '📅 First tracked', value: row?.created_at ? `<t:${Math.floor(new Date(row.created_at).getTime()/1000)}:D>` : 'Not tracked yet', inline: true },
      )
      .setTimestamp()] });
  },
};
