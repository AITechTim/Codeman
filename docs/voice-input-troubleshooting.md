# Voice input: empty recordings and duplicate text

This records the Pixel 8 / Android Chrome repairs validated on September 10–11, 2026. The user confirmed that dictation and paste looked correct after the final
deployment.

## Recording starts but nothing is inserted

Microphone capture and transcription are separate stages. A recording indicator
does not establish that a provider has returned any text.

The inspected server reported Claude transcription as disabled; its stored Claude
access token was also expired. Browser speech recognition was the chosen repair
path and requires no transcription API key. Deepgram needs its own key. Enabling
Claude or adding an OpenAI key was not part of the fix.

The running frontend predated the voice lifecycle fix in commit `958bdc80`:

- Browser recognition opened the microphone while a separate `getUserMedia`
  stream powered a cosmetic level meter. The extra capture could contend with
  recognition on phones. Browser recognition now owns the microphone alone.
- Confirmation could discard late results. The controller now transitions from
  recording to finalizing, retains interim text, accepts final results, and
  inserts once. Finalization has a bounded timeout.
- Silence and failures could end without useful feedback. Empty confirmations
  and recognition errors now display feedback; available text is retained for
  review on interruption or session change.

The workspace launcher also omitted that existing fix when building its cached
runtime package. Its patch inputs now include the voice patch module, controller,
and PCM worklet. The patch runs before the package becomes ready; changes to any
voice input invalidate the package cache. `CODEMAN_PREPARE_ONLY=1` permits package
verification without starting another server or rewriting live settings.

## Dictation duplicates words immediately

The follow-up report placed duplication in the input, before Send/Enter. The
controller enabled native continuous recognition on Android.

[Chromium's Android speech bridge](https://chromium.googlesource.com/chromium/src/+/e26f3c7e3a932fe4401a979a4bf36e5546b82cb9/content/public/android/java/src/org/chromium/content/browser/SpeechRecognitionImpl.java)
promotes provisional results to final results in continuous mode. That was the
likely source of repeated transcript segments; the exact phone event stream was
not captured.

Android now uses single-phrase recognition. Codeman restarts recognition after
each phrase while the user is still recording, carries the transcript forward,
and waits for explicit confirmation before insertion. Other platforms retain
native continuous recognition. Results within each recognition cycle are treated
as snapshots, so revisions replace interim text rather than append another copy.

Do not remove repeated text by string comparison: saying “hello hello,” repeating
a phrase later, or pasting the same text twice can all be intentional. Tests
explicitly preserve those cases.

## Herdr browser paste duplicates text

This was a separate browser integration bug. A single paste, one browser page,
and one mocked WebSocket produced two identical input frames with real xterm.
Having Codeman and Herdr open on the same pane was not required to reproduce it.

Both xterm and the custom image-aware paste handler listened on the textarea.
The custom handler's `stopPropagation()` could not undo xterm's earlier delivery.
The custom handler now runs once during capture on the terminal container and
consumes the event before xterm's handlers run. It retains image priority,
newline normalization, and bracketed paste through `terminal.paste()`.

The Herdr browser integration lives in the Cancilico runtime overlay, outside
this upstream application tree. Its changes and regression tests are preserved in
the `cancilico-openshell` repository's
`docs/patches/codeman-input-repair.patch`; its runbook is
`docs/runbooks/codeman-input-repair.md`.

## Verification and recurrence checks

The final repair passed 17 voice unit tests, four packaged Android browser tests,
six Herdr paste browser tests, and four voice packaging tests. Browser tests used
mock recognition/transports with real UI handling; none sent test input to a
user pane. All six existing sessions survived the final web-service restart.

```sh
mise exec -- npm test -- test/voice-input.test.ts
mise exec -- npm run test:mobile -- test/mobile/voice-input.test.ts
```

Set `CODEMAN_VOICE_TEST_PUBLIC_DIR` to a prepared package's `dist/web/public`
directory to exercise packaged controller/app assets in the mobile suite.

If the issue returns, first check the active provider and whether the preview
already contains duplication. Then verify the served controller, the package's
voice patch inputs, and the browser's loaded assets. A normal reload selects the
versioned Codeman script; Herdr's custom HTML and JavaScript use `no-store`.
Confirm on the actual phone with two phrases separated by a pause, one explicit
confirmation, a second recording, and an intentional repeated phrase.
