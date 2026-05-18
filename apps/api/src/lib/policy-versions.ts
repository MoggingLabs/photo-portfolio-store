// F1.33 — biometric-consent policy-version allow-list.
//
// Keep this list in sync with docs/compliance/policy-versions/<version>/<locale>.md.
// The markdown files are the human-readable source of truth; this module is
// the runtime allow-list the API uses to reject unknown (version, locale)
// pairs and to seed the consent_policy_versions table at boot.
//
// Lock-step process for a new version: write the markdown, copy the body
// here, bump `version`, leave older versions with isActive=true if you still
// accept their proofs.

export type PolicyJurisdiction = 'eu_gdpr' | 'br_lgpd' | 'us_bipa' | 'us_ccpa' | 'other';

export interface PolicyVersion {
  version: string;
  locale: string;
  jurisdiction: PolicyJurisdiction;
  title: string;
  bodyMarkdown: string;
  isActive: boolean;
}

// English (EU/GDPR default; BIPA-compatible). Mirror of
// docs/compliance/policy-versions/2026-05-18/en-US.md.
const POLICY_EN_US_2026_05_18 = `# Biometric processing consent

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
\`{retention_days}\` days after the event ends. You may force earlier
deletion by revoking this consent.

## Your rights

- Withdraw consent at any time via DELETE /v1/consents/biometric/:id.
- Right to erasure (GDPR Art. 17, LGPD Art. 18, CCPA right to delete):
  privacy@example.com.
- Right of access (GDPR Art. 15): privacy@example.com.
- Right to lodge a complaint with your supervisory authority.

## Acknowledgements you confirm

1. biometricProcessing — I understand my face descriptor will be processed.
2. retentionPeriod — I understand the retention schedule.
3. rightToErasure — I can revoke at any time.
4. jurisdictionRules — I accept the jurisdiction shown above.

Required by 740 ILCS 14/15(b) (BIPA), GDPR Art. 9(2)(a), LGPD Art. 11(I).

## Validity

24 hours from grant or 20 searches, whichever first, this event only.
`;

// Brazilian Portuguese (LGPD). Mirror of
// docs/compliance/policy-versions/2026-05-18/pt-BR.md.
const POLICY_PT_BR_2026_05_18 = `# Consentimento para processamento biometrico

**Versao da politica:** 2026-05-18
**Idioma:** pt-BR
**Jurisdicao:** Brasil LGPD (Lei 13.709/2018)

## O que fazemos

Ao enviar uma selfie para encontrar suas fotos, nosso sistema extrai um
descritor numerico do seu rosto (embedding de 512 dimensoes) e o compara com
descritores ja extraidos das fotos deste evento. A imagem da selfie nao e
gravada em disco nem em armazenamento de objetos. O embedding e mantido em
memoria durante a busca e descartado em seguida.

Tratamento de dado pessoal sensivel (dado biometrico) nos termos do art. 5,
II, e art. 11 da LGPD.

## Por que

Para retornar somente as fotos em que voce aparece. Nenhuma decisao
automatizada com efeitos juridicos relevantes (art. 20 da LGPD nao e
acionado).

## Retencao

Os descritores faciais sao excluidos automaticamente \`{retention_days}\`
dias apos o termino do evento. Voce pode forcar a exclusao antecipada
revogando este consentimento.

## Seus direitos (LGPD art. 18)

- Revogar a qualquer momento via DELETE /v1/consents/biometric/:id.
- Confirmacao, acesso, correcao, anonimizacao, portabilidade, eliminacao:
  privacidade@example.com.
- Peticao perante a ANPD (art. 18, paragrafo 1, LGPD).

## Reconhecimentos

1. biometricProcessing — Descritor do meu rosto sera processado.
2. retentionPeriod — Compreendo a janela de retencao.
3. rightToErasure — Posso revogar a qualquer momento.
4. jurisdictionRules — Aceito a jurisdicao indicada.

Atende ao art. 11, I, da LGPD.

## Validade

24 horas ou 20 buscas, o que ocorrer primeiro, somente este evento.
`;

export const POLICY_VERSIONS: ReadonlyArray<PolicyVersion> = [
  {
    version: '2026-05-18',
    locale: 'en-US',
    jurisdiction: 'eu_gdpr',
    title: 'Biometric processing consent',
    bodyMarkdown: POLICY_EN_US_2026_05_18,
    isActive: true,
  },
  {
    version: '2026-05-18',
    locale: 'pt-BR',
    jurisdiction: 'br_lgpd',
    title: 'Consentimento para processamento biometrico',
    bodyMarkdown: POLICY_PT_BR_2026_05_18,
    isActive: true,
  },
];

export const isVersionSupported = (version: string, locale: string): boolean =>
  POLICY_VERSIONS.some(
    (policy) => policy.version === version && policy.locale === locale && policy.isActive,
  );

export const findPolicy = (version: string, locale: string): PolicyVersion | undefined =>
  POLICY_VERSIONS.find(
    (policy) => policy.version === version && policy.locale === locale && policy.isActive,
  );
