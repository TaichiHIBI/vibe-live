//! Live transcription over a WebSocket: `GET /v1/audio/live`.
//!
//! The socket holds the model lease for the whole session. Audio arrives as
//! binary frames of 16 kHz mono `f32` PCM; the worker runs Silero VAD over what
//! it has, transcribes every utterance the VAD closed as a final `segment`, and
//! re-transcribes the utterance still open every so often as a `partial`. The
//! engine is whatever is loaded: each utterance goes through `Engine::transcribe`
//! on a slice, so Whisper, Nemotron and Parakeet all work without a streaming
//! decoder. See docs/LIVE.md for the protocol.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use whisper_rs::{Segment, TranscribeOptions};

use crate::cli::AppConfig;
use crate::engine::Engine;
use crate::server::unload_timeout::ModelLease;
use crate::server::{error, format, AppState};

const SAMPLE_RATE: usize = vad_rs::SAMPLE_RATE;

/// New audio that has to arrive before the buffer is scanned again.
const SCAN_STEP: usize = SAMPLE_RATE * 32 / 100;
/// A VAD segment ending this far before the buffer end is closed: the state
/// machine only closes one after `min_silence_ms`, while the open one ends
/// within a VAD window (32 ms) of the buffer end.
const CLOSED_MARGIN: usize = SAMPLE_RATE / 4;
/// The open utterance is re-transcribed no more often than this, unless the
/// client asked for another cadence: every decode re-runs the encoder over the
/// whole utterance, so this is the GPU load knob.
const DEFAULT_PARTIAL_INTERVAL: Duration = Duration::from_millis(700);
const MIN_PARTIAL_INTERVAL: Duration = Duration::from_millis(300);
const MAX_PARTIAL_INTERVAL: Duration = Duration::from_secs(10);
/// In `auto` mode the gap is this many times the last decode's duration, within
/// `AUTO_PARTIAL_RANGE`: a fast machine refreshes often, a busy one backs off.
const AUTO_PARTIAL_FACTOR: u32 = 3;
const AUTO_PARTIAL_RANGE: (Duration, Duration) = (Duration::from_millis(500), Duration::from_secs(5));
/// With partials off, a long utterance is still decoded this often so its
/// finished sentences can be committed (see `COMMIT_AFTER`).
const COMMIT_INTERVAL: Duration = Duration::from_secs(3);
/// A decode slower than this (a model paged out to swap, a hallucination loop)
/// means partials would only pile up behind it: `auto` stops asking for them
/// until a decode is quick again, and the slowness is logged where the app
/// keeps the server's stderr.
const SLOW_DECODE: Duration = Duration::from_secs(3);
/// And not before it is this long: shorter than a word is not worth a decode.
const MIN_PARTIAL: usize = SAMPLE_RATE / 2;
/// An utterance this long is finalised as it stands, so the buffer stays bounded
/// and the reader is not kept waiting for a pause that never comes.
const MAX_UTTERANCE: usize = SAMPLE_RATE * 25;
/// Once the open utterance is this long, every line the engine split off before
/// the last one is final: a speaker who never pauses still gets settled lines.
const COMMIT_AFTER: usize = SAMPLE_RATE * 6;
/// A committed line has to end this far before the buffer end, so the engine
/// had the whole of it when it drew the boundary.
const COMMIT_MARGIN: usize = SAMPLE_RATE;
/// Audio kept in front of a cut made mid-speech. Handed a slice that starts
/// inside a phrase, the engine loses up to a second at its head (its own VAD
/// and encoder start cold), so the next decode begins this far back and the
/// lines it repeats are dropped by time instead.
const LEFT_CONTEXT: usize = SAMPLE_RATE * 3 / 2;
/// A line ending within this of the committed point is that line again.
const COMMIT_EPSILON_CS: i64 = 30;
/// Silence kept in the buffer between utterances, so the VAD sees a lead-in.
const KEEP_TAIL: usize = SAMPLE_RATE / 2;
/// Whisper gets the tail of what was said as its prompt; Nemotron takes none.
const PROMPT_TAIL_CHARS: usize = 200;
/// A decode that starts inside `LEFT_CONTEXT` says the end of the last final
/// line again; the repeat is cut off by text, since RNN-T timestamps are too
/// loose to cut it by time. Shorter overlaps than this are coincidence.
const MIN_OVERLAP_CHARS: usize = 3;

#[derive(Debug, Deserialize)]
struct StartMessage {
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    detect_language: bool,
    vad_model: String,
    #[serde(default)]
    prompt: Option<String>,
    /// `fixed` (default), `auto`, or `off`; see `PartialMode`.
    #[serde(default)]
    partial_mode: Option<String>,
    /// Milliseconds between partial decodes in `fixed` mode; see `DEFAULT_PARTIAL_INTERVAL`.
    #[serde(default)]
    partial_interval_ms: Option<u64>,
}

/// How the utterance in progress is re-decoded while it is still open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PartialMode {
    /// Every `partial_interval`.
    Fixed,
    /// As often as the machine keeps up with.
    Auto,
    /// Never shown; decoded only to commit finished sentences of a long utterance.
    Off,
}

impl PartialMode {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("auto") => Self::Auto,
            Some("off") => Self::Off,
            _ => Self::Fixed,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ControlMessage {
    #[serde(rename = "type")]
    kind: String,
}

enum Input {
    Samples(Vec<f32>),
    Stop,
}

type EventSender = tokio::sync::mpsc::UnboundedSender<serde_json::Value>;

fn live_vad_options() -> vad_rs::Options {
    vad_rs::Options {
        // A breath inside a sentence is shorter than this; the file default of
        // 100 ms would hand out one line per clause.
        min_silence_ms: 600,
        ..vad_rs::Options::default()
    }
}

pub(super) async fn live(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    let model = match state.unload_timeout.try_acquire(state.inner.clone()) {
        Ok(model) => model,
        Err(_) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "busy",
                "server is busy with another transcription",
            );
        }
    };
    if model.ctx.is_none() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "no_model", "no model loaded");
    }
    let config = state.config;
    ws.on_upgrade(move |socket| session(socket, model, config))
}

async fn session(socket: WebSocket, model: ModelLease, config: AppConfig) {
    let (mut sink, mut stream) = socket.split();

    // The first text frame has to be `start`; anything else is a protocol error.
    let start = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<ControlMessage>(&text) {
                Ok(control) if control.kind == "start" => match serde_json::from_str::<StartMessage>(&text) {
                    Ok(start) => break start,
                    Err(err) => {
                        let _ = send(
                            &mut sink,
                            error_event("invalid_request", &format!("invalid start message: {err}")),
                        )
                        .await;
                        return;
                    }
                },
                _ => {
                    let _ = send(&mut sink, error_event("invalid_request", "expected a start message")).await;
                    return;
                }
            },
            Some(Ok(Message::Binary(_))) => {
                let _ = send(&mut sink, error_event("invalid_request", "audio before the start message")).await;
                return;
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return,
        }
    };

    let (audio_tx, audio_rx) = mpsc::channel::<Input>();
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();

    let worker = tokio::task::spawn_blocking(move || run_worker(model, start, audio_rx, event_tx, config));
    let writer = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            if send(&mut sink, event).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    while let Some(message) = stream.next().await {
        match message {
            Ok(Message::Binary(bytes)) => {
                if audio_tx.send(Input::Samples(decode_f32le(&bytes))).is_err() {
                    break;
                }
            }
            Ok(Message::Text(text)) => {
                let kind = serde_json::from_str::<ControlMessage>(&text).ok().map(|control| control.kind);
                if kind.as_deref() == Some("stop") {
                    let _ = audio_tx.send(Input::Stop);
                    break;
                }
            }
            Ok(Message::Close(_)) | Err(_) => {
                let _ = audio_tx.send(Input::Stop);
                break;
            }
            Ok(_) => {}
        }
    }
    drop(audio_tx);
    let _ = worker.await;
    let _ = writer.await;
}

async fn send(sink: &mut futures_util::stream::SplitSink<WebSocket, Message>, event: serde_json::Value) -> Result<(), ()> {
    sink.send(Message::Text(event.to_string().into())).await.map_err(|_| ())
}

fn error_event(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "type": "error", "code": code, "message": message })
}

fn decode_f32le(bytes: &[u8]) -> Vec<f32> {
    let (samples, _) = bytes.as_chunks::<4>();
    samples.iter().map(|chunk| f32::from_le_bytes(*chunk)).collect()
}

/// One session's transcription state: the audio not yet finalised and where it
/// sits in the session's timeline.
struct Worker<'a> {
    ctx: &'a mut Engine,
    vad: vad_rs::Vad,
    options: TranscribeOptions,
    prompts: bool,
    events: EventSender,
    /// Audio after the last finalised utterance.
    buffer: Vec<f32>,
    /// Samples the session has consumed before `buffer[0]`.
    base: usize,
    /// Session position up to which lines are final; the buffer keeps
    /// `LEFT_CONTEXT` of audio before it.
    committed: usize,
    partial_mode: PartialMode,
    partial_interval: Duration,
    /// How long the last decode took, for `PartialMode::Auto`.
    last_decode: Duration,
    last_partial_at: Instant,
    last_partial_text: String,
    /// The final text so far, for Whisper's prompt.
    said: String,
    /// The last final lines, joined, for cutting repeats off the next decode.
    committed_text: String,
}

fn run_worker(mut model: ModelLease, start: StartMessage, rx: mpsc::Receiver<Input>, events: EventSender, config: AppConfig) {
    let Some(ctx) = model.ctx.as_mut() else {
        let _ = events.send(error_event("no_model", "no model loaded"));
        return;
    };
    let vad = match vad_rs::Vad::new(&start.vad_model, live_vad_options()) {
        Ok(vad) => vad,
        Err(err) => {
            let _ = events.send(error_event("invalid_request", &format!("failed to load VAD model: {err}")));
            return;
        }
    };
    let prompts = ctx.capabilities().text_prompts;
    let partial_interval = start
        .partial_interval_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_PARTIAL_INTERVAL)
        .clamp(MIN_PARTIAL_INTERVAL, MAX_PARTIAL_INTERVAL);
    // Nemotron rejects a text prompt outright, so one only reaches an engine that reads it.
    let prompt = start
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty() && prompts)
        .map(str::to_owned);
    let options = TranscribeOptions {
        language: start.language.filter(|language| !language.is_empty()),
        detect_language: start.detect_language,
        vad_model_path: Some(start.vad_model),
        verbose: config.verbose(),
        prompt: prompt.clone(),
        ..TranscribeOptions::default()
    };
    let mut worker = Worker {
        ctx,
        vad,
        options,
        prompts,
        events,
        buffer: Vec::new(),
        base: 0,
        committed: 0,
        partial_mode: PartialMode::parse(start.partial_mode.as_deref()),
        partial_interval,
        last_decode: Duration::ZERO,
        last_partial_at: Instant::now() - MAX_PARTIAL_INTERVAL,
        last_partial_text: String::new(),
        said: prompt.unwrap_or_default(),
        committed_text: String::new(),
    };
    if worker.events.send(serde_json::json!({ "type": "ready" })).is_err() {
        return;
    }

    let mut pending = 0usize;
    loop {
        let mut stopping = false;
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Input::Samples(samples)) => {
                pending += samples.len();
                worker.buffer.extend(samples);
            }
            Ok(Input::Stop) | Err(RecvTimeoutError::Disconnected) => stopping = true,
            Err(RecvTimeoutError::Timeout) => {}
        }
        // Take everything that queued up while a decode ran, so the scan sees
        // the newest audio rather than lagging one frame per iteration.
        while !stopping {
            match rx.try_recv() {
                Ok(Input::Samples(samples)) => {
                    pending += samples.len();
                    worker.buffer.extend(samples);
                }
                Ok(Input::Stop) | Err(mpsc::TryRecvError::Disconnected) => stopping = true,
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        if worker.events.is_closed() {
            return;
        }
        if stopping {
            let result = worker.flush();
            if let Err(err) = result {
                let _ = worker.events.send(error_event("internal_error", &err.to_string()));
            }
            let _ = worker.events.send(serde_json::json!({ "type": "stopped" }));
            return;
        }
        if pending < SCAN_STEP {
            continue;
        }
        pending = 0;
        if let Err(err) = worker.scan() {
            tracing::error!("live transcription failed: {err:#}");
            let _ = worker
                .events
                .send(error_event(crate::server::engine_error_code(&err), &err.to_string()));
            return;
        }
    }
}

impl Worker<'_> {
    /// Run the VAD over the buffer, finalise what it closed, refresh the partial.
    fn scan(&mut self) -> anyhow::Result<()> {
        let segments = self.vad.segments(&self.buffer)?;
        let total = self.buffer.len();
        let (closed, open): (Vec<_>, Vec<_>) = segments
            .into_iter()
            .partition(|segment| segment.end_sample + CLOSED_MARGIN < total);

        let mut trim_to: Option<usize> = None;
        let committed_local = self.committed.saturating_sub(self.base);
        for segment in &closed {
            // The context kept in front of the committed point closes as its own
            // segment once the speaker pauses; it is done already.
            if segment.end_sample <= committed_local {
                trim_to = Some(segment.end_sample);
                continue;
            }
            self.finalize(segment.start_sample, segment.end_sample)?;
            trim_to = Some(self.commit(segment.end_sample));
        }

        // The VAD reports at most one segment still running into the buffer end.
        if let Some(segment) = open.last() {
            let length = segment.end_sample.saturating_sub(segment.start_sample);
            if length >= MAX_UTTERANCE {
                self.finalize(segment.start_sample, segment.end_sample)?;
                trim_to = Some(self.commit(segment.end_sample));
            } else if length >= self.min_decode_length() && self.last_partial_at.elapsed() >= self.decode_interval() {
                let lines = self.partial(segment.start_sample, segment.end_sample)?;
                if length >= COMMIT_AFTER {
                    if let Some(end) = self.commit_settled(&lines, segment.end_sample) {
                        trim_to = Some(self.commit(end));
                    }
                }
            }
        } else if trim_to.is_none() && self.buffer.len() > KEEP_TAIL {
            // Silence only: keep a lead-in, drop the rest.
            trim_to = Some(self.buffer.len() - KEEP_TAIL);
        }

        if let Some(end) = trim_to {
            let end = end.min(self.buffer.len());
            self.buffer.drain(..end);
            self.base += end;
        }
        Ok(())
    }

    /// `auto` behaves as `off` while decodes are too slow to keep up with speech.
    fn effective_mode(&self) -> PartialMode {
        match self.partial_mode {
            PartialMode::Auto if self.last_decode > SLOW_DECODE => PartialMode::Off,
            mode => mode,
        }
    }

    /// How long to wait between decodes of the open utterance.
    fn decode_interval(&self) -> Duration {
        match self.effective_mode() {
            PartialMode::Fixed => self.partial_interval,
            PartialMode::Auto => (self.last_decode * AUTO_PARTIAL_FACTOR).clamp(AUTO_PARTIAL_RANGE.0, AUTO_PARTIAL_RANGE.1),
            PartialMode::Off => COMMIT_INTERVAL,
        }
    }

    /// With partials off, the only reason to decode an open utterance is to
    /// commit its finished sentences, and there is nothing to commit before then.
    fn min_decode_length(&self) -> usize {
        match self.effective_mode() {
            PartialMode::Off => COMMIT_AFTER,
            _ => MIN_PARTIAL,
        }
    }

    /// Everything before buffer index `end` is final. Returns where to trim the
    /// buffer to: `LEFT_CONTEXT` earlier, for the next decode's sake.
    fn commit(&mut self, end: usize) -> usize {
        self.committed = self.committed.max(self.base + end);
        end.saturating_sub(LEFT_CONTEXT)
    }

    /// End of session: whatever speech is left becomes final lines.
    fn flush(&mut self) -> anyhow::Result<()> {
        let segments = self.vad.segments(&self.buffer)?;
        for segment in segments {
            self.finalize(segment.start_sample, segment.end_sample)?;
        }
        let length = self.buffer.len();
        self.buffer.clear();
        self.base += length;
        Ok(())
    }

    /// Of the lines a partial decode split the open utterance into, every one
    /// but the last that ended well before the buffer end is final. Returns the
    /// buffer position the next partial starts from.
    fn commit_settled(&mut self, lines: &[Segment], open_end: usize) -> Option<usize> {
        let limit = open_end.checked_sub(COMMIT_MARGIN)?;
        let settled: Vec<&Segment> = lines
            .iter()
            .take(lines.len().saturating_sub(1))
            .take_while(|line| self.buffer_index(line.end) <= limit)
            .collect();
        let last = settled.last()?;
        let end = self.buffer_index(last.end);
        for line in settled.iter() {
            self.emit_final(line);
        }
        self.after_final();
        Some(end)
    }

    /// The buffer index of a session-clock timestamp.
    fn buffer_index(&self, cs: i64) -> usize {
        let sample = (cs.max(0) as usize * SAMPLE_RATE) / 100;
        sample.saturating_sub(self.base)
    }

    fn finalize(&mut self, start: usize, end: usize) -> anyhow::Result<()> {
        let segments = self.transcribe(start, end)?;
        for segment in &segments {
            self.emit_final(segment);
        }
        self.after_final();
        Ok(())
    }

    /// The line these partials previewed is out; the next partial starts fresh.
    fn after_final(&mut self) {
        self.last_partial_text.clear();
        self.last_partial_at = Instant::now() - MAX_PARTIAL_INTERVAL;
    }

    fn emit_final(&mut self, segment: &Segment) {
        let text = segment.text.trim();
        if text.is_empty() {
            return;
        }
        self.committed_text.push_str(text);
        if self.committed_text.chars().count() > PROMPT_TAIL_CHARS {
            let cut = self.committed_text.chars().count() - PROMPT_TAIL_CHARS;
            self.committed_text = self.committed_text.chars().skip(cut).collect();
        }
        if self.prompts {
            if !self.said.is_empty() {
                self.said.push(' ');
            }
            self.said.push_str(text);
            if self.said.chars().count() > PROMPT_TAIL_CHARS {
                let cut = self.said.chars().count() - PROMPT_TAIL_CHARS;
                self.said = self.said.chars().skip(cut).collect();
            }
            self.options.prompt = Some(self.said.clone());
        }
        let _ = self.events.send(serde_json::json!({
            "type": "segment",
            "start": format::cs_to_seconds(segment.start),
            "end": format::cs_to_seconds(segment.end),
            "text": text,
        }));
    }

    /// Re-transcribe the open utterance and send it as the partial. Returns the
    /// lines the engine split it into, on the session clock.
    fn partial(&mut self, start: usize, end: usize) -> anyhow::Result<Vec<Segment>> {
        self.last_partial_at = Instant::now();
        let segments = self.transcribe(start, end)?;
        let text = segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if self.effective_mode() == PartialMode::Off || text.is_empty() || text == self.last_partial_text {
            return Ok(segments);
        }
        let first = segments.first().map_or(0, |segment| segment.start);
        let last = segments.last().map_or(0, |segment| segment.end);
        let _ = self.events.send(serde_json::json!({
            "type": "partial",
            "start": format::cs_to_seconds(first),
            "end": format::cs_to_seconds(last),
            "text": text,
        }));
        self.last_partial_text = text;
        Ok(segments)
    }

    /// Transcribe `buffer[start..end]`; timestamps come back on the session's
    /// clock, and lines that end inside what is already final are left out.
    fn transcribe(&mut self, start: usize, end: usize) -> anyhow::Result<Vec<Segment>> {
        let end = end.min(self.buffer.len());
        if start >= end {
            return Ok(Vec::new());
        }
        let offset_cs = ((self.base + start) as i64 * 100) / SAMPLE_RATE as i64;
        let committed_cs = (self.committed as i64 * 100) / SAMPLE_RATE as i64;
        let started = Instant::now();
        let result = self.ctx.transcribe(&self.buffer[start..end], self.options.clone())?;
        self.last_decode = started.elapsed();
        if self.last_decode > SLOW_DECODE {
            tracing::warn!(
                audio_ms = (end - start) * 1000 / SAMPLE_RATE,
                took_ms = self.last_decode.as_millis(),
                "slow live decode: the model may be paged out, or looping; partials are paused in auto mode"
            );
        } else {
            tracing::debug!(
                audio_ms = (end - start) * 1000 / SAMPLE_RATE,
                took_ms = self.last_decode.as_millis(),
                "live decode"
            );
        }
        let mut lines: Vec<Segment> = result
            .segments
            .into_iter()
            .map(|segment| Segment {
                start: segment.start + offset_cs,
                end: segment.end + offset_cs,
                ..segment
            })
            .filter(|segment| segment.end > committed_cs + COMMIT_EPSILON_CS)
            .collect();
        // The first line of a decode that began inside the context repeats the
        // tail of the last final line, and when that line had no sentence mark
        // the repeat is glued to the next sentence, so no time filter catches it.
        if let Some(first) = lines.first_mut() {
            let trimmed = strip_overlap(&self.committed_text, first.text.trim());
            first.text = trimmed.to_string();
        }
        lines.retain(|line| !line.text.trim().is_empty());
        Ok(lines)
    }
}

/// `line` without the longest prefix that ends `committed` (at least
/// `MIN_OVERLAP_CHARS` long), so a re-decoded tail is not said twice.
fn strip_overlap<'a>(committed: &str, line: &'a str) -> &'a str {
    let committed: Vec<char> = committed.chars().filter(|c| !c.is_whitespace()).collect();
    let line_chars: Vec<(usize, char)> = line.char_indices().collect();
    let candidates: Vec<(usize, char)> = line_chars.iter().copied().filter(|(_, c)| !c.is_whitespace()).collect();
    let max = candidates.len().min(committed.len());
    for k in (MIN_OVERLAP_CHARS..=max).rev() {
        let head: Vec<char> = candidates[..k].iter().map(|(_, c)| *c).collect();
        if committed.ends_with(&head) {
            // Cut after the k-th non-blank character of the line.
            let (last_index, last_char) = candidates[k - 1];
            let cut = last_index + last_char.len_utf8();
            return line[cut..].trim_start();
        }
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_repeated_tail_of_the_last_final_line() {
        assert_eq!(strip_overlap("係数がアルファプラスベータですよね。", "ベータですよね。"), "");
        assert_eq!(
            strip_overlap("それに内積を設定したい", "設定したいで内積だけど、ベクトルじゃない"),
            "で内積だけど、ベクトルじゃない"
        );
        assert_eq!(
            strip_overlap("the cat sat on the mat", "the mat and then left"),
            "and then left"
        );
        // Too short to be more than coincidence.
        assert_eq!(strip_overlap("これは線形なんです", "で次に"), "で次に");
        assert_eq!(strip_overlap("", "何でもいい"), "何でもいい");
    }

    #[test]
    fn decodes_little_endian_f32() {
        let bytes = [0.5f32, -1.0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(decode_f32le(&bytes), vec![0.5, -1.0]);
        // A trailing partial sample is dropped rather than misread.
        assert_eq!(decode_f32le(&bytes[..5]), vec![0.5]);
    }
}
