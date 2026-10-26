# Security Policy

## Reporting a vulnerability

Please report privately. Do not open a public issue.

Use GitHub private vulnerability reporting:
[Report a vulnerability](https://github.com/tripl3tr3s/mcp-tool-idempotency/security/advisories/new)

This includes correctness bugs that break the documented guarantees (a side effect running
twice, a result replayed to the wrong request), not only classic security issues: for this
library they have the same impact.

I aim to acknowledge reports within 3 business days and to ship a fix or a documented
mitigation within 30 days. I'm happy to coordinate disclosure on a 90-day window, or sooner
once a fix ships, and to credit reporters who want it.

## Supported versions

| Version | Supported             |
| ------- | --------------------- |
| 0.2.x   | Yes                   |
| 0.1.x   | No - upgrade to 0.2.0 |

## Past advisories

- **0.1.0 - duplicate execution windows (fixed in 0.2.0).** Two store instances sharing a
  backend could both run the executor for one key, because the claim loser reset the
  winner's live `pending` row. A `pending` row was also re-run without checking whether its
  holder was still alive, and a key reused with a different request replayed the first
  request's result. 0.2.0 adds owner tokens, renewing leases, owner-gated writes, an
  opt-in `uncertain` state and request conflict detection. Reported privately in
  October 2026.
