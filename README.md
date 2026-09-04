# BizLab — Ripple + Ember

Combined source repository for Ripple and Ember, hosted in HighLevel with a shared Supabase project.

## Included

| Area | Source |
| --- | --- |
| Ripple | Dashboard, booking page, send-postcards, provision-thanksio, landing, ghl-intake, drain-queue |
| Ember | Control Center, fieldroutes webhook, historical backfill, operations API |
| Shared | BizLab Super Admin HTML, location switcher, admin-operations, backend helpers |
| Database | 23 recorded migrations exported on 2026-09-04 |
| Documentation | Ripple and Ember runbooks, version notes, provenance inventory |
| Workflows | Available Ripple address-backfill n8n export |

## Layout

- `web/highlevel/ripple/`: Ripple dashboard and booking HTML.
- `web/highlevel/ember-control-center.html`: Ember location dashboard.
- `web/highlevel/shared/`: combined Super Admin and location switcher.
- `supabase/functions/`: nine deployed Edge Functions and shared helpers.
- `supabase/migrations/`: original recorded migration versions, in order.
- `workflows/n8n/`: available workflow export.
- `docs/archive/`: historical source snapshots, NOT deployment inputs.
- `docs/source-inventory.json`: source provenance and known gaps.

## Important: this is not yet a clean-install database backup

The recorded migration history starts at 0029. Earlier base-table definitions and migrations are not in that history; only a separate local 0028 SQL file was available. Do NOT run these migrations against a blank database or automatically push them to production.

A verified baseline schema export and restore test are still needed for a reproducible fresh installation. The ZIP does not contain customer data, database backups, secrets, provider accounts, scheduled-job configuration, a login page, or a complete collection of HighLevel/n8n workflows.

The HTML is taken from the available local source files, not freshly exported from HighLevel. The two runbooks are historical documentation and can predate the backend captured here. Exported Edge Functions preserve deployed code; packaging is not a security certification or end-to-end application test.

## Existing environment

The browser interfaces use the existing Supabase project and shared login/session setup. Keep the current `/ember-control-center?loc=...` route. Review URLs and public anonymous-key configuration before using a different environment.

Secrets belong in Supabase's server-side secret configuration, never in browser HTML or Git. `.env.example` lists placeholders. No deployment or message sending was performed while assembling this repository.

Keep Ripple and Ember authorization and sending controls separate. Ember must remain disabled until its onboarding and backfill requirements are met.

## Upload to GitHub

Create a PRIVATE repository named `bizlab-ripple-ember`.

For the downloaded source ZIP, extract it and run in that folder:

```bash
git init -b main
git add .
git commit -m "Add Ripple and Ember source"
git remote add origin https://github.com/YOUR-ACCOUNT/bizlab-ripple-ember.git
git push -u origin main
```

The ZIP is a source archive, not a Git history bundle. The working repository used to create it retains the original Ember commit.
