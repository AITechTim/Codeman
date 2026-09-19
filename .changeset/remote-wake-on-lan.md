---
"aicodeman": minor
---

feat(remote): wake a sleeping remote host from Codeman

A remote SSH case pointing at a machine that suspends used to fail the same way every
time: the session was there, the host was not, and typing into it went nowhere. A host
can now carry a wake target, either a MAC address for Wake-on-LAN (Codeman builds the
magic packet itself, so nothing reaches a shell) or a wake command of your own, and
Codeman uses it when you ask for the host: when you type into a sleeping session, when
you press the wake button on the banner, or when you start or attach a session on that
host. Input you type while it wakes is buffered and flushed once it is back, up to 4 KB,
and a chunk over that is refused outright rather than delivered as a fragment.

Waking only ever happens because you asked. No watcher, dropped-session handler or
boot-recovery path can reach it, since a machine woken by a reconnect watcher would come
back seconds after every suspend.
