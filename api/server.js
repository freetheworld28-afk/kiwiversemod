'use strict';

const http = require('http');
const { URL } = require('url');

let server = null;
const startedAt = Date.now();

function sendJson(res, status, payload, origin = '*') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function getAllowedOrigin(req) {
  const configured = process.env.DASHBOARD_ORIGIN || '*';
  const requestOrigin = req.headers.origin;
  if (configured === '*') return '*';
  return requestOrigin === configured ? configured : 'null';
}

function isAuthorized(req) {
  const key = process.env.DASHBOARD_API_KEY;
  if (!key) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${key}`;
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getGuild(client) {
  const guildId = process.env.GUILD_ID;
  if (!guildId) return null;
  return client.guilds.cache.get(guildId) || null;
}

function serializeChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId || null,
    position: channel.rawPosition ?? 0,
  };
}

function serializeRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.hexColor,
    position: role.position,
    managed: role.managed,
    mentionable: role.mentionable,
  };
}

async function getConfig(db, guildId) {
  const rows = await db.all(
    'SELECT key, value FROM guild_settings WHERE guild_id = ? ORDER BY key ASC',
    guildId,
  );
  const config = {};
  for (const row of rows) {
    try {
      config[row.key] = JSON.parse(row.value);
    } catch {
      config[row.key] = row.value;
    }
  }
  return config;
}

async function patchConfig(db, guildId, updates) {
  const entries = Object.entries(updates || {});
  await db.exec('BEGIN');
  try {
    for (const [key, value] of entries) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) continue;
      await db.run(
        `INSERT INTO guild_settings (guild_id, key, value, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(guild_id, key)
         DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        guildId,
        key,
        JSON.stringify(value),
      );
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  return getConfig(db, guildId);
}

async function handleRequest(req, res, client, database) {
  const origin = getAllowedOrigin(req);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {}, origin);

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' }, origin);
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const guild = getGuild(client);
  const db = await database;

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        bot: {
          online: client.isReady(),
          username: client.user?.username || null,
          id: client.user?.id || null,
          ping: Math.round(client.ws.ping || 0),
          uptimeMs: Date.now() - startedAt,
        },
        database: 'connected',
        guildConnected: Boolean(guild),
      }, origin);
    }

    if (!guild) {
      return sendJson(res, 503, { error: 'Configured Discord guild is not available' }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/guild') {
      return sendJson(res, 200, {
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL({ size: 256 }) || null,
        memberCount: guild.memberCount,
        ownerId: guild.ownerId,
      }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/guild/channels') {
      const channels = guild.channels.cache
        .filter((channel) => channel.id !== guild.id)
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
        .map(serializeChannel);
      return sendJson(res, 200, { channels }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/guild/roles') {
      const roles = guild.roles.cache
        .filter((role) => role.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(serializeRole);
      return sendJson(res, 200, { roles }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, 200, { guildId: guild.id, config: await getConfig(db, guild.id) }, origin);
    }

    if (req.method === 'PATCH' && url.pathname === '/api/config') {
      const body = await readJson(req);
      const updates = body.config && typeof body.config === 'object' ? body.config : body;
      const config = await patchConfig(db, guild.id, updates);
      return sendJson(res, 200, { ok: true, guildId: guild.id, config }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/tickets') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      const tickets = await db.all(
        `SELECT id, channel_id AS channelId, user_id AS userId, guild_id AS guildId,
                status, created_at AS createdAt, closed_at AS closedAt
         FROM tickets WHERE guild_id = ? ORDER BY id DESC LIMIT ?`,
        guild.id,
        limit,
      );
      return sendJson(res, 200, { tickets }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/moderation') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      const actions = await db.all(
        `SELECT id, discord_id AS userId, action, moderator_id AS moderatorId,
                reason, created_at AS createdAt
         FROM moderation_logs ORDER BY id DESC LIMIT ?`,
        limit,
      );
      return sendJson(res, 200, { actions }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/roblox/accounts') {
      const rows = await db.all(
        `SELECT discord_id AS discordId, roblox_accounts AS robloxAccounts,
                active_roblox_id AS activeRobloxId, verified_at AS verifiedAt
         FROM verified_users ORDER BY verified_at DESC`,
      );
      const users = rows.map((row) => {
        let accounts = [];
        try { accounts = JSON.parse(row.robloxAccounts || '[]'); } catch { accounts = []; }
        return {
          discordId: row.discordId,
          accounts,
          activeRobloxId: row.activeRobloxId,
          verifiedAt: row.verifiedAt,
        };
      });
      return sendJson(res, 200, { users }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const [ticketRow, modRow, robloxRow] = await Promise.all([
        db.get(`SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND status = 'open'`, guild.id),
        db.get(`SELECT COUNT(*) AS count FROM moderation_logs WHERE created_at >= datetime('now', '-7 days')`),
        db.get(`SELECT COUNT(*) AS count FROM verified_users`),
      ]);
      const config = await getConfig(db, guild.id);
      return sendJson(res, 200, {
        members: guild.memberCount,
        openTickets: ticketRow?.count || 0,
        modActions7d: modRow?.count || 0,
        robloxLinks: robloxRow?.count || 0,
        enabledModules: Object.entries(config)
          .filter(([key, value]) => key.endsWith('.enabled') && value === true)
          .map(([key]) => key.replace(/\.enabled$/, '')),
      }, origin);
    }

    return sendJson(res, 404, { error: 'Not found' }, origin);
  } catch (error) {
    console.error('Dashboard API error:', error);
    return sendJson(res, 500, { error: 'Internal server error' }, origin);
  }
}

function startApiServer(client, database) {
  if (server) return server;
  const port = Number(process.env.API_PORT || process.env.PORT || 3000);

  if (!process.env.DASHBOARD_API_KEY) {
    console.warn('⚠️ DASHBOARD_API_KEY is missing; dashboard API will reject all requests.');
  }

  server = http.createServer((req, res) => handleRequest(req, res, client, database));
  server.listen(port, '0.0.0.0', () => {
    console.log(`✅ KiwiVerse Dashboard API listening on port ${port}`);
  });
  return server;
}

module.exports = { startApiServer };
