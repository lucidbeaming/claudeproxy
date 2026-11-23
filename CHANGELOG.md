# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- README: "Retired" notice. LM Studio 0.4.1+ and Ollama 0.14.0+ serve Claude Code natively; note that Ollama also works as a backend (#9)
- README: notice that LM Studio 0.4.1+ serves `/v1/messages` natively, translation limits, configuration table, `claude-local.sh`, How it works, troubleshooting via `LOGS.md` (#10)
- MIT license (#5)
- Package metadata: `repository`, `bugs` and `homepage` in `package.json` (#5)

### Changed
- `.gitignore`: all `.env.*` variants (keeping `.env.example`), Sublime workspaces, shared `.vscode/extensions.json` (#7)
- express 5.3, axios 1.21, dotenv 18 (#3)
- Requires Node 20 or newer (`engines.node`, README) (#3)

### Security
- Resolved 1 critical (`proxy-addr` via express) and 4 high npm advisories (#3)
