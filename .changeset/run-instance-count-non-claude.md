---
"aicodeman": patch
---

fix(run): make the Instance count stepper work for every non-Claude mode

The Instance count stepper next to the Run button only ever applied to Claude.
Setting it to 3 and launching OpenCode, Codex, Gemini, Antigravity, Pi, OMP, Grok or
DeepSeek started exactly one session, with no error and no hint that the control had
done nothing. All eight now launch the count you asked for, and the opening banner
says how many are starting. The one exception is a launch started from the Custom
Endpoints section of the Run menu, which always starts a single session.
