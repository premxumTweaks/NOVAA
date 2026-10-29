'use strict';
// HTTP integration test - runs the full server
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

// Set environment before requiring server
process.env.PORT = '3099';
process.env.DATA_DIR = path.join(__dirname, '..', 'data-test-http');
process.env.COOKIE_SECURE = 'false';

// Clean test data
try { fs.rmSync(path.join(__dirname, '..', 'data-test-http'), { recursive: true }); } catch(e) {}

let passed = 0;
let failed = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log('  PASS:', label);
    passed++;
  } else {
    console.error('  FAIL:', label, detail || '');
    failed++;
  }
}

async function req(method, path, body, cookieStr) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'Accept': 'application/json',
      'Host': 'localhost:3099',
      'Origin': 'http://localhost:3099'
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    if (cookieStr) headers['Cookie'] = cookieStr;

    const opts = { hostname: 'localhost', port: 3099, path, method, headers };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch(e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

function getCookie(res) {
  const sc = res.headers['set-cookie'];
  if (!sc) return null;
  const val = Array.isArray(sc) ? sc[0] : sc;
  return val.split(';')[0]; // just name=value
}

// Start server
require('../server.js');

async function run() {
  await new Promise(r => setTimeout(r, 500));

  console.log('\n[TEST] Health endpoint');
  const health = await req('GET', '/health', null, null);
  assert('health ok', health.status === 200 && health.body.ok === true);
  assert('health has schema', health.body.schema === 1);

  console.log('\n[TEST] GET /api/auth/me (no session)');
  const me0 = await req('GET', '/api/auth/me', null, null);
  assert('me with no session: ok true, user null', me0.status === 200 && me0.body.ok && me0.body.user === null);

  console.log('\n[TEST] Register');
  const reg = await req('POST', '/api/auth/register', { email: 'alice@test.nova', password: 'SecurePass111', name: 'Alice' });
  assert('register 201', reg.status === 201, 'got ' + reg.status);
  assert('register returns user', reg.body && reg.body.ok && reg.body.user && reg.body.user.email === 'alice@test.nova');
  const regCookie = getCookie(reg);
  assert('register sets cookie', typeof regCookie === 'string' && regCookie.startsWith('novaa_sid='));

  console.log('\n[TEST] GET /api/auth/me (after register)');
  const me1 = await req('GET', '/api/auth/me', null, regCookie);
  assert('me after register: user present', me1.status === 200 && me1.body.user !== null, JSON.stringify(me1.body));
  assert('me after register: correct email', me1.body.user && me1.body.user.email === 'alice@test.nova');

  console.log('\n[TEST] Duplicate register');
  const dup = await req('POST', '/api/auth/register', { email: 'alice@test.nova', password: 'SecurePass222' });
  assert('duplicate register 409', dup.status === 409);

  console.log('\n[TEST] Login correct');
  const login = await req('POST', '/api/auth/login', { email: 'alice@test.nova', password: 'SecurePass111', remember: true });
  assert('login 200', login.status === 200, JSON.stringify(login.body));
  assert('login returns user', login.body && login.body.ok && login.body.user);
  const loginCookie = getCookie(login);
  assert('login sets cookie', typeof loginCookie === 'string' && loginCookie.startsWith('novaa_sid='));

  console.log('\n[TEST] GET /api/auth/me with login session');
  const me2 = await req('GET', '/api/auth/me', null, loginCookie);
  assert('me with login session', me2.status === 200 && me2.body.user !== null);
  assert('correct user email', me2.body.user && me2.body.user.email === 'alice@test.nova');

  console.log('\n[TEST] Login wrong password');
  const badLogin = await req('POST', '/api/auth/login', { email: 'alice@test.nova', password: 'wrongpassword' });
  assert('wrong password 401', badLogin.status === 401);
  assert('error message', badLogin.body && badLogin.body.error);

  console.log('\n[TEST] Login non-existent email');
  const noUser = await req('POST', '/api/auth/login', { email: 'nobody@test.nova', password: 'SecurePass111' });
  assert('nonexistent user 401', noUser.status === 401);

  console.log('\n[TEST] Logout');
  const logout = await req('POST', '/api/auth/logout', null, loginCookie);
  assert('logout 200', logout.status === 200 && logout.body.ok === true);
  const clearCookie = logout.headers['set-cookie'];
  assert('logout clears cookie', clearCookie && (Array.isArray(clearCookie) ? clearCookie[0] : clearCookie).includes('Max-Age=0'));

  console.log('\n[TEST] GET /api/auth/me after logout');
  const me3 = await req('GET', '/api/auth/me', null, loginCookie);
  assert('me after logout: user null', me3.status === 200 && me3.body.user === null, JSON.stringify(me3.body));

  console.log('\n[TEST] Contact route still works');
  const contact = await req('POST', '/api/contact', {
    name: 'Bob Test', email: 'bob@test.com', message: 'Hello from the automated test suite. This message tests the contact route with enough characters.', company: 'Test Co', budget: '5k', scope: ['web']
  });
  assert('contact 201', contact.status === 201 && contact.body.ok === true, JSON.stringify(contact.body));

  console.log('\n[TEST] Short password validation');
  const shortPwd = await req('POST', '/api/auth/register', { email: 'short@test.nova', password: 'short' });
  assert('short password 422', shortPwd.status === 422);

  console.log('\n[TEST] Invalid email validation');
  const badEmail = await req('POST', '/api/auth/register', { email: 'notanemail', password: 'ValidPass123' });
  assert('invalid email 422', badEmail.status === 422);

  console.log('\n[TEST] Static pages reachable');
  const home = await new Promise((resolve) => {
    http.get('http://localhost:3099/', (res) => resolve({ status: res.statusCode }));
  });
  assert('home page 200', home.status === 200);

  const loginPage = await new Promise((resolve) => {
    http.get('http://localhost:3099/login', (res) => resolve({ status: res.statusCode }));
  });
  assert('login page 200', loginPage.status === 200);

  const registerPage = await new Promise((resolve) => {
    http.get('http://localhost:3099/register', (res) => resolve({ status: res.statusCode }));
  });
  assert('register page 200', registerPage.status === 200);

  const accountPage = await new Promise((resolve) => {
    http.get('http://localhost:3099/account', (res) => resolve({ status: res.statusCode }));
  });
  assert('account page 200', accountPage.status === 200);

  console.log('\n' + '='.repeat(50));
  console.log('HTTP Integration Results: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('Test error:', err); process.exit(1); });
