// Browser mic capture → base64 pcm16 chunks (~100 ms) for voice:audio:chunk.
// getUserMedia → AudioWorklet (or ScriptProcessor fallback) → ~100 ms frames at
// the AudioContext's native rate → floatTo16BitPCM → base64 → onChunk(b64, rate).
//
// No client-side resampling: a linear resampler is not band-limited and aliases
// high-frequency noise into the speech band, which hurts recognition badly. The
// server band-limits properly when it needs 16 kHz.

import type { MicController, MicOptions, MicDeviceChange } from '../voiceTypes';
import { VOICE_SAMPLE_RATE } from '../voiceConstants';
import { floatTo16BitPCM, int16ToBase64 } from './pcm';
import { MicUnsupportedError } from './micError';

// Inline AudioWorklet processor: forwards each render quantum's mono samples to
// the main thread. Loaded via a Blob URL so we ship no separate asset.
const WORKLET_SOURCE = `
class SnagletCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // Copy — the render buffer is reused after process() returns.
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('snaglet-capture-processor', SnagletCaptureProcessor);
`;

export class MicCapture implements MicController {
  private readonly onChunk: (b64: string, sampleRate: number) => void;
  private readonly onWarning?: (err: unknown) => void;
  private readonly onDeviceLabel?: (label: string) => void;
  private readonly onDeviceChange?: (info: MicDeviceChange) => void;

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private residual: Float32Array = new Float32Array(0);
  /** Capture AudioContext's native rate (set on start; sent on every chunk). */
  private captureRate = VOICE_SAMPLE_RATE;
  /** ~100 ms frame size at the native rate (set on start from `captureRate`). */
  private chunkSamples = Math.round(VOICE_SAMPLE_RATE * 0.1);
  private running = false;
  /** The live capture track (kept so we can detect it ending / its device going). */
  private track: MediaStreamTrack | null = null;
  /** deviceId the live track is bound to (to notice it disappearing). */
  private activeDeviceId: string | null = null;
  /** deviceId of the current default audio input (to notice a silent OS switch). */
  private defaultInputId: string | null = null;
  private devicechangeListener: (() => void) | null = null;

  constructor(opts: MicOptions) {
    this.onChunk = opts.onChunk;
    this.onWarning = opts.onWarning;
    this.onDeviceLabel = opts.onDeviceLabel;
    this.onDeviceChange = opts.onDeviceChange;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.residual = new Float32Array(0);
    try {
      // Absent outside a secure context (or in a webview without media
      // capture); calling it would throw an opaque TypeError.
      if (!navigator.mediaDevices?.getUserMedia) throw new MicUnsupportedError();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      if (!this.running) {
        // Stopped while getUserMedia was in flight.
        this.releaseStream();
        return;
      }
      // Surface which input device we got and watch for it changing (a yanked
      // device fires the track's 'ended'; a silent OS default switch, such as
      // macOS Continuity to an iPhone, only fires 'devicechange').
      this.watchDevice();
      // Some webviews type AudioContext behind a webkit prefix. Capture at the
      // context's native rate (no forced 16 kHz); the server band-limits.
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      // Chrome may create an AudioContext in the suspended state even after
      // getUserMedia succeeds (notably when capture starts after the async
      // voice-session handshake). A suspended graph looks healthy — the track
      // is live and startup resolves — but neither AudioWorklet nor
      // ScriptProcessor ever receives samples. Explicitly resume before we
      // report the microphone ready; a rejected resume is a real startup
      // failure and is surfaced by useVoiceSession instead of silently leaving
      // both Dictation and Voice mode listening to nothing.
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (!this.running) {
        this.stop();
        return;
      }
      this.captureRate = this.ctx.sampleRate;
      this.chunkSamples = Math.max(1, Math.round(this.captureRate * 0.1)); // ~100 ms
      console.info(`[voice] mic capture at native sampleRate=${this.captureRate}`);
      this.source = this.ctx.createMediaStreamSource(this.stream);

      const useWorklet = typeof this.ctx.audioWorklet?.addModule === 'function';
      if (useWorklet) {
        await this.startWorklet();
      } else {
        this.startScriptProcessor();
      }
    } catch (err) {
      this.stop();
      // Fatal startup failures are the Promise contract. The caller owns
      // visible recovery and session teardown; swallowing here would let the
      // UI claim it was listening after a permission/device failure.
      throw err;
    }
  }

  private async startWorklet(): Promise<void> {
    if (!this.ctx || !this.source) return;
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
      if (!this.running || !this.ctx || !this.source) return;
      this.worklet = new AudioWorkletNode(this.ctx, 'snaglet-capture-processor');
      this.worklet.port.onmessage = (e: MessageEvent) => {
        this.accumulate(e.data as Float32Array);
      };
      this.source.connect(this.worklet);
      // A worklet needs a graph terminus to pull audio; a muted gain avoids
      // echoing the mic back to the speakers.
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.worklet.connect(sink);
      sink.connect(this.ctx.destination);
    } catch (err) {
      // AudioWorklet unavailable/blocked — fall back.
      // Worklet failure is recoverable: surface the degradation, then keep the
      // same microphone stream alive through ScriptProcessor.
      this.onWarning?.(err);
      if (this.running) this.startScriptProcessor();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private startScriptProcessor(): void {
    if (!this.ctx || !this.source) return;
    // 4096-frame buffer ≈ 85 ms at 48 kHz — a reasonable capture granularity.
    const node = this.ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      this.accumulate(input);
    };
    this.source.connect(node);
    // ScriptProcessor only fires while connected to the destination.
    node.connect(this.ctx.destination);
    this.processor = node;
  }

  /**
   * Record the live input device, log it once, report its label upward, and
   * subscribe to the two ways it can change out from under us: the track ending
   * (device unplugged) and a `devicechange` (the OS default input switching).
   */
  private watchDevice(): void {
    const track = this.stream?.getAudioTracks()[0] ?? null;
    this.track = track;
    if (track) {
      const label = track.label || 'unknown device';
      this.activeDeviceId = track.getSettings().deviceId ?? null;
      // Log once per capture so a wrong/unexpected device is diagnosable.
      console.info(`[voice] mic input device: ${label}`);
      this.onDeviceLabel?.(label);
      track.addEventListener('ended', this.handleTrackEnded);
    }
    const md = navigator.mediaDevices;
    if (md?.addEventListener) {
      this.devicechangeListener = () => {
        void this.handleDeviceChange();
      };
      md.addEventListener('devicechange', this.devicechangeListener);
      // Seed the current default so the first real change is detectable.
      void this.readDefaultInputId().then((id) => {
        this.defaultInputId = id;
      });
    }
  }

  /** deviceId of the current default audio input (heuristic: the 'default' entry,
   *  else the first input), or null when it can't be determined. */
  private async readDefaultInputId(): Promise<string | null> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const def = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
      return def?.deviceId ?? null;
    } catch {
      return null;
    }
  }

  /** The live capture track ended (device unplugged / revoked). */
  private handleTrackEnded = (): void => {
    if (!this.running) return; // our own stop() — not an involuntary end
    this.onDeviceChange?.({ reason: 'track-ended', label: this.track?.label || 'unknown device' });
  };

  /**
   * The set of media devices changed. Fire a notice only when it affects us: the
   * device our track is bound to disappeared, or the default input switched (a
   * silent Continuity-style handoff the live track doesn't follow). We do not
   * auto-switch devices here — a rebuild (if any) is the hook's call and lands on
   * whatever getUserMedia's default then yields.
   */
  private async handleDeviceChange(): Promise<void> {
    if (!this.running) return;
    let inputs: MediaDeviceInfo[];
    try {
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audioinput'
      );
    } catch {
      return;
    }
    if (!this.running) return;
    const track = this.stream?.getAudioTracks()[0];
    const activeId = track?.getSettings().deviceId ?? this.activeDeviceId;
    const activePresent = activeId ? inputs.some((d) => d.deviceId === activeId) : true;
    const def = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
    const defId = def?.deviceId ?? null;
    const defaultChanged = this.defaultInputId !== null && defId !== this.defaultInputId;
    this.defaultInputId = defId;
    if (!activePresent || defaultChanged) {
      const label = def?.label || track?.label || 'unknown device';
      this.onDeviceChange?.({ reason: 'devicechange', label });
    }
  }

  /** Accumulate native-rate blocks and emit full ~100 ms chunks (no resampling). */
  private accumulate(block: Float32Array): void {
    if (!this.running || !this.ctx) return;
    const combined = new Float32Array(this.residual.length + block.length);
    combined.set(this.residual, 0);
    combined.set(block, this.residual.length);

    let offset = 0;
    while (combined.length - offset >= this.chunkSamples) {
      const frame = combined.subarray(offset, offset + this.chunkSamples);
      this.onChunk(int16ToBase64(floatTo16BitPCM(frame)), this.captureRate);
      offset += this.chunkSamples;
    }
    this.residual = combined.slice(offset);
  }

  stop(): void {
    this.running = false;
    if (this.track) {
      this.track.removeEventListener('ended', this.handleTrackEnded);
      this.track = null;
    }
    if (this.devicechangeListener && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.devicechangeListener);
      this.devicechangeListener = null;
    }
    this.activeDeviceId = null;
    this.defaultInputId = null;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch((err: unknown) => {
        console.error('MicCapture: failed to close AudioContext', err);
      });
      this.ctx = null;
    }
    this.releaseStream();
    this.residual = new Float32Array(0);
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}
