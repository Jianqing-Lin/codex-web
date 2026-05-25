# Codex Web

Codex Web is a lightweight local web console for running the Codex CLI from a browser. It is designed for a single server or personal workspace where the web UI can control the local `codex` binary, browse project files, upload context files, and continue previous Codex conversations.

## Features

- Send normal chat messages as background `codex exec` tasks instead of launching an interactive terminal.
- Start interactive Codex CLI terminal sessions explicitly when raw terminal control is needed.
- Chat and terminal views for the same workspace.
- Continue previous Codex sessions through `codex exec resume <session-id>` in chat mode, or `codex resume <session-id>` in terminal mode.
- Select the model from the composer before sending a message.
- Browse and edit files under `/root`.
- Upload files and attach them as task context.
- Discover local projects from common markers such as `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, and `go.mod`.
- Browse installed Codex skills and plugins.
- Read conversation history from `~/.codex/sessions` and prompt history from `~/.codex/history.jsonl`.

## Requirements

- Node.js 18 or newer.
- A working Codex CLI available as `codex` in `PATH`.
- Optional: `node-pty` for an interactive terminal-like session. The app falls back to normal pipes when PTY is unavailable.

## Install

```bash
cd /root/codex-web
npm install
```

## Start

```bash
npm start
```

By default the server listens on `0.0.0.0:8686`.

Environment variables:

```bash
HOST=0.0.0.0
PORT=8686
CODEX_BIN=codex
CODEX_HOME=/root/.codex
```

Example with a custom port:

```bash
PORT=8687 npm start
```

## Run In Background

This server is often run inside `tmux`:

```bash
cd /root/codex-web
tmux new-session -d -s codex-web 'node server.js'
```

Check the service:

```bash
curl http://127.0.0.1:8686/api/health
tmux capture-pane -pt codex-web:0 -S -30
```

Restart it:

```bash
tmux kill-session -t codex-web
cd /root/codex-web
tmux new-session -d -s codex-web 'node server.js'
```

## Continue History Conversations

The sidebar lists previous Codex sessions found under `~/.codex/sessions`.

To continue an old conversation in chat mode:

1. Open a historical conversation from the sidebar.
2. Click `继续`, or type a new message while that historical conversation is selected.
3. The backend runs `codex exec resume <session-id> -` and sends the prompt through stdin.

The UI also restores visible historical messages into the chat pane so the resumed session is easier to follow.

The interactive terminal is separate. Use `启动终端` or `原样` when you need to control a live Codex TUI process.

## File Scope

For safety, workspace and file operations are restricted to paths under `/root`.

Important paths:

- Static UI: `public/`
- Server: `server.js`
- Codex sessions: `~/.codex/sessions`
- Codex prompt history: `~/.codex/history.jsonl`
- Skills: `~/.codex/skills`
- Plugins: `~/.codex/.tmp/plugins/plugins`

## Development

Run syntax checks:

```bash
node --check server.js
node --check public/app.js
```

Check Git status:

```bash
git status --short --branch
```

## Notes

This project is intended as a local control panel. If exposed to a public network, put it behind your own authentication, firewall, or reverse proxy access control.
