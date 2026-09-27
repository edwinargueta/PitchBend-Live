// Types for signalsmith-stretch 1.3.2, which ships JS only (verified against
// node_modules/signalsmith-stretch/SignalsmithStretch.mjs, not the README alone).
//
// How the package loads (no static assets needed):
//  - The WASM binary is inlined in the JS as a base64 data URI.
//  - On first use per AudioContext, the factory builds the AudioWorklet module
//    source from its own functions, wraps it in a Blob URL and calls
//    audioWorklet.addModule(). Setting `moduleUrl` overrides that URL.
//  - The node's methods are proxied to the processor over its MessagePort; each
//    returns a Promise for the processor's reply.
declare module "signalsmith-stretch" {
  /**
   * One entry in the processor's time map. `output` is AudioContext time; the
   * node compensates for its own latency so the output at time t is the input
   * at `input + (t - output) * rate`. Unset fields inherit from the previous
   * entry. Scheduling drops every entry at or after the processor's current time.
   */
  export interface StretchSegment {
    output?: number;
    active?: boolean;
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchConfig {
    blockMs?: number | null;
    intervalMs?: number;
    splitComputation?: boolean;
    preset?: "default" | "cheaper";
  }

  export interface StretchNode extends AudioWorkletNode {
    /** Last input position reported by the processor (seconds). */
    inputTime: number;
    schedule(
      segment: StretchSegment,
      adjustPrevious?: boolean,
    ): Promise<StretchSegment>;
    start(
      when?: number,
      offset?: number,
      duration?: number,
      rate?: number,
      semitones?: number,
    ): Promise<StretchSegment>;
    stop(when?: number): Promise<StretchSegment>;
    /** One typed array per channel, equal lengths. An extra trailing argument is the transfer list. */
    addBuffers(
      buffers: Float32Array[],
      transfer?: Transferable[],
    ): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    /** Input + output latency in seconds. */
    latency(): Promise<number>;
    configure(config: StretchConfig): Promise<void>;
    setUpdateInterval(
      seconds: number,
      callback?: (inputTime: number) => void,
    ): Promise<void>;
  }

  export interface StretchFactory {
    (
      audioContext: BaseAudioContext,
      options?: AudioWorkletNodeOptions,
    ): Promise<StretchNode>;
    moduleUrl?: string;
  }

  const SignalsmithStretch: StretchFactory;
  export default SignalsmithStretch;
}
