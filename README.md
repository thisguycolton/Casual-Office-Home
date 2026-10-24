# Self-Hosted Productivity Suite

A private, self-hosted alternative to Google Workspace built around four open-source
CasualOffice editors (Docs, Sheets, Slides, PDF) behind one login and one file manager.

**Status: Phase 1 complete (reconnaissance + recorded architecture decisions). Nothing is deployable yet.**

- [`docs/phase1-reconnaissance.md`](docs/phase1-reconnaissance.md) — what the four upstream projects
  actually do (verified by running them), their gaps, and security findings.
- [`docs/architecture.md`](docs/architecture.md) — recorded decisions, topology, per-editor integration
  contract, and the phase plan.
- [`spikes/embed-poc`](spikes/embed-poc/README.md) — reproducible proof that Docs and Sheets can be
  embedded with all file bytes owned by the host.

Single sign-on, collaborative editing and cross-format compatibility are **not** claimed
until verified (see the recon doc).
