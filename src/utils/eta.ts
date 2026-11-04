// Ambulance ETA helpers.
//
// Simulation units: a vehicle with `speed` s covers s * KM_PER_SPEED_UNIT km per
// (simulation) second. The ambulance cruises at AMBULANCE_CRUISE and is displayed
// as AMBULANCE_CRUISE_KMH in the real world.

export const KM_PER_SPEED_UNIT = 0.22;
export const AMBULANCE_CRUISE = 1.85;
export const AMBULANCE_CRUISE_KMH = 80;

/** Exponential moving average so the ETA doesn't jump every time the ambulance slows for a car. */
export function smoothSpeed(prevAvg: number, sample: number, alpha = 0.15): number {
  if (!prevAvg || prevAvg <= 0) return sample;
  return prevAvg * (1 - alpha) + sample * alpha;
}

/** Seconds (wall-clock, as the viewer experiences them) until arrival. */
export function etaSeconds(remainingKm: number, avgSpeed: number, simSpeed: number): number {
  const effective = Math.max(avgSpeed, AMBULANCE_CRUISE * 0.55); // never assume a standstill
  return remainingKm / (effective * KM_PER_SPEED_UNIT * Math.max(simSpeed, 0.1));
}

/** Real-world minutes for the same remaining distance. */
export function etaRealMinutes(remainingKm: number, avgSpeed: number): number {
  const effective = Math.max(avgSpeed, AMBULANCE_CRUISE * 0.55);
  const kmh = Math.max(15, (effective / AMBULANCE_CRUISE) * AMBULANCE_CRUISE_KMH);
  return (remainingKm / kmh) * 60;
}

export function speedToKmh(speed: number): number {
  return Math.round((speed / AMBULANCE_CRUISE) * AMBULANCE_CRUISE_KMH);
}

/** 83 -> "1:23" */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 4.4 -> "4 min", 0.4 -> "<1 min" */
export function formatMinutes(min: number): string {
  if (min < 1) return '<1 min';
  return `${Math.round(min)} min`;
}
