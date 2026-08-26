'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('moneytop').setDescription('Show the richest KiwiVerse members'),

  async execute(interaction, client, database) {
    const db = await database;
    const rows = await db.all('SELECT discord_id, balance FROM users ORDER BY balance DESC LIMIT 10');
    const lines = rows.length
      ? rows.map((row, i) => `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i + 1}**`} <@${row.discord_id}> — **${Number(row.balance || 0).toLocaleString()}** 🪙`).join('\n')
      : 'Nobody has an economy balance yet.';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('💰 KiwiVerse Rich List').setDescription(lines).setTimestamp()] });
  },
};
