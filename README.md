# Kalshi black-box study and clean-room clone

[![CI](https://github.com/htweet/kalshi-clone/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/htweet/kalshi-clone/actions/workflows/ci.yml)


- `CLONE_SPEC.md`: clean-room specification of kalshi.com, built from observed behavior. Every requirement cites its evidence, and anything unconfirmed is marked UNKNOWN. **§13 covers the live site as of 2026-11-02** (from a browser HAR), **§14 the Perps margin product** (from the public margin API docs), and **§15 the live UI/UX** (from screenshots and the current build's JS, analysed with REA), **§16 fractional contracts, §17 combos + RFQ/quotes + portfolio tabs, §18 the admin panel/CMS and §19 sports live scoreboards, §20 event live chat**. `PLAN.md` holds the phased roadmap, research backlog and security plan. §1–12 describe the February 2026 build.
- `evidence/`: the captures the spec cites. These are HAR recordings of the public API and of the live site (`web_live_2026-11-02.har`, sanitized), the public OpenAPI and AsyncAPI specs, the recovered call-site list, and screenshots.
- `clone/`: **Parlance Exchange**, a functional equivalent built only from the spec. It has its own name, styling and invented data. See `clone/README.md`.

```bash
npm install && npm start      # from the repository root or from clone/; prints the URL (3000, or next free port)
npm run test:e2e              # 180 end-to-end browser tests
```

## Running on Windows (Git Bash or PowerShell)

- **Where to run commands.** The app lives in `clone/`. The root `package.json` forwards `npm install`, `npm start`, `npm run dev`, `build`, `seed`, `create-admin`, `lint` and `test:e2e` to it, so they work from the repository root or from `clone/`. If you see `ENOENT: no such file or directory, open '.../package.json'`, run `git pull` first; older checkouts have no root `package.json`.
- **Paths.** Git Bash accepts forward slashes (`cd /c/Users/you/kalshi-clone/clone` or `cd ~/kalshi-clone/clone`). Use quotes if the path has spaces. Environment variables go in front of the command in Git Bash (`PORT=8080 npm start`); in PowerShell set them first (`$env:PORT=8080; npm start`).
- **Stopping a running server.** Press `Ctrl+C` in the terminal that runs it; the server closes the database cleanly and prints `Stopping Parlance Exchange…`. If the terminal is gone, find and stop the process: Git Bash `netstat -ano | grep :3000` then `taskkill //PID <pid> //F` (note the doubled slashes in Git Bash); PowerShell `Get-NetTCPConnection -LocalPort 3000 | Select OwningProcess` then `Stop-Process -Id <pid>`.
- **"Another Parlance server (process 1234) is already using …/parlance.db. Stop it first …".** Only one server may use a database file at a time (single-instance lock file `clone/data/parlance.db.lock` holding the owner's process id). Stop that process as above and start again, or give this server its own file: `DB_FILE=data/second.db PORT=3001 npm start`. A lock left behind by a crashed server is taken over automatically, because the process it names is no longer running. The older wording "the database is busy — another Parlance server is probably still running on it" means the same thing.
- **Line endings.** Keep `core.autocrlf=input` (or `false`) so shell scripts such as `.githooks/pre-commit` keep LF endings.

## Checks and guardrails

- CI (`.github/workflows/ci.yml`) runs on every push and pull request: `npm ci`, `npm audit --audit-level=high`, `npm run lint`, the full end-to-end suite, gitleaks secret scanning, CodeQL and an OWASP ZAP baseline scan. Make these required checks on `main` (branch protection) before merging.
- `npm install` in `clone/` installs a pre-commit hook (`.githooks/pre-commit`: secret scan + `npm audit`).
- `SECURITY.md` holds the vulnerability disclosure policy and the STRIDE threat model; `.claude/settings.json` keeps coding agents away from `.env*`, `clone/data/**` and key files (a guardrail, not a security boundary). Environment variables are documented in `clone/.env.example`.
