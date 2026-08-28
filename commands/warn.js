'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { notifyUser } = require('../services/notificationService');
const { logEvent } = require('../services/loggingService');
const { getSettingsByPrefix } = require('../services/settingsService');

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

    const modSettings = await getSettingsByPrefix(database, interaction.guild.id, 'moderation');
    if (modSettings.enabled === false) {
      return interaction.reply({ content: '⛔ Moderation commands are currently disabled for this server (dashboard setting).', flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    if (target.bot) return interaction.reply({ content: 'You cannot warn bots.', flags: MessageFlags.Ephemeral });

    try {
      const db = await database;

      // The warning count and its audit-log row must stay in sync - wrap
      // both writes in a transaction so a mid-sequence crash can't leave
      // one without the other.
      await db.exec('BEGIN');
      try {
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
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }

      const row = await db.get('SELECT warnings FROM users WHERE discord_id = ?', target.id);
      const totalWarnings = row?.warnings || 1;

      const dm = modSettings.dmAffectedUsers === false
        ? { delivered: false, error: 'DM disabled by dashboard setting' }
        : await notifyUser(target, {
          title: `⚠️ Warning in ${interaction.guild.name}`,
          description: 'A moderator issued you a warning.',
          color: 0xfee75c,
          fields: [
            { name: 'Reason', value: reason },
            { name: 'Total warnings', value: String(totalWarnings), inline: true },
          ],
        });

      await logEvent(interaction.guild, database, 'memberWarn', {
        target,
        moderator: interaction.user,
        reason,
        totalWarnings,
        dmDelivered: dm.delivered,
      });

      return interaction.reply({ content: `⚠️ Warned **${target.tag}**. They now have **${totalWarnings}** warning(s).`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      console.error('[Moderation] Warn command failed:', error);
      return interaction.reply({ content: `❌ Failed to warn user: ${error.message}`, flags: MessageFlags.Ephemeral });
    }
  },
};
