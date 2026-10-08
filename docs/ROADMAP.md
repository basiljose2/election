# Campus EVM – Implementation Roadmap

This file tells you which OpenSpec changes to implement, in what order, and which ones
agents can work on at the same time. Each change lives in `openspec/changes/<name>/`
with its proposal, specs, design and tasks. Project-wide rules and vocabulary are in
`openspec/config.yaml`.

## Dependency graph

```
                    ┌──────────────┐
                    │ 1 foundation │
                    └──────┬───────┘
              ┌────────────┴─────────────┐
     ┌────────▼─────────┐      ┌─────────▼──────────────┐
     │ 2 election-setup │      │ 3 realtime-device-     │
     └────────┬─────────┘      │   pairing              │
     ┌────────▼──────────────┐ └─────────┬──────────────┘
     │ 4 election-state-     │           │
     │   machines            │           │
     └────────┬──────────────┘           │
              └────────────┬─────────────┘
                 ┌─────────▼─────────────┐
                 │ 5 ballot-casting-core │   ← critical path
                 └─────────┬─────────────┘
       ┌───────────────────┼──────────────────────┐
┌──────▼──────────────┐ ┌──▼──────────────────┐ ┌─▼────────────────────────┐
│ 6 master-terminal-ui│ │ 7 voting-terminal-ui│ │ 8 booth-close-           │
└─────────────────────┘ └─────────────────────┘ │   reconciliation         │
                                                └─┬───────────────┬────────┘
                                   ┌──────────────▼───┐ ┌─────────▼──────────────┐
                                   │ 9 results-       │ │ 10 transparency-portal │
                                   │   dashboard      │ │   (results pages last) │
                                   └──────────────────┘ └────────────────────────┘
                              all ──► 11 hardening
```

## Waves (what can run in parallel)

| Wave | Changes (one agent each)                                                   | Notes                                                         |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1    | `foundation`                                                               | Everything else depends on the gateway and the audit log      |
| 2    | `election-setup` ‖ `realtime-device-pairing`                               | Pairing stubs booths until setup lands                        |
| 3    | `election-state-machines`                                                  | Guards from later changes are fail-closed stubs               |
| 4    | `ballot-casting-core`                                                      | Assign a second agent as a dedicated security reviewer        |
| 5    | `master-terminal-ui` ‖ `voting-terminal-ui` ‖ `booth-close-reconciliation` |                                                               |
| 6    | `results-dashboard` ‖ `transparency-portal`                                | Portal results pages wait for the dashboard's shared packages |
| 7    | `hardening`                                                                | Release gate for the first real election                      |

## Workflow per change

1. `openspec show <change>` and read `openspec/config.yaml`.
2. Implement with `/opsx:apply <change>`. Tasks are checked off in `tasks.md`.
3. `openspec validate <change> --strict` and the full test suite must pass.
4. Review. For changes 1, 5, 8 and 10, a separate agent also reviews against the secrecy and integrity rules.
5. Archive with `/opsx:archive <change>`. The specs move into `openspec/specs/`.

## Shared packages (ownership)

| Package                         | Owned by                   | Used by                           |
| ------------------------------- | -------------------------- | --------------------------------- |
| canonical-json + audit hashing  | foundation                 | all, verifier                     |
| ballot validation               | ballot-casting-core        | voting-terminal-ui, verifier      |
| signatures (Ed25519)            | ballot-casting-core        | reconciliation, results, verifier |
| merkle                          | booth-close-reconciliation | verifier                          |
| computePostResult               | results-dashboard          | verifier                          |
| SignalBus + terminal state hook | realtime-device-pairing    | both terminal UIs, RO dashboard   |
