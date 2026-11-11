# The harness carries the result, not the model

Code does everything it can; the model makes only the decisions code can't, and code checks every model answer
. Each model call does one narrow job (pick the next action from a short list code proposes, or judge one
assertion against only the nodes that matter) and answers in structured output that code validates. We chose this so
that the cheapest tier (Haiku) gives strong, provable results: published scores are Haiku scores, with one Opus
comparison per release. The obvious path, a capable model driving freely, was rejected because its verdicts can't be
checked and its cost grows with every step.

## Consequences

- Readiness checks are judged by code only; the model can propose crawl targets and `unconfirmed` findings but never
  makes a check pass.
- Every model-calling run starts with a free quote, and the amount a person types at a terminal is the run's hard cap.
  With no terminal there is no live run, and no flag overrides that.
