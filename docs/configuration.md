# Configuration

Nothing about anyone's machine is compiled into ClawSCAD. Every external path is
either probed at run time or set by you, and every default is one that works on a
clean install of any of the three platforms. This is the list of places you can
plug your own setup in.

Everything here is optional. The app runs with none of it set.

## Environment variables

| Variable | Used by | Default | What it does |
|---|---|---|---|
| `CLAWSCAD_WORKSPACE` | desktop + web | `~/clawscad-workspace` | Where projects live. On the desktop it is the launch default; a path argument (`clawscad D:\parts`) still wins over it. |
| `OPENSCAD_BINARY` | desktop + web | probed | Full path to the `openscad` executable. Set it when OpenSCAD is installed somewhere the probe misses, or when you want a Nightly build for `--backend=Manifold`. The desktop app's *Locate OpenSCAD…* sets it for the session only. |
| `CLAWSCAD_CLAUDE_BIN` | desktop + web | probed | Full path to the Claude Code CLI. The probe covers the standalone installer, `~/.local/bin`, `/usr/local/bin` and everything on `PATH` (`.exe` / `.cmd` on Windows); this is the escape hatch for anything else. |
| `CLAWSCAD_CLI` | web | probed on `PATH` | Full path to `claw-gen`. The desktop equivalent is *Locate claw-gen…*, which stores it in `pipeline-settings.json`. |
| `CLAWSCAD_STATE_DIR` | web | `<workspace>/.clawscad-web` | The web port's `userData`: composer state, pipeline settings, and its own `presets/` overrides. |
| `CLAWSCAD_HOST` | web | `127.0.0.1` | Bind address. **Read `web/README.md` before changing this** — the server has no authentication of its own. |
| `PORT` | web | `8730` | Bind port. |
| `CLAWSCAD_DISABLE_CLAUDE` | desktop | — | `1` spawns a plain shell instead of Claude. Used by the test suite; also handy for a UI-only run. |
| `CLAWSCAD_TEST_PROFILE_ROOT` | desktop | — | Redirects `userData` so a test run never touches a real profile. Set by `playwright.config.js`; not for normal use. |

The web server takes the same settings as flags, which win over the environment:
`--workspace`, `--state`, `--port`, `--host`, `--cli`, `--openscad`, `--claude`.

## Your printer, your presets

The product data in `presets/` ships with the app and is **overridable wholesale**
by a same-named file in the user data directory, under `presets/`:

| File | What it holds |
|---|---|
| `machine.json` | Printer profiles — bed size, nozzle, material, tolerances, exclusion zones. The default is a Bambu P1S; change `active` or add your own machine. |
| `presets.json` | Intent presets — the modelling and print settings each intent implies. |
| `categories.json` | The print-type grid on the front door. |
| `tools.json` | The switchable field groups (Dimensions, Hardware, Fit & tolerance, …). |

The user data directory is Electron's `userData`:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\ClawSCAD` (`%APPDATA%\clawscad` when run from source) |
| macOS | `~/Library/Application Support/ClawSCAD` |
| Linux | `~/.config/ClawSCAD` |

An override **replaces** the shipped file rather than merging into it, so copy the
whole file before editing one number. That is deliberate: a partial override that
silently dropped half the data shape would be a much worse failure than having to
copy a file. A missing override is normal; a corrupt one falls back to the shipped
default rather than failing the load.

The web port reads the same `categories.json` and `tools.json` overrides out of
`$CLAWSCAD_STATE_DIR/presets/` — it calls `main/tools.js` and `main/categories.js`
directly rather than reimplementing the rules.

## Generation pipeline (`claw-gen`)

Optional — ClawSCAD works fully without it, and says so rather than failing
quietly. The app hardcodes nothing about image or mesh providers: backend names,
availability and reasons all come from `claw-gen backends --json`. Point at it with
*Locate claw-gen…* (desktop, remembered per user) or `CLAWSCAD_CLI` (web).

## Releasing from a fork

`package.json` → `build.publish` is both the upload target for
`npm run release` and the update feed every installed copy asks. Repoint it before
you publish anything — see [releasing.md](releasing.md).
