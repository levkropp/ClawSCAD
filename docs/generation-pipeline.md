# The generation pipeline (`claw-gen`)

The **Generate** panel turns a sentence into a 3D sculpt: *text → candidate images
→ you pick one → mesh → print-prep → a normal `.scad` checkpoint that `import()`s
the mesh*.

ClawSCAD does not implement any of that. It shells out to an external CLI called
`claw-gen`, one short-lived child process per action — no daemon, no port, no
SDK. **The app hardcodes nothing about image or mesh providers**: backend names,
availability and the reason a backend is unavailable all come from the CLI. That
is deliberate, and it is what makes this document possible: anything that
satisfies the contract below works, whatever it runs underneath.

The feature is optional. With no CLI present the panel says *"No generation
pipeline configured"* and everything else in ClawSCAD works normally.

> **The reference implementation (`clawscad-gen`) is not publicly released.** If
> you are reading this because the Generate panel says it is unconfigured, that
> is why. The contract is documented here so the panel is an integration point
> rather than a dead end.

## How the CLI is found

1. The path stored by **Locate claw-gen…**, in
   `<userData>/pipeline-settings.json` as `cliPath` (remembered per user, not per
   workspace).
2. `claw-gen` on `PATH`.

The web port uses `$CLAWSCAD_CLI` or `--cli` instead — a browser cannot open a
file picker on the server's filesystem, and exposing a remote one would be a bad
idea.

Every invocation runs with **cwd set to the workspace**.

## `claw-gen backends --json`

Called to decide what the panel offers. It must print JSON on stdout; the **last
non-empty line** is parsed, so progress chatter above it is fine.

```json
{
  "configured": true,
  "backends": [
    { "kind": "image", "name": "local-sdxl", "ok": false, "reason": "busy" },
    { "kind": "image", "name": "some-api",   "ok": true },
    { "kind": "mesh",  "name": "local-mesh", "ok": true }
  ]
}
```

- `configured: false` → the panel reports the pipeline as not configured.
- A backend with no `kind` is treated as an image backend.
- If no image backend has `ok: true`, the panel says *no image backend available
  right now* and shows the reasons rather than failing ten minutes into a job.
- Unparsable output is reported as *`claw-gen` failed to start*, with its stderr
  shown. A 15-second timeout applies.

## Actions

```
claw-gen <action> [args…] --json-events [--job <id>]
```

`<action>` is one of `images`, `mesh`, `prep`, `checkpoint` — anything else is
refused before spawning. `--job` continues an existing job, which is how *More
like this* and *Refine…* accumulate rounds instead of starting a new job whose
candidate keys would collide with the previous one's.

**stdout is NDJSON** — one JSON object per line. Every line is forwarded to the
UI as-is, so a CLI may emit whatever progress events it likes. Two fields are
interpreted:

| Field | Meaning |
|---|---|
| `job` | Adopted as the current job id, on any event that carries it. |
| `event: "candidate"` with `path` | A generated candidate image. `path` must be absolute, and must live **inside the workspace** — the web port serves candidates only from within the job directory, so a `job_root` elsewhere renders every picture as "Picture unavailable", correctly but confusingly. The job directory is inferred as two levels up from the image (`<job>/img/<file>`). |

**stderr** is forwarded verbatim to the panel's log. The **exit code** ends the
run; a non-zero code leaves the failed stage visibly failed rather than silently
clearing.

One pipeline child runs at a time (per window on the desktop, per server in the
web port). A second start returns `already-running`.

## What ClawSCAD does with the result

A generated checkpoint is mesh-derived and badged `GEN` in the checkpoint tree
with a diamond node. Branch it and `difference()` your parametric features into
the import; never edit it in place. Anything tolerance-critical — snap fits,
threads, mating parts — should be modelled parametrically from the start.
