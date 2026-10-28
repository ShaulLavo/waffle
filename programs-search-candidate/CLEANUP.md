# Test resource ownership

Before setup, `/work` was confirmed mounted on XFS with about 1.5 TiB logical free space. PC owner-busy was false; its heavy runner had an active drain and quiet benchmark. No local heavy work is allowed outside that runner. Mac owner-busy and its job lock were absent; Rust 1.98.1 is installed. Existing fleet services, caches, shared checkouts and Bash's untracked RESULT are borrowed and preserved.

This task owns only the exclusive candidate, this report directory, source-test `.build/*` scratch, and `.work/*` test staging. Each existing source test installs teardown before mutations. Root verification runs install an EXIT/INT/TERM cleanup for `.work`, empty family `.build` directories, pack tarballs and targets. No package installation or dependency download is permitted.

Any Mac run owns only `~/tmp/waffle-search-native-20261027`, its exact transfer archive, and the Mac lock while held by that run. Its controller checks directory absence before staging. A Python finally clause stops the task's process group and removes its source, targets, archive and lock on success, failure, timeout or interruption. The controller probes the actual Mac afterward and removes only an orphaned task directory if needed.

Keep small logs, source and portable patch for parent transfer/review. Remove candidate and report only after the parent has transferred or explicitly discarded them. No app, route, service, browser, container, guest, benchmark or CI resource is created.

The first Mac-native attempt stopped before compilation because its offline cache lacked frozen fancy-regex 0.19.2. To avoid downloading or changing pins, 73 dependencies were staged from the PC's already-populated Cargo cache with `cargo vendor --offline --locked`, about 74 MiB. The second Mac attempt found another job's lock and stopped before extraction/compilation. Both task directories were removed on the Mac; the other job's lock was preserved. Local staging/dependencies/archive are removed by the final source-check script's cleanup. Native tests are not claimed passed.
