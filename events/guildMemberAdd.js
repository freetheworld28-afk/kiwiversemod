const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');
const { logEvent } = require('../services/loggingService');
const { getCachedSettingsByPrefix } = require('../services/settingsService');
const { notifyUser } = require('../services/notificationService');

function applyTemplate(template, member) {
  return template
    .replaceAll('{user}', member.user.toString())
    .replaceAll('{server}', member.guild.name);
}

// guildId -> Timeout that will lift a raid lockdown. Tracked (instead of a
// fire-and-forget setTimeout) so a second raid burst re-arms the timer
// instead of the original one silently lifting the newer lockdown early,
// and so the callback can be null-checked/caught instead of risking an
// unhandled promise rejection 5 minutes after the raid.
const raidLockdownTimers = new Map();

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member, client, database, cache) {
    try {
      await inviteTracker.handleMemberAdd(member, database);

      await logEvent(member.guild, database, 'memberJoin', { member });

      const welcomeSettings = await getCachedSettingsByPrefix(database, member.guild.id, 'welcome');

      if (welcomeSettings.enabled !== false) {
        const welcomeChannel = (welcomeSettings.channelId && member.guild.channels.cache.get(welcomeSettings.channelId))
          || member.guild.channels.cache.find((ch) => ch.name === process.env.WELCOME_CHANNEL_NAME && ch.isTextBased());

        const greeting = applyTemplate(welcomeSettings.message || 'Welcome {user} to {server}!', member);

        if (welcomeChannel?.isTextBased()) {
          const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('🎉 Welcome to the KiwiVerse Studio')
            .setDescription(
              `${greeting}\n\nRead through the studio rules below, then press **Accept Studio Rules** to unlock the rest of the server.`,
            )
            .addFields(
              { name: 'Rule 01 - Respect', value: 'Keep it civil. Zero tolerance for hate speech or harassment.' },
              { name: 'Rule 02 - No Spam', value: 'No spamming, raiding, or unsolicited advertising.' },
              { name: 'Rule 03 - Staff Calls', value: 'Follow direction from the KiwiVerse staff team at all times.' },
            )
            .setFooter({ text: 'KiwiVerse Moderation' })
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('accept_studio_rules')
              .setLabel('Accept Studio Rules')
              .setEmoji('✅')
              .setStyle(ButtonStyle.Success),
          );

          await welcomeChannel.send({ content: `${member.user}`, embeds: [embed], components: [row] }).catch((error) => console.error('[Welcome] Failed to send welcome message:', error));
        }

        if (welcomeSettings.dmWelcome) {
          await notifyUser(member.user, {
            title: `👋 Welcome to ${member.guild.name}`,
            description: greeting,
            color: 0x5865f2,
          });
        }

        if (welcomeSettings.autoRoleId) {
          await member.roles.add(welcomeSettings.autoRoleId, 'Welcome auto-role (dashboard setting)').catch((error) => console.error('[Welcome] Failed to add auto-role:', error));
        }
      }

      // Track raid attempts
      const now = Date.now();
      const guildId = member.guild.id;
      const raidLog = cache.get(`raid_log_${guildId}`) || [];
      const recentJoins = raidLog.filter((timestamp) => now - timestamp <= 5000);
      recentJoins.push(now);
      cache.set(`raid_log_${guildId}`, recentJoins);

      if (recentJoins.length >= 10) {
        const generalChannel = member.guild.channels.cache.find(
          (ch) => ch.name === process.env.GENERAL_CHANNEL_NAME && ch.isTextBased(),
        );
        if (generalChannel) {
          await generalChannel.permissionOverwrites.edit(member.guild.roles.everyone, {
            SendMessages: false,
          }).catch((error) => console.error('[Anti-Raid] Failed to lock channel:', error));

          await logEvent(member.guild, database, 'antiRaid', {
            joinCount: recentJoins.length,
            lockedChannel: generalChannel,
          });

          // Re-arm: cancel any prior lockdown timer for this guild so a
          // second raid burst doesn't get its lockdown lifted early by the
          // first burst's now-stale timer.
          const existingTimer = raidLockdownTimers.get(guildId);
          if (existingTimer) clearTimeout(existingTimer);

          const timer = setTimeout(async () => {
            raidLockdownTimers.delete(guildId);
            try {
              // Re-fetch rather than trust the channel object captured 5
              // minutes ago - it may have been deleted or renamed since.
              const guild = client.guilds.cache.get(guildId);
              const channel = guild?.channels.cache.get(generalChannel.id);
              if (!channel) return;
              await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
            } catch (error) {
              console.error('[Anti-Raid] Failed to lift lockdown:', error);
            }
          }, 5 * 60 * 1000);
          timer.unref?.();
          raidLockdownTimers.set(guildId, timer);
        }
      }
    } catch (error) {
      console.error('Error in guildMemberAdd:', error);
    }
  },
};
