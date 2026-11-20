// One-time setup for silent printing. Makes a certificate + private key for QZ Tray.
//   npm run qz:cert
// Writes:
//   public/qz-cert.txt        the certificate the portal page gives to QZ Tray (public, gets deployed)
//   qz-install/override.crt   the same certificate: copy it into the QZ Tray folder on every printing computer
//   qz-private-key.pem        the private key (secret, never deploy or share it)
import { createRequire } from 'node:module';
import { createPrivateKey } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const selfsigned = require('selfsigned');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (existsSync(join(root, 'qz-private-key.pem')) && !process.argv.includes('--force')) {
  console.log('A key already exists (qz-private-key.pem). Run with --force only if you really want a new one:\n  npm run qz:cert -- --force');
  console.log('A new key means copying the new override.crt to every printing computer again.');
  process.exit(0);
}

const pems = selfsigned.generate(
  [{ name: 'commonName', value: 'Supplier Portal' }, { name: 'organizationName', value: 'Supplier Portal' }],
  {
    keySize: 2048, days: 3650, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true }],
  },
);
// Cloudflare Workers need the key as PKCS#8
const pkcs8 = createPrivateKey(pems.private).export({ type: 'pkcs8', format: 'pem' });

mkdirSync(join(root, 'qz-install'), { recursive: true });
writeFileSync(join(root, 'public', 'qz-cert.txt'), pems.cert);
writeFileSync(join(root, 'qz-install', 'override.crt'), pems.cert);
writeFileSync(join(root, 'qz-private-key.pem'), pkcs8);

console.log(`
Done. Three more steps:

1. Give the private key to the portal (once). Windows PowerShell:
     Get-Content qz-private-key.pem -Raw | npx wrangler secret put QZ_PRIVATE_KEY
   Mac / Linux / Git Bash:
     npx wrangler secret put QZ_PRIVATE_KEY < qz-private-key.pem

2. Deploy:  npm run deploy

3. On EVERY computer that prints labels, copy  qz-install/override.crt  into the QZ Tray folder
   (Windows: C:\\Program Files\\QZ Tray\\ ), then restart QZ Tray.

Keep qz-private-key.pem safe. Never put it in the deployed public folder.
`);
