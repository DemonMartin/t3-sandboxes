# Sandboxes for T3 Code

An external plugin for the host on [`t3/create-plugin-system`](https://github.com/djgilcrease/t3code/tree/t3/create-plugin-system). The controller lives on your always-on T3 environment. Each sandbox runs its own T3 environment and this plugin in reporter mode. Your clients connect directly to the sandbox.

## This fork

A fork of [digitalxero/t3-sandboxes](https://github.com/digitalxero/t3-sandboxes) that makes a sandbox the default place a chat runs, the way cloud coding agents work: open a project, write a message, send. The chat starts in a fresh sandbox prepared from the project's environment, and stays listed under the project.

It is developed together with a fork of the T3 Code plugin host, [DemonMartin/t3code](https://github.com/DemonMartin/t3code) (branch `agentbox`), which adds the client features this plugin relies on. On another host the plugin still loads and behaves like upstream: sandboxes are started by hand from "Run on → New sandbox".

Everything in the upstream guide below still applies unless this section says otherwise.

### What is different from upstream

| Area                   | Upstream                                                                                                                                                                                                                                                                     | This fork                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting a sandbox     | Pick "New sandbox" in the environment picker and confirm a form                                                                                                                                                                                                              | The first send of a new chat starts one automatically (`autoSandbox` policy, on by default). Pick the machine under "Run on" to run one chat on the host instead      |
| Where the thread shows | A separate project per sandbox, named after the thread                                                                                                                                                                                                                       | The guest project takes the originating project's name, so clients list sandbox threads under the same project                                                        |
| Thread title           | The title typed in the form                                                                                                                                                                                                                                                  | Generated from the first message                                                                                                                                      |
| Base commit            | The controller checkout's pushed HEAD                                                                                                                                                                                                                                        | The remote tip of the branch picked in the composer (or checked out), else the remote default branch                                                                  |
| Checkout               | The plugin clones and uses a worktree                                                                                                                                                                                                                                        | Drivers with `prepare` own the checkout; the thread works in the repository itself on branch `sandbox/<id>`                                                           |
| Environments           | None                                                                                                                                                                                                                                                                         | Per repository: setup script, start script, environment variables, size. Edited under Project settings → Sandbox environment                                          |
| Sizes                  | Whatever the image/provider gives                                                                                                                                                                                                                                            | CPU and memory presets (`low` 4 cores / 16 GB, `medium` 8 / 32, `high` 16 / 48 by default), chosen before sending, per project, and changeable on an existing sandbox |
| Idle stop              | One policy for all                                                                                                                                                                                                                                                           | Default from the policy, plus a per-sandbox choice (10 min to 24 h) with a countdown on the thread                                                                    |
| Settled threads        | Stop the sandbox at once                                                                                                                                                                                                                                                     | Same, after a two-minute grace from the sandbox's last start, so one resumed to continue a settled thread is not stopped under the user                               |
| Stopped sandboxes      | Resumed by hand                                                                                                                                                                                                                                                              | Advertise a `resume` action; the client runs it when the user opens the thread, sends a message or runs a thread command                                              |
| Launch progress        | A text line in a dialog                                                                                                                                                                                                                                                      | Steps with the driver's current phase, elapsed time and the tail of the setup log                                                                                     |
| Failures               | A generic message                                                                                                                                                                                                                                                            | The cause is also written to `diagnostics.log` in the plugin's data directory                                                                                         |
| Delegated threads      | A sandbox that used a subagent could not stop (transcript file name too long)                                                                                                                                                                                                | Fixed                                                                                                                                                                 |
| Resuming after a stop  | The guest server is taken as running if the process id saved before the stop exists. In the restarted machine that id can belong to another process, such as one the start script spawned: the server is then never started, and the sandbox can neither be used nor stopped | The saved id counts only if it is the guest server's own process                                                                                                      |

### Requirements

- The T3 Code host from [DemonMartin/t3code](https://github.com/DemonMartin/t3code), branch `agentbox`, on the controller **and** inside the sandbox image (the same build in both). Its `FORK.md` describes building it.
- Node 24 or later.
- For the features marked "driver" below: an external driver that implements them. [`examples/docker-driver/driver.py`](examples/docker-driver/driver.py) does, for local Docker.

### Install

1. Clone this repository on the controller and check out `agentbox`. The bundle `dist/plugin.mjs` is committed; no build step is needed to run it. (`npm ci && npm test` and `npm run build` are for development.)
2. Register it in `plugins.json` under the controller's T3 home, then restart the T3 server:
   ```json
   {
     "plugins": [
       {
         "id": "sandboxes",
         "path": "/absolute/path/to/t3-sandboxes/dist/plugin.mjs",
         "enabled": true
       }
     ]
   }
   ```
   Installing from Settings → Plugins by repository URL picks the latest stable tag of that repository; to run this branch, register the path as above.
3. Build a sandbox image that contains: Bash, Git, Node 24, your agent CLIs with their credentials or gateway settings, and the same T3 host build with `t3` on `PATH` (the upstream section "Build a local guest image" shows how to stage the build). If the sandbox runs as root, set `IS_SANDBOX=1` so Claude Code accepts running without permission prompts, and `T3CODE_CODEX_EXTERNAL_SANDBOX=1` so Codex does not try to start its own sandbox inside the container.
4. In Settings → Extensions → Sandboxes, save a provider profile:
   - **Docker with environments, sizes and progress (recommended):** driver `external`, "External driver executable" = the absolute path of `examples/docker-driver/driver.py` (or your own driver). When the profile is saved the plugin asks the driver what it supports, so nothing else needs configuring. The example driver is configured with environment variables of the T3 server process; see the top of the file (`SANDBOX_IMAGE`, `SANDBOX_RUN_FLAGS`, `SANDBOX_ENV_FILE`, `SANDBOX_TAILNET_HOST`, `SANDBOX_STATE_DIR`).
   - **Upstream drivers** (`docker`, `boat`) work as upstream; they have no environments, sizes or progress detail.
5. Optional: review the policy on the same page (`idleMinutes`, `autoSandbox`, `maxRunning`, `deleteDays`, …) and the sizes table.

### Using it

- **New chat.** Open a project, write the first message, send. "Run on" shows the launcher; next to it you can pick the size. The launch appears under your message as steps and opens the thread when it is ready. Images and files attached to the first message go with it: the controller keeps a copy while the sandbox comes up, uploads them to the sandbox's server and starts the thread with them. What cannot start a sandbox (other attached context such as terminal output, more than eight attachments, a project without an `origin` remote) is refused with the reason shown, rather than silently run on the host.
- **Environment.** Project settings → Sandbox environment: a _setup script_ (run once in a fresh checkout as the sandbox user, from the repository root), a _start script_ (run in the background on every start and resume), _environment variables_ (one `KEY=VALUE` per line) and the _size_ of new sandboxes. With the example driver, the result of the setup script is committed as a snapshot image per repository and reused while the base image and the script are unchanged and it is less than a week old; "Rebuild snapshot" drops it. Stored in `environments.json` (mode 600) in the plugin's data directory.
- **On the thread.** The sandbox's row shows its state and when it will stop, with Stop/Resume, an idle-stop choice and a size choice. Changing the size applies to the running sandbox.
- **Stopping.** A sandbox stops after its idle window, once all its threads are settled, or on Stop; its disk is kept. Using the thread again starts it. Deletion follows upstream rules (after `deleteDays`, only when work is pushed and transcripts were exported).

### Driver additions

An external driver executable is asked `{"operation":"capabilities","input":[]}` when its profile is saved and may answer with the capabilities it supports. All of these are optional:

| Capability / operation                                                                                                                                                                                                                        | Purpose                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare: true` → `create` receives `environment: { repository, setup, start, env }`; `prepare` is called with `[ref, { repository, base, branch, environment }]` on every start, before the guest server is used, and may take up to an hour | The driver checks the repository out at `base` on `branch`, runs the setup script once, may snapshot the result, runs the start script, and returns `{ "workspace": "/absolute/path", "setup": "ok" \| "cached" \| "failed" \| "none" }`. The guest server is started in parallel |
| `progress` with `[ref]`                                                                                                                                                                                                                       | Called every few seconds during `prepare`; returns `{ "phase": "what is happening", "seconds": N, "log": "last lines of output" }`                                                                                                                                                |
| `environment` with `[{ repository, setup, start, env, reset? }]`                                                                                                                                                                              | Snapshot state for project settings: `{ "snapshot": null \| { "created", "bytes", "current" } }`; `reset: true` drops it                                                                                                                                                          |
| `resize: true` → `create` receives `size: { cpus, memoryGb }`; `resize` is called with `[ref, { cpus, memoryGb }]`                                                                                                                            | CPU and memory of a new sandbox, and changing them in place                                                                                                                                                                                                                       |

### Working in a sandbox thread

The host fork adds controls that are useful in long sandbox threads; they are part of [DemonMartin/t3code](https://github.com/DemonMartin/t3code), not of this plugin, and need the guest to run a build that has them (a sandbox keeps the build it was created with):

- "Rewind to here" and "Cut out" on any step inside a turn, for OpenCode 2 and Claude Code.
- "Agent's view" in the thread header, which shows only what the current agent has in its context, for example after a switch of agent.
- A switch of agent hands over much more of the thread than upstream does.

### Troubleshooting

- **Where to look.** Failures are written with their cause to `diagnostics.log` in the plugin's data directory (`<T3 home>/plugins/sandboxes/`); the sandbox's row in `ledger.json` there holds its `state`, `stage` and `error`. The guest server's own log is `/home/user/t3-sandbox/server.log` inside the sandbox.
- **A thread that does not start, with "Could not complete Inspecting resource".** `Guest request failed (502)` in `diagnostics.log` means the machine runs but its guest server does not. The controller cannot stop such a sandbox either, because it exports the transcripts first. Stop the machine through the provider (with an external driver: `{"operation":"stop","input":["<ref or name>"]}` on its stdin; with Docker, `docker stop`), then open the thread again: the resume starts the server. The cause fixed in this fork is described under "Resuming after a stop" above.
- **A change to the controller's build does not show in a sandbox.** Existing sandboxes keep the image they were created from. New chats use the new image.

### Not included here

Publishing sandbox ports (private tailnet or public URLs), the LLM gateway and the sandbox image used by the author are part of a private setup and not in this repository. The example driver only publishes each sandbox's T3 port.

---

The remainder is the upstream guide.

## Install and start

Install `https://github.com/digitalxero/t3-sandboxes` through **Settings → Plugins** on the controller. The host selects the latest stable tag. This requires the [plugin-system host branch](https://github.com/djgilcrease/t3code/tree/t3/create-plugin-system), at least commit `e2d0e6ea87`; upstream T3 Code does not include this host yet.

Use Node 24 or later. Run `npm ci`, then `task verify`. Register `dist/plugin.mjs` as the `sandboxes` plugin in `plugins.json` under the controller’s T3 home. A tagged Git repository can also be installed through Plugins settings; the committed bundle is ready to run without executing a build during install. Do not point a development server at your live T3 home.

In Settings → Extensions → Sandboxes, save a provider profile. Docker profiles take an image name; Boat profiles take a saved snapshot and optionally a Boat environment that supplies Git and agent credentials. The image must include Bash, Git, Node 24, and the **same plugin host build** as your controller, with `t3` on PATH. No subscription credentials are copied from your home directory.

From a new thread in a Git project on the controller, choose **New sandbox** in the environment picker. Choose a provider profile, review the pushed base commit and first message, then send. The first message currently supports text only; remove attachments and local context first. Provisioning and the first send run on the controller, so locking your phone does not cancel them. The sandbox uses its own thread branch and runs the project's normal worktree setup.

Every connected client discovers the running environment and obtains its own one-time pairing token. The initiating client opens the new thread after registering the connection. A stopped sandbox stays in the connection list for cached reads; deletion removes only connections owned by this plugin. Manually added environments are never replaced. If automatic pairing fails, use Pair client in the extension page and open the one-time URL.

The extension page also accepts a Git remote, its full **pushed** base commit SHA, a title, and an optional first message. Docker's default loopback URL only works on the Docker host; remote clients skip that address. Boat exposes HTTPS guarded by T3 bearer authentication. Set a reachable URL override for a tailnet route.

The guest contributes a small status item to the thread info pane and sidebar on web, desktop, and mobile. For Stop controls in the guest, configure the controller's reachable origin. Otherwise manage it through the controller's settings page.

## Lifecycle and cost

The default idle stop is 15 minutes; pending questions get 60 minutes; unattended activity gets a two-hour provider lease; a continuous run stops at 12 hours. Connected clients do not count as activity. All foreground threads, subagents and pending background work count. Terminal input resets the idle clock. Archived threads remain in transcript exports. Keep awake has an explicit expiry; Pin prevents automatic deletion. Stop and Resume preserve the sandbox identity. Create retries reuse a persisted request id and provider name. A lost create response is reconciled before another create is considered. Failed operations back off; five failed provisioning attempts switch to stopping instead of provisioning forever.

Before a controlled stop, the guest attempts to pause turns and checkpoint them; the controller exports each complete thread transcript to `transcripts/<sandbox-id>/` in its private plugin data directory. Export failure blocks a controlled stop; the provider's independent lease can still expire. Stopping preserves provider disk. Deletion after seven days only proceeds when transcripts were retained and all Git worktrees were verified clean and pushed, or Rehome retained it. Deleting the last thread starts the same safety check immediately. Otherwise it stays stopped. Explicit Delete requires a separate data-loss checkbox. Provider-side retention still applies independently.

Boat keeps an independent stop deadline. Docker has no independent provider deadline, so its idle and lifetime limits require the controller to remain online. Usage shows runtime and estimated cost at the hourly rate, or the provider quote, each sandbox captured when it was created; replacing a profile never reprices existing rows. The monthly budget refuses creation and resume at the estimated cap; setting a budget without a rate or a fresh quote refuses creation. Provider invoices remain authoritative.

Disable and Remove are guarded while managed resources remain. Stop and delete those resources first. On removal, transcripts are copied into `sandbox-archives` under the T3 home before the host clears plugin data. A crash or manual configuration edit still leaves the provider lease as the fallback for Boat.

## Optional Rehome

Rehome is a bonus, not a dependency. Install Rehome on the controller and include its packaged plugin in your guest image. Set the profile's `rehomePath` to that file's absolute guest path. Bootstrap enables it and supplies a per-sandbox transfer key. Before stopping, Sandboxes discovers Rehome's agent-enabled `pull` command, runs it on the controller, and waits through its `status` command. The source is `{url, key}`. The destination must contain a clone of the repository, as required by Rehome. If it is absent or fails, the controller retains transcripts and stops normally; workspace files remain in the stopped provider disk.

## Other providers

An external driver is either an executable receiving `{operation,input}` on stdin, or a JSON POST endpoint with a plugin-held bearer key. Operations are `list`, `create`, `get`, `start`, `stop`, `remove`, `setDeadline`, `exec`, `write`, and `expose`; `input` is an array of positional arguments. `list` returns observed records `{ref,name,state}`; create receives `{name,requestId,ttl}` and returns an observed record; get returns one; exec returns stdout; write takes resource id, absolute guest path, and UTF-8 contents; expose returns a credential-free origin. Create must be idempotent on requestId or name. Stop must keep disk. Do not advertise that guarantee for a provider whose stop destroys data.

### Optional price quotes

An external profile can take its price from the driver instead of a typed hourly rate: set **Price source** to "Provider quote". Drivers that do not implement `quote` keep working unchanged with a typed rate; the plugin calls `quote` only for profiles that opt in.

`quote` takes no arguments (`{"operation":"quote","input":[]}`) and returns:

```json
{
  "currency": "USD",
  "unit": "minute",
  "rounding": "up",
  "validUntil": "2026-11-11T12:15:00Z",
  "choices": [
    { "id": "small", "label": "2 vCPU", "rate": 0.001 },
    { "id": "large", "label": "8 vCPU", "rate": 0.004 }
  ]
}
```

- `currency` must be `USD`, the unit of the monthly budget. Other currencies are rejected.
- `unit` is the billing unit for `rate`: `second`, `minute` or `hour`. `rounding` is `none` (prorated) or `up` (each session is rounded up to a whole unit; a session crossing a UTC month is rounded separately on each side, and the lifetime cost is the sum of those parts). Both fields are required; other values are rejected rather than assumed.
- `choices` lists 1 to 50 resource options. `id` is 1 to 64 letters, digits, `.`, `_` or `-`, unique within the quote; `label` is an optional string; `rate` must be a JSON number from 0 to 1000. `null`, strings, booleans, arrays and non-finite values are rejected. A rate of `0` is a valid price.
- `validUntil` is an optional ISO 8601 UTC timestamp of the form `YYYY-MM-DDTHH:MM:SS[.sss]Z`. Without it a quote is valid for 15 minutes after receipt. A quote that is already expired, or valid for more than 24 hours ahead, is rejected.
- Other fields are ignored. In particular, account grants, free allowances and credits are not applied: the plugin sees only its own sandboxes, not what an account has spent elsewhere, so estimates and budgets use the quoted rate for every unit.

The profile stores the choice it was saved with (blank selects the first listed). Saving the profile requests a quote and refuses a missing choice or an unusable quote. Afterwards the settings form offers the choices returned by saved profiles' quotes. The chosen id is passed to `create` as `{name,requestId,ttl,choice}`, so the driver provisions the size that was priced; profiles without a quote send no `choice`.

Each create and resume requests a fresh quote. A failed, expired or invalid quote refuses the request, with or without a monthly budget, and the last accepted quote is never reused for a new request. A refused request changes nothing: an earlier accepted resume keeps its pending price. Resume only acts on a stopped sandbox; on one already running or starting it does nothing. Provisioning and starting run later in the background, so just before the provider `create` or `start` the worker checks the accepted quote again. If it has expired, the worker requests a fresh quote for the same choice. It uses that quote only if its currency, billing unit and rounding are identical to the accepted quote, its per-unit rate is no higher, and the budget is not yet reached. A change of unit or rounding is never accepted automatically, because a larger rounded unit can raise the minimum charge even at a lower hourly rate; otherwise, or if the refresh fails, it does not call the provider: a pending create is marked deleted with no billed time, a pending resume returns the sandbox to stopped, and the reason is shown as the sandbox's error. Request again to accept a higher price. A create whose request was already sent is reconciled by name as before and is not quoted again. The accepted quote is copied onto the sandbox for its first session and onto each resumed session, and is never changed afterwards. A session opens at the time `start` was requested, so a start whose reply is lost is still billed once the provider reports the sandbox running, even if Stop was requested in the meantime. The usage page lists each quoted profile's last accepted price, its age and validity, and the last refresh failure.

## Build a local guest image

Build the shared host's server bundle and web client first. Then run:

```sh
T3_HOST_CHECKOUT=/path/to/t3code node scripts/build-image.mjs
```

This stages only built server and web assets and the host's declared runtime dependencies; it does not copy your T3 data, credentials, or checkout. The default image name is `localhost/t3-sandbox:dev`. Install agent executables and supply their credentials through your own derived image or Boat environment. Creating an idle thread does not run a paid agent. The verification scripts use temporary T3 homes and clean up their task-owned sandboxes.

The bundled Docker image and Boat snapshot must match the controller's host build. This first release uses prebuilt images rather than installing or upgrading T3 during bootstrap. Docker and Boat are built in; other providers use the external driver. T3 Connect reach, moving an existing local thread into a sandbox, and cloning a sandbox for a fork remain later features.
