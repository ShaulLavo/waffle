# Candidate cleanup

The source checkout and small report/patch are retained for parent transfer. Cargo targets, generated binaries, dependency copies and temporary test fixtures are disposable and must be removed after their consumers stop. No service, container, route, browser profile, runtime worker or installed package belongs to this candidate.
