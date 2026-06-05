# In-camera FTP setup + compatibility (F4.3)

Sports photographers push frames straight from the body over the wireless
transmitter during the shoot. This guide covers which protocol to use per camera,
the exact camera settings, and the server-side profile. It complements the
per-event SFTP accounts from F4.2 (`docs/integrations/sftp.md`).

> Spike status: the protocol/auth findings and setup steps below are derived from
> the manufacturers' transmitter documentation. The **measured** acceptance
> criteria — a 1-hour burst-shoot reliability run per body, success-rate, retry
> behavior, and failure-case packet captures — require borrowed/rented hardware
> and are **not yet executed**. The compatibility matrix marks those cells
> `TBD (hardware)`. See "Validation status" at the end.

## The one decision that matters: use FTPS for cameras

Our F4.2 SFTP server is **key-based only** (`PasswordAuthentication no`). Camera
transmitters do **not** pair with that:

- **Canon** WFT-E9 supports SFTP, but only with **SSH username+password** — the
  camera UI exposes no private-key field, so it cannot authenticate to a key-only
  SFTP server.
- **Nikon** (WT-7, Z9/Z8) and **Sony** (A1/A9) do **not** speak SFTP at all —
  their secure option is **FTPS** (explicit FTP over TLS).

Therefore:

- **Cameras → FTPS** (explicit TLS, passive mode). This is the universal common
  denominator across Canon/Nikon/Sony.
- **Software clients** (a field laptop's `sftp`/`rsync`, an ingest tool) → the
  F4.2 **SFTP** account (key-based), which is stronger and already shipped.
- **Plain FTP** (no TLS) is discouraged; only acceptable on an isolated,
  VPN-only network (see "Plain FTP isolation").

The FTPS endpoint is a separate server profile from the SFTP daemon (see
"Server-side profile") — it is deploy infrastructure, not application code.

## Compatibility matrix

| Body (transmitter) | FTPS | SFTP | Auth (FTPS) | Passive | Root cert on camera | Reliability run |
| --- | --- | --- | --- | --- | --- | --- |
| Canon R5/R3/R1 (WFT-E9) | Yes | Password-only (not usable vs F4.2) | user+pass + TLS | Yes | Recommended for private CA | TBD (hardware) |
| Canon 5D IV / 1DX II (WT-7B / WFT-E8) | Yes | No | user+pass + TLS | Yes | Recommended for private CA | TBD (hardware) |
| Nikon D850/D780/D6 (WT-7) | Yes | No | user+pass + TLS | Yes | Required for private CA | TBD (hardware) |
| Nikon Z9/Z8 (built-in, fw C ≥ 3.00) | Yes | No | user+pass + TLS | Yes | Required (load before connect) | TBD (hardware) |
| Sony A1 / A9 II / A9 III (built-in) | Yes | No | user+pass + TLS | Yes | Required for private CA | TBD (hardware) |

Notes:
- "Reliability run" is the acceptance-criteria measurement (success rate over a
  1-hour burst simulation); it is filled in during the hardware session.
- Use a **publicly-trusted TLS certificate** (e.g. Let's Encrypt) on the FTPS
  endpoint so no per-camera root-certificate install is needed. With a private CA
  you must load the root cert onto each Nikon/Sony body (and it is recommended on
  Canon) before the TLS handshake will succeed.

## Photographer setup (per body)

All bodies use the same server values:

- **Host / address**: the FTPS endpoint hostname (e.g. `ftp.<your-domain>`).
- **Port**: `21` (explicit FTPS negotiates TLS on the control channel after
  `AUTH TLS`). Do **not** use implicit FTPS on `990` unless told to.
- **Mode**: **Passive (PASV)** on.
- **TLS / encryption**: on (explicit). Set the target/destination folder to the
  per-event upload path you were given.
- **Username / password**: the per-event FTPS credentials (issued per event, like
  the SFTP account).

### Canon (WFT-E9 / WT-7B)

1. Network menu → "Communication settings" → "Connection settings" → create an
   FTP transfer connection.
2. FTP server: enter the host, set **FTP mode = FTPS**, **Passive mode = Enable**.
3. Address/port: host + `21`. Login: username + password.
4. **Directory structure**: choose "Upload destination folder" to upload into the
   configured target dir, or "Camera" to mirror the card's `DCIM/100EOS…` tree.
   Prefer "Upload destination folder" so the watcher sees a flat per-event dir.
5. Trusting the certificate: if using a private CA, set "Trust target server" /
   import the root cert.
6. Transfer: enable transfer-on-capture; choose JPEG+RAW (both) if delivering
   RAW. Canon sends the JPEG first, then the RAW.

### Nikon (WT-7, or Z9/Z8 built-in)

1. (WT-7) Attach the WT-7 and select it as the network device; (Z9/Z8) use the
   built-in wired/wireless LAN. Network menu → "Connect to FTP server".
2. Create a profile (or use the Wireless Transmitter Utility on a laptop to
   author it): server type **FTPS**, host, port `21`, **PASV mode = On**.
3. **Root certificate**: FTPS requires it — Network menu → "Connect to FTP
   server" → "Options" → "Manage root certificate" → load your CA root before
   connecting (Z9 needs firmware **C 3.00+** for FTPS).
4. Login: username + password. Set the upload folder.
5. Auto upload: "Auto send" = On; "Send file as" = JPEG+RAW as needed.

### Sony (A1 / A9 II / A9 III)

1. Network → "FTP Transfer Func." → "Server Setting" → register a server.
2. Set **Secure Protocol = On** (FTPS), host, port `21`, **PASV Mode = On**,
   destination directory.
3. Root certificate: import via "Import Root Certificate" if using a private CA.
4. Login: username + password. Enable "FTP Auto Transfer".

## Server-side profile (ops)

The FTPS endpoint mirrors the F4.2 SFTP chroot model but runs a TLS-FTP daemon
(e.g. `vsftpd`/`pure-ftpd`):

- **Explicit TLS** (`AUTH TLS`) required on the control channel; reject plaintext
  logins. TLS ≥ 1.2.
- **Passive mode** with a bounded, firewall-opened passive port range (e.g.
  `30000-30100`), and `pasv_address` set to the public address (NAT). Cameras use
  PASV, so the passive range must be reachable.
- **Per-event chroot** + per-event credentials, landing uploads in the same
  staging path the F4.2 watcher consumes (`enqueueStableUploads`). The dedup /
  ingest path is identical to SFTP — only the transport differs.
- **Certificate**: prefer a publicly-trusted cert to avoid per-camera root
  installs.

## Transport behavior to capture (hardware session)

Record these during the shoot simulation and fill into this doc:

- **MTU**: note if jumbo frames or a reduced MTU (VPN/tethered) changes throughput
  or causes stalls.
- **Keepalive**: control-channel idle timeout vs the camera's reconnect interval;
  set the server idle timeout generously (bursts have gaps).
- **Reconnect / retry**: on connectivity loss, does the body re-queue and resend
  the in-flight frame, or drop it? Measure duplicate vs lost frames.
- **TLS session reuse**: some FTPS servers require the data connection to reuse
  the control channel's TLS session; a few camera stacks fail this — note any
  `require_ssl_reuse` adjustment needed.
- **Data corruption**: verify a byte-exact hash of a sample of uploaded RAW files
  against the card.

## Firmware + known-bad combinations

Fill during testing:

| Body | Transmitter | Firmware tested | Result | Notes |
| --- | --- | --- | --- | --- |
| _e.g._ Nikon Z9 | built-in | C _x.yz_ | TBD | FTPS needs C ≥ 3.00 + root cert |
| Canon R5 | WFT-E9 | _x.y.z_ | TBD | "Upload destination folder" dir mode |
| Sony A9 III | built-in | _x.yz_ | TBD | TLS session-reuse check |

## Plain FTP isolation

If a body in the field only supports plain FTP (no TLS), do **not** expose the
FTP endpoint on the public internet. Require a VPN: the camera connects to the
VPN, and the plain-FTP endpoint binds only to the VPN interface. Credentials are
still per-event; the chroot + staging + ingest path is unchanged.

## Validation status

Done here (no hardware required):

- Protocol/auth findings + the FTPS-for-cameras decision.
- Per-body setup steps and the server-side FTPS profile requirements.
- Compatibility matrix structure + the transport checklist.

Requires a hardware session (borrow/rent the bodies) to satisfy the issue's
acceptance criteria — these are intentionally left `TBD`:

- The 1-hour burst-shoot reliability run per Canon + Nikon body, with success
  rate, retry behavior, and a byte-exact corruption check.
- Capturing the measured MTU/keepalive/reconnect values and any failure-case
  packet traces.
- Confirming firmware versions and any known-bad combinations.
- Screenshots of each camera's menu for the photographer-facing steps.

Sources: Canon WFT-E9 FTP server manual (cam.start.canon, support.usa.canon.com);
Nikon Z9 online manual "Connect to FTP server" / "Support for FTPS" + WT-7 guide
(onlinemanual.nikonimglib.com); Sony A1/A9 FTP Transfer Func. help guide
(helpguide.sony.net).
