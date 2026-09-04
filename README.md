# Product Sync

Shopify app for synchronizing products and orders between source and destination stores.

## Production details

- Public URL: `https://productsync.sistagging.com`
- Server: `82.25.90.123`
- SSH user: `sistagging-productsync`
- Application directory: `/home/sistagging-productsync/htdocs/productsync.sistagging.com`
- Node.js: version 18 or newer (production currently uses Node.js 22)
- Process manager: PM2, running one fork-mode instance named `product-sync`
- Application port: `3664`
- Database: MySQL

Only run one application instance. Product and order background workers run inside the Node process, so PM2 cluster mode or multiple instances would run the workers more than once.

## First-time production deployment

### 1. Connect to the server

```bash
ssh sistagging-productsync@82.25.90.123
cd /home/sistagging-productsync/htdocs/productsync.sistagging.com
```

Upload or clone the project into that directory. Do not overwrite an existing production `.env` when uploading an update.

### 2. Configure MySQL

Create a database and a dedicated database user. The current production database name is `productsyncdb`.

The database user needs permissions to create and alter tables in this database because `server.js` runs the idempotent migrations in `config/migrate.js` during startup.

### 3. Create `.env`

Copy `.env.example` to `.env` and populate every required value:

```env
PORT=3664
HOST=https://productsync.sistagging.com

SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_API_VERSION=2026-07
SHOPIFY_SCOPES=read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_publications,write_publications
SHOPIFY_TIMEOUT_MS=15000

TOKEN_ENCRYPTION_KEY=

DB_HOST=127.0.0.1
DB_USER=
DB_PASSWORD=
DB_NAME=productsyncdb
DB_POOL_SIZE=10
```

Generate `TOKEN_ENCRYPTION_KEY` once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Back up this key securely. Never change it after stores have been installed, because existing encrypted Shopify tokens would become unreadable.

Protect the environment file:

```bash
chmod 660 .env
```

### 4. Configure the reverse proxy

The CloudPanel/Nginx site must proxy `productsync.sistagging.com` to:

```text
http://127.0.0.1:3664
```

The value of `PORT` in `.env` must match this upstream port. A mismatch produces a `502 Bad Gateway` response.

### 5. Install and test

```bash
npm install --omit=dev
npm test
```

Do not continue if the test command reports a syntax error, conflict marker, or failed assertion. Resolve it first.

### 6. Start the application

```bash
pm2 start server.js --name product-sync --time
pm2 save
```

Confirm that only one instance is online:

```bash
pm2 ls
pm2 logs product-sync --lines 100 --nostream
```

If the account cannot install a system-level PM2 startup service, restore the saved process list through the user's crontab:

```bash
(crontab -l 2>/dev/null; echo '@reboot /usr/bin/pm2 resurrect') | crontab -
```

Add that entry only once. Confirm it with:

```bash
crontab -l | grep 'pm2 resurrect'
```

### 7. Configure Shopify

Set these values in the Shopify Partner Dashboard:

- App URL: `https://productsync.sistagging.com`
- Allowed redirect URL: `https://productsync.sistagging.com/api/auth/callback`
- Customer data request webhook: `https://productsync.sistagging.com/webhooks/customers/data_request`
- Customer data erasure webhook: `https://productsync.sistagging.com/webhooks/customers/redact`
- Shop data erasure webhook: `https://productsync.sistagging.com/webhooks/shop/redact`

Product, order, and uninstall webhooks are registered automatically during Shopify OAuth installation. Reinstall a store if its registered webhook URLs still point to an old host.

### 8. Verify production

```bash
curl -I http://productsync.sistagging.com
curl -o /dev/null -sS -w '%{http_code}\n' \
  'https://productsync.sistagging.com/api/auth/install?shop=example.myshopify.com'
curl -o /dev/null -sS -w '%{http_code}\n' -X POST \
  'https://productsync.sistagging.com/webhooks/app/uninstalled'
pm2 logs product-sync --lines 100 --nostream
```

Expected results:

- HTTP redirects to HTTPS.
- The example OAuth install route returns `200`.
- An unsigned webhook request returns `401`.
- Logs contain `MySQL pool ready`, both sync-worker startup messages, and `Server running on port 3664`.
- Opening `/` outside Shopify may return `401`; that is expected because the embedded app requires Shopify session context.

## Regular production update

### 1. Back up and inspect

```bash
ssh sistagging-productsync@82.25.90.123
cd /home/sistagging-productsync/htdocs/productsync.sistagging.com
cp .env ../productsync.env.backup
pm2 ls
```

Do not place the backup inside the public application directory.

### 2. Upload or pull the new code

If this deployment is managed with Git:

```bash
git status --short
git pull --ff-only
```

If files are uploaded with SFTP, preserve `.env` and upload all changed source, view, static, SQL, and package files. Never upload `node_modules`; install dependencies on the server instead.

Check that the uploaded files contain no unresolved merge conflicts:

```bash
git grep -n -e '^<<<<<<<' -e '^=======' -e '^>>>>>>>'
```

No output is expected.

### 3. Install dependencies and run tests

```bash
npm install --omit=dev
npm test
```

### 4. Restart and save PM2

```bash
pm2 restart product-sync --update-env
pm2 save
```

Do not use `pm2 start ... -i max` or cluster mode.

### 5. Verify the update

```bash
pm2 ls
pm2 logs product-sync --lines 100 --nostream
curl -o /dev/null -sS -w '%{http_code}\n' \
  'https://productsync.sistagging.com/api/auth/install?shop=example.myshopify.com'
```

The PM2 process should be `online`, the logs should contain no startup errors, and the install route should return `200`.

## Useful production commands

```bash
# Application status
pm2 ls

# Recent output and errors
pm2 logs product-sync --lines 100 --nostream

# Live logs
pm2 logs product-sync

# Restart after code or environment changes
pm2 restart product-sync --update-env

# Confirm the application port
ss -ltnp | grep 3664

# Confirm the local Node response
curl -I http://127.0.0.1:3664
```

Never commit or share `.env`, database passwords, Shopify secrets, access tokens, or the token encryption key.
