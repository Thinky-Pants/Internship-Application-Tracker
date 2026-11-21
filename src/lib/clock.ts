/** Injectable clock so scheduling/dispatch logic is testable with simulated time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now() {
    return new Date(this.t);
  }
  set(d: Date | string) {
    this.t = new Date(d).getTime();
  }
  advance(ms: number) {
    this.t += ms;
    return this.now();
  }
  advanceMinutes(m: number) {
    return this.advance(m * 60_000);
  }
}

/** Clock offset by a fixed amount (used by demo "simulated time"). */
export function offsetClock(offsetMs: number, base: Clock = systemClock): Clock {
  return { now: () => new Date(base.now().getTime() + offsetMs) };
}
