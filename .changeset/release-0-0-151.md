---
"@waffle-os/runtime": patch
---

Processes can now check whether another process or job exists without sending a signal, like POSIX `kill(pid, 0)`. `runtime_proc.kill(pid, 0)` checks an execution handle, `runtime_proc.kill_job(job, 0)` checks a job, and the new `runtime_proc.probe_process(pid)` checks a logical PID. Each returns `0` when the caller can signal the target or fails with `EPERM` when the target exists in the same root outside the caller's control. Missing targets and targets in another root fail with `ESRCH`. Exited processes still exist until collected. Probes wake nothing and change no state.
