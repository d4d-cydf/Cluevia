# Cluevia · Evidence Graph

A web app that identifies objects and relationships in source material, validates their evidence, and presents them as graphs. A request from the home screen runs through **clarification and scope confirmation → reading the supplied URLs → ontology design with Claude → tabular data conversion / document analysis with Claude / optional Jev judgments → schema and evidence validation → SQLite storage → graph and short report rendering**. No Palantir account or Foundry data is required.

## Run the app

Use **Node.js 22.17 or later**. In Windows PowerShell:

```powershell
npm ci --include=dev
npm run dev
```

Open `http://localhost:5173`. New analyses first design an ontology for the supplied material, so a Claude Code login is required. Saved graphs and ontologies can be opened without a model connection.

### Build and run locally

The same commands work in Windows PowerShell and macOS/Linux/WSL. Install dependencies and run the app in the same environment.

```sh
npm ci --include=dev --include=optional
npm run build:all
```

The app is built into `dist/` and the documentation into `docs/out/`. Both builds first check the required executables and native dependencies for the current OS, reinstalling them automatically if they are missing or incompatible. Reinstallation requires an internet connection. Building does not require a model login or API key.

After building, run these commands in two separate terminals.

```sh
# App + API: http://127.0.0.1:5173
npm start
```

```sh
# Documentation: http://127.0.0.1:3001
npm run docs:preview
```

The documentation's app links point to `http://127.0.0.1:5173` by default. If an existing `docs/.env.local` specifies another address, change it to `NEXT_PUBLIC_CLUEVIA_URL=http://127.0.0.1:5173` and rebuild. Use `npm run build` to build only the app, or `npm run docs:build` to build only the documentation.

### Connect models

**Connect Jev:** Enter your TypeSafe API key after `TYPESAFE_API_KEY=` in `.env.local`, then restart the server. If the file does not exist, copy `.env.example`. Do not overwrite an existing `.env.local`. You can start with the default model and concurrency settings.

```dotenv
TYPESAFE_API_KEY=your_TypeSafe_API_key_here
```

For ontology design and document analysis, install Claude Code and sign in with the following commands on the same computer, OS, and user account that runs the server. The server uses a recent CLI that supports `high` and `medium` for `--effort`.

```powershell
claude auth login
claude auth status
```

Jev is optional. Without a key, Claude still handles ontology design and document analysis. Even with a key, the app does not send every document to Jev; it uses Jev only for judgments that can be safely expressed as a limited set of choices.

- If you see `'vite' is not recognized`, run `npm ci --include=dev` first.
- Windows and WSL use separate executables and logins. Install and run in the same environment. If you switch environments, run `npm ci` again in that environment.
- The home screen's **Jev selective judgments ready** status means a key is configured on the server. Key validity, model access, usage limits, and network errors are checked during actual analysis requests. Tabular data also uses Claude for the initial ontology design, then converts each row using validated column mappings.
- The default model is Claude Sonnet 5.5. Select it with `CLUEVIA_MODEL_PROVIDER=claude` and `CLAUDE_MODEL=claude-sonnet-5-5` in `.env.local`. Claude runs in an isolated temporary directory and returns only structured JSON, with tools, MCP, user settings, hooks, and conversation persistence disabled. The existing Codex runner is available through `CLUEVIA_MODEL_PROVIDER=codex`.
- Install Claude using the [official setup guide](https://code.claude.com/docs/en/setup). Authentication uses the server OS's login store; do not copy credentials into the project.

## Workflow

1. Enter a question on the home screen and attach UTF-8 text sources such as JSONL, NDJSON, CSV, TSV, JSON, XML, YAML, or logs, or paste the source text. You can also enter article URLs, one per line, in **Paste source text or URLs**. Source files have no extension restriction.
2. Select **START INVESTIGATION** to answer questions about the analysis objective, subjects, and scope. Choose an option or **Other · Enter your own answer**, edit the summarized request, then select **Start analysis with this scope**. The app uploads the sources, creates a job, and opens the graph workspace at `/analysis/:jobId`. The AI agent panel on the left shows the server's actual stages—ontology design → source preparation → analysis → evidence validation → storage—and the current task.
3. Partial graphs appear in the same workspace as soon as they are validated and saved. **Overview** shows the standard graph by default. Gap analysis starts only when you select **Cluevia on**; if a saved analysis exists, its results are displayed first. There are no separate Connections / Evidence tabs or Review screen. When enabled, the view animates red lines and warning icons by gap type over an Evidence graph containing conclusions, conditions, and evidence. Select a warning to open an overlay with its explanation, evidence, likelihood ratios, factors, and supplementary sources. The analysis shows its stage status and reveals only calculated results, in sequence. **Recheck** explicitly starts a new analysis, and **Cancel** stops it. **Cluevia off** hides the gap visualization without canceling an analysis in progress. Results are versioned, and dragged node positions are saved on the server so they can be restored on other devices. **Board / Lanes** lets you explore all objects and relationships.
4. Open **ONTOLOGY** to inspect each analysis's object types, properties, relationships, and constraints, and search the objects and original evidence stored under that ontology.
5. Use the toggle to the left of the logo to open the **case sidebar** and revisit saved graphs. Graphs remain available when you switch browsers, provided you connect to the same server.

**Confidence in the bottom-right corner of Overview** uses the adjusted likelihood-ratio model from saved judgments. For each condition, it calculates `log(LR′) = source factor × evidence factor × log(LR)` and multiplies the specified prior odds only by observations whose independence has been established. Duplicate observations, repeated citations, and shared observations are not counted again. Parent AND/OR nodes show ranges when dependence between conditions is unknown. NOT_SUPPORT is an AND that establishes a negative claim. The app does not guess a score when the prior probability, LR, or factors are missing. The popup shows the original and adjusted LR, assumptions, inputs, exclusion reasons, and calculations for each condition. Existing quality-support scores remain separate values. Once analysis is complete and connecting lines appear, the view displays the actual calculations and their changes from previous values. Opening the view or checking Confidence does not run a model.

**If you submit only a question**, the app designs and saves the ontology structure and shows an **Open ontology** link on the analysis screen. Without supporting source material, it does not invent actual objects, relationships, or graphs. Attach evidence or paste source text to generate a graph.

You can also start by attaching sources without a question. In that case, the app uses a default request to organize the objects and relationships in the material.

Example of designing a structure from a question alone:

> Create an ontology for customers, orders, and products. Identify customers by customer ID and orders by order number, and include order amount and order date as properties.

If you attach a CSV, the app uses its columns and sample data to design types, properties, and relationships, then converts the actual rows into a graph. GFW's public 2017 Galápagos case remains available as an existing example.

Refreshing the analysis screen during generation or selecting **Open analysis** on the home screen retrieves the server job again. Existing `/?job=JOB_ID` links also open the new analysis screen. Canceling stops active model requests and Codex processes. After a failure, cancellation, or server restart, use **Resume remaining segments** to continue unfinished segments. Saved partial graphs are retained. Jobs run one at a time, with a maximum of five running and queued jobs combined.

## Clarification before analysis

- If a request is broad or ambiguous, the AI proposes 1–3 multiple-choice questions. Each question has 2–4 choices plus **Other · Enter your own answer**, with at most two rounds of clarification. A sufficiently specific request may go directly to scope confirmation.
- This step does not upload files or create a graph job. The browser reads a limited preview from the beginning of each file and sends **at most 12,000 characters of previews in total** from up to 10 sources, along with the original request and answers. Previews are not assumed to represent the full source material.
- On the final screen, you can edit the **analysis objective, scope, and desired output**. Review the original request and the questions and answers before explicitly starting. **Edit request** cancels clarification and returns to the existing input and attachments. **Analyze the current request without questions** starts directly with the original request.
- If follow-up question generation fails, the app displays **default clarification questions**. If summarization fails after you answer, it provides a scope confirmation screen that preserves the original request and your exact answers. Connection errors can be retried; an error alone never starts graph analysis.
- While answers are being submitted, selections are retained and duplicate submissions are blocked. The request and original attachments are temporarily stored in browser IndexedDB, with form state saved as a draft for each tab. After a refresh, scope preparation resumes from the submitted answers; a graph job is created only after the final start button is selected. Temporary copies are removed after a successful start or when you edit the request, and drafts older than 24 hours are cleared on the next save or recovery. If browser storage is blocked, analysis can still proceed in the current view, but refresh recovery is unavailable.
- The confirmed `analysisBrief` represents the user's analysis intent. It is not used as an original source or evidence of facts. Original attachments and every analysis segment are preserved, while the model is instructed to focus design and extraction on relevant objects and relationships. Clarification alone neither truncates the source material nor guarantees better model accuracy or shorter total processing time.
- Importing a completed graph JSON follows the existing flow without clarification questions.

## Analyze large files in full

The previous **2 MB limit on source attachments has been removed**. By default, the app imposes no file size cap. Server storage, browser limits, and external proxy limits still apply separately.

- Regardless of file extension, **UTF-8 text** is sent from the browser as a raw file. The browser does not turn an entire large file into one string or JSON request.
- For supported tabular formats, the server reads records and converts them into the ontology. **It does not call an LLM for each row that has a validated mapping.** AI handles portions that are difficult to map. Column meanings and relationships follow the ontology mappings for that analysis, and the complete original is stored separately. Syntax errors in structured files are reported with their locations.
- Documents are split into bounded segments and analyzed by AI against the generated schema. Jev handles repeated classification and candidate relationship-type judgments for text and description columns. Independent short records are grouped and sent to Codex; complex or uncertain records are analyzed individually. Analysis caches distinguish ontologies and processing settings.
- AI handles segments that are unsuitable for Jev or remain uncertain. New ontology-based analyses do not save uncertain partial results as completed output, even with `CLUEVIA_JEV_FALLBACK=false`. See [large-file processing details](docs/large-data.md) for supported formats and compatibility with earlier workflows.
- For tables without row IDs, the server assigns an `evidenceId` and converts rows directly. Text columns are analyzed separately as `semanticColumns`, and segments that time out are split into smaller pieces and retried. Repeated Jev judgments use [JSON policies and a fixed executor](docs/jev-decision-plan.md).
- **Every segment of the attached material is processed.** This means the complete input is processed; it does not guarantee that the model extracts every fact. Relationships between distant passages may require separate review.
- The left side of the analysis screen shows actual segment counts, the current source, and the **Jev processing** path or reason it was not used. **Processing details** shows tabular rows, Jev calls and judgments, individual Jev review judgments, Codex calls and batched analyses, and reused results. Expand **Jev judgment details** to inspect each source's choices, confidence, and processing path. Percentages are not shown until the total segment count is known. Estimated cost or completion time is not presented as an actual measurement.
- Results are saved as partial graphs. Use **Previous / Next / Select graph** to open all results. Objects are linked by ontology, type, and primary key; separate ontologies remain distinct.
- Failed or canceled segments are not counted as completed. Saved results and segment progress are committed together so that resuming does not reanalyze completed segments.

You can optionally set an operational limit in `.env.local`, such as `CLUEVIA_MAX_UPLOAD_MB=100`. A value of `0` removes the size cap. Restart the server after changing it. The 2 MB limit for **importing completed graph JSON** and the object count limit per graph are separate from the upload limit for original source files.

## Ontology builder

Codex produces a concise blueprint of core objects, properties, relationships, and mappings. The server's builder fills in repeated metadata and defaults, then validates the result. It runs automatically when you start an analysis from the home screen, and a local script is also available.

```powershell
python scripts/build_ontology.py --template commerce | Set-Content -Encoding utf8 blueprint.json
python scripts/build_ontology.py blueprint.json | Set-Content -Encoding utf8 ontology.json
```

The script validates and expands blueprint JSON without calling a model. `valueSource` distinguishes business identifiers from the original material from server-assigned provenance and extraction record IDs. See [large-file processing details](docs/large-data.md) for the full contract and how to resume failed jobs.

## Custom ontology and graph generation

```text
Question + attached sources
  → Clarification questions and answers → user confirms objective, scope, and output
  → Codex: design object types, properties, relationships, identity keys, and source mappings
  → Validate and save a versioned OntologyDefinition
  → No sources: save the structure only and stop
  → Tabular data: convert every record using validated mappings
  → Table text and descriptions: repeated Jev classification and candidate relationship-type judgments
  → Batch independent short records for Codex; analyze complex or uncertain records individually
  → Also use direct Jev extraction for simple relationships that meet the criteria
  → Validate property types, relationship endpoints, references, and original quotations
  → Generate GraphDocument + save objects, relationships, and evidence in SQLite
  → Render Overview / Board / Lanes
```

| Component | Implemented scope |
| --- | --- |
| Object Type / Property | Types generated for each analysis, primary keys and display names, 22 primitive type names, property validation, and display metadata |
| Link Type | Source and target object types for each relationship, with 1:1, 1:N, N:1, and N:M declarations |
| Shared Property / Interface / Value Type | Shared properties, property and relationship contracts, semantics, and value constraints |
| Group | Classification of object types |
| Action Type / Function | **Design drafts that are not executed.** Only parameter and target-type metadata describing the behavior is stored |
| Identity / Versioning | Based on ontology ID and version, object type, and primary key. Resumed analyses use the saved definition |
| Evidence / Claims | Original quotations, source-specific properties, and the distinction between reported and inferred claims are retained |

This is an independent implementation informed by Palantir's [Ontology type concepts](https://www.palantir.com/docs/foundry/object-link-types/type-reference). It does not call Foundry APIs or an organization's Ontology. Supporting primitive type names does not implement all Foundry functionality. Media, attachment, time-series, marking, and encrypted types are schemas containing reference values; they do not provide file upload handling, a time-series engine, access control, or encryption. Interface search and display hints are also contract metadata and do not create a separate full-text search index.

Vessel types remain only in the existing example and are not fixed defaults for new analyses. Code handles graph assembly and layout. Quotation validation checks whether a quotation appears in the source; it does not guarantee that the model's semantic interpretation is factual.

- Ontology contract: [src/types/ontology.ts](src/types/ontology.ts)
- Extraction validation and graph conversion: [server/ontology.ts](server/ontology.ts)
- Accumulated knowledge and source storage: [server/ontology-store.ts](server/ontology-store.ts)
- Job management: [server/jobs.ts](server/jobs.ts)
- Jev API integration: [server/jev.ts](server/jev.ts), [large-file processing details](docs/large-data.md)
- Codex execution: [server/codex.ts](server/codex.ts), [details](docs/codex-wrapper.md)
- Graph contract and validation: [src/types/graph.ts](src/types/graph.ts), [src/lib/graph-document.ts](src/lib/graph-document.ts)
- Renderer: [src/components/graph/GraphRenderer.tsx](src/components/graph/GraphRenderer.tsx)

## Storage and configuration

If you need to configure the app, copy `.env.example` to `.env.local`. **Do not overwrite an existing `.env.local`.** Restart the server after making changes. There is no need to copy Codex authentication files or tokens into the project.

| Variable | Default / purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe API key. Used only on the server. Leave blank to disable the Jev connection |
| `TYPESAFE_MODEL` | `jev-1.13.0`. The Jev model to use |
| `TYPESAFE_CONCURRENCY` | `4`. Concurrent Jev requests, in the range 1–16 |
| `TYPESAFE_TIMEOUT_MS` | `30000`ms per request. Range: 1000–120000 |
| `TYPESAFE_MIN_CONFIDENCE` | `0.85`. Acceptance threshold for judgments, in the range 0.5–1. This does not guarantee actual accuracy |
| `CLUEVIA_JEV_FALLBACK` | Controls additional Codex analysis for jobs using the legacy pipeline. New ontology-based jobs always pass uncertain Jev judgments to AI |
| `CLUEVIA_MODEL_PROVIDER` | Defaults to `claude`; use `codex` for the previous runner |
| `CLAUDE_MODEL` | Defaults to `claude-sonnet-5-5` |
| `CLAUDE_BIN` | Path to the Claude executable. Leave blank to search PATH |
| `CODEX_BIN` | Leave blank to use the CLI installed in the project. Specify a path to use another executable |
| `CODEX_MODEL` | Model used when Codex is selected. Defaults to `gpt-6.1-sol` |
| `CODEX_REASONING_EFFORT` | Defaults to `high`; accepts `low`, `medium`, `high`, `xhigh`, `max` |
| `CODEX_ONTOLOGY_EFFORT` | Defaults to `medium` for ontology design |
| `CODEX_CLARIFICATION_EFFORT` | Defaults to `medium` for generating questions to clarify the user's scope |
| `CODEX_JEV_PLANNING_EFFORT` | Codex design of rules for repeated Jev judgments. Defaults to the global effort (`high`) |
| `CODEX_EXTRACTION_EFFORT`, `CODEX_CHAT_EFFORT` | Fact extraction, review of complex source text, and case chat. Default to the global effort (`high`) |
| `CODEX_TIMEOUT_MS` | 180000ms per extraction call. Range: 10000–600000 |
| `CLUEVIA_DATA_DIR` | `.cluevia`. SQLite data directory |
| `CLUEVIA_SEED_EXAMPLE` | `true`. Adds the GFW case on initial setup. `false` leaves a new workspace empty |
| `CLUEVIA_MAX_UPLOAD_MB` | `0`. No source file size limit. A positive value sets a per-file limit in MiB |
| `CLUEVIA_ACCESS_TOKEN` | Shared workspace key for external access. Must contain at least 16 characters when set |
| `CLUEVIA_HOST`, `PORT` | Address and port for `npm start`. Defaults to `127.0.0.1:5173` |

The server transforms each row of tabular data using a validated mapping. Material needed for ontology design and document analysis is sent to the connected Codex or TypeSafe model. Do not put API keys in `VITE_` environment variables or frontend code. Once an upload is complete, the source text is stored in the server's `.cluevia/ontology.sqlite` before analysis begins. Graphs and quoted evidence from successful segments are saved along with the position from which the job can resume. Canceling a job leaves completed uploads and graphs already generated in place. Incomplete data from an interrupted file transfer is deleted. This directory and `.env.local` are excluded from Git. To make a backup, stop the server and copy **the entire data directory**. Copying only the database file while SQLite WAL is in use may omit the latest records.

This app is **one shared workspace**. Users who know the access key share access to its material and graphs. Individual accounts, data isolation, and role-based permissions are not yet available. When the key is blank, only actual loopback connections can use the API. To use the app over a LAN or from another computer, configure a random access key on the server and enter it in the web interface. The key is stored in the current tab's `sessionStorage`. For internet deployment, use HTTPS and an authenticated access path. Do not connect a public reverse proxy without a key.

## Running the production build

```powershell
npm run build
npm start
```

`npm start` runs a Node server that serves both the built web interface and the API. Use `npm run dev` for the development server and `npm run preview` to preview a build; both use the same API and storage. Do not run multiple servers against the same data directory.

For LAN access, set `CLUEVIA_HOST=0.0.0.0` and `CLUEVIA_ACCESS_TOKEN` in `.env.local`. The host and port variables apply to `npm start`. Set the Vite development port with a command such as `npm run dev -- --port 5173 --strictPort`. Hosting only `dist` as static files does not run the generation or ontology storage APIs, so a Node server is required.

## API

If a key is configured, use `Authorization: Bearer <workspace key>`.

| Request | Purpose |
| --- | --- |
| `GET /api/system/status` | Connection, engine, and storage status |
| `POST /api/analysis/clarify` | `{question, sources:[{id,name,size,excerpt}], answers:[{question,answer}], round:0..2}` → clarification questions or an editable analysis scope. Does not upload files or create a job |
| `POST /api/documents/upload` | Raw file body, `Content-Type: application/octet-stream`, `X-File-Name: encodeURIComponent(name)` → `201 {document}` |
| `GET /api/documents/:id` | Size and segment count of a completed upload |
| `POST /api/jobs` | Request generation with `{question, documents:[{id,name,text,url?}], uploadIds?:string[], analysisBrief?:{objective,scope,output,answers}}`. Use upload IDs for large files. Returns `202 {job}` |
| `GET /api/jobs`, `GET /api/jobs/:id` | Job list and progress |
| `POST /api/jobs/:id/cancel` | Cancel generation. Retains completed partial graphs |
| `POST /api/jobs/:id/resume` | Resume analysis from the saved position |
| `GET /api/graphs`, `GET /api/graphs/:id` | Saved graph list and contents |
| `GET /api/graphs/:id/collection` | List and progress of all partial graphs in the same job |
| `POST /api/graphs/import` | Save a completed JSON graph with `{graph}` |
| `GET /api/ontology` | Generated ontology definitions and cumulative statistics |
| `GET /api/ontology/definitions/:id` | Definition including its version, types, properties, relationships, and processing policies |
| `GET /api/ontology/entities?q=&type=&ontologyId=` | Search objects and filter by ontology |
| `GET /api/ontology/entities/:id` | Object details, claims by source, relationships, and evidence |

The existing Foundry module `server/aip.ts` remains in the repository, but the current home screen and server use Claude ontology design, tabular data transformation, document analysis, and the optional Jev pipeline. The current app does not connect to the old `/api/aip/status` or `/api/graphs/generate` endpoints. Foundry environment variables are not required.

## GFW example and supported scope

The **public GFW case**, also available at `/case/gfw-galapagos/board`, is a prebuilt historical example. It contains 12 objects, 15 relationships, 2 events, and 3 sources. Counts in newly generated graphs vary with the question and the model's extraction results.

- [Introduction to the Global Fishing Watch map](https://globalfishingwatch.org/our-map/)
- [2017 vessel encounter analysis](https://globalfishingwatch.org/impacts/policy-compliance/transhippment-reefer-illegal-sharks/)
- [Follow-up report on the shark fishing case](https://globalfishingwatch.org/success-story/data-and-analysis-help-track-illegal-shark-fishing/)

The example [JSON](public/examples/gfw-galapagos.json) and [source summary TXT](public/examples/gfw-source-notes.txt) summarize official publications. They do not represent live AIS data or current vessel positions. An encounter at sea alone does not prove a cargo transfer. `reported` and `inferred` relationships are displayed differently.

- A job accepts up to 10 sources. Source files have no size limit by default, while each model call is limited by the segment size. PDF, image, Office, and archive files require separate content extraction and are not yet converted automatically. Extract their contents and attach them as UTF-8 text. Inline `documents` in the API retain the existing limits of 50,000 characters per document and 150,000 characters in total; send larger bodies through the file upload API.
- Enter public article URLs one per line in **Paste source text or URLs** to read their contents before designing the ontology. Up to 8 links are read, with 3 concurrent requests, a 10-second limit per page, a 25-second total limit, a 2 MB response limit, and a 60,000-character body limit. The original URL and retrieved text are retained. Blocked access, login requirements, unsupported formats, and other failures are reported with reasons. Content that could not be read within these limits is not treated as reviewed. The app does not perform automatic searches or recursively collect links from page contents.
- Completed graph JSON can be imported to and exported from the server. An explicitly selected browser-storage fallback is available only when the server is unavailable.
- The existing `/case/0143/*` routes are a design demo and do not actually execute follow-up conversations or automated external actions. Generated graphs provide the exploration features that have been implemented.
- A schema editing UI, per-user permissions, data retention management, automatic web search, and recursive collection are outside the current scope.

## Validation

```powershell
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Unit and HTTP integration tests cover schemas, exact quotations, identity resolution and storage, job cancellation and restart, correction retries, authentication, and wrapper behavior. Generation APIs in browser tests use mock responses; the tests do not call a real model on every run. Separate validation was also performed with an authenticated Codex instance. In the previous pipeline, a question about the stored GFW material generated 11 objects, 10 relationships, and 2 events; graph refresh and retrieval of ontology evidence were also verified. This records the results of that run and does not fix the number of outputs a model must produce.

Automated validation of the Jev connection and hybrid processing uses mock model responses. An actual TypeSafe key was also used to verify an API call, graph storage, and cache reuse for an explicit relationship stated in one sentence. This single case does not establish accuracy across new domains or performance on large datasets. Browser tests cover navigation between partial Jev and structured graph results, display of processing metrics, and mobile screens.

Playwright starts a development server by default. Set `PLAYWRIGHT_BASE_URL` to use an external test server and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium installation.

## Unified cases and chat

Analysis segments are preserved as Records and shown as one unified graph at `/analysis/:jobId`. Objects with the same stored ID are connected, while conflicting properties are retained by record. See [design and handling of existing data](docs/analysis-case.md).

- Use the trash icon in the case library to permanently delete a case. After stopping generation and chat in progress, the app deletes its results, records, conversations, and dedicated uploads. Material shared with other cases is retained. Legacy caches lack case ownership information, so extraction and judgment caches are cleared on deletion. External backup files are not deleted.
- Collapse the panel inside a case using the button above the graph. It operates independently of the full case library. The source list is collapsed by default.
- Dragging a node also moves its connecting arrows. Layouts are saved in the current browser for each case and view.
- In a completed case, ask questions in the AI chat panel on the left. You can include the selected node; clicking a citation in an answer opens the corresponding Record. Conversations are stored on the server. Chat retrieves relevant objects from the full graph and source text from up to 8 records, and displays the scope actually consulted. Chat does not modify results or search the internet.
- The default model is `claude-sonnet-5-5`. Ontology design and clarification questions use `medium`; fact extraction, Jev rule design, case chat, and Why-not analysis use `high`. The `CODEX_*_EFFORT` setting names are retained for compatibility and also apply to Claude. See the [official model guide](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) and [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

### Lightweight ontology design

The local build CLI uses only Python 3.10 or later and the standard library. The server expands and validates the model's compact design using the existing shared validator, without launching another process. Unnecessary extended resources and null property fields have been removed from the default model output. Administrative columns that are not needed for analysis are preserved in the source as `retainedColumns`, while narrative columns containing factual relationships continue to be analyzed as `semanticColumns`. Identity key and evidence validation remain in place.

The Python CLI is an authoring tool that checks keys and basic references. The server's shared validator performs final validation of advanced Interfaces, Value Types, and constraints. Switching to Python alone is not assumed to reduce total LLM time. Schema design runs at `high`, and any required rules for repeated Jev judgments are generated in a separate `xhigh` call. Both stages use a compact schema and a short source profile.

## Analysis performance and evidence validation improvements

See the [analysis improvements document](docs/analysis-improvements.md) for execution limits and per-stage settings, source text retrieval and scope filters, claim review, ontology reuse, large graph exploration, and real model evaluation results. `npm run eval:analysis` runs offline checks; `npm run eval:analysis -- --live` evaluates a real model using synthetic material.

## Algorithm documentation site

`docs/` is a separate documentation site built with Fumadocs and Next.js. It documents **Why-not Tree → Gap Find → Gap Fill** as Cluevia's main algorithm guide, detailing how evidence connects to logic, relevance and event checks, duplicates and source lineage, confidence, and actions for the six gap types. The [main guide](docs/content/docs/main-algorithm/overview.mdx) defines the design to implement; descriptions of the existing extraction, storage, and layout code are maintained separately as documentation of the current implementation.

Run these commands from the project root.

```powershell
npm run docs:install
npm run docs:dev
```

The documentation is available at `http://127.0.0.1:3001`. App and documentation dependencies are separate. Running, building, or type-checking the documentation checks the executables and native modules for the current OS. Documentation dependencies are automatically reinstalled when switching between Windows and WSL.

```powershell
npm run docs:typecheck
npm run docs:build
npm run test:docs
```

The static build is written to `docs/out/`. `test:docs` uses the root project's Playwright and Chromium. See [docs/README.md](docs/README.md) for documentation structure, search, and deployment settings. Existing server design documents and evaluation material are also retained in `docs/`.
