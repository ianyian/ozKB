# KB Hub prototype

> Full feature description, configuration, deployment and API: see the [project README](../README.md).

A working mini version of the Shopfloor KB Hub proposal (`docs/project-profile.md`):

| Layer | In this prototype |
|---|---|
| **FlexPM (simulated)** | Scripted timeline of 100 task revisions: new CRs, revision +1, ticket edits, with .docx/.pdf/.md attachments. Sample Python/Node repos with real git commits, including plug-and-play copies, independent duplicates and tickets with no code. Same seed = same story every run. |
| **L1 · Normalize** (scheduler) | Scans the raw store, SHA-256 change detection, one job per change (before → processing → done/failed). docx/pdf/md → Markdown, code → function-level units with MinHash fingerprints. |
| **L2 · Cards & links** (scheduler) | CR↔commit links with confidence (confirmed / strong / inferred), clone groups, similar tickets and duplicate flags, one knowledge card per task revision built from the code *as it was* at the linked commit. Every card statement carries a source tag. |
| **L3 · Index** | Postgres (Neon in the cloud, embedded PGlite locally): link DB, cards, documents and code with full-text search. |
| **L4–L6 · Engineer portal** (`/`) | **Ask** with cited answers and the agent's steps (complete "which sites" lists from the link DB), **Search**, **Functions** pages (every site, revisions, plug-and-play copies, separate re-implementations), **Check before you build** for new CR text, **Code → requirement** (click a line: commit, CR, why, copies elsewhere), ticket pages with **ticket package download** and **feedback** into the review queue. |
| **Operations** (`/ops/`) | Dashboard, control & configuration console (with change history), job monitor, logs with per-ticket trace, run history, review queue, demo reset. |

## Run locally

```bash
cd prototype
npm install
npm start            # http://localhost:7860, embedded database in ./.data
```

Set `DATABASE_URL` to use Neon or any Postgres instead. Optional: `ADMIN_PASSWORD` protects
the control actions; `HF_TOKEN` plus `llm.provider = hf` in the console makes cards with a
Hugging Face model (needs Inference Provider credits).

Headless full run (all 383 events, about one minute): `npm run demo`.

## Cloud

- **App:** Hugging Face Space `YianXingJian/ozKB` (Docker), deployed by `.github/workflows/deploy-space.yml` on every push to `prototype/`.
- **Database:** Neon Postgres; the workflow copies the `DATABASE_URL` GitHub secret into a Space secret.
- **Raw store:** inside the container (`/tmp/sim-data`). After a restart it is rebuilt by replaying the same events, so commit ids stay identical.

## Demo script (about 15 minutes)

Part 1 – the engineer's view (start here; run the pipeline beforehand so data is there):

1. **Home** → ask *"Which sites have label reprint control?"*: complete list with citations, the hidden GDL copy and the separately built AUS version. Open *How this answer was found*.
2. Ask *"Why was the reprint limit added?"*: the original reason, the rules and how the function evolved.
3. **Functions → Label reprint control**: one page per function across all sites.
4. **Check before you build** → Example 1: the function already exists, so reuse instead of rebuild.
5. **Code → requirement** → `AMER-HALCYON-ShopfloorExt/modules/label_reprint.py`, click line 15: a commit with no CR traced to CR 118256-01.
6. Any ticket → **Download ticket package**; report a **Wrong link** and show it arriving in the ops review queue.

Part 2 – how it is kept up to date (`/ops/`):

1. **Control & configuration → Reset demo.** Everything is empty.
2. **Dashboard → Start all schedulers.** FlexPM events start arriving; L1 and L2 queues fill and drain.
3. **Job monitor.** Click a job: before/after of one ticket or file, plus its log lines.
4. **Logs.** Filter by ticket to show the trace from simulator to card.
5. **Tickets → 118256-01.** Card with source tags, revision chain, and the inferred plug-and-play copy at GDL. Compare with 118256-03: different code, because each card shows the code as it was for that revision.
6. **Search** "label reprint": cards, attachments, and code with copies collapsed.
7. **Review queue.** Approve an inferred link; L2 regenerates the card with an expert-confirmed link.
8. **Configuration.** Change a threshold or the simulator speed; show the change history.
9. Reset again to repeat.
