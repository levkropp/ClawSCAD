# ClawSCAD Studio — web port

The v0.6 **Make** view, self-hostable on your own machine or behind your own
authenticating proxy — so a phone, a tablet or a laptop can drive it. It runs
`renderer/studio.js` **unmodified**: the same 2,200 lines that ship in the
Electron app, mounted by `web/entry.js` against a `window.api` shim that speaks
`fetch` + `EventSource` instead of `ipcRenderer`.

Nothing outside `web/` is modified. The stylesheets are served from the repo
root (`/style.css`, `/style-studio.css`) rather than copied, so the dashboard
cannot drift from S2's sheet.

```
web/
  server.js     zero-dependency node:http server + the API + the SSE stream
  api-shim.js   the browser half of that API, shaped exactly like preload.js
  entry.js      builds ctx, owns the #gen-* call sites, calls mountStudio(ctx)
  index.html    the shell: #studio, #main-content, #toast-container, #gen-*
  web.css       the few shell-only rules; touches no #studio selector
  build.js      esbuild → web/dist/app.js
```

## Running it

```sh
node web/build.js                              # → web/dist/app.js  (esbuild)
node web/server.js --workspace /path/to/workspace
```

Open **http://127.0.0.1:8730**.

| flag / env | default | what it is |
|---|---|---|
| `--workspace` / `$CLAWSCAD_WORKSPACE` | `~/clawscad-workspace` | claw-gen's cwd, and the **only** directory this server will read files from |
| `--state` / `$CLAWSCAD_STATE_DIR` | `<workspace>/.clawscad-web` | the web port's `userData`: `composer-state.json`, `pipeline-settings.json`, and optional `presets/` overrides |
| `--port` / `$PORT` | `8730` | not 3000/8080/8788 on purpose — this shares a machine with dev servers |
| `--host` / `$CLAWSCAD_HOST` | `127.0.0.1` | loopback only; a tunnel or reverse proxy connects over it |
| `--cli` / `$CLAWSCAD_CLI` | — | path to `claw-gen`. Falls back to `<state>/pipeline-settings.json`'s `cliPath`, then `PATH` |
| `--claude` / `$CLAWSCAD_CLAUDE_BIN` | — | path to the Claude Code CLI. Falls back to the usual install locations, then `PATH` |
| `--openscad` / `$OPENSCAD_BINARY` | — | path to `openscad`, for Customize's render and export. Falls back to the usual install locations, then `PATH` |

`node web/build.js --watch` rebuilds on every change to `web/*.js` or
`renderer/*.js`. `--minify` for a production bundle.

**Rebuild after any `renderer/*.js` edit.** The bundle is what runs, not the
source — exactly as `npm run build:renderer` gates the desktop app.

### Deploying

> **There is no authentication in this server.** None. It has a filesystem API
> and it spawns `claude` and `claw-gen` on the host. The loopback bind is what
> stops anything else reaching it — do not move it off `127.0.0.1` and call it
> done.

Run it under whatever supervises services on the host (`systemd`, `launchd`, a
Windows service), and if you want it from anywhere but that machine, put an
authenticating proxy in front of the loopback port and let *that* own the auth
story. Any of these work:

- **A tunnel with an identity layer** — `cloudflared` + Cloudflare Access,
  pointed at `http://127.0.0.1:8730`. This is what it was developed against.
- **A private network** — Tailscale/WireGuard, and reach it over the tailnet
  address. No public exposure at all.
- **A reverse proxy you already run** — nginx/Caddy with oauth2-proxy or basic
  auth over TLS.

Whichever you pick, the server keeps its own guards regardless: paths are
containment-checked against the workspace, and no CORS header is ever sent.

## What works, and what does not

The Studio's own §S1 degradation table is the contract; this port fires the same
paths, with the reason stated on screen rather than a dead control.

| | |
|---|---|
| **Type grid + tools** | Fully. `tools:load` / `categories:load` go through `main/tools.js`'s `loadTools()` and `main/categories.js`'s `loadCategories()` — the same files the desktop app calls, including the `userData/presets/` override rules. |
| **The routing decision** | Fully. `renderer/route.js` is pure and runs in the bundle. |
| **State persistence** | Fully. `composer:set-state` reuses `main/composer.js`'s `mergeState`, so the top-level merge and the `{}`-means-clear reset behave identically. |
| **Flow B — pictures first** | Fully. `claw-gen images` runs on the host with `cwd` = workspace and `--json-events`; NDJSON lines are streamed to the browser over SSE. Rounds, refine and "more like this" all continue the same job. |
| **Flow C — recreate an upload** | Fully, for images. `mesh --image <relPath> --new-job` runs and chains mesh → prep → checkpoint. |
| **Upload** | Images only (png, jpg, webp, svg, dxf). `upload:pick` has no browser equivalent, so the shim drives a hidden `<input type=file>`; drag-and-drop goes through `upload:ingest-bytes`. Files land in `<workspace>/uploads/` via `main/uploads.js`'s own `storeUnique` (hash on collision, never overwrite) and are recorded in `uploads/uploads.json`. |
| **Flow A — "Make it" straight to Claude** | **Yes** (v0.6.1). It never needed a pty: `claude -p --permission-mode acceptEdits` runs headless in the workspace and exits. Progress streams on the `make:*` SSE channel; the produced `.scad` is found by **diffing the workspace's `.scad` mtimes**, not by trusting the model to report a path. One make at a time, 10-minute ceiling, killed as a process tree on cancel. |
| **Customize + export** | **Yes** (v0.6.1). `web/scad-params.mjs` parses OpenSCAD's own Customizer syntax; the values are applied with `-D`, which is OpenSCAD's own mechanism. Preview is a server-side PNG, so it cannot drift from the artifact the way a client-side re-mesh could. **3MF** is the primary export (STL secondary). |
| **Workbench** | **No.** The three.js viewport, the `node-pty` terminal and the checkpoint tree are absent. The Workbench tab leads to a panel naming each one. (OpenSCAD *rendering* now exists — for Customize — but not the interactive viewport.) |
| **Opening a checkpoint** | **No.** `clawscad.json` is read (so "pick up where you left off" lists real work) but never written, and selecting one explains that it needs the desktop app. |
| **Locate claw-gen…** | **No.** A browser cannot browse the server's filesystem, and exposing a remote file picker over the network would be a bad idea. Set `CLAWSCAD_CLI` instead. |
| **Editing the `.scad`** | **No, deliberately.** Customize never rewrites the file — every value goes through `-D`. Each `.scad` is an immutable checkpoint, and a UI that edited them to "customize" would be the easiest possible way to break that promise. |

## Notes for whoever touches this next

- **`claw-gen`'s `job_root` must be inside the workspace.** Candidate images are
  served by `/api/pipeline/image`, which refuses any path that does not resolve
  inside the workspace (and, once a job is running, inside that job's directory).
  A `job_root` pointing elsewhere makes every picture render as
  "Picture unavailable" — correctly, but confusingly.
- **One pipeline child per server**, mirroring Electron's one-per-window. A
  second browser tab starting a run gets `already-running`, and every connected
  tab sees every event. That is the honest behaviour for a single-user
  self-host; it is not multi-tenant.
- **The `#gen-*` elements in `index.html` are off-screen, not inert.** `studio.js`
  writes `#gen-prompt`, clicks `#gen-generate-btn`, clicks a
  `.gen-candidate[data-key]`, then clicks `#gen-make3d-btn`, and it reads
  `#gen-generate-btn.disabled` through a `MutationObserver` as its *only*
  end-of-run signal. `entry.js` owns their behaviour exactly as `renderer.js`
  does on the desktop. Remove one and the picture step goes silently dead. Add
  `debug-gen` to `<body>` to see the panel.
- **Path handling is the security boundary.** `containedInWorkspace()` resolves
  and `realpath`s both ends and compares with `path.relative` — it does not
  filter `..`, because an absolute path on another drive and a symlink out of
  the tree both contain none.
- **No CORS headers, deliberately.** Behind Access, an allow-any-origin header
  would let any page the user visits ride their Access cookie into this API.
