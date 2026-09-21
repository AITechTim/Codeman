---
"aicodeman": minor
---

feat(split-pane): view two live sessions side by side

A new Split button in the header (opt-in in App Settings, off by default, desktop only at 1180px and wider) opens a picker and shows a second live session beside the active one: its own terminal, its own WebSocket, and a divider you can drag. When either session ends the view collapses back to one pane, with Pane B promoted to the primary when it is Pane A that ended. Nothing is persisted on purpose in this first cut, so a page reload always returns to a single pane. Pane B is deliberately plainer than the primary pane (no local-echo overlay, CJK input, touch handling or keyboard accessory bar); the design and the v2 boundaries are in discussion #452.
