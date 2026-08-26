'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getStartingBalance } = require('../services/economyService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a member’s KiwiVerse profile')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to view')),

  async execute(interaction, client, database) {
    const target = interaction.options.getUser('user') || interaction.user;
    const db = await database;
    const row = await db.get('SELECT xp, level, balance, warnings, created_at FROM users WHERE discord_id = ?', target.id);
    const xp = Number(row?.xp || 0);
    const rank = await db.get('SELECT COUNT(*) + 1 AS rank FROM users WHERE xp > ?', xp);
    const balance = row?.balance ?? (await getStartingBalance(database, interaction.guild.id));

    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setAuthor({ name: `${target.username}'s KiwiVerse Profile`, iconURL: target.displayAvatarURL({ size: 128 }) })
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '⭐ Level', value: String(row?.level || 0), inline: true },
        { name: '✨ XP', value: xp.toLocaleString(), inline: true },
        { name: '🏆 XP Rank', value: `#${rank?.rank || 1}`, inline: true },
        { name: '💰 Balance', value: `${Number(balance).toLocaleString()} 🪙`, inline: true },
        { name: '⚠️ Warnings', value: String(row?.warnings || 0), inline: true },
        { name: '📅 First tracked', value: row?.created_at ? `<t:${Math.floor(new Date(row.created_at).getTime()/1000)}:D>` : 'Not tracked yet', inline: true },
      )
      .setTimestamp()] });
  },
};
