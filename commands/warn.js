'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { notifyUser } = require('../services/notificationService');
const { getLogChannel } = require('../services/loggingService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member and record the warning')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Warning reason').setRequired(true).setMaxLength(500)),

  async execute(interaction, client, database) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return interaction.reply({ content: '⛔ You need Moderate Members to warn users.', flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    if (target.bot) return interaction.reply({ content: 'You cannot warn bots.', flags: MessageFlags.Ephemeral });

    const db = await database;
    await db.run(
      `INSERT INTO users (discord_id, username, warnings) VALUES (?, ?, 1)
       ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, warnings = COALESCE(users.warnings, 0) + 1`,
      target.id,
      target.username,
    );
    await db.run(
      'INSERT INTO moderation_logs (discord_id, action, moderator_id, reason) VALUES (?, ?, ?, ?)',
      target.id,
      'warn',
      interaction.user.id,
      reason,
    );

    const row = await db.get('SELECT warnings FROM users WHERE discord_id = ?', target.id);
    const dm = await notifyUser(target, {
      title: `⚠️ Warning in ${interaction.guild.name}`,
      description: 'A moderator issued you a warning.',
      color: 0xfee75c,
      fields: [
        { name: 'Reason', value: reason },
        { name: 'Total warnings', value: String(row?.warnings || 1), inline: true },
      ],
    });

    const logs = await getLogChannel(interaction.guild, database, 'member');
    if (logs) {
      await logs.send({ embeds: [new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('⚠️ Warning Issued')
        .addFields(
          { name: 'Member', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: interaction.user.tag, inline: true },
          { name: 'Total warnings', value: String(row?.warnings || 1), inline: true },
          { name: 'Reason', value: reason },
          { name: 'Member DM', value: dm.delivered ? '✅ Delivered' : '⚠️ Not delivered', inline: true },
        )
        .setTimestamp()] }).catch((error) => console.error('Failed to post warn log:', error));
    }

    return interaction.reply({ content: `⚠️ Warned **${target.tag}**. They now have **${row?.warnings || 1}** warning(s).`, flags: MessageFlags.Ephemeral });
  },
};
