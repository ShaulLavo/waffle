# Program family cutover

This branch moves the prepared everyday programs into Waffle packages. The Bash consumer cutover belongs to the shell track and must land after env PR162 is green and merged.

1. Release the Waffle family packages from one green Waffle commit. The `base` package installs coreutils, findutils, grep, ripgrep and sed through one caller-owned runtime and one `installPrograms` operation.
2. Move bash-web's package-script and playground setup to install `waffle-base` and use the returned `path` directories. Keep shell builtins and the shell's runtime in bash-web.
3. Remove the old bash-web program sources, assets, workers and aggregate build routes in the same consumer change. Preserve the historical source receipts in the Waffle family packages.
4. Update bash-web's Waffle pin only after the family release is available. Python and Git stay optional packages; neither is included in `base`.
5. Prove the combined browser path with the real Waffle runtime: `cat`, `seq`, `tail`, `grep`, `mkdir`, `which`, `env`, `sed`, `find`, `xargs` and `rg`, then Python scripts and Git's six local commands.

The env PR162 browser fix remains an external prerequisite for the Bash companion change. This plan does not modify PR162 or the Bash environment source.
