# Shopfloor KB Hub — Project Profile

> Status: POC planning · Last updated: 2026-10-01
> Purpose of this file: single source of truth for the project background, requirements, decisions and architecture. Read this first before any design or implementation work.

---

## 1. Background

The company runs a large, multi-country, multi-region shopfloor (MES) solution. Over 20+ years it has grown into a very rich platform:

- **Thousands of shopfloor instances** running across Asia and the Americas.
- Every project is deployed **on-premises** at its site, and most projects carry **customizations** to meet local or customer needs.
- Developers and deployment teams change over time. Much of the knowledge (why something was built, how, and where else it exists) has left with them.
- The same or similar functions have been built more than once at different sites, because nobody could find the existing one.

The knowledge exists, but it is scattered across two systems:

| System | Holds | Notes |
|---|---|---|
| **FlexPM** (in-house) | Change Request (CR) tickets and their tasks, attachments (docs, ppt, pdf, customer specs, drafts), edit history | >20,000 CR tickets; ~200 new per year |
| **Azure DevOps** | Source code repos, PRs, commits, builds/artifacts | Many repos, one per task; plus legacy code not linked through PRs |

## 2. Goal

Build a **Knowledge Base (KB) Hub** that lets company engineers worldwide:

1. **Find** a shopfloor function, spec or requirement quickly.
2. **Understand** what a function does and **why** it was built — the real requirement *at the moment it was implemented*, even when the original developer has left.
3. **Locate** where else a function is available (other sites, projects, versions).
4. **Detect duplicates** — the same function built more than once — before building it again.
5. **Trace** in both directions: requirement → code, and code → requirement.

Users are **internal only** (company members). Cross-project visibility is allowed.

## 3. Source data facts

### 3.1 FlexPM tickets

- Task ID format: `<CR number>-<revision>`, e.g. `121648-01`, `121648-02`.
- **Revisions** (`-01`, `-02`, …) under the same number represent **newer functionality**. A given revision may serve **different projects** depending on when it was implemented.
- Fields include: Task, Topic, Old #, Priority, State, Owner, Required Date, Project, CUAT.
- Project field format: `<Prefix>_<Site>_<Customer>_<Program> <description> [<project id>]`.
- Example states: IN IMPLEMENT, IN DEV. LEAD APPROVAL, IN IMPLEMENTATOR TEST (PRE-UAT), IN UAT, SIT/UAT, SIT/UAT HOLD, SIQ, IN SUPPORT VERIFICATION (UAT), IN SUPPORT TICKET POOL, NOT IMPLEMENTED.
- Tickets get edited after creation; edit history must be kept.

### 3.2 Source code (Azure DevOps)

- Newer repos follow the naming convention `<Region>-<Customer>-FLEXPM<TaskNumber>-<FeatureName>`, which carries the CR link directly.
- Some code is linked to CRs via PRs / work items; some older code exists "old school" with no PR link.
- Every piece of code *should* trace back to a CR, but in practice linkage is incomplete.
- **Plug-and-play reuse:** a CR's code is sometimes applied to other projects **without a new CR**. These copies are invisible in FlexPM and can only be detected from the code itself.
- Different versions of the same function run at different sites worldwide.

### 3.3 Ingestion (already built)

- An in-house downloader app (FlexPM Terminal) downloads tickets and attachments daily, multi-threaded, with run reports and problem tracking.
- Observed average: ~2.3 MB of attachments per ticket (sample of 10 tickets).
- Current change detection: date + size checksum (add content hash).
- Azure DevOps source download/pre-processing is handled by the same in-house tooling.

## 4. Requirements

### 4.1 Functional

| # | Requirement |
|---|---|
| F1 | Keyword search with filters (site, customer, region, project, state, date, source type); exact IDs and code symbols jump straight to the item |
| F2 | AI question answering with citations to ticket, file, line range, commit |
| F3 | Browse ticket, CR family, repo, site and capability pages (wiki) |
| F4 | Download a complete ticket package (card + original attachments + references) |
| F5 | "Similar tickets at other sites" on every ticket (duplicate finder) |
| F6 | Show the requirement and code **as they were** at implementation time |
| F7 | Detect code reuse and clones across repos/sites, including plug-and-play copies |
| F8 | Answer list/count questions completely ("which sites have X?") |
| F9 | Daily incremental update for new and edited tickets and new commits |
| F10 | Expert review of low-confidence links and generated pages; human edits preserved |
| F11 | Same capabilities available from the web portal and from a homegrown IDE |

### 4.2 Non-functional

| # | Requirement |
|---|---|
| N1 | **Self-managed, portable stack.** No cloud-vendor managed services. AWS may be used only as rented infrastructure (EC2, GPU instances, disks), so the platform can later move to company-owned servers for better cost control |
| N2 | LLM and embedding models hosted in-house (open-weight models) |
| N3 | Every AI answer and every generated statement is traceable to evidence |
| N4 | Inferred links are marked as inferred, never shown as fact |
| N5 | Incremental by default; full rebuild only on template/prompt version change |
| N6 | Company SSO (AD / Entra ID) |
| N7 | Logging of questions, tool calls, answers and feedback for evaluation |

## 5. Key design decisions

| # | Decision | Reason |
|---|---|---|
| D1 | **Knowledge card per task revision** (e.g. `121648-02`) is the central unit | Matches how FlexPM tracks functionality; revisions can serve different projects |
| D2 | Card merges **CR requirement + linked source code logic** into one document, in a skill.md-style format (overview → detail → references) | Agents read the overview first and drill down only when needed |
| D3 | **Card first, code on demand** — real source code stays indexed and searchable | The card is a lossy summary; exact logic, verification, unexpected questions and unlinked code all need real code |
| D4 | RAG is the core engine; the wiki is a human-facing view of the same cards | Agent + retrieval answers questions; wiki serves browsing, sharing and downloads |
| D5 | Three stores in L3: link DB (truth), search index (retrieval), code search (exact) | Vector search alone fails on exact IDs, completeness, relationships and clone flooding |
| D6 | Index pages are **generated** from the link DB, hierarchical | Hand-maintained indexes drift; one flat index is too big for any context window |
| D7 | Links carry confidence: Confirmed / Strong / Inferred / Unlinked, with evidence | Partial and messy historical linkage |
| D8 | Link CRs to **changesets/commits**, not just current files | Enables "requirement at that moment" via blame → commit → CR |
| D9 | One incremental pipeline; historical backfill = replay through it | Avoid two systems that disagree; re-runnable when logic improves |
| D10 | Central **git mirror** of all repos (bare clones, daily `git fetch`); legacy code imported into the same store | Fast incremental sync, full history local, low load on Azure DevOps |
| D11 | **Mid-size open-weight LLM** for the POC | Main cost is backend processing (backfill), not user traffic; measure quality before scaling |
| D12 | Web portal + **homegrown IDE** (Claude Code desktop-style) on one backend; MCP server for AI clients | Customizable for company needs; single source of logic |
| D13 | Static wiki build for the POC | Simple; move to dynamic rendering when review/edit screens are needed |

## 6. Knowledge card

### 6.1 Identity model

| Level | Example | Meaning | In the KB |
|---|---|---|---|
| CR family | `121648` | Same base number | Family index page listing all revisions |
| Task revision | `121648-01`, `121648-02` | Newer functionality; may serve different projects | **One card each**, linked as a revision chain, each with its own "applies to projects" list |
| Card version | edit #3 of `121648-02` | Ticket edited after creation | History kept inside the card, never overwritten |

### 6.2 Card template

```markdown
---
ticket: 121648-02
cr_family: 121648
revision: 02
title: <FlexPM topic>
project: <FlexPM project>
site: <site>
customer: <customer>
region: <region>
state: <FlexPM state>
owner: <owner>
dates: { created: , required: , cuat: , last_edit: }
applies_to_projects: [ ... ]
previous_revision: 121648-01
repos: [ ... ]
commits: [ ... ]
link_confidence: confirmed | strong | inferred | unlinked
card_status: generated | reviewed
template_version: v1
source_hashes: { ticket: , attachments: [ ], code: [ ] }
---

# Overview
3–5 lines: what this does, why it was built, where it runs.

## Business logic
The requirement as understood from the CR and its specs.

## Technical logic
Components, stored procedures, tables, flow, configuration flags.

## Variants & reuse
Other sites/repos with the same or similar code (clone group, revision chain).

## Change history
CR versions and key commits over time.

## Gaps & confidence
Missing specs, inferred links, conflicts between spec and code.
Marks which statements come from sources vs. interpretation.

## References
- FlexPM ticket link
- Attachments (file names, versions)
- Repo / path / line range / commit for each code reference
```

Special cases: tickets with no code and code with no ticket still get cards, marked as such. Very large tickets may need a parent card with child sections.

## 7. Architecture

### 7.1 Layers

| Layer | Name | Function | Components (POC) | Output |
|---|---|---|---|---|
| L0 | **Ingestion** (existing) | Daily download of FlexPM tickets/attachments; git mirror of all repos; run manifest of new/edited/deleted | In-house downloader; `git clone --mirror` + `git fetch`; ADO REST API for repo list | Raw files store + git mirror |
| L1 | **Normalization** | Docs → Markdown with front-matter; OCR; parse code into functions/procedures; parse repo names; hash-based change detection | Docling or MarkItDown; PaddleOCR or Tesseract; tree-sitter; ScriptDom or sqlglot; Python workers | Normalized MD + parsed code (MinIO) |
| L2 | **Knowledge cards** | CR↔code linking with confidence; clone detection; generate one card per task revision; review queue | LLM via gateway; AST hashing + MinHash/LSH; versioned card template + prompt | Card MD files + link records |
| L3 | **Knowledge index** (RAG retrieval) | Link DB as source of truth; generated hierarchical index pages; chunk + embed cards, attachments, code; code search | PostgreSQL; Elasticsearch (self-managed); BGE-M3 embeddings (in-house); Zoekt | Searchable index + index pages |
| L4 | **Knowledge views** (wiki) | Ticket/family/repo/site pages rendered from cards + DB; ticket package download; similar tickets; capability pages (LLM, reviewed) | MkDocs Material static build (POC) | Wiki site |
| L5 | **Agent & services** (RAG generation) | Agent with tools; tool API; MCP server; LLM gateway | vLLM serving a mid-size open-weight model; LiteLLM proxy; agent service; REST + streaming; MCP over HTTP | Cited answers |
| L6 | **Clients** | Web portal (Search, Ask, Browse, download); homegrown IDE with local tools; Teams bot later | React web app; Electron or Tauri desktop IDE | — |

### 7.2 What gets chunked and embedded (L3)

| Source | Chunked by | Role |
|---|---|---|
| Knowledge cards | Section (Overview, Business logic, Technical logic, …) | Primary; searched first |
| Attachment MD | Heading / slide | Detail summarized away by the card |
| Code | Function / stored procedure | Exact technical lookup |

Every chunk carries the card's front-matter for filters and citations. Index pages are read by the agent directly, not embedded. Clone copies are collapsed to one result per clone group before results reach the LLM.

### 7.3 Agent tools (L5)

| Tool | Purpose | Backed by |
|---|---|---|
| `get_index` | Navigate index pages (site / customer / capability / CR family) | Generated index pages |
| `search_kb` | Hybrid search over cards and raw docs, with filters | Elasticsearch |
| `get_card` | Read a full card | Card store |
| `which_sites` / `query_links` | Lists, counts, versions, lineage (fixed parameterized queries) | PostgreSQL |
| `find_similar` | Similar tickets / clone group | PostgreSQL + Elasticsearch |
| `search_code` / `get_code` | Exact/regex search; read code at a given commit | Zoekt + git mirror |

The IDE adds **local tools** (open file, current repo, current line → card).

### 7.4 Platform

| Need | Component |
|---|---|
| Container platform | Kubernetes (RKE2 or k3s on EC2) |
| Object storage | MinIO (S3-compatible, self-hosted) |
| Git mirror storage | Filesystem volume / NAS |
| Pipeline orchestration | Prefect or Airflow (self-hosted) |
| Queue | RabbitMQ or Redis |
| Identity | Company AD / Entra ID via OIDC (Keycloak optional) |
| Secrets | HashiCorp Vault |
| Container registry | Harbor |
| Monitoring | Prometheus + Grafana, OpenTelemetry |
| LLM tracing & evaluation | Langfuse (self-hosted) + golden question set |

## 8. Process flows

### A. Daily update (incremental)

```
L0 manifest (new / edited / deleted tickets; new commits via git fetch)
  → L1 normalize changed files only (hash check)
  → L2 relink + regenerate cards for affected task revisions
       (a commit on a linked repo also triggers its cards)
  → L3 upsert link DB → re-render affected index pages → upsert search index
  → L4 rebuild affected wiki pages; flag reviewed pages whose sources changed
  → Review queue: low-confidence links, new clone groups, flagged pages
```

### B. Question from the web portal

```
User → portal → agent service
  → classify (lookup / list-count / compare / explain)
  → tools: index pages or search → cards → link DB → code if needed
  → LLM (via gateway) answers with citations
  → portal shows answer + clickable cards and sources
```

### C. Question from the homegrown IDE

```
Developer in a repo → IDE → same agent service
  → server tools + IDE local tools (open file, current repo)
  → answer tied to the code on screen
```

### D. Full rebuild (rare, planned)

```
Card template or prompt version changes
  → batch regenerate all cards → re-embed → rebuild index pages
  → keep old version live until the new one passes evaluation
```

### E. Card first, code on demand

```
Question → read card (Overview → Business/Technical logic)
  → enough? yes → answer citing the card
             no  → follow References (repo, path, line range, commit)
                   → read real code → answer citing the code
```

## 9. Linkage strategy

| Tier | Evidence | Handling |
|---|---|---|
| Confirmed | Repo name contains `FLEXPM<id>`; PR or work item links the CR | Used directly |
| Strong | CR number in commit message, branch name or code comment | Used, marked strong |
| Inferred | LLM judges CR text vs. code change, with time / developer / files as hints | Marked inferred; sampled for review |
| Unlinked | Nothing found | Recorded as a knowledge gap |

Clone detection (normalized AST hashing + MinHash/LSH, embedding similarity for modified copies) classifies code as exact copy, modified variant, or independent re-implementation, and builds lineage: origin CR → copies across projects.

## 10. Sizing (estimates, to be confirmed)

| Item | Estimate |
|---|---|
| Raw FlexPM attachments (20k tickets × ~2.3 MB) | ~45–50 GB |
| Normalized MD | a few GB |
| Knowledge cards | < 1 GB |
| Vectors + keyword index | ~20–40 GB (×2 with replica) |
| PostgreSQL link DB | a few GB |
| Git mirror | **Unknown — measure with first full clone** |
| Backfill compute | Likely days on 1–2 GPUs with a batched mid-size model; measure on 200–500 tickets first |

Code index scope for the POC: default/release branch only; skip generated files, binaries and third-party libraries.

## 11. Quality and evaluation

- Golden set of ~100 real user questions with known answers, covering lookup, list/count, comparison and explanation.
- Run after every pipeline, prompt or model change; track answer accuracy, citation correctness, "not found" rate.
- Weekly sample review of inferred links; tune thresholds.
- Expert review of top capability pages; reviewed status shown in the UI.
- User feedback in the UI (thumbs, "wrong link", "outdated page") feeds the review queue.

## 12. POC roadmap

1. **Foundation** — L0 git mirror alongside the existing downloader; L1 normalization; link DB with confirmed links only (repo names, PRs).
2. **Card pilot** — generate cards for 200–500 tickets on the mid-size model; measure tokens per card, hours per 1,000 cards, card quality via expert review.
3. **Search release** — Elasticsearch + Zoekt; web portal with Search, ticket pages, similar tickets, ticket package download; static wiki.
4. **AI release** — inferred links, clone lineage, Ask mode with citations, golden-set evaluation.
5. **IDE + knowledge release** — homegrown IDE client, MCP server, capability pages with expert review.

Phases 1–3 deliver value before any AI answering, which lowers risk for the first release.

## 13. Open questions

- [ ] Number of repos and total code size (git mirror sizing)?
- [ ] Is there a reliable record of which repo / branch / tag is deployed at each site?
- [ ] Languages used in CRs and specs (English only, or others)?
- [ ] Elasticsearch license tier: which hybrid/ML features are needed and covered?
- [ ] Which mid-size open-weight LLM and GPU instance type for the POC?
- [ ] Pilot scope: which region or product line first?
- [ ] Domain reviewers for links, cards and capability pages?
- [ ] Format of legacy (non-PR) code: TFVC, SVN, file shares?

## 14. Glossary

| Term | Meaning |
|---|---|
| CR | Change Request ticket in FlexPM |
| Task revision | A FlexPM task number with revision suffix, e.g. `121648-02` |
| CR family | All revisions sharing the same base number |
| Knowledge card | One generated Markdown document per task revision combining requirement + code logic |
| Link DB | PostgreSQL store of tickets, revisions, repos, sites, projects, links, clone groups |
| Index pages | Generated hierarchical navigation pages for the agent and users |
| Clone group | Set of code units identified as copies or variants of the same function |
| Plug-and-play | Applying an existing CR's code to another project without a new CR |
| RAG | Retrieval-Augmented Generation: retrieve evidence (L3), then generate an answer (L5) |
| MCP | Model Context Protocol: standard way for AI clients to call the KB's tools |
