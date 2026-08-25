'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const roblox = require('../services/robloxVerificationService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roblox')
    .setDescription('Manage your linked Roblox accounts')
    .addSubcommand((sub) =>
      sub
        .setName('verify')
        .setDescription('Start verifying a Roblox account')
        .addStringOption((opt) => opt.setName('username').setDescription('Roblox username').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('confirm')
        .setDescription('Confirm a Roblox account after adding the code to your profile')
        .addStringOption((opt) => opt.setName('username').setDescription('Roblox username').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('accounts').setDescription('View your linked Roblox accounts'))
    .addSubcommand((sub) =>
      sub
        .setName('active')
        .setDescription('Set your active Roblox account')
        .addStringOption((opt) => opt.setName('username').setDescription('Linked Roblox username').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unlink')
        .setDescription('Unlink one of your Roblox accounts')
        .addStringOption((opt) => opt.setName('username').setDescription('Linked Roblox username').setRequired(true)),
    ),

  async execute(interaction, client, database) {
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'accounts') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const record = await roblox.getLinkedRecord(database, interaction.user.id);
        return interaction.editReply({ embeds: [roblox.accountsEmbed(record, interaction.user)] });
      }

      const username = interaction.options.getString('username', true).trim();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (sub === 'verify') {
        const result = await roblox.beginVerification(database, interaction.user, username);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });

        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('🔐 Verify your Roblox account')
          .setDescription(`To prove you own **${result.roblox.name}**, temporarily add the verification code below to your Roblox profile description.`)
          .addFields(
            { name: 'Verification code', value: `\`${result.code}\`` },
            { name: 'Next step', value: `After saving your Roblox profile, run \`/roblox confirm username:${result.roblox.name}\`.` },
            { name: 'Expires', value: `<t:${Math.floor(result.expiresAt / 1000)}:R>` },
          )
          .setFooter({ text: 'You can remove the code from your Roblox profile after verification.' });
        return interaction.editReply({ embeds: [embed] });
      }

      if (sub === 'confirm') {
        const result = await roblox.confirmVerification(database, interaction.user, username);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        return interaction.editReply({
          content: `✅ **${result.account.username}** is now verified and linked. You have **${result.accounts.length}/${roblox.MAX_ACCOUNTS}** linked Roblox accounts.`,
        });
      }

      if (sub === 'active') {
        const result = await roblox.setActive(database, interaction.user.id, username);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        return interaction.editReply({ content: `⭐ **${result.account.username}** is now your active Roblox account.` });
      }

      if (sub === 'unlink') {
        const result = await roblox.unlink(database, interaction.user.id, username);
        if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}` });
        return interaction.editReply({ content: `🗑️ **${username}** was unlinked. You now have **${result.accounts.length}/${roblox.MAX_ACCOUNTS}** linked accounts.` });
      }
    } catch (error) {
      console.error('Roblox command error:', error);
      return interaction.editReply({ content: '❌ Roblox verification is temporarily unavailable. Please try again shortly.' }).catch(() => null);
    }
  },
};
