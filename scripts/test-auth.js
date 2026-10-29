'use strict';
const http = require('node:http');
const { createStore } = require('../lib/db');
const auth = require('../lib/auth');

// Quick unit test for auth + db layer
const store = createStore({ dataDir: './data-test', legacyContactLog: null });
let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log('  PASS:', label);
    passed++;
  } else {
    console.error('  FAIL:', label);
    failed++;
  }
}

console.log('\n[TEST] Password hashing');
const hash = auth.hashPassword('MySecurePass99');
assert('hash is non-empty string', typeof hash === 'string' && hash.length > 20);
assert('verify correct password', auth.verifyPassword('MySecurePass99', hash));
assert('reject wrong password', !auth.verifyPassword('wrongpassword', hash));
assert('reject empty string', !auth.verifyPassword('', hash));

console.log('\n[TEST] User creation');
const uid = store.createUser('alice@nova.studio', hash, 'Alice');
assert('createUser returns numeric id', typeof uid === 'number' && uid > 0);
const user = store.findUserByEmail('alice@nova.studio');
assert('findUserByEmail finds user', user !== null);
assert('email matches', user.email === 'alice@nova.studio');
assert('display_name matches', user.display_name === 'Alice');

console.log('\n[TEST] Duplicate email');
const uid2 = store.createUser('alice@nova.studio', hash, 'Alice2');
assert('duplicate returns null', uid2 === null);

console.log('\n[TEST] Sessions');
const { token, idHash } = auth.newSessionToken();
assert('token is string', typeof token === 'string' && token.length > 20);
assert('idHash is string', typeof idHash === 'string' && idHash.length === 64);
store.createSession(idHash, uid, Date.now() + 86400000, '127.0.0.1', 'test-agent');
const sess = store.findSession(idHash);
assert('findSession returns session', sess !== null);
assert('session has email', sess.email === 'alice@nova.studio');

console.log('\n[TEST] Session expiry');
const { token: t2, idHash: h2 } = auth.newSessionToken();
store.createSession(h2, uid, Date.now() - 1000, '127.0.0.1', 'test-agent');
const expiredSess = store.findSession(h2);
assert('expired session still exists in DB', expiredSess !== null);
store.purgeExpiredSessions();
const afterPurge = store.findSession(h2);
assert('expired session removed after purge', afterPurge === null);

console.log('\n[TEST] Logout (delete session)');
store.deleteSession(idHash);
const afterDelete = store.findSession(idHash);
assert('session deleted', afterDelete === null);

console.log('\n[TEST] Validation helpers');
assert('validEmail ok', auth.validEmail('user@example.com'));
assert('validEmail bad', !auth.validEmail('not-an-email'));
assert('validPassword ok', auth.validPassword('abcdef1234'));
assert('validPassword too short', !auth.validPassword('short'));
assert('normalizeEmail trims + lowercases', auth.normalizeEmail('  USER@Example.COM  ') === 'user@example.com');

console.log('\n[TEST] Contact');
store.addContact({ name: 'Bob', email: 'bob@test.com', company: 'ACME', budget: '5k', scope: ['web'], message: 'Hello' }, '1.2.3.4');
const msgs = store.listContact(10);
assert('contact stored', msgs.length === 1 && msgs[0].email === 'bob@test.com');

store.close();

console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
