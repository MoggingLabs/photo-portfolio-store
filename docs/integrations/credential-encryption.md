# Connector credential encryption (F4.1)

Per-org connector credentials (`integration_configs.encrypted_credentials`) are
stored using envelope encryption. Plaintext credentials never touch the
database and are never returned by the API.

## Scheme

- A fresh 256-bit **data-encryption key (DEK)** is generated per record.
- The DEK encrypts the credential plaintext with **AES-256-GCM**.
- The DEK itself is wrapped (AES-256-GCM) under the **master key**
  (`INTEGRATIONS_MASTER_KEY`, base64-encoded 32 bytes).
- The serialized, versioned blob holds the wrapped DEK + both nonces/tags +
  ciphertext. Implementation: `packages/integrations/src/crypto.ts`.

Because each record carries its own wrapped DEK, **master-key rotation only
re-wraps DEKs** — payload ciphertext is never re-encrypted.

## Generating the master key

```bash
openssl rand -base64 32
```

Set it as `INTEGRATIONS_MASTER_KEY` (Doppler in non-local environments; see
`docs/adr/0003-secrets.md`). A key that is not exactly 32 bytes is rejected at
encrypt/decrypt time with a clear error.

## Master-key rotation

The current format wraps each DEK directly under the master key. To rotate:

1. Provision the new master key alongside the old one.
2. For each `integration_configs` row with `encrypted_credentials`: decrypt with
   the old key (`decryptCredentials`) and re-encrypt with the new key
   (`encryptCredentials`). A one-off migration script performs this in a single
   transaction per org.
3. Swap `INTEGRATIONS_MASTER_KEY` to the new value and retire the old one.

Rotation does not require connectors to be disabled; rows are independent.

## Operational guarantees

- **No plaintext at rest.** Only the envelope blob is persisted.
- **No plaintext in responses.** The API status views omit
  `encrypted_credentials` entirely (snapshot-tested).
- **No secrets in logs.** Anything derived from `integration_configs` is passed
  through `redactSecrets` (`@pkg/integrations`) before logging; keys matching
  `credential|secret|token|api_key|password|...` are masked. The service never
  logs decrypted credentials.
- **Tamper-evident.** GCM auth tags cause decryption to fail on a wrong key or
  any modified byte.
