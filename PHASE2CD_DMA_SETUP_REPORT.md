# Phase 2C/2D — one-DMA setup, 27 September 2026

Selected DMA: **300mm Bukit Kuau lama** (canonical D1 spelling). This is a real active GIS zone, not a fabricated pilot. Current D1 has **137** clipped parts/segments, **126** distinct asset IDs, **4** parts without positive GIS diameter, and **39,623.4 m** geometry-derived line length. GIS length is not accepted as engineering pipe length. No verified ID can be assigned to otherwise unlinked source segments from proximity.

The existing AI Agent page now has a compact per-DMA status card, missing-data controls, manual and CSV/Excel column-mapped preview, explicit DRAFT confirmation/save and independent append-only review controls, plus a button for actual locatable missing-diameter GIS issues on the existing Leaflet map. All actions bind to the existing District Metered Area selector; there is no pilot selector or new map. The Worker validates model/DMA registration, units, source, time, duplicates, conflicts and exact preview hash. A staging TEST JWT cannot write real model data. Approved review records update field evidence status; a DRAFT or ASSUMED value never silently becomes VERIFIED. The Run Baseline control remains disabled without a complete signed model.

Production D1 migrations **0005 and 0006 applied** after a private SQL recovery export. The export was restored locally; both migrations passed on the snapshot. Protected assets and selected GIS line counts are unchanged: **9,428 assets** and **137** selected-zone parts before and after. The checkpoint is local, outside Git, at `private-checkpoints/sains-ai-db-pre-0005-0006-20260927.sql` (SHA-256 `06005E97BDDCB05D04819510865E2C82087D36EDA5CC2B3FCEBAA14B942F8FE5`). No production asset/GIS/operational row was modified.

The staging gateway was deployed directly as version `f298f615-985f-4616-b808-009e98553e70`; the private Container was **not rebuilt**. Its TEST model completed via Worker → Container → EPANET → persisted result with 87.59948 m minimum pressure and GeoJSON. Staging has no D1 binding: the real-DMA save/status endpoints return unavailable there, and the TEST credential cannot write them. Production Worker and GitHub Pages frontend were **not deployed**; the new real-DMA workflow has not passed deployed authenticated production E2E. Current D1 has **0 hydraulic models and 0 parameter reviews**. No SAINS baseline or calibration run occurred.

Targeted JavaScript regression: **31/31 PASS**, including Phase 2A smoke, Phase 2B readiness, Phase 2B-S reference E2E, intake validation, independent review and DMA binding. Browser issue highlighting and real-DMA save need authenticated production validation after safe promotion. No old Container fault or numerical benchmark was repeated.

| Selected DMA status | Result |
|---|---|
| HYDRAULIC DATA COMPLETION | PARTIAL — GIS only; no registered engineering model |
| STEADY-STATE | NOT READY |
| BASELINE | NOT READY; Run Baseline disabled |
| CALIBRATION | NOT READY; no approved non-TEST observations/mappings |
| PIPE FAILURE | NOT READY |
| SCENARIO COMPARE | NOT READY |
| PRODUCTION HYDRAULIC SIMULATION | DISABLED |

Next operator action: supply the reviewed as-built/engineering dataset for **300mm Bukit Kuau lama**—verified Pipe IDs and connectivity, engineering lengths and diameters, Hazen-Williams C with provenance, node elevations/demands, source head, equipment inventory and applicable sensor observations. Then safely promote the additive Worker/UI changes to production, register the DRAFT model using a real ADMIN account, submit and independently approve entries, verify topology and recalculated readiness. Only after every gate passes may a model-version-specific real baseline be considered; the current Python staging service still refuses non-TEST model IDs.
