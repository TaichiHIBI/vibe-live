//! Live transcription: the same capture as `start_record`, streamed to
//! vibe-server's `/v1/audio/live` socket while it happens (docs/LIVE.md).
//!
//! Three moving parts per session: the cpal callbacks, which only downmix and
//! hand their buffer to a channel; a mixer thread, which resamples every device
//! to 16 kHz, sums them, writes the WAV and cuts 100 ms frames; and an async
//! pump, which sends those frames over the socket and turns the server's lines
//! into `live_partial` / `live_segment` events.

use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, Sample, SizedSample, Stream, SupportedStreamConfig};
use eyre::{bail, eyre, Context, ContextCompat, Result};
use futures_util::{SinkExt, StreamExt};
use rubato::{FastFixedIn, PolynomialDegree, Resampler};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_tungstenite::tungstenite::Message;

use super::audio::{buffer_peak, get_output_device_and_config, AudioDevice, LevelMeter, StreamHandle};
use super::CommandError;
use crate::error::LogError;
use crate::ffmpeg::{get_local_time, get_vibe_temp_folder};
use crate::setup::ServerState;
use crate::transcript::Segment;

const TARGET_RATE: u32 = 16_000;
/// Frames handed to the resampler at a time, at the device's own rate.
const RESAMPLE_CHUNK: usize = 1024;
/// One socket frame: 100 ms of 16 kHz audio.
const FRAME_SAMPLES: usize = TARGET_RATE as usize / 10;
/// A device that delivered nothing for this long is mixed as absent, so a dead
/// loopback cannot hold the microphone back.
const DEVICE_STALL: Duration = Duration::from_millis(1000);
/// How long stop waits for the server to flush the last utterance.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// Model warm-up on the server before the first `ready`.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveOptions {
    pub lang: Option<String>,
    pub vad_model: String,
    pub recording_name: Option<String>,
    /// Whisper's initial prompt (a vocabulary list, say); ignored by engines without one.
    pub prompt: Option<String>,
    /// `fixed`, `auto` or `off`; None is the server's default (fixed).
    pub partial_mode: Option<String>,
    /// Milliseconds between partial decodes in fixed mode; None takes the server's default.
    pub partial_interval_ms: Option<u64>,
}

/// The one live session, if any: `start_live` fills it, `stop_live` (or a server
/// error) takes it back out.
#[derive(Default)]
pub struct LiveState(Mutex<Option<LiveSession>>, std::sync::atomic::AtomicBool);

/// Set while `start_live` is between opening the socket and storing the session:
/// a second click in that window used to open a second socket and get the
/// server's 429, then tear the first session's UI down on the error.
struct Starting<'a>(&'a LiveState);

impl<'a> Starting<'a> {
    fn begin(state: &'a LiveState) -> Option<Self> {
        (!state.1.swap(true, std::sync::atomic::Ordering::SeqCst)).then_some(Self(state))
    }
}

impl Drop for Starting<'_> {
    fn drop(&mut self) {
        self.0 .1.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

struct LiveSession {
    streams: Vec<StreamHandle>,
    capture_tx: mpsc::Sender<Capture>,
}

enum Capture {
    Samples { device: usize, mono: Vec<f32> },
    Stop,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
enum LiveEvent {
    Ready,
    Partial { start: f64, end: f64, text: String },
    Segment { start: f64, end: f64, text: String },
    Error { code: Option<String>, message: String },
    Stopped,
}

fn segment(start: f64, end: f64, text: String) -> Segment {
    Segment {
        start: (start * 100.0).round() as i64,
        stop: (end * 100.0).round() as i64,
        text,
        speaker: None,
    }
}

/// Pause and drop the capture, and let the mixer finish. The pump notices the
/// end of the audio and takes it from there.
fn teardown(app_handle: &AppHandle) -> bool {
    let state = app_handle.state::<LiveState>();
    let Some(session) = state.0.lock().ok().and_then(|mut guard| guard.take()) else {
        return false;
    };
    for stream in session.streams {
        stream.0.pause().map_err(|e| eyre!("{e:?}")).log_error();
    }
    let _ = session.capture_tx.send(Capture::Stop);
    true
}

#[tauri::command]
pub async fn start_live(
    app_handle: AppHandle,
    devices: Vec<AudioDevice>,
    options: LiveOptions,
    server_state: State<'_, tokio::sync::Mutex<ServerState>>,
    live_state: State<'_, LiveState>,
) -> std::result::Result<(), CommandError> {
    if devices.is_empty() {
        return Err(CommandError {
            code: "invalid_request".to_string(),
            message: "At least one audio device is required".to_string(),
        });
    }
    let already = || CommandError {
        code: "invalid_request".to_string(),
        message: "A live transcription is already running".to_string(),
    };
    let Some(_starting) = Starting::begin(&live_state) else {
        return Err(already());
    };
    if live_state.0.lock().map(|guard| guard.is_some()).unwrap_or(false) {
        return Err(already());
    }
    let base_url = {
        let state = server_state.lock().await;
        let process = state.process.as_ref().ok_or_else(|| CommandError {
            code: "no_model".to_string(),
            message: "Please load model first".to_string(),
        })?;
        process.base_url()
    };

    // The socket first: a busy server or a missing VAD model is reported before
    // any device is opened, and the meter never flickers for nothing.
    let ws = open_session(&base_url, &options).await?;

    let stem = options
        .recording_name
        .as_deref()
        .map(crate::cmd::files::sanitize_filename_stem)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(get_local_time);
    let wav_path = crate::cmd::files::available_path(&get_vibe_temp_folder(), &stem, "wav");

    let (capture_tx, capture_rx) = mpsc::channel::<Capture>();
    let (audio_tx, audio_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();
    let meter = Arc::new(LevelMeter::new(app_handle.clone()));

    let (feeds, streams) = open_capture(&devices, &capture_tx, &meter)?;

    let wav_for_mixer = wav_path.clone();
    let mixer = std::thread::Builder::new()
        .name("live-mixer".into())
        .spawn(move || run_mixer(capture_rx, feeds, &wav_for_mixer, audio_tx))
        .context("failed to start the live mixer thread")?;

    // In the state before the pump runs: a server error arriving first must find
    // something to tear down.
    if let Ok(mut guard) = live_state.0.lock() {
        *guard = Some(LiveSession { streams, capture_tx });
    }
    crate::meeting_prompt::recording_started(&app_handle);

    let name = wav_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    tauri::async_runtime::spawn(pump(app_handle, ws, audio_rx, mixer, wav_path, name));
    Ok(())
}

/// One cpal stream per device, already playing, and the feed each one lands in.
fn open_capture(
    devices: &[AudioDevice],
    capture_tx: &mpsc::Sender<Capture>,
    meter: &Arc<LevelMeter>,
) -> Result<(Vec<Feed>, Vec<StreamHandle>)> {
    let host = cpal::default_host();
    let mut feeds = Vec::new();
    let mut streams = Vec::new();
    for (index, device) in devices.iter().enumerate() {
        tracing::debug!("Live capture from device: {} ({})", device.name, device.id);
        let (device, config) = if device.is_input {
            let device_id: usize = device.id.parse().context("Failed to parse device ID")?;
            let dev = host.devices()?.nth(device_id).context("Failed to get device by ID")?;
            let config = dev.default_input_config().context("Failed to get default input config")?;
            (dev, config)
        } else {
            get_output_device_and_config(&host, device)?
        };
        feeds.push(Feed::new(config.sample_rate())?);
        let stream = build_capture_stream(&device, config, index, capture_tx.clone(), meter.clone())?;
        stream.play()?;
        streams.push(StreamHandle(stream));
    }
    Ok((feeds, streams))
}

#[tauri::command]
pub async fn stop_live(app_handle: AppHandle) -> std::result::Result<bool, CommandError> {
    Ok(teardown(&app_handle))
}

type WebSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, send `start`, and wait for the server's `ready`.
async fn open_session(base_url: &str, options: &LiveOptions) -> std::result::Result<WebSocket, CommandError> {
    let url = format!("{}/v1/audio/live", base_url.replacen("http", "ws", 1));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|error| CommandError {
        code: match &error {
            // The server answers a busy or model-less upgrade with its usual error body.
            tokio_tungstenite::tungstenite::Error::Http(response) if response.status().as_u16() == 429 => "busy".to_string(),
            tokio_tungstenite::tungstenite::Error::Http(response) if response.status().as_u16() == 503 => "no_model".to_string(),
            _ => "internal_error".to_string(),
        },
        message: format!("failed to open the live transcription socket: {error}"),
    })?;
    let start = json!({
        "type": "start",
        "language": options.lang.as_deref().filter(|lang| !lang.is_empty()),
        "detect_language": false,
        "vad_model": options.vad_model,
        "prompt": options.prompt.as_deref().filter(|prompt| !prompt.trim().is_empty()),
        "partial_mode": options.partial_mode,
        "partial_interval_ms": options.partial_interval_ms,
    });
    ws.send(Message::Text(start.to_string().into()))
        .await
        .map_err(|error| CommandError::from(eyre!("failed to send the live start message: {error}")))?;

    let ready = tokio::time::timeout(READY_TIMEOUT, async {
        while let Some(message) = ws.next().await {
            match message {
                Ok(Message::Text(text)) => match serde_json::from_str::<LiveEvent>(&text) {
                    Ok(LiveEvent::Ready) => return Ok(()),
                    Ok(LiveEvent::Error { code, message }) => {
                        return Err(CommandError {
                            code: code.unwrap_or_else(|| "internal_error".to_string()),
                            message,
                        })
                    }
                    Ok(_) => continue,
                    Err(error) => return Err(CommandError::from(eyre!("unexpected live message: {error}"))),
                },
                Ok(Message::Close(_)) => break,
                Ok(_) => continue,
                Err(error) => return Err(CommandError::from(eyre!("live socket failed: {error}"))),
            }
        }
        Err(CommandError::from(eyre!("live socket closed before the server was ready")))
    })
    .await;
    match ready {
        Ok(result) => result?,
        Err(_) => {
            return Err(CommandError::from(eyre!(
                "timed out after {}s waiting for the live session to become ready",
                READY_TIMEOUT.as_secs()
            )))
        }
    }
    Ok(ws)
}

/// Forward the mixer's frames to the server and the server's lines to the
/// window, then report how the session ended.
async fn pump(
    app_handle: AppHandle,
    ws: WebSocket,
    mut audio_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<f32>>,
    mixer: std::thread::JoinHandle<Result<()>>,
    wav_path: PathBuf,
    name: String,
) {
    let (mut sink, mut stream) = ws.split();
    let mut segments: Vec<Segment> = Vec::new();
    let mut failure: Option<String> = None;
    let mut audio_done = false;
    let mut stopped = false;
    let deadline = tokio::time::sleep(STOP_TIMEOUT);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            frame = audio_rx.recv(), if !audio_done => match frame {
                Some(samples) => {
                    let bytes = samples.iter().flat_map(|sample| sample.to_le_bytes()).collect::<Vec<u8>>();
                    if let Err(error) = sink.send(Message::Binary(bytes.into())).await {
                        failure = Some(format!("live socket send failed: {error}"));
                        break;
                    }
                }
                None => {
                    // The mixer is done: ask for the flush and give it a deadline.
                    audio_done = true;
                    deadline.as_mut().reset(tokio::time::Instant::now() + STOP_TIMEOUT);
                    if let Err(error) = sink.send(Message::Text(json!({ "type": "stop" }).to_string().into())).await {
                        failure = Some(format!("live socket send failed: {error}"));
                        break;
                    }
                }
            },
            message = stream.next() => match message {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<LiveEvent>(&text) {
                    Ok(LiveEvent::Partial { start, end, text }) => {
                        app_handle.emit_to("main", "live_partial", segment(start, end, text)).log_error();
                    }
                    Ok(LiveEvent::Segment { start, end, text }) => {
                        let line = segment(start, end, text);
                        app_handle.emit_to("main", "live_segment", line.clone()).log_error();
                        segments.push(line);
                    }
                    Ok(LiveEvent::Error { message, .. }) => {
                        failure = Some(message);
                        break;
                    }
                    Ok(LiveEvent::Stopped) => {
                        stopped = true;
                        break;
                    }
                    Ok(LiveEvent::Ready) => {}
                    Err(error) => tracing::warn!("ignoring unparsable live message: {error}"),
                },
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    failure = Some(format!("live socket failed: {error}"));
                    break;
                }
            },
            _ = &mut deadline, if audio_done => {
                tracing::warn!("live session: no `stopped` from the server within {}s", STOP_TIMEOUT.as_secs());
                break;
            }
        }
    }
    let _ = sink.close().await;

    // Whatever ended the loop, the capture must not outlive it, and the WAV has
    // to be finalised before the window hears about the file.
    teardown(&app_handle);
    let mixed = tokio::task::spawn_blocking(move || mixer.join())
        .await
        .map_err(|error| eyre!("{error}"))
        .and_then(|joined| joined.map_err(|_| eyre!("the live mixer thread panicked")))
        .and_then(|result| result);
    crate::meeting_prompt::recording_stopped(&app_handle);

    if let Err(error) = &mixed {
        tracing::error!("live mixer failed: {error:#}");
    }
    if !stopped && failure.is_none() {
        failure = Some("the live session ended before the server finished".to_string());
    }
    match failure {
        Some(message) => {
            tracing::error!("live transcription failed: {message}");
            app_handle
                .emit_to("main", "live_error", json!({ "message": message }))
                .log_error();
        }
        None => {
            app_handle
                .emit_to(
                    "main",
                    "live_finish",
                    json!({
                        "path": wav_path.to_string_lossy(),
                        "name": name,
                        "segments": segments,
                    }),
                )
                .log_error();
        }
    }
}

/// One device's audio on its way to 16 kHz mono.
struct Feed {
    resampler: Option<FastFixedIn<f32>>,
    /// Native-rate mono waiting for a full resampler chunk.
    pending: Vec<f32>,
    /// 16 kHz mono waiting to be mixed.
    ready: VecDeque<f32>,
    last_seen: Option<Instant>,
}

impl Feed {
    fn new(rate: u32) -> Result<Self> {
        let resampler = if rate == TARGET_RATE {
            None
        } else {
            Some(
                FastFixedIn::<f32>::new(
                    f64::from(TARGET_RATE) / f64::from(rate),
                    1.0,
                    PolynomialDegree::Septic,
                    RESAMPLE_CHUNK,
                    1,
                )
                .map_err(|error| eyre!("failed to build a {rate} Hz resampler: {error}"))?,
            )
        };
        Ok(Self {
            resampler,
            pending: Vec::new(),
            ready: VecDeque::new(),
            last_seen: None,
        })
    }

    fn push(&mut self, mono: Vec<f32>) -> Result<()> {
        self.last_seen = Some(Instant::now());
        let Some(resampler) = self.resampler.as_mut() else {
            self.ready.extend(mono);
            return Ok(());
        };
        self.pending.extend(mono);
        while self.pending.len() >= RESAMPLE_CHUNK {
            let chunk: Vec<f32> = self.pending.drain(..RESAMPLE_CHUNK).collect();
            let out = resampler
                .process(&[chunk], None)
                .map_err(|error| eyre!("resampling failed: {error}"))?;
            self.ready.extend(out.into_iter().next().unwrap_or_default());
        }
        Ok(())
    }

    /// The tail shorter than a chunk, at the end of the session.
    fn flush(&mut self) -> Result<()> {
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(());
        };
        if self.pending.is_empty() {
            return Ok(());
        }
        let tail: Vec<f32> = std::mem::take(&mut self.pending);
        let out = resampler
            .process_partial(Some(&[tail]), None)
            .map_err(|error| eyre!("resampling failed: {error}"))?;
        self.ready.extend(out.into_iter().next().unwrap_or_default());
        Ok(())
    }

    fn active(&self) -> bool {
        self.last_seen.is_some_and(|seen| seen.elapsed() < DEVICE_STALL)
    }
}

struct Mixer {
    feeds: Vec<Feed>,
    started: Instant,
    out: Vec<f32>,
    writer: hound::WavWriter<BufWriter<File>>,
    audio_tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
}

impl Mixer {
    /// Sum what every live device has ready. `all` takes everything, padding the
    /// shorter feeds with silence, for the end of the session.
    fn mix(&mut self, all: bool) -> Result<()> {
        // Give a device that has not started yet a moment before writing it off:
        // the loopback opens a little after the microphone.
        if !all && self.feeds.iter().any(|feed| feed.last_seen.is_none()) && self.started.elapsed() < DEVICE_STALL {
            return Ok(());
        }
        let active: Vec<usize> = (0..self.feeds.len())
            .filter(|&index| all || self.feeds[index].active())
            .collect();
        for (index, feed) in self.feeds.iter_mut().enumerate() {
            if !active.contains(&index) {
                // A resumed device would come back misaligned; its backlog goes.
                feed.ready.clear();
            }
        }
        let lengths = active.iter().map(|&index| self.feeds[index].ready.len());
        let count = if all { lengths.max() } else { lengths.min() }.unwrap_or(0);
        if count == 0 {
            return Ok(());
        }
        for _ in 0..count {
            let mut sum = 0.0f32;
            for &index in &active {
                sum += self.feeds[index].ready.pop_front().unwrap_or(0.0);
            }
            self.out.push(sum.clamp(-1.0, 1.0));
        }
        self.drain(all)
    }

    fn drain(&mut self, all: bool) -> Result<()> {
        while self.out.len() >= FRAME_SAMPLES || (all && !self.out.is_empty()) {
            let take = self.out.len().min(FRAME_SAMPLES);
            let frame: Vec<f32> = self.out.drain(..take).collect();
            for &sample in &frame {
                self.writer.write_sample((sample * f32::from(i16::MAX)) as i16)?;
            }
            // The pump being gone is not the mixer's problem; the WAV still completes.
            let _ = self.audio_tx.send(frame);
        }
        Ok(())
    }
}

fn run_mixer(
    rx: mpsc::Receiver<Capture>,
    feeds: Vec<Feed>,
    wav_path: &PathBuf,
    audio_tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let writer = hound::WavWriter::create(wav_path, spec).context("failed to create the live WAV")?;
    let mut mixer = Mixer {
        feeds,
        started: Instant::now(),
        out: Vec::new(),
        writer,
        audio_tx,
    };

    'session: loop {
        let mut received = match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(capture) => vec![capture],
            Err(mpsc::RecvTimeoutError::Timeout) => Vec::new(),
            Err(mpsc::RecvTimeoutError::Disconnected) => break 'session,
        };
        while let Ok(capture) = rx.try_recv() {
            received.push(capture);
        }
        for capture in received {
            match capture {
                Capture::Samples { device, mono } => {
                    if let Some(feed) = mixer.feeds.get_mut(device) {
                        feed.push(mono)?;
                    }
                }
                Capture::Stop => break 'session,
            }
        }
        mixer.mix(false)?;
    }

    for feed in &mut mixer.feeds {
        feed.flush()?;
    }
    mixer.mix(true)?;
    mixer.writer.finalize().context("failed to finalize the live WAV")?;
    Ok(())
}

fn downmix<T>(data: &[T], channels: usize) -> Vec<f32>
where
    T: Sample,
    f32: FromSample<T>,
{
    if channels <= 1 {
        return data.iter().map(|&sample| f32::from_sample(sample)).collect();
    }
    data.chunks_exact(channels)
        .map(|frame| frame.iter().map(|&sample| f32::from_sample(sample)).sum::<f32>() / channels as f32)
        .collect()
}

fn build_capture_stream_typed<T>(
    device: &Device,
    config: SupportedStreamConfig,
    index: usize,
    tx: mpsc::Sender<Capture>,
    meter: Arc<LevelMeter>,
) -> Result<Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels()).max(1);
    let stream = device.build_input_stream(
        config.into(),
        move |data: &[T], _: &_| {
            meter.push(buffer_peak(data));
            let mono = downmix(data, channels);
            // The receiver being gone means the session is over; nothing to do here.
            let _ = tx.send(Capture::Samples { device: index, mono });
        },
        |err| tracing::error!("An error occurred on live stream: {}", err),
        None,
    )?;
    Ok(stream)
}

fn build_capture_stream(
    device: &Device,
    config: SupportedStreamConfig,
    index: usize,
    tx: mpsc::Sender<Capture>,
    meter: Arc<LevelMeter>,
) -> Result<Stream> {
    match config.sample_format() {
        cpal::SampleFormat::I8 => build_capture_stream_typed::<i8>(device, config, index, tx, meter),
        cpal::SampleFormat::I16 => build_capture_stream_typed::<i16>(device, config, index, tx, meter),
        cpal::SampleFormat::I32 => build_capture_stream_typed::<i32>(device, config, index, tx, meter),
        cpal::SampleFormat::F32 => build_capture_stream_typed::<f32>(device, config, index, tx, meter),
        sample_format => bail!("Unsupported sample format '{}'", sample_format),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(downmix(&[1.0f32, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix(&[0.25f32, -0.25], 1), vec![0.25, -0.25]);
    }

    #[test]
    fn feed_resamples_48k_to_16k() {
        let mut feed = Feed::new(48_000).unwrap();
        feed.push(vec![0.0; 4800]).unwrap();
        feed.flush().unwrap();
        // 100 ms in, about 100 ms out: the flush pads the last chunk with silence
        // and releases the resampler's delay, so a little more than 1600 comes out.
        assert!((1500..=1800).contains(&feed.ready.len()), "got {}", feed.ready.len());
    }

    #[test]
    fn segment_times_are_centiseconds() {
        let line = segment(1.234, 2.5, "hi".into());
        assert_eq!((line.start, line.stop), (123, 250));
    }
}
