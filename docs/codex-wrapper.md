# Codex extraction wrapper

Cluevia runs the installed Codex CLI on the backend to extract a proposed ontology from supplied text. The server validates the proposal, compiles the graph and persists it in its workspace. The browser never runs Codex or receives its credentials.

## Install and log in

The project pins `@openai/codex` to `0.162.1`. From the project directory, use the same operating system and user account that will run the backend:

```sh
npm ci --include=dev
node node_modules/@openai/codex/bin/codex.js login
node node_modules/@openai/codex/bin/codex.js login status
npm run dev
```

The explicit Node launcher uses the project's CLI without downloading a different version or requiring a global `codex` command. A current Node 22 release is required; Node 22.17.1 was used for the Windows tests. CLI authentication follows the [official Codex authentication process](https://learn.chatgpt.com/docs/auth).

Windows and WSL/Linux can use different home directories and credential stores. Logging in on Windows does not establish a WSL login. Run the login command in the environment running the backend. Do not copy authentication files into the project, `.env.local`, the browser, or source control.

## Configuration

Configure optional values in `.env.local`, then restart the server:

```dotenv
# Blank: use node_modules/@openai/codex/bin/codex.js, then fall back to PATH.
CODEX_BIN=
# Blank: use the CLI's default model. Set a model your account can access.
CODEX_MODEL=gpt-6.1-sol
CODEX_REASONING_EFFORT=xhigh
# Milliseconds per extraction call. Server accepts 10000–600000.
CODEX_TIMEOUT_MS=180000
```

`CODEX_BIN` accepts a single executable or launcher path, not a shell command with arguments. A Windows path containing spaces is supported. For npm `.cmd` shims, the wrapper locates the adjacent `@openai/codex/bin/codex.js` and launches it with Node directly. It never sends a shim or user evidence through `cmd.exe` or a shell.

Each extraction uses `--ignore-user-config`: the CLI retains access to its own authentication but does not load the user's `config.toml`. Custom model providers, profiles, MCP connections and hooks from that configuration are therefore not inherited. Use `CODEX_MODEL` for the model selection supported by this wrapper. A logged-in status confirms local authentication only; provider reachability, model access and available usage are checked when generation runs.

## Execution contract

`server/codex.ts` exports:

```ts
probeCodex(config?: CodexConfig): Promise<CodexStatus>
runCodex(input: CodexInput, config?: CodexConfig, options?: CodexOptions): Promise<unknown>
```

`input` contains the question, bounded evidence documents, a server-generated ontology context and a JSON Schema. The wrapper feeds the prompt through stdin. Structured output uses `--output-schema` and `--output-last-message`, documented in [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

The returned object remains untrusted until `parseExtraction` and `compileExtraction` in `server/ontology.ts` succeed. Those functions check the closed schema, allowed types, references, relation constraints, dates and exact evidence quotations. Exact quotations prove that the text is present in a source; they do not prove that a model's interpretation is correct. Insufficient evidence yields an explicit error without saving an invented graph.

The jobs layer can make one additional extraction attempt after a validation failure. Each attempt starts a fresh isolated CLI invocation. The wrapper itself does not create an agent loop. The jobs layer iterates over every uploaded chunk, checkpoints validated graphs and supports explicit resume after failure or cancellation. Each part stays a separately navigable graph; no global relationship synthesis across distant chunks is claimed.

## Capability and resource limits

- Execution occurs in a fresh temporary directory outside the repository; temporary schema and output files are removed afterward.
- The CLI runs with a read-only sandbox, approval policy `never`, ephemeral sessions, no daemon and no project instructions.
- Web search, shell execution, apps, plugins, hooks, browser/computer use, image tools, subagents and skill discovery/dependency installation are disabled. The invocation supplies no MCP server configuration.
- Evidence and questions are treated as data. They cannot become process arguments, shell commands or configuration. Model instructions require extraction from supplied evidence only.
- Unrelated server credentials are excluded from the child environment. The wrapper does not open, parse or copy Codex authentication files. The CLI handles its own authentication.
- One model invocation accepts at most 10 documents, 50,000 characters per document and 150,000 characters total. These are model-call limits, not upload limits. Large files use the streaming upload API and are analyzed sequentially in chunks of at most 30,000 characters, with overlap. Question length is limited to 2,000 characters; server context to 100,000 characters; the combined prompt to 1 MB.
- Schema size is limited to 200 KB, final JSON to 2 MB, and captured process output to 8 MB.
- Cancellation and timeout terminate the process tree. Windows uses `taskkill /T`; Unix uses a separate process group. Raw provider diagnostics are not sent to the browser.

Configuration behavior and feature switches are documented in the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). These controls bound the extraction capability; the backend is a single-workspace application, not a general autonomous coding or research agent. Uploaded data and stored graphs belong to that server workspace. Access control and deployment settings are covered in the main README.

## Verification

Run the wrapper tests directly:

```sh
node --experimental-strip-types --test server/codex.test.ts
```

All 10 tests passed with Windows Node 22.17.1 and Linux Node 23.8.0. Tests cover literal stdin handling, temporary-directory cleanup, child environment filtering, Windows npm launcher resolution, cancellation, timeout, authentication/nonzero errors, missing/malformed/oversized outputs and rejected tool events.

A real authenticated Linux Codex CLI invocation also returned the expected vessel name from a short synthetic source with a strict output schema. A second live integration used the actual ontology schema and passed `runCodex → parseExtraction → compileExtraction`: a three-sentence synthetic maritime source produced 4 entities, 4 relationships and 1 dated event in about 21 seconds, with all evidence quotes checked against the source. Neither live test wrote to the user's ontology store. These checks verify the live subprocess/model path in that environment.

A native Windows live check used the bundled CLI and the same ontology schema. Although the local CLI reported a stored ChatGPT login, the provider request returned an authentication failure (`CODEX_AUTH`). The wrapper surfaced the login guidance without exposing raw diagnostics; successful native Windows model generation remains to be verified after refreshing that account's login. Unit-test success and `login status` do not establish live provider access.

Case chat uses the same bounded Codex process with purpose `case-chat`. The server supplies only the selected case’s retrieved graph context, source excerpts and recent conversation, validates quotation references, and persists the result. Tools remain disabled. Defaults are `gpt-6.1-sol` and `xhigh`; both are explicitly passed to the CLI.
