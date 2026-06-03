# Per-event SFTP ingest (F4.2)

Photographers can upload directly from cameras / field laptops over SFTP. Each
event gets a dedicated chrooted home and a unique key pair. This document covers
the deploy-side infrastructure; the application owns the **account lifecycle**
(`apps/api/src/services/sftp.ts`) and the **dedup→enqueue** logic
(`apps/worker/src/jobs/sftp-ingest.ts`).

## What the app does

- `POST /v1/events/:id/sftp/provision` generates an ed25519 key pair, stores the
  account (`system_username`, `public_key_fingerprint`, `chroot_path`,
  `status`), and returns the **private key once** (PKCS8 PEM). The private key is
  never persisted — only the fingerprint.
- `POST /v1/events/:id/sftp/rotate` mints a new key (old key is invalidated once
  the new public key is installed) and stamps `last_rotated_at`.
- `DELETE /v1/events/:id/sftp` disables the account.
- A stable upload (size settled ≥2s, no open handle) is passed to
  `enqueueStableUploads({ eventId, path, contentHash })`, which dedups on
  `(event_id, content_hash)` via `sftp_uploads` and enqueues exactly one ingest
  job (resumed/duplicate uploads enqueue nothing).

## What the deploy must provide

1. **OpenSSH key-based auth only.** In `sshd_config`:
   ```
   PasswordAuthentication no
   PubkeyAuthentication yes
   Match User evt_*
       ChrootDirectory /srv/sftp/%u
       ForceCommand internal-sftp
       AllowTcpForwarding no
       X11Forwarding no
   ```
   The provisioned public key (returned in `opensshPublicKey`) is installed into
   `/srv/sftp/<event_id>/.ssh/authorized_keys` (root-owned chroot dir;
   `0755 root:root` on the ChrootDirectory, writable upload subdir owned by the
   per-event user).

2. **Chroot jail** prevents path traversal (`../`, symlink escape) — the API
   never trusts client paths; the chroot is the security boundary. An automated
   test should attempt `cd ..` and a symlink escape and assert both fail.

3. **Brute-force protection.** fail2ban (or sshguard): ban an IP after 5 failed
   auths within 10 minutes, ban duration 1 hour.

4. **The watcher.** Production uses inotify on each event's upload subdir with a
   debounce so a file is only handed to `enqueueStableUploads` once its size has
   been stable for ≥2s and no process holds it open. A periodic scan is an
   acceptable fallback. Uploads land in a **staging path**; the ingest worker
   moves them to permanent storage after a virus scan.

## Rotation

Provision returns the key once. To rotate: call rotate, install the new public
key into `authorized_keys`, then remove the previous key. `last_rotated_at`
records when. Disabling removes `authorized_keys` and stops the watcher.

## Not runtime-verified here

The OpenSSH chroot, fail2ban, and the inotify watcher are infrastructure and are
not exercised by the local test suite. The app-side pieces — key generation +
fingerprint, account lifecycle, and the content-hash dedup/enqueue — are fully
unit-tested.
