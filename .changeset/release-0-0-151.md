---
"@waffle-os/runtime": patch
---

Let a process check whether another process or process group exists without signalling it, as POSIX `kill(pid, 0)` does. `kill(pid, 0)`, `kill_job(job, 0)` and the new `runtime_proc.probe_process(pid)` succeed when the caller may signal the target, return `EPERM` when it exists in the caller's root but may not be signalled, and return `ESRCH` when it is gone or belongs to another root. A process that has exited but is not yet collected still exists. The probe changes nothing and wakes nothing. Signals other than 0 behave as before.
