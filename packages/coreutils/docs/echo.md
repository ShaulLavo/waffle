# External echo

Status: implementation in progress.

The isolated echo guest calls unmodified `uu_echo` and `uucore` at the same
uutils/coreutils revision `07763857f6b9a547742a994b58aef0ccd036198b` as cut and tr.
Coreutils installs `/usr/bin/echo` and `/bin/echo` lazily. Xargs finds this real
utility through the existing generic executable registry; no shell builtin or
xargs special case supplies its output.
