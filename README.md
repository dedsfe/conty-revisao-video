# Revisão de vídeo

API para a revisão de uma entrega da campanha: versões de roteiro, vídeo, capa e legenda, comentários presos a um segundo do vídeo e a regra de quando a entrega pode ser aprovada. O upload pode ser falso (uma URL como `fake://video-v1.mp4`); o que não é falso é a regra. Node 22, Hono, `node:sqlite`, TypeScript.

```bash
npm install
npm test        # 29 testes
npm run dev     # http://127.0.0.1:3008
```

Por onde ler: `src/rules.ts` (a regra da entrega, pura, com os estados explicados no topo) → `src/service.ts` → `test/api.test.ts`.

## Modelo

- **Campanha** declara `required_pieces`, a lista das peças que exige (`script`, `video`, `cover`, `caption`). É dado da campanha, gravado nela: não existe `if` por tipo de peça no código. Uma campanha só de vídeo tem `["video"]` e simplesmente não exige o resto.
- **Entrega** é o que um criador manda para uma campanha. Cada peça tem **versões** numeradas (1, 2, 3...). Nenhuma versão é apagada ou sobrescrita; a **atual** é a de maior número.
- **Versão** nasce `pending`. A marca decide sobre a versão atual: `approved` ou `changes_requested`. Decidida, não muda mais (para mudar, envia-se uma versão nova).
- **Comentário** pertence a uma versão. No vídeo ele é preso a um segundo (`at_second`, a partir de 0, aceita fração).

## A regra da entrega

Em `evaluateDelivery`, uma função pura:

1. Só conta a **versão atual** de cada peça. Aprovação de versão antiga não vale: tentar aprovar uma versão já substituída devolve `409 superseded_version`.
2. Só conta peça **exigida** pela campanha. Peça que ela não pediu nunca bloqueia nem desfaz aprovação.
3. Status da entrega, sempre derivado das versões atuais, nunca digitado:

| Status | Quando |
|---|---|
| `in_production` | falta alguma peça exigida com a versão atual aprovada |
| `ready_for_approval` | toda peça exigida está aprovada, mas a marca ainda não aprovou a entrega |
| `approved` | a marca aprovou a entrega **e** toda peça exigida continua com a versão atual aprovada |

`POST /deliveries/:id/approve` só passa quando não há bloqueio. Com peça exigida pendente responde `409` com um erro claro e a lista do que falta:

```json
{
  "error": "pending_required_pieces",
  "message": "não dá para aprovar a entrega: faltam peças exigidas aprovadas: roteiro (sem versão enviada)",
  "blocking": [{ "piece": "script", "reason": "no_version", "version": null }]
}
```

Os motivos possíveis: `no_version`, `current_version_pending`, `current_version_changes_requested`.

## Versão nova desfaz a aprovação

Se a entrega já estava aprovada e uma peça **exigida** recebe versão nova, a entrega volta a `in_production` com `approval_revoked: true` e a peça aparece em `blocking`. Quando a nova versão é aprovada, ela volta a `approved` (sem a marca precisar aprovar a entrega de novo, porque a aprovação da entrega foi dada e só estava suspensa pela peça nova). Resposta real depois da versão 2 do vídeo:

```json
{ "status": "in_production", "approval_revoked": true,
  "blocking": [{ "piece": "video", "reason": "current_version_pending", "version": 2 }] }
```

Cada mudança de status fica no rastro `history`, com a causa. Exemplo real do mesmo fluxo:

```
(início)            -> in_production      | delivery_created
in_production       -> ready_for_approval | version_approved:script:v1
ready_for_approval  -> approved           | delivery_approved
approved            -> in_production      | new_version:video:v2
in_production       -> approved           | version_approved:video:v2
```

Decisão de leitura do enunciado: considerei que a aprovação volta sozinha quando a versão nova é aprovada ("até a nova versão ser aprovada"). Se a marca precisasse aprovar a entrega outra vez, bastaria zerar `approved_at` ao chegar a versão nova; o resto não muda.

## Comentário preso a um segundo, na versão em que foi feito

```bash
curl -s -X POST localhost:3008/deliveries/$D/pieces/video/versions/1/comments \
  -H 'content-type: application/json' \
  -d '{"author":"marca","text":"Corta o silêncio aqui","at_second":12.5}'
```

- O comentário fica na versão em que foi feito (`GET .../versions/1` o lista; ordenados pelo segundo).
- **Não migra** para a versão nova: a versão 2 nasce sem comentários. Resposta real depois da v2: `v1 → [(12.5, "Corta o silêncio aqui")]`, `v2 → []`.
- No vídeo `at_second` é obrigatório, não pode ser negativo e, se a versão informou `duration_seconds`, não pode passar dela (no limite vale). Peça sem linha do tempo (roteiro, capa, legenda) comenta **sem** segundo, e informar um é erro.
- Comentar uma versão antiga é permitido e o comentário continua nela; só a decisão de aprovação vale apenas para a atual.

## API

```
POST /campaigns                                           {name, required_pieces: ["script","video"]}
POST /deliveries                                          {campaign_id, creator_id}
GET  /deliveries/:id                                      status, bloqueios, peças e versões, rastro
POST /deliveries/:id/approve                              aprova a entrega (409 se faltar peça)
POST /deliveries/:id/pieces/:piece/versions               {url, duration_seconds?}
GET  /deliveries/:id/pieces/:piece/versions/:n            a versão e os comentários feitos nela
POST /deliveries/:id/pieces/:piece/versions/:n/approve
POST /deliveries/:id/pieces/:piece/versions/:n/request-changes
POST /deliveries/:id/pieces/:piece/versions/:n/comments   {author, text, at_second?}
```

Erros: `400` entrada inválida, `404` não encontrado, `409` regra de negócio (`pending_required_pieces`, `superseded_version`, `already_decided`).

## Testes

29 testes. A regra pura (peças sem versão, pendentes, com alteração pedida; campanha só de vídeo; peça não exigida; entrega aprovada que ganha versão pendente) e a API de ponta a ponta: peça obrigatória pendente que falha com erro claro, campanha só de vídeo que não exige roteiro, duas campanhas com duas listas diferentes, versão que substitui a anterior, aprovação de versão antiga recusada, entrega aprovada que recebe versão nova (desfaz e volta), peça não exigida que não desfaz, rastro de status, aprovação repetida, e comentários (na versão certa, ordenados, sem migrar, validação do segundo e da duração). Para ter certeza de que pegam bug, mutei o código em seis pontos: exigir todas as peças ignorando a campanha, aceitar aprovar versão antiga, comentário que migra para versões novas, aprovação que não é desfeita por versão nova, aprovação da entrega que não grava, e peças exigidas fixas no código. Todos quebram testes.

## O que ficou de fora

- **A lista de peças exigidas não muda depois de criada.** Não há `PATCH` da campanha; trocar a lista de uma campanha com entregas em andamento exigiria decidir o que acontece com elas.
- **Sem upload de verdade, sem leitura do arquivo.** A URL é só um texto válido; `duration_seconds` é informado pelo cliente e não conferido.
- **Sem autenticação nem papéis.** Qualquer chamador é "marca" ou "criador"; o desenho certo prende aprovar e pedir alteração à marca e enviar versão ao criador.
- **Sem resolver comentário** (marcar como tratado), sem resposta em thread e sem editar ou apagar comentário.
- **Sem notificação** quando uma entrega aprovada perde a aprovação; o rastro `history` é a base para isso.
- **Aprovada ou com alteração pedida é final para aquela versão**, sem "desfazer decisão"; a saída é uma versão nova.
- **Uma só decisão por versão**, de uma única pessoa; não há aprovação em duas etapas.

## Uso de IA

Usei IA para escrever o código, os testes e este README. Acompanhei o desenvolvimento, os testes passando, as mutações que quebram os testes e os exemplos acima, que são respostas reais da API rodando. O repositório não tem nenhum arquivo dirigido a ferramenta.
