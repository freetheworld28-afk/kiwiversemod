'use strict';

// Standalone test for the Dashboard API's OAuth state lifecycle
// (api/server.js's handleDiscordLogin/handleDiscordCallback/cleanExpiredAuth).
// Run with: node scripts/oauth-lifecycle-test.js
//
// Starts the REAL api/server.js HTTP server on a local test port and makes
// REAL HTTP requests against it - only Discord's own API (token exchange,
// /users/@me) is mocked via a global.fetch override, since a real Discord
// OAuth app can't be exercised in this environment. Everything else -
// routing, state validation, session creation, CORS headers - is the actual
// production code path, not a mock.

process.env.CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
process.env.GUILD_ID = 'guild-1';
process.env.DASHBOARD_ORIGIN = 'https://kiwi-verse-admin.base44.app';
process.env.API_PORT = '34599';

const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

async function main() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE guild_settings (
    guild_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id, key)
  );`);
  const database = Promise.resolve(db);

  const fakeGuild = {
    id: 'guild-1',
    ownerId: 'owner-id',
    members: { fetch: async (id) => (id === 'admin-user' ? { permissions: { has: () => true } } : null) },
  };
  const client = { guilds: { cache: new Map([['guild-1', fakeGuild]]) } };

  // Mock only Discord's own API - everything else is the real server.
  const originalFetch = global.fetch;
  let mockMode = 'success'; // 'success' | 'unauthorized-user' | 'token-fail'
  global.fetch = async (url, opts) => {
    if (String(url).includes('/oauth2/token')) {
      if (mockMode === 'token-fail') return { ok: false, status: 400, text: async () => 'invalid_grant' };
      return { ok: true, json: async () => ({ access_token: 'fake-access-token' }) };
    }
    if (String(url).includes('/users/@me')) {
      const userId = mockMode === 'unauthorized-user' ? 'random-user' : 'admin-user';
      return { ok: true, json: async () => ({ id: userId, username: 'Tester', global_name: null, avatar: null }) };
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const { startApiServer } = require('../api/server.js');
  startApiServer(client, database);
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the server finish binding

  const base = `http://127.0.0.1:${process.env.API_PORT}`;

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}${path}`, { method: options.method || 'GET', headers: options.headers || {} }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function extractState(location) {
    const url = new URL(location);
    return url.searchParams.get('state');
  }

  console.log('--- Test 1: successful OAuth issues a session and consumes the state ---');
  {
    mockMode = 'success';
    const login = await request('/auth/discord');
    if (login.status !== 302) throw new Error(`FAIL: expected 302 from /auth/discord, got ${login.status}`);
    const state = extractState(login.headers.location);
    console.log(`  Got state (redacted length only): ${state.length} chars`);

    const callback = await request(`/auth/discord/callback?code=fake-code&state=${state}`);
    console.log(`  Callback status: ${callback.status}, redirects to: ${callback.headers.location || '(none)'}`);
    if (callback.status !== 302) throw new Error(`FAIL: expected a redirect on successful login, got ${callback.status} ${callback.body}`);

    // Confirm the session token actually works. It's delivered in the URL
    // fragment (#kiwiverse_session=...), not a query param, so it never
    // reaches the dashboard's server logs.
    const sessionMatch = callback.headers.location.match(/#kiwiverse_session=([^&]+)/);
    if (!sessionMatch) throw new Error('FAIL: no session token found in the success redirect');
    const token = decodeURIComponent(sessionMatch[1]);
    const me = await request('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    console.log(`  /api/me with the new session token: ${me.status}`);
    if (me.status !== 200) throw new Error('FAIL: session token issued at login did not authenticate a follow-up request');

    // The state must be single-use: replaying it should now fail.
    const replay = await request(`/auth/discord/callback?code=fake-code&state=${state}`);
    console.log(`  Replaying the same state: ${replay.status}`);
    if (replay.status !== 400) throw new Error('FAIL: a consumed OAuth state was accepted a second time (not single-use)');
  }

  console.log('\n--- Test 2: failed OAuth (bogus state) is rejected and does not leak a session ---');
  {
    const callback = await request('/auth/discord/callback?code=fake-code&state=never-issued-state-xyz');
    console.log(`  status=${callback.status}, body=${callback.body}`);
    if (callback.status !== 400) throw new Error('FAIL: a bogus/never-issued state should be rejected with 400');
  }

  console.log('\n--- Test 3: failed OAuth (unauthorized Discord user) still consumes the state ---');
  {
    mockMode = 'unauthorized-user';
    const login = await request('/auth/discord');
    const state = extractState(login.headers.location);
    const callback = await request(`/auth/discord/callback?code=fake-code&state=${state}`);
    console.log(`  First attempt (unauthorized user): status=${callback.status}`);
    if (callback.status !== 403) throw new Error(`FAIL: expected 403 for an unauthorized Discord user, got ${callback.status}`);

    const replay = await request(`/auth/discord/callback?code=fake-code&state=${state}`);
    console.log(`  Replaying the same state after the 403: status=${replay.status}`);
    if (replay.status !== 400) throw new Error('FAIL: state should already be consumed even though authorization failed downstream');
    mockMode = 'success';
  }

  console.log('\n--- Test 4: expired OAuth state is rejected (simulated via a patched clock) ---');
  {
    const login = await request('/auth/discord');
    const state = extractState(login.headers.location);

    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000; // jump past the 10-minute OAuth state TTL
    let callback;
    try {
      callback = await request(`/auth/discord/callback?code=fake-code&state=${state}`);
    } finally {
      Date.now = realNow;
    }
    console.log(`  status=${callback.status}`);
    if (callback.status !== 400) throw new Error('FAIL: an expired OAuth state should be rejected');
  }

  console.log('\n--- Test 5: repeated login attempts stay bounded and the server keeps working ---');
  {
    const attempts = 50;
    let failures = 0;
    for (let i = 0; i < attempts; i++) {
      const login = await request('/auth/discord');
      if (login.status !== 302) failures++;
    }
    console.log(`  ${attempts} rapid /auth/discord hits: ${attempts - failures} succeeded, ${failures} failed`);
    if (failures > 0) throw new Error('FAIL: repeated login attempts should all succeed in issuing a redirect');
    // Each of these states is now abandoned (never completed) - this is
    // exactly the case the size cap + TTL sweep exist for. We can't reach
    // into the module-private oauthStates map from outside, but we CAN
    // confirm the server keeps responding correctly afterward, which it
    // would not if state accumulation broke request handling.
    const stillWorks = await request('/auth/discord');
    if (stillWorks.status !== 302) throw new Error('FAIL: server stopped responding correctly after a burst of login attempts');
    console.log('  Server still responds correctly after the burst.');
  }

  console.log('\n--- Test 6: CORS reflects only the configured DASHBOARD_ORIGIN, never a wildcard ---');
  {
    const matching = await request('/api/me', { headers: { Origin: process.env.DASHBOARD_ORIGIN } });
    const mismatched = await request('/api/me', { headers: { Origin: 'https://evil.example.com' } });
    console.log(`  matching origin -> Access-Control-Allow-Origin: ${matching.headers['access-control-allow-origin']}`);
    console.log(`  mismatched origin -> Access-Control-Allow-Origin: ${mismatched.headers['access-control-allow-origin']}`);
    if (matching.headers['access-control-allow-origin'] !== process.env.DASHBOARD_ORIGIN) throw new Error('FAIL: matching origin should be reflected back');
    if (mismatched.headers['access-control-allow-origin'] !== 'null') throw new Error('FAIL: a non-matching origin should get null, never a wildcard');
  }

  global.fetch = originalFetch;
  await db.close();
  console.log('\nAll OAuth lifecycle test assertions passed.');
  process.exit(0); // the API server's http.Server keeps the event loop alive
}

main().catch((error) => {
  console.error('\nOAUTH LIFECYCLE TEST FAILED:', error);
  process.exit(1);
});
