// @pkg/integrations — shared connector primitives used by both apps/api and
// apps/worker (workers cannot import apps/api, so cross-cutting connector code
// lives here): credential envelope encryption, secret redaction, outbound
// webhook HMAC signing, and an SSRF guard for outbound target URLs.

export { CredentialCryptoError, decryptCredentials, encryptCredentials } from './crypto.js';
export { SENSITIVE_KEY_RE, redactSecrets } from './redaction.js';
export { signWebhookBody, verifyWebhookSignature, type VerifyOptions } from './webhook-signing.js';
export { SsrfError, assertPublicHttpsUrl, type AssertUrlOptions } from './ssrf.js';
