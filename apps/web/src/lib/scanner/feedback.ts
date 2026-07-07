/**
 * Door-staff feedback: distinct beep + vibration per verdict so the result
 * is unambiguous without looking at the screen. WebAudio (no assets — the
 * scanner must work fully offline) and navigator.vibrate where available.
 */

let ctx: AudioContext | null = null;

function tone(freq: number, startMs: number, durMs: number, type: OscillatorType = "square"): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = 0.12;
  osc.connect(gain).connect(ctx.destination);
  const t0 = ctx.currentTime + startMs / 1000;
  const t1 = t0 + durMs / 1000;
  gain.gain.setValueAtTime(0.12, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t1);
  osc.start(t0);
  osc.stop(t1);
}

/** Must be called from a user gesture once (autoplay policy). */
export function armAudio(): void {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
}

export function feedbackSuccess(): void {
  tone(1320, 0, 90);
  tone(1760, 100, 140);
  navigator.vibrate?.(60);
}

export function feedbackDuplicate(): void {
  tone(880, 0, 110);
  tone(880, 160, 110);
  navigator.vibrate?.([80, 60, 80]);
}

export function feedbackInvalid(): void {
  tone(196, 0, 420, "sawtooth");
  navigator.vibrate?.([200, 80, 200]);
}
