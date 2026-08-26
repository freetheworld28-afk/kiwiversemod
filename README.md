# 🤖 KiwiVerse All-in-One Discord Bot

A comprehensive Discord bot featuring moderation, leveling, games, economy, giveaways, tickets, and much more.

> Railway deployment trigger: KiwiVerse V3 is now live on `main`, including the dashboard API and ticket system.

## ✨ Features

### 🛡️ Moderation
- Ban, kick, and timeout members
- Content filtering (slurs, invite links)
- Anti-raid detection & lockdown
- Moderation logging
- Warning system

### 💰 Economy System
- User balances & currency
- Daily rewards
- Games (coin flip, dice)
- Leaderboards
- Shop & purchases

### 📊 Leveling & XP
- Message-based XP gains
- Auto leveling
- Level-up announcements
- Profile system

### 🎉 Community Features
- Giveaway system
- Suggestions & voting
- Starboard (highlight messages)
- Reaction roles
- Tickets system

### 🎮 Games
- Coin flip
- Dice rolling
- Mini-games

### 🔧 Utility
- User info & profiles
- Server stats
- Reminders
- Auto-responses
- Help commands

## 🚀 Setup

### Prerequisites
- Node.js 18+
- Discord Bot Token
- SQLite3

### Installation

1. **Clone or download the repository**
   ```bash
   git clone https://github.com/yourusername/kiwiversemod.git
   cd kiwiversemod
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create `.env` file** (copy from `.env.example`)
   ```bash
   cp .env.example .env
   ```

4. **Fill in your environment variables**
   - `DISCORD_TOKEN`: Your Discord bot token
   - `CLIENT_ID`: Your bot's client ID
   - `GUILD_ID`: Your server's guild ID (optional, for guild-specific commands)
   - Configure channel names and role IDs

5. **Run the bot**
   ```bash
   npm start
   ```

## 📝 Configuration

Edit `.env` to customize:
- **Channels**: logs, welcome, general, suggestions, announcements
- **Roles**: mod roles, verified role
- **Features**: Toggle music, games, economy, etc.
- **Economy**: Starting balance, XP rewards

## 🤝 Invite Bot to Server

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your bot
3. Go to OAuth2 > URL Generator
4. Select scopes: `bot`, `applications.commands`
5. Select permissions:
   - Manage Messages
   - Manage Members
   - Manage Roles
   - Ban Members
   - Kick Members
   - Timeout Members
   - Embed Links
   - Attach Files
6. Copy the generated URL and visit it

## 📚 Commands

### Moderation
- `/ban <user> [reason]` - Ban a member
- `/kick <user> [reason]` - Kick a member
- `/timeout <user> <duration> [reason]` - Timeout a member

### Economy
- `/balance [user]` - Check your or another user's balance
- `/daily` - Claim your daily reward

### Games
- `/coinflip <amount> <choice>` - Flip a coin
- `/dice <amount> <number>` - Roll a dice

### User
- `/info [user]` - Get user profile info
- `/profile` - View your profile

### Community
- `/giveaway start <prize> <duration> [winners] [channel]` - Start a giveaway
- `/giveaway end <id>` - End a giveaway early and draw winners
- `/giveaway reroll <id>` - Reroll winners for an ended giveaway
- `/suggest <idea>` - Submit a suggestion for members to vote on
- `/reactionrole add <message_id> <emoji> <role> [channel]` - Bind a reaction to a role
- `/reactionrole remove <message_id> <emoji>` - Remove a reaction role binding
- `/reactionrole list <message_id>` - List reaction role bindings on a message

### Utility
- `/help` - Show all available commands

## 🗄️ Database

The bot uses SQLite with the following tables:
- `users` - User profiles, XP, levels, balance
- `verified_users` - Roblox account verification
- `moderation_logs` - Mod action history
- `giveaways` - Giveaway data
- `suggestions` - Community suggestions
- `tickets` - Support tickets
- `starboard` - Highlighted messages
- `reaction_roles` - Role reactions
- `autoresponses` - Auto-responses
- `infractions` - Bans/mutes tracking

## 📂 Project Structure

```
kiwiversemod/
├── index.js              # Main bot file
├── package.json          # Dependencies
├── .env.example          # Environment template
├── ecosystem.config.js   # PM2 config
├── database.sqlite       # SQLite database
├── events/               # Event handlers
│   ├── ready.js
│   ├── interactionCreate.js
│   ├── messageCreate.js
│   └── guildMemberAdd.js
├── commands/             # Slash commands
│   ├── moderation.js
│   ├── economy.js
│   ├── games.js
│   ├── info.js
│   └── help.js
└── features/             # Feature modules
    ├── leveling.js
    └── contentFilter.js
```

## 🐛 Troubleshooting

### Bot not responding to commands
- Check if bot has necessary permissions
- Verify `DISCORD_TOKEN` and `CLIENT_ID` are correct
- Ensure guild ID matches your server

### Database errors
- Delete `database.sqlite` and restart (will reinitialize)
- Check file permissions

### Permission errors
- Ensure bot role is placed above member roles
- Re-invite bot with correct permissions

## 📄 License

MIT

## 🤝 Contributing

Feel free to submit issues and enhancement requests!

---

Made with ❤️ for the KiwiVerse Community

