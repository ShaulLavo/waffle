# Browser dependency transport

The hosted browser job keeps Playwright's Chromium, Firefox and WebKit install,
including `--with-deps`, after restoring the browser cache. That cache does not
skip apt's system-package installation.

Before Playwright runs, CI removes the start-anchored
`http://azure.archive.ubuntu.com/ubuntu/` entry from the runner's mirror list.
The runner's existing HTTPS archive and security entries stay byte-identical.
The step rejects a missing or empty list and prints the survivors. Source suites,
signing keys, package verification, browser selection and all checks stay unchanged.

This protects against the slow successful Azure HTTP downloads observed in
bash-web. It does not establish the cause of Waffle's delayed installation.
Waffle's own apt log and matching-head CI are required for that conclusion.

The three-line fixture in `tests/ci-browser-install.test.ts` comes from
[the official runner source](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh),
blob `b3f5b2b180df8eb39fcbba034f616e03a69e775c`. The test executes CI's command on
disposable mirror files, never the host's apt configuration.
