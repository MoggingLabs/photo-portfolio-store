# Consentimento para processamento biometrico

**Versao da politica:** 2026-05-18
**Idioma:** pt-BR
**Jurisdicao:** Brasil LGPD (Lei 13.709/2018)

## O que fazemos

Ao enviar uma selfie para encontrar suas fotos, nosso sistema extrai um
descritor numerico do seu rosto (embedding de 512 dimensoes) e o compara com
descritores ja extraidos das fotos deste evento. A imagem da selfie **nao e
gravada em disco nem em armazenamento de objetos** em nenhum momento. O
embedding e mantido apenas em memoria durante a busca e descartado em
seguida.

Esse tratamento configura dado pessoal sensivel (dado biometrico) nos termos
do art. 5, II, e art. 11 da LGPD.

## Por que

Para retornar somente as fotos em que voce aparece. Nenhuma outra inferencia
e realizada: nao ha perfilamento demografico, escoragem comportamental, nem
decisao automatizada com efeitos juridicos relevantes (art. 20 da LGPD nao
e acionado neste fluxo).

## Retencao

Os descritores faciais derivados das fotos do evento sao excluidos
automaticamente **`{retention_days}` dias apos o termino do evento**. Voce
pode forcar a exclusao antecipada revogando este consentimento (DELETE no
endpoint de consentimento); os descritores gerados sob o seu consentimento
sao apagados dentro da mesma requisicao HTTP.

A janela de retencao deste evento e configurada pelo organizador e exibida
junto a este aviso.

## Quem tem acesso

- O organizador do evento (leitura, restrito a este evento)
- Fotografos que sao membros deste evento
- Nossa equipe de infraestrutura (auditado, somente em emergencia)

**Nao** compartilhamos dados biometricos com terceiros. Nenhum dado e
vendido.

## Seus direitos (LGPD art. 18)

- **Revogar o consentimento a qualquer momento** — chame
  `DELETE /v1/consents/biometric/:id` ou use o link de revogacao na UI. A
  revogacao aciona a exclusao imediata dos descritores faciais gerados sob
  este consentimento.
- **Confirmacao, acesso, correcao, anonimizacao, portabilidade, eliminacao**:
  privacidade@example.com.
- **Peticao perante a ANPD** (art. 18, paragrafo 1, da LGPD).

## Reconhecimentos

Ao conceder consentimento voce confirma, individualmente:

1. **biometricProcessing** — Compreendo que um descritor numerico do meu
   rosto sera processado contra descritores extraidos das fotos do evento.
2. **retentionPeriod** — Compreendo a janela de retencao acima.
3. **rightToErasure** — Compreendo que posso revogar o consentimento e
   forcar a exclusao a qualquer momento.
4. **jurisdictionRules** — Li as regras da jurisdicao indicada acima e
   aceito sua aplicacao.

Este consentimento atende ao requisito de consentimento especifico e em
destaque do art. 11, I, da LGPD.

## Validade

Este consentimento e valido por **24 horas** a partir da concessao ou **20
buscas**, o que ocorrer primeiro, dentro deste evento somente. Nova concessao
e necessaria apos qualquer um dos limites.
