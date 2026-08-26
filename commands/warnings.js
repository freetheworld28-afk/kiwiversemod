'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View warning history for a member')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to check').setRequired(true)),

  async execute(interaction, client, database) {
    const target = interaction.options.getUser('user');
    const own = target.id === interaction.user.id;
    if (!own && !interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '⛔ You need Moderate Members to view another member’s warnings.', flags: MessageFlags.Ephemeral });
    }

    const db = await database;
    const user = await db.get('SELECT warnings FROM users WHERE discord_id = ?', target.id);
    const rows = await db.all(
      "SELECT id, moderator_id, reason, created_at FROM moderation_logs WHERE discord_id = ? AND lower(action) = 'warn' ORDER BY id DESC LIMIT 10",
      target.id,
    );
    const history = rows.length
      ? rows.map((r) => `**#${r.id}** • <@${r.moderator_id}> • ${r.reason || 'No reason'} • <t:${Math.floor(new Date(r.created_at).getTime()/1000)}:R>`).join('\n')
      : 'No warning history.';

    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle(`⚠️ ${target.username} — Warnings`)
      .setDescription(`Current warning count: **${user?.warnings || 0}**\n\n${history}`)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .setTimestamp()], flags: own ? undefined : MessageFlags.Ephemeral });
  },
};
