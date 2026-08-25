const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member, client, database, cache) {
    try {
      await inviteTracker.handleMemberAdd(member, database);

      // Deliver welcome message
      const welcomeChannel = member.guild.channels.cache.find(
        (ch) => ch.name === process.env.WELCOME_CHANNEL_NAME && ch.isTextBased(),
      );

      if (welcomeChannel) {
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('🎉 Welcome to the KiwiVerse Studio')
          .setDescription(
            `Hey ${member.user}, glad you made it in!\n\nRead through the studio rules below, then press **Accept Studio Rules** to unlock the rest of the server.`,
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

        await welcomeChannel.send({ content: `${member.user}`, embeds: [embed], components: [row] });
      }

      // Track raid attempts
      const now = Date.now();
      const raidLog = cache.get(`raid_log_${member.guild.id}`) || [];
      const recentJoins = raidLog.filter((timestamp) => now - timestamp <= 5000);
      recentJoins.push(now);
      cache.set(`raid_log_${member.guild.id}`, recentJoins);

      if (recentJoins.length >= 10) {
        const generalChannel = member.guild.channels.cache.find(
          (ch) => ch.name === process.env.GENERAL_CHANNEL_NAME && ch.isTextBased(),
        );
        if (generalChannel) {
          await generalChannel.permissionOverwrites.edit(member.guild.roles.everyone, {
            SendMessages: false,
          });

          const logsChannel = member.guild.channels.cache.find(
            (ch) => ch.name === process.env.LOGS_CHANNEL_NAME && ch.isTextBased(),
          );
          if (logsChannel) {
            const raidEmbed = new EmbedBuilder()
              .setColor(0xed4245)
              .setTitle('🚨 Anti-Raid Lockdown Engaged')
              .setDescription(`Detected **${recentJoins.length} joins** in a 5-second window.`)
              .addFields({ name: 'Channel Locked', value: `${generalChannel}` })
              .setTimestamp();
            await logsChannel.send({ embeds: [raidEmbed] });
          }

          setTimeout(() => {
            generalChannel.permissionOverwrites.edit(member.guild.roles.everyone, { SendMessages: null });
          }, 5 * 60 * 1000);
        }
      }
    } catch (error) {
      console.error('Error in guildMemberAdd:', error);
    }
  },
};
