#!/usr/bin/env python3
"""Example external driver for the Sandboxes plugin: Docker containers with environments.

The plugin runs this executable with one JSON request on stdin,
`{"operation": ..., "input": [...]}`, and reads one JSON value from stdout.
A non-zero exit reports failure.

Each sandbox is a Docker container from an image that contains the same T3 Code
build as the controller. Its T3 server (port 3773 in the container) is published
on a host loopback port; with SANDBOX_TAILNET_HOST set, that port is also served
over HTTPS on the tailnet at the same number, so the address stays the same when
the sandbox is stopped and started again.

Environments (profile capability `prepare`). The plugin passes the project's
environment with `create` and `prepare`: the repository, a setup script, a start
script and extra environment variables. `prepare` clones the repository to
/home/user/<name>, runs the setup script once and commits the result as a
snapshot image for that repository, so later sandboxes start from an installed,
built checkout. The start script runs on every sandbox start.

Configuration (environment variables of the T3 server that runs the plugin):
  SANDBOX_IMAGE          image to start sandboxes from (default t3-sandbox:current)
  SANDBOX_RUN_FLAGS      extra `docker run` flags (default: 4096 PIDs, 2 GB /dev/shm);
                         CPU and memory come from the size the plugin passes (capability `resize`)
  SANDBOX_ENV_FILE       env file passed to every sandbox (model keys, tokens); optional
  SANDBOX_TAILNET_HOST   MagicDNS name of this host; unset keeps sandboxes on loopback
  SANDBOX_STATE_DIR      lock and log directory (default ~/.local/state/t3-sandbox-driver)
"""

from __future__ import annotations

import datetime
import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

STATE = Path(os.environ.get("SANDBOX_STATE_DIR", Path.home() / ".local/state/t3-sandbox-driver"))
LOCK = STATE / "driver.lock"
LOG = STATE / "driver.log"
ENV_FILE = os.environ.get("SANDBOX_ENV_FILE", "")
TAILNET_HOST = os.environ.get("SANDBOX_TAILNET_HOST", "")

IMAGE = os.environ.get("SANDBOX_IMAGE", "t3-sandbox:current")
LABEL = "t3-sandbox"
PORT_LABEL = "t3-sandbox.port"
PORTS = range(21000, 21200)
DEFAULT_SIZE = {"cpus": 4, "memoryGb": 16}
RUN_FLAGS = shlex.split(os.environ.get("SANDBOX_RUN_FLAGS", "--pids-limit 4096 --shm-size 2g")) + (["--env-file", ENV_FILE] if ENV_FILE else [])
GUEST_PORT = 3773
SNAPSHOT_REPOSITORY = "t3-sandbox-env"
SNAPSHOT_HASH_LABEL = "t3-sandbox.env.hash"
SNAPSHOT_REPO_LABEL = "t3-sandbox.env.repo"
SNAPSHOT_USED_LABEL = "t3-sandbox.env.snapshot"
SNAPSHOT_MAX_AGE = datetime.timedelta(days=7)
SETUP_TIMEOUT = 45 * 60
STATE_DIR = "/var/lib/t3-sandbox"
PROGRESS = STATE / "progress"


def log(message: str) -> None:
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as fh:
            fh.write(message + "\n")
    except OSError:
        pass


def run(*command: str, stdin: str | None = None, check: bool = True, timeout: float | None = None) -> str:
    result = subprocess.run(command, input=stdin, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f"{command[0]} {command[1]} failed: {result.stderr.strip()[-400:]}")
    return result.stdout.strip()


def inspect(ref: str) -> dict | None:
    out = run("docker", "inspect", ref, check=False)
    data = json.loads(out) if out.startswith("[") else []
    return data[0] if data else None


def observe(info: dict | None, ref: str = "") -> dict:
    if info is None:
        return {"ref": ref, "name": "", "state": "deleted"}
    state = info["State"]
    status = "running" if state["Running"] else "starting" if state["Status"] == "created" else "stopped"
    return {"ref": info["Id"], "name": info["Name"].lstrip("/"), "state": status}


def port_of(info: dict) -> int:
    return int(info["Config"]["Labels"][PORT_LABEL])


def serve(port: int) -> None:
    if TAILNET_HOST:
        run("tailscale", "serve", "--bg", f"--https={port}", f"http://127.0.0.1:{port}")


def unserve(port: int) -> None:
    if TAILNET_HOST:
        run("tailscale", "serve", f"--https={port}", "off", check=False)


def sandboxes() -> list[dict]:
    ids = run("docker", "ps", "-aq", "--filter", f"label={LABEL}=1").split()
    return json.loads(run("docker", "inspect", *ids)) if ids else []


def repository_name(repository: str) -> str:
    """`https://github.com/Owner/repo.git` -> `repo` (the checkout directory)."""
    name = re.sub(r"\.git$", "", repository.rstrip("/")).rsplit("/", 1)[-1].rsplit(":", 1)[-1]
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name) or name in {".", ".."}:
        raise RuntimeError("unsupported repository name")
    return name


def snapshot_tag(repository: str) -> str:
    path = re.sub(r"^(https?://|git@)", "", re.sub(r"\.git$", "", repository.rstrip("/"))).replace(":", "/")
    slug = re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")
    return f"{SNAPSHOT_REPOSITORY}/{slug}:latest"


def environment_hash(environment: dict) -> str:
    """Changes whenever the base image or the setup script does."""
    base = run("docker", "image", "inspect", "--format", "{{.Id}}", IMAGE)
    return hashlib.sha256((base + "\0" + (environment.get("setup") or "")).encode()).hexdigest()[:32]


def inspect_image(tag: str) -> dict | None:
    out = run("docker", "image", "inspect", tag, check=False)
    data = json.loads(out) if out.startswith("[") else []
    return data[0] if data else None


def usable_snapshot(environment: dict) -> str | None:
    if not (environment.get("setup") or "").strip():
        return None
    tag = snapshot_tag(environment["repository"])
    image = inspect_image(tag)
    if image is None:
        return None
    created = datetime.datetime.fromisoformat(image["Created"][:19] + "+00:00")
    fresh = datetime.datetime.now(datetime.timezone.utc) - created < SNAPSHOT_MAX_AGE
    same = (image["Config"].get("Labels") or {}).get(SNAPSHOT_HASH_LABEL) == environment_hash(environment)
    return tag if fresh and same else None


def environment_variables(environment: dict) -> list[str]:
    lines = []
    for raw in (environment.get("env") or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, _ = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise RuntimeError(f"environment variable line is not KEY=VALUE: {key[:40]}")
        lines.append(line)
    return lines


def size_flags(size: dict | None) -> list[str]:
    """CPU and memory limits of a sandbox; memory and swap are capped together (no swap)."""
    size = {**DEFAULT_SIZE, **(size or {})}
    cpus, memory = float(size["cpus"]), float(size["memoryGb"])
    if not 0.5 <= cpus <= 512 or not 1 <= memory <= 4096:
        raise RuntimeError("sandbox size out of range")
    megabytes = int(memory * 1024)
    return ["--cpus", f"{cpus:g}", "--memory", f"{megabytes}m", "--memory-swap", f"{megabytes}m"]


def create(spec: dict) -> dict:
    name = spec["name"]
    environment = spec.get("environment") or {}
    snapshot = usable_snapshot(environment) if environment.get("repository") else None
    variables = environment_variables(environment)
    STATE.mkdir(parents=True, exist_ok=True)
    with LOCK.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        existing = inspect(name)
        if existing is not None:
            return observe(existing)
        used = {port_of(info) for info in sandboxes()}
        port = next((p for p in PORTS if p not in used), None)
        if port is None:
            raise RuntimeError("no free sandbox port")
        with tempfile.NamedTemporaryFile("w", prefix="sandbox-env-", suffix=".env") as extra:
            extra.write("\n".join(variables) + "\n")
            extra.flush()
            ref = run(
                "docker", "run", "-d",
                "--name", name,
                # T3 shows the hostname as the environment's label on every thread.
                "--hostname", "sandbox",
                "--label", f"{LABEL}=1",
                "--label", f"{PORT_LABEL}={port}",
                "--label", f"{SNAPSHOT_USED_LABEL}={1 if snapshot else 0}",
                "--publish", f"127.0.0.1:{port}:{GUEST_PORT}",
                *size_flags(spec.get("size")),
                *RUN_FLAGS,
                "--env-file", extra.name,
                snapshot or IMAGE,
            )
    serve(port)
    log(f"created {name} port={port} image={snapshot or IMAGE}")
    return {"ref": ref, "name": name, "state": "running"}


def guest(info: dict, script: str, *, stdin: str | None = None, timeout: float | None = None, check: bool = True) -> str:
    return run("docker", "exec", "-i", info["Id"], "bash", "-lc", script, stdin=stdin, check=check, timeout=timeout)


def write_guest(info: dict, path: str, content: str) -> None:
    run(
        "docker", "exec", "-i", info["Id"], "bash", "-c",
        'umask 077; mkdir -p "$(dirname "$1")" && cat > "$1"', "write", path,
        stdin=content,
    )


def commit_snapshot(info: dict, environment: dict) -> None:
    """Save the prepared filesystem for the next sandbox of this repository.

    Environment values are blanked in the image config so keys and tokens stay
    out of the snapshot; every sandbox gets the current values at `docker run`.
    """
    changes = [f"LABEL {SNAPSHOT_HASH_LABEL}={environment_hash(environment)}",
               f"LABEL {SNAPSHOT_REPO_LABEL}={shlex.quote(environment['repository'])}"]
    for entry in info["Config"].get("Env") or []:
        key = entry.split("=", 1)[0]
        if key in secret_keys(environment):
            changes.append(f"ENV {key}=")
    flags = [flag for change in changes for flag in ("--change", change)]
    run("docker", "commit", *flags, info["Id"], snapshot_tag(environment["repository"]))
    run("docker", "image", "prune", "-f", "--filter", f"label={SNAPSHOT_REPO_LABEL}", check=False)
    log(f"snapshot {snapshot_tag(environment['repository'])} from {info['Name'].lstrip('/')}")


def secret_keys(environment: dict) -> set[str]:
    keys = {line.split("=", 1)[0] for line in environment_variables(environment)}
    for line in Path(ENV_FILE).read_text().splitlines() if ENV_FILE else []:
        if "=" in line and not line.lstrip().startswith("#"):
            keys.add(line.split("=", 1)[0].strip())
    return keys


def phase(info: dict, text: str | None) -> None:
    """Say what `prepare` is doing right now; `progress` reports it to the waiting user."""
    path = PROGRESS / (info["Name"].lstrip("/") + ".json")
    try:
        if text is None:
            path.unlink(missing_ok=True)
        else:
            PROGRESS.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"phase": text, "since": time.time()}))
    except OSError:
        pass


def progress(ref: str) -> dict:
    info = require(ref)
    try:
        current = json.loads((PROGRESS / (info["Name"].lstrip("/") + ".json")).read_text())
    except (OSError, ValueError):
        return {"phase": None, "seconds": 0, "log": ""}
    log_tail = ""
    if "setup" in current["phase"] and info["State"]["Running"] and not info["State"]["Paused"]:
        # Progress bars redraw with carriage returns; keep what each line ended up showing.
        raw = run("docker", "exec", info["Id"], "tail", "-c", "6000", "/var/log/sandbox-setup.log", check=False)
        lines = [line.split("\r")[-1].rstrip() for line in raw.splitlines()]
        log_tail = "\n".join(re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", line)[:200] for line in lines if line.strip())
        log_tail = "\n".join(log_tail.splitlines()[-12:])
    return {"phase": current["phase"], "seconds": int(time.time() - current["since"]), "log": log_tail}


def prepare(ref: str, spec: dict) -> dict:
    """Check the repository out, run the environment's setup once, start its services.

    Called by the plugin every time the sandbox starts (first start and resume).
    """
    info = require(ref)
    environment = spec.get("environment") or {}
    repository, base, branch = spec["repository"], spec["base"], spec["branch"]
    if not re.fullmatch(r"[a-f0-9]{40}", base) or not re.fullmatch(r"[A-Za-z0-9._/-]+", branch):
        raise RuntimeError("invalid base commit or branch")
    workspace = f"/home/user/{repository_name(repository)}"
    marker = f"{STATE_DIR}/checkout-{info['Name'].lstrip('/')}"
    q = shlex.quote
    phase(info, "Checking out repository")
    guest(info, f"""set -eu
mkdir -p {STATE_DIR}
if [ ! -e {q(marker)} ]; then
  [ -d {q(workspace)}/.git ] || git clone -- {q(repository)} {q(workspace)}
  cd {q(workspace)}
  git fetch --prune origin
  git checkout -f -B {q(branch)} {q(base)}
  touch {q(marker)}
fi""", timeout=900)

    setup = (environment.get("setup") or "").strip()
    outcome = "none"
    if setup:
        fresh = info["Config"]["Labels"].get(SNAPSHOT_USED_LABEL) != "1"
        done = guest(info, f"cat {STATE_DIR}/setup-status 2>/dev/null || true")
        if not fresh and not done:
            outcome = "cached"
        elif done:
            outcome = done
        else:
            write_guest(info, f"{STATE_DIR}/setup.sh", setup + "\n")
            phase(info, "Running setup script")
            try:
                guest(info, f"cd {q(workspace)} && bash {STATE_DIR}/setup.sh > /var/log/sandbox-setup.log 2>&1",
                      timeout=SETUP_TIMEOUT)
                outcome = "ok"
            except (RuntimeError, subprocess.TimeoutExpired):
                outcome = "failed"
            log(f"setup {outcome} in {info['Name'].lstrip('/')}")
            if outcome == "ok":
                phase(info, "Saving snapshot")
                guest(info, "sync")
                # A failed snapshot only costs the next sandbox a setup run; this one is ready.
                try:
                    with LOCK.open("w") as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX)
                        commit_snapshot(info, {**environment, "repository": repository})
                except RuntimeError as error:
                    log(f"snapshot failed for {info['Name'].lstrip('/')}: {error}")
            # Written after the commit: a snapshot must not claim its sandboxes ran setup.
            guest(info, f"printf %s {outcome} > {STATE_DIR}/setup-status")

    start = (environment.get("start") or "").strip()
    phase(info, "Starting services" if start else None)
    if start:
        write_guest(info, f"{STATE_DIR}/start.sh", start + "\n")
        guest(info, f"cd {q(workspace)} && setsid nohup bash {STATE_DIR}/start.sh "
                    f"> /var/log/sandbox-start.log 2>&1 < /dev/null &")
    phase(info, None)
    return {"workspace": workspace, "setup": outcome}


def environment_status(spec: dict) -> dict:
    """Snapshot state of a repository's environment; `reset` drops the snapshot."""
    tag = snapshot_tag(spec["repository"])
    if spec.get("reset"):
        run("docker", "image", "rm", tag, check=False)
        log(f"snapshot removed {tag}")
    image = inspect_image(tag)
    if image is None:
        return {"snapshot": None}
    return {
        "snapshot": {
            "created": image["Created"][:19] + "Z",
            "bytes": image.get("Size"),
            "current": usable_snapshot(spec) == tag,
        }
    }


def require(ref: str) -> dict:
    info = inspect(ref)
    if info is None:
        raise RuntimeError("sandbox does not exist")
    return info


def handle(operation: str, args: list):
    if operation == "capabilities":
        # Read by the plugin when the profile is saved.
        return {"deadline": False, "stopKeepsDisk": True, "prepare": True, "resize": True}
    if operation == "list":
        return [observe(info) for info in sandboxes()]
    if operation == "create":
        return create(args[0])
    if operation == "get":
        return observe(inspect(args[0]), args[0])
    if operation == "start":
        info = require(args[0])
        run("docker", "start", info["Id"])
        serve(port_of(info))
        return None
    if operation == "stop":
        info = require(args[0])
        run("docker", "stop", info["Id"])
        # A stopped sandbox has no address on the tailnet; `start` serves it again.
        unserve(port_of(info))
        return None
    if operation == "remove":
        info = inspect(args[0])
        if info is not None:
            run("docker", "rm", "-f", info["Id"])
            unserve(port_of(info))
            log(f"removed {info['Name'].lstrip('/')}")
        return None
    if operation == "setDeadline":
        return None
    if operation == "exec":
        return run("docker", "exec", require(args[0])["Id"], "bash", "-lc", args[1])
    if operation == "write":
        write_guest(require(args[0]), args[1], args[2])
        return None
    if operation == "prepare":
        return prepare(args[0], args[1])
    if operation == "progress":
        return progress(args[0])
    if operation == "resize":
        # Takes effect at once on a running sandbox and sticks across stop and start.
        run("docker", "update", *size_flags(args[1]), require(args[0])["Id"])
        return None
    if operation == "environment":
        return environment_status(args[0])
    if operation == "expose":
        port = port_of(require(args[0]))
        return f"https://{TAILNET_HOST}:{port}" if TAILNET_HOST else f"http://127.0.0.1:{port}"
    raise RuntimeError(f"unsupported operation: {operation}")


def main() -> None:
    try:
        request = json.load(sys.stdin)
        result = handle(request["operation"], request.get("input") or [])
    except Exception as exc:  # noqa: BLE001 - the plugin only sees the exit code
        log(f"error: {exc}")
        sys.stderr.write(f"driver: {exc}\n")
        sys.exit(1)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
