// Usage: node scripts/make-admin.mjs <username> <password>
// Writes seed-admin.sql (git-ignored). Run it against D1, then delete it.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 8 || !/^[a-z0-9._@-]{3,60}$/.test(username)) {
  console.error('Usage: node scripts/make-admin.mjs <username> <password>\n' +
    'username: lowercase letters/digits/._@-  |  password: at least 8 characters');
  process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256'); // must match src/index.js
const stored = `${salt.toString('hex')}:${hash.toString('hex')}`;
writeFileSync('seed-admin.sql',
  `INSERT INTO users (supplier_id, username, password_hash, role) VALUES (NULL, '${username}', '${stored}', 'admin');\n`);
console.log('Created seed-admin.sql');
