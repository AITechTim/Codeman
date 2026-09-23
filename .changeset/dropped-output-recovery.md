---
"aicodeman": patch
---

Terminal: when a burst of output overflows the render queue and a frame has to be dropped, the repaint that repairs it is now retried until it actually happens, instead of being scheduled once and silently skipped when another load was in flight (#470).
