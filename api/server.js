'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { PermissionFlagsBits } = require('discord.js');

let server = null;
const startedAt = Date.now();
const oauthStates = new Map();
const sessions = new Map();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sendJson(res, status, payload, origin = '*') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, PATCH, POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  res.end();
}

function getAllowedOrigin(req) {
  const configured = process.env.DASHBOARD_ORIGIN || '*';
  const requestOrigin = req.headers.origin;
  if (configured === '*') return '*';
  return requestOrigin === configured ? configured : 'null';
}

function getPublicBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function cleanExpiredAuth() {
  const now = Date.now();
  for (const [state, expiresAt] of oauthStates.entries()) {
    if (expiresAt <= now) oauthStates.delete(state);
  }
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function getAuthorizedSession(req) {
  cleanExpiredAuth();
  const token = getBearerToken(req);
  if (!token) return null;

  const session = sessions.get(token);
  if (session && session.expiresAt > Date.now()) {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { token, session, type: 'session' };
  }

  // Optional server-to-server/admin fallback. Never expose this key in browser code.
  const apiKey = process.env.DASHBOARD_API_KEY;
  if (apiKey && token === apiKey) {
    return { token, session: { user: null }, type: 'apiKey' };
  }

  return null;
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

async function isDashboardAdmin(guild, discordUser) {
  const explicitlyAllowed = (process.env.DASHBOARD_ALLOWED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (explicitlyAllowed.includes(discordUser.id)) return true;
  if (!guild) return false;
  if (guild.ownerId === discordUser.id) return true;

  const member = await guild.members.fetch(discordUser.id).catch(() => null);
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.Administrator)
    || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

async function handleDiscordLogin(req, res) {
  if (!process.env.CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return sendJson(res, 503, { error: 'Discord OAuth is not configured' });
  }

  cleanExpiredAuth();
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);

  const redirectUri = `${getPublicBaseUrl(req)}/auth/discord/callback`;
  const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', process.env.CLIENT_ID);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'identify');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('prompt', 'consent');

  return redirect(res, authorizeUrl.toString());
}

async function handleDiscordCallback(req, res, client, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedExpiry = state ? oauthStates.get(state) : null;

  if (!code || !state || !expectedExpiry || expectedExpiry <= Date.now()) {
    if (state) oauthStates.delete(state);
    return sendJson(res, 400, { error: 'Invalid or expired OAuth state' });
  }
  oauthStates.delete(state);

  const redirectUri = `${getPublicBaseUrl(req)}/auth/discord/callback`;
  const tokenBody = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });

  if (!tokenResponse.ok) {
    console.error('Discord OAuth token exchange failed:', tokenResponse.status, await tokenResponse.text());
    return sendJson(res, 502, { error: 'Discord OAuth token exchange failed' });
  }

  const tokenData = await tokenResponse.json();
  const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userResponse.ok) {
    return sendJson(res, 502, { error: 'Could not load Discord user' });
  }

  const discordUser = await userResponse.json();
  const guild = getGuild(client);
  const allowed = await isDashboardAdmin(guild, discordUser);
  if (!allowed) {
    return sendJson(res, 403, { error: 'You are not allowed to manage this KiwiVerse server' });
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionToken, {
    user: {
      id: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name || null,
      avatar: discordUser.avatar || null,
    },
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  const dashboardOrigin = (process.env.DASHBOARD_ORIGIN || '').replace(/\/$/, '');
  if (!dashboardOrigin || dashboardOrigin === '*') {
    return sendJson(res, 500, { error: 'DASHBOARD_ORIGIN must be set to the live dashboard URL' });
  }

  // Fragment values are not sent to Base44's server. The frontend should save this
  // short-lived user session token to sessionStorage and immediately clear the hash.
  return redirect(res, `${dashboardOrigin}/#kiwiverse_session=${encodeURIComponent(sessionToken)}`);
}

async function handleRequest(req, res, client, database) {
  const origin = getAllowedOrigin(req);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {}, origin);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/auth/discord') {
      return handleDiscordLogin(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/auth/discord/callback') {
      return handleDiscordCallback(req, res, client, url);
    }

    const auth = getAuthorizedSession(req);
    if (!auth) {
      return sendJson(res, 401, { error: 'Unauthorized', loginUrl: '/auth/discord' }, origin);
    }

    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      if (auth.type === 'session') sessions.delete(auth.token);
      return sendJson(res, 200, { ok: true }, origin);
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      return sendJson(res, 200, {
        authenticated: true,
        authType: auth.type,
        user: auth.session.user,
        expiresAt: auth.type === 'session' ? auth.session.expiresAt : null,
      }, origin);
    }

    const guild = getGuild(client);
    const db = await database;

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

  if (!process.env.DISCORD_CLIENT_SECRET) {
    console.warn('⚠️ DISCORD_CLIENT_SECRET is missing; dashboard Discord login will not work.');
  }

  server = http.createServer((req, res) => handleRequest(req, res, client, database));
  server.listen(port, '0.0.0.0', () => {
    console.log(`✅ KiwiVerse Dashboard API listening on port ${port}`);
  });
  return server;
}

module.exports = { startApiServer };
