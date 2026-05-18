# Biometric processing consent

**Policy version:** 2026-05-18
**Locale:** en-US
**Jurisdiction:** EU GDPR (default strictest tier; covers BIPA written-consent
requirements when invoked from a US/Illinois IP)

## What we do

When you submit a selfie to find your photos, our system extracts a numerical
face descriptor (a 512-dimension embedding) from the image and compares it
against face descriptors already extracted from photos in this event. The
selfie image itself is **never written to disk or object storage**. The
embedding is held in memory for the duration of one search and discarded.

This processing is biometric data under GDPR Art. 9, LGPD Art. 11, and BIPA
sec. 14/15.

## Why

To return only the photos that contain you. No other inference is performed:
no demographic profiling, no behavioural scoring, no automated decision that
produces legal or significant effects for you (GDPR Art. 22 is not engaged).

## Retention

Face descriptors derived from event photos are deleted automatically
**`{retention_days}` days after the event ends**. You may force earlier
deletion by revoking this consent (DELETE the consent record); the descriptors
generated under your consent are purged within the same HTTP request.

The retention window for this event is configured by the organizer and is
shown alongside this notice.

## Who has access

- The event organizer (read-only, scoped to this event)
- Photographers who are members of this event
- Our infrastructure team (audited, break-glass only)

We do **not** share biometric data with third parties. No data is sold.

## Your rights

- **Withdraw consent at any time** — call `DELETE /v1/consents/biometric/:id`
  or use the revoke link in our UI. Withdrawal triggers immediate deletion of
  any face descriptors generated under this consent.
- **Right to erasure (GDPR Art. 17, LGPD Art. 18, CCPA right to delete)**:
  contact privacy@example.com.
- **Right of access (GDPR Art. 15)**: contact privacy@example.com.
- **Right to lodge a complaint** with your supervisory authority (GDPR Art.
  77) or the relevant data-protection authority in your jurisdiction.

## Acknowledgements you confirm

By granting consent you confirm, individually:

1. **biometricProcessing** — I understand that a numerical descriptor of my
   face will be processed against face descriptors extracted from event
   photos.
2. **retentionPeriod** — I understand the retention schedule above.
3. **rightToErasure** — I understand I can revoke consent and force deletion
   at any time.
4. **jurisdictionRules** — I have read the rules of the jurisdiction shown
   above and accept that they apply.

This consent is required by 740 ILCS 14/15(b) (BIPA written-consent rule),
GDPR Art. 9(2)(a) (explicit consent for special-category data), and LGPD
Art. 11(I) (consentimento específico e em destaque).

## Validity

This consent is valid for **24 hours** from the moment of grant or **20
searches**, whichever occurs first, within this event only. Re-grant is
required after either limit.
