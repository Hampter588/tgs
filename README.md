# TGS — The Gathering Social

An ad-free Magic community app with a shared server, persistent relational database, accounts, moderation, and subscription integrations. Supports 17 format categories. One React UI runs on the web, Electron desktop, and Capacitor mobile apps.

## Run locally

Requires **Node 24**. The database uses Node's built-in SQLite driver.

```sh
npm ci
npm run local
```

Open **http://127.0.0.1:3001**. This starts a real local server with persistent data at `data/local-tgs.sqlite`, not the old localStorage demo. The launcher creates a random-password administrator once and saves credentials in `../TGS-local-admin.txt`. The file is outside the project and is not part of source archives. Email verification is disabled only in this explicit development launcher. Do not deploy its development database.

For live frontend development use `npm run dev:full`; the API runs on port 3001 and Vite proxies `/api` from port 5173. This mode uses `data/tgs.sqlite`. Create its administrator with `npm run admin:create`.

## Implemented

- Registration, login/logout, hashed passwords, revocable 30-day sessions, email verification, and one-time password reset.
- Shared, paginated text feed with format/search filters, linked deck showcases, likes, bookmarks, comments, reports, and blocking.
- Playgroups with membership-protected conversations; messages and feed refresh by polling.
- Hosted games with timezones, transactional capacity checks, idempotent RSVPs, and host cancellation.
- Deck creation/editing and profiles; account data export and deletion.
- **Plus:** game logging/stats, deck revision history with notes, and profile themes. Entitlements are enforced by the API, not a client-side flag.
- **Admin:** user search, bans/unbans, immediate session revocation, post/comment removal and restoration, report review, and an audit log. Administrators cannot ban each other through the app.
- No ads, advertising SDKs, analytics trackers, or bundled official Magic artwork. RevenueCat is used for subscription processing, not advertising.

The feed currently supports text and decklists, not user-uploaded images/video. Direct messages, following, push notifications, and automated moderation are outside this version. Native sessions are held in memory, so mobile/desktop users sign in again after restarting the app; credentials and session tokens are not saved in localStorage.

## Deploy the server

The Docker image serves both `/api` and the production web app. Caddy supplies HTTPS. This repository contains deployment files; it has **not been deployed to a public host**. Docker is unavailable on this machine, so the image build remains unverified here; the GitHub workflow includes that check.

1. Point a domain's DNS at a Linux server. Install Docker with Compose and open ports 80/443.
2. Copy `.env.example` to `.env`. Set `PUBLIC_URL=https://your-domain`, `TGS_DOMAIN=your-domain`, SMTP settings, and billing settings if ready. Keep `.env` private.
3. Run `docker compose up -d --build` from the project directory. SQLite lives in the `tgs-data` volume. The API is not exposed directly to the internet.
4. Create the production administrator with the procedure below.
5. Test registration, verification email, resets, report submission, moderation, and test payments at your actual domain before opening registration to the public.

Production startup requires HTTPS and SMTP configuration. Billing stays disabled until all provider settings are present. Do not deploy a build with test-server code as its entrypoint; the image starts only `server/index.mjs`.

This deployment uses **one server process and a persistent SQLite volume**. Do not scale it to multiple application containers or put the SQLite file on network storage. A future multi-instance deployment should migrate the relational schema and transactions to PostgreSQL, plus use shared rate-limit storage and a job queue. Email delivery currently occurs inline. Back up the database and test restoration before accepting real payments.

### Create the administrator

Register your own production account first, then promote it from the server:

```sh
docker compose exec -e ADMIN_EMAIL=you@example.com app node server/admin.mjs
```

Only an operator with server access can promote administrators. The public registration endpoint rejects roles and entitlements supplied by clients.

For a fresh account without prior registration, pass `ADMIN_EMAIL`, `ADMIN_HANDLE`, and a unique 12+ character `ADMIN_PASSWORD` through the process environment, then run `npm run admin:create`. The existing-account promotion preserves its password. No production admin or default password is bundled. Avoid passwords in shell history, source files, or GitHub variables.

### Backups

```sh
npm run db:backup -- data/backups/tgs.sqlite
```

Uses SQLite `VACUUM INTO` for a consistent snapshot including WAL state. In Docker, run `node server/backup.mjs /app/data/backups/tgs.sqlite` inside the app container, then copy the snapshot to encrypted off-host storage. To restore, stop the app, replace the database with the snapshot, remove stale WAL/SHM sidecars only while the app is stopped, and restart. Backups contain personal data; honor your retention/deletion policy.

## Subscriptions

### Web and desktop: Stripe

Create a TGS Plus product with monthly and yearly recurring prices. Configure:

- `STRIPE_SECRET_KEY`
- `STRIPE_MONTHLY_PRICE_ID` and `STRIPE_YEARLY_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`

Register **`https://your-domain/api/billing/webhook`** for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Enable the Stripe customer portal so members can cancel/update billing.

Checkout chooses server-side price IDs. Pending checkouts are recorded persistently and reuse provider idempotency keys. Signed raw-body webhooks trigger a fresh provider lookup and replay-safe processing; redirect query parameters never grant Plus. Active/trialing subscriptions are eligible only until their current period expires. Cancellations at period end retain access through the paid period. Failed/past-due subscriptions lose access until provider status recovers. Current prices and recurring terms appear in provider checkout before payment.

### iOS and Android: RevenueCat + store subscriptions

The app includes real purchase and restore calls through `@revenuecat/purchases-capacitor`. To enable them:

1. Create auto-renewing subscriptions in App Store Connect and Google Play Console and connect the apps to RevenueCat.
2. Create a **`tgs_plus`** entitlement and a current offering containing monthly/annual packages.
3. Set `REVENUECAT_SECRET_KEY` (a server-side v1-compatible secret key), `REVENUECAT_IOS_PUBLIC_KEY`, `REVENUECAT_ANDROID_PUBLIC_KEY`, and optionally `REVENUECAT_ENTITLEMENT`.
4. Set a long random `REVENUECAT_WEBHOOK_AUTHORIZATION` value, configure the exact same Authorization header in RevenueCat, and set the endpoint to **`https://your-domain/api/billing/store-webhook`**.
5. Test purchases, restore, renewal, expiration, refund, and account transfer on real store sandbox builds. Production rejects sandbox entitlements.

The SDK uses the signed-in account UUID as its app user ID. The server fetches RevenueCat's subscriber record after each purchase/restore and webhook; client SDK success cannot unlock Plus by itself. Account-transfer webhooks refresh both sides. Secret API keys are never returned to the client. Web/desktop Stripe checkout is not presented in native store builds.

**Live billing has not been tested:** no Stripe, RevenueCat, or store credentials were supplied. Tests use signed test webhooks and mocked provider lookups. Product configuration, store review requirements, terms/privacy documents, signing, and real-device purchase testing remain necessary before charging users. Native store subscriptions must be canceled in the user's store account; deleting a TGS account can automatically cancel Stripe subscriptions but cannot cancel Apple/Google subscriptions.

## Build all platforms with GitHub Actions

`.github/workflows/platforms.yml` runs on main pushes, version tags, pull requests, and manual dispatch. Set the repository's **`TGS_API_URL` variable** to your HTTPS server origin for desktop/mobile artifacts. This is public build configuration, not a secret. Without it, packaged clients let users configure an HTTPS server in the sign-in screen.

The workflow tests first, then compiles and uploads:

| Artifact | Contents |
| --- | --- |
| `tgs-web` | Production static web bundle |
| `tgs-windows-x64-unsigned` | NSIS installer |
| `tgs-macos-x64-arm64-unsigned` | Intel and Apple Silicon DMG/ZIP builds |
| `tgs-linux-x64-appimage-deb` | AppImage and Debian package |
| `tgs-android-debug-and-unsigned-release` | Installable debug APK; unsigned release APK and AAB |
| `tgs-ios-simulator-and-unsigned-device-archive` | Simulator `.app` ZIP and unsigned `.xcarchive` ZIP |
| `tgs-nixos-x86_64-binary-cache` | Nix binary cache, closure path, flake, and generated lock |
| `tgs-server-docker-image` | Docker image tarball (`docker load` compatible) |

Artifacts are retained for 30 days and missing outputs fail their jobs. Builds do not publish an app, submit to stores, or deploy the server. **A signed installable iOS IPA requires Apple certificates/provisioning and a separate signed export.** Simulator apps and unsigned device archives cannot be installed on normal iPhones. Debug Android signing is for testing only; app-store Android builds need your keystore. Desktop signing/notarization also requires your certificates. The workflow has been checked with actionlint. See the repository Actions tab for build results; a push to main starts all platform jobs.

### Local platform commands

```sh
npm run package:win
npm run package:mac
npm run package:linux
npm run mobile:sync
npx cap open android
npx cap open ios
```

Use each target's supported host/toolchain. Android requires JDK 21 and Android SDK 36; iOS requires macOS and Xcode. Mobile builds include the RevenueCat native plugin after `cap sync`.

### NixOS

```sh
npm ci
npm run prepare:nix
nix build path:./work/nix-source#
nix run path:./work/nix-source#
```

The staging command includes only built web assets, Electron entrypoint, package metadata, and the flake; it avoids copying credentials/databases or node_modules into the Nix store. To consume the CI artifact, extract it and import its closure with `nix copy --from file://ABSOLUTE_PATH/nix-cache --no-check-sigs STORE_PATH_FROM_MANIFEST`, then run the imported package's `bin/tgs`. Only import artifacts you trust; the cache is unsigned. Commit the generated flake lock in your maintained source when establishing a release pin. NixOS builds require a Nix host and have not been executed on this Windows machine.

## Tests and architecture

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

API tests cover privilege injection, ownership, bans/session revocation, moderation restoration/audit, simultaneous RSVP capacity, membership boundaries, reset token replay, entitlement expiration, refunds/sandbox rejection, provider webhook validation/replay, and account deletion. Browser tests run against an isolated in-memory server and cover a two-account feed, persisted sessions, mobile games, Plus revision/history flows, and admin moderation. Test credentials exist only in `server/tests/runtime.mjs`; production never imports it.

Source: `server/` holds SQL migrations/API/auth/billing; `src/OnlineApp.jsx` and `src/Dialog.jsx` provide the UI; `electron/`, `android/`, and `ios/` contain platform shells. Server credentials belong in deployment environments. The previous localStorage demo and its fictional seeded community have been removed.

This is an independent fan project, not affiliated with Wizards of the Coast. No official card art or logos are bundled. The source is open source under the [MIT license](LICENSE) at [Hampter588/tgs](https://github.com/Hampter588/tgs). Publish your community rules, privacy policy, and subscription terms before a public service launch.
