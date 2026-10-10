/** Web Audio tones. The context is created inside the Activate tap, which browsers require. */

interface AudioWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

export function createAudioContext(): AudioContext | null {
  const w = window as unknown as AudioWindow;
  const Context = w.AudioContext ?? w.webkitAudioContext;
  return Context ? new Context() : null;
}

export const TEST_TONE = { frequency: 880, seconds: 0.3 } as const;
/** The EVM "vote recorded" beep: one continuous tone of about two seconds. */
export const VOTE_BEEP = { frequency: 1000, seconds: 2 } as const;

const FADE_SECONDS = 0.05;

/** A sine tone with a short fade in and out so it starts and ends without clicks. */
export async function playTone(
  context: AudioContext,
  tone: { frequency: number; seconds: number },
): Promise<void> {
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime;
  const end = start + tone.seconds;
  oscillator.type = "sine";
  oscillator.frequency.value = tone.frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.4, start + FADE_SECONDS);
  gain.gain.setValueAtTime(0.4, end - FADE_SECONDS);
  gain.gain.linearRampToValueAtTime(0, end);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(end);
}
