'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const ITEMS = {
  'xp-boost': { name: 'XP Boost', price: 1500, description: 'A collectible XP boost token for future perks.' },
  'vip-ticket': { name: 'VIP Ticket', price: 5000, description: 'A collectible VIP ticket for future rewards.' },
  'kiwi-crown': { name: 'Kiwi Crown', price: 10000, description: 'A rare KiwiVerse collector item.' },
};

async function ensureSchema(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS inventory (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, user_id, item_id)
  );`);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse or buy KiwiVerse shop items')
    .addSubcommand((sub) => sub.setName('view').setDescription('View the shop'))
    .addSubcommand((sub) => sub
      .setName('buy')
      .setDescription('Buy an item')
      .addStringOption((opt) => opt.setName('item').setDescription('Item to buy').setRequired(true).addChoices(
        ...Object.entries(ITEMS).map(([value, item]) => ({ name: `${item.name} — ${item.price} coins`, value })),
      )))
    .addSubcommand((sub) => sub.setName('inventory').setDescription('View your purchased items')),

  async execute(interaction, client, database) {
    const db = await database;
    await ensureSchema(db);
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const lines = Object.entries(ITEMS).map(([id, item]) => `**${item.name}** — ${item.price.toLocaleString()} 🪙\n${item.description}\nID: \`${id}\``).join('\n\n');
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle('🛍️ KiwiVerse Shop').setDescription(lines)] });
    }

    if (sub === 'inventory') {
      const rows = await db.all('SELECT item_id, quantity FROM inventory WHERE guild_id = ? AND user_id = ? AND quantity > 0 ORDER BY item_id', interaction.guild.id, interaction.user.id);
      const lines = rows.length ? rows.map((r) => `• **${ITEMS[r.item_id]?.name || r.item_id}** × ${r.quantity}`).join('\n') : 'Your inventory is empty.';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle(`🎒 ${interaction.user.username}'s Inventory`).setDescription(lines)] });
    }

    const itemId = interaction.options.getString('item');
    const item = ITEMS[itemId];
    const row = await db.get('SELECT balance FROM users WHERE discord_id = ?', interaction.user.id);
    const balance = row?.balance ?? 1000;
    if (balance < item.price) return interaction.reply({ content: `❌ You need **${item.price.toLocaleString()}** 🪙 but only have **${balance.toLocaleString()}**.`, flags: MessageFlags.Ephemeral });

    const newBalance = balance - item.price;
    await db.exec('BEGIN');
    try {
      await db.run(`INSERT INTO users (discord_id, username, balance) VALUES (?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, balance = excluded.balance`, interaction.user.id, interaction.user.username, newBalance);
      await db.run(`INSERT INTO inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, 1)
        ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + 1, updated_at = CURRENT_TIMESTAMP`, interaction.guild.id, interaction.user.id, itemId);
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }

    return interaction.reply({ content: `✅ Bought **${item.name}** for **${item.price.toLocaleString()}** 🪙. New balance: **${newBalance.toLocaleString()}** 🪙.` });
  },
};
