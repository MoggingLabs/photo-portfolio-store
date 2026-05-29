// @pkg/integrations — shared connector primitives used by both apps/api and
// apps/worker (workers cannot import apps/api, so cross-cutting connector code
// lives here). Currently: credential envelope encryption + secret redaction.

export { CredentialCryptoError, decryptCredentials, encryptCredentials } from './crypto.js';
export { SENSITIVE_KEY_RE, redactSecrets } from './redaction.js';
