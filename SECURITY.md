# Security policy

waffle runs WebAssembly programs inside a page and gives them a shared filesystem, processes, and a loopback network. Reports about those boundaries are welcome.

## Report a vulnerability

Use GitHub's private vulnerability reporting. Open the repository's **Security** tab and choose **Report a vulnerability**, or go to <https://github.com/ShaulLavo/waffle/security/advisories/new>.

Include the commit or version, what you did, what happened, and what you expected. Redact real hostnames, keys, and tokens.

There is no bug bounty and no response-time commitment. This is a personal project.

## Supported versions

waffle is pre-1.0. Only the `main` branch receives fixes.

## Scope

A guest program reading or writing outside the filesystem and permissions the page granted, or reaching beyond the loopback network, is in scope. See [status](docs/status.md) for what is untested.
