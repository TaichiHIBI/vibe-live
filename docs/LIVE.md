# Live transcription

Live mode transcribes the microphone and/or system audio while it is being
captured, instead of recording to a file first. It is a local fork feature; the
pieces are:

1. `vibe-server`: a WebSocket route, `GET /v1/audio/live`, that holds the model
   lease for the whole session, runs Silero VAD over the incoming audio, and
   emits a `partial` line for the utterance in progress plus a `segment` line
   for every utterance the VAD closed. Engine-agnostic: it calls
   `Engine::transcribe` on slices, so Whisper, Nemotron and Parakeet all work.
   Nemotron is the recommended engine (fast, no hallucination on silence).
2. The Tauri app (`desktop/src-tauri/src/cmd/live.rs`): captures with cpal like
   `start_record` does, downmixes to mono, resamples to 16 kHz, mixes the
   devices, streams PCM to the server over the WebSocket, writes the same 16 kHz
   mono WAV to the temp folder, and re-emits the server's lines as Tauri events.
3. The frontend: a "Live" switch on the record panel with its own model picker
   (`recording.liveModelPath`, empty = the file model; the language setting is
   translated to the live engine's spelling by `lib/live-language.ts`), a live
   view that shows the finished lines plus the in-progress line, and on stop
   the same project flow a recording takes (`saveTranscript` + `hydrate`).

## Cleaning up afterwards: AI vocabulary prompt

The live engine (Nemotron) hears the words but spells homophones by frequency
(講師列 for コーシー列). The intended workflow is live for following along,
then "Re-transcribe" with Whisper large-v3 for the clean copy. The
re-transcribe dialog has an "AI vocabulary prompt" switch: the AI connection
from Settings → AI reads the topic (prefilled with the project name) and the
existing transcript, lists the terms likely to be spoken with the correct
spelling (`lib/ai/glossary.ts`), and that list becomes Whisper's prompt for
that run only (`EnqueueItem.initPrompt` → `init_prompt`). Models without text
prompts hide the switch; a failed generation runs the job without it.

Whisper's prompt is prior text it imitates, not an instruction, so the
settings prompt is the place for a sentence in the wanted style (script,
punctuation, register) and the glossary supplies the words: both paths send
`combinePrompt(settings, glossary)` — settings first, glossary last, because
Whisper reads only the tail. The glossary instruction keeps names and acronyms
that are normally written in the Latin alphabet (SVM, ViT) in it.

The same switch exists on the record panel for live sessions run on Whisper
(`recording.liveGlossary`, `recording.liveTopic`): the glossary is written from
the topic alone before the speech model is loaded (so the AI model and the
speech model need not share memory), and reaches the server as the `prompt`
field of the `start` message. Nemotron hides the switch and ignores the field.
Measured on the M4 Pro (24 GB): gpt-oss:20b ~30 s, gemma4:26b minutes once it
has to page beside Whisper large-v3 — prefer the smaller model. After the
glossary is written the AI model is released (`AiClient.release`: Ollama's
`keep_alive: 0`), so it does not sit on the GPU during the session.

## WebSocket protocol (`/v1/audio/live`)

Text frames are JSON objects with a `type` field. Binary frames are raw
little-endian `f32` mono PCM at 16 kHz.

Client → server:

| type    | fields                                                                 |
| ------- | ---------------------------------------------------------------------- |
| `start` | `language` (string, `"auto"` allowed), `detect_language` (bool), `vad_model` (path, required), `prompt` (optional, Whisper only), `partial_mode` (`fixed` default / `auto` / `off`), `partial_interval_ms` (fixed mode, 300–10000, default 700) |
| binary  | audio samples; any frame size, ~100 ms recommended                     |
| `stop`  | flush the open utterance as a final segment and close                  |

Server → client:

| type      | fields                                                                      |
| --------- | --------------------------------------------------------------------------- |
| `ready`   | sent after `start` was accepted and the model is ready                      |
| `partial` | `start`, `end` (seconds, absolute since session start), `text` — replaces the previous partial |
| `segment` | `start`, `end`, `text` — final; the partial it replaces is cleared          |
| `error`   | `code`, `message`                                                           |
| `stopped` | last message before the server closes the socket                            |

A second live session or a file transcription while one is open gets `429 busy`
like any concurrent request: the model lease is exclusive.

## Tauri commands and events

Commands:

- `start_live(devices: AudioDevice[], options: { lang?: string, vadModel: string, recordingName?: string, partialMode?: 'fixed' | 'auto' | 'off', partialIntervalMs?: number })`
  — the frontend calls `load_model` first, exactly as the transcribe queue does.
- `stop_live()` — returns at once; the result arrives as `live_finish`.

Events (all emitted to the `main` window):

| event          | payload                                                        |
| -------------- | -------------------------------------------------------------- |
| `record_level` | `number` 0..1, the same meter the recorder uses                |
| `live_partial` | `Segment { start, stop, text }` (centiseconds), replaces the previous partial |
| `live_segment` | `Segment` final line, append it and clear the partial          |
| `live_error`   | `{ message: string }` — the session is over                    |
| `live_finish`  | `{ path, name, segments: Segment[] }` — the 16 kHz WAV and every final line |

## Timing knobs (server, `live.rs`)

- VAD: threshold 0.5, min speech 250 ms, min silence 600 ms (longer than the
  file default so a breath inside a sentence does not split it), pad 30 ms.
- The buffer is scanned every ~320 ms of new audio.
- Every partial re-runs the encoder over the whole open utterance, so the
  partial cadence is the GPU load knob (record panel → "Line in progress"):
  - `fixed`: at most every `partial_interval_ms` (default 700 ms);
  - `auto`: 3× the last decode's duration, clamped to 0.5–5 s (on an M4 Pro a
    6 s utterance decodes in ~150 ms with Nemotron, so this behaves like fixed
    500 ms; a busy or slower machine backs off on its own);
  - `off`: no partial at all; a long utterance is decoded every 3 s only to
    commit its finished sentences.
  A partial needs the open utterance to be at least 500 ms long.
  Decode durations are logged at debug level (`live decode audio_ms=… took_ms=…`).
- Once the open utterance is 6 s long, every line the engine split off before
  the last one (Nemotron splits on sentence punctuation) is committed as final,
  provided it ended at least 1 s before the buffer end. A speaker who never
  pauses still gets settled lines every sentence or so.
- An utterance that reaches 25 s is finalised as it stands.
- A cut made mid-speech keeps 1.5 s of audio in front of the committed point:
  handed a slice that starts inside a phrase, the engine drops up to a second
  at its head (measured with Nemotron: a slice starting 0.6 s before a phrase
  still lost the first four characters). The next decode starts that far back;
  lines it repeats are dropped by their end time, and the first surviving line
  has the tail of the last final line cut off by text (`strip_overlap`, at
  least 3 characters), because RNN-T timestamps are too loose to catch a
  repeat that got glued onto the next sentence.
