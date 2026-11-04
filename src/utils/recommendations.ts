import { AIRecommendation, RecPriority, TrafficZone, ZoneForecast } from '../types/traffic';
import { getAqiCategory, holtDampedTrend } from './trafficAlgorithms';

export interface AnalysisInput {
  zones: TrafficZone[];
  congestionHistory: number[][]; // [zoneId][samples], 0..1
  aqiHistory: number[][]; // [zoneId][samples], raw AQI
  blockedRoadCount: number;
  ambulanceActive: boolean;
  isAdaptive: boolean;
  isRushHour: boolean;
}

export interface AnalysisResult {
  recommendations: AIRecommendation[];
  forecasts: ZoneForecast[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const PRIORITY_RANK: Record<RecPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function forecastZone(z: TrafficZone, cHist: number[], aHist: number[]): ZoneForecast {
  const cF = holtDampedTrend(cHist, 10);
  const aF = holtDampedTrend(
    aHist.map((v) => v / 300),
    10
  );

  const congestionPeak = clamp01(Math.max(z.congestion, ...cF.forecast));
  const aqiPeak = Math.round(Math.max(z.aqi, ...aF.forecast.map((v) => v * 300)));

  const avg = cHist.reduce((a, b) => a + b, 0) / Math.max(1, cHist.length);
  const confidence = Math.max(10, Math.min(98, Math.round(100 * (1 - cF.mae / (avg + 0.1)))));

  const trend: ZoneForecast['trend'] =
    cF.trendSlope > 0.004 ? 'rising' : cF.trendSlope < -0.004 ? 'falling' : 'stable';

  return {
    zoneId: z.id,
    name: z.name,
    congestionNow: z.congestion,
    congestionPeak,
    aqiNow: z.aqi,
    aqiPeak,
    trend,
    confidence,
  };
}

/**
 * Turns the Holt forecasts plus current network state into a short, ranked list of actions.
 * Pure function: it only reads its input, so it can never act on stale state.
 */
export function generateRecommendations(input: AnalysisInput): AnalysisResult {
  const { zones, congestionHistory, aqiHistory } = input;
  const recs: AIRecommendation[] = [];

  const forecasts = zones.map((z) => forecastZone(z, congestionHistory[z.id] || [], aqiHistory[z.id] || []));

  forecasts.forEach((f) => {
    const z = zones[f.zoneId];
    if (!z) return;

    // 1. Congestion surge -> diversion + longer greens
    const surge = f.congestionPeak >= 0.6 || (f.congestionPeak >= 0.5 && f.trend === 'rising');
    if (surge && !(z.diversion && z.extendGreens)) {
      const priority: RecPriority =
        f.congestionPeak >= 0.8 ? 'critical' : f.congestionPeak >= 0.65 ? 'high' : 'medium';
      recs.push({
        id: `cong-${z.id}`,
        zoneId: z.id,
        priority,
        title: `Ease congestion in ${z.name}`,
        reason: `Congestion is ${pct(f.congestionNow)} now and forecast to reach ${pct(f.congestionPeak)} (${f.trend}).`,
        impact: 'Diverts through-traffic around the zone and lengthens green phases to drain queues.',
        actionLabel: 'Divert + extend greens',
        action: { kind: 'zone', zoneId: z.id, patch: { diversion: true, extendGreens: true } },
      });
    }

    // 2. Air quality -> low-emission zone + mist cannons
    const smog = f.aqiPeak >= 170 || (f.aqiPeak >= 150 && f.trend === 'rising');
    if (smog && !(z.lez && z.purifiers)) {
      const priority: RecPriority = f.aqiPeak >= 300 ? 'critical' : f.aqiPeak >= 200 ? 'high' : 'medium';
      recs.push({
        id: `aqi-${z.id}`,
        zoneId: z.id,
        priority,
        title: `Cut emissions in ${z.name}`,
        reason: `AQI is ${f.aqiNow} now and forecast to reach ${f.aqiPeak} (${getAqiCategory(f.aqiPeak)}).`,
        impact: 'Restricts high-emission vehicles and switches on smog mist cannons.',
        actionLabel: 'Enforce LEZ + mist',
        action: { kind: 'zone', zoneId: z.id, patch: { lez: true, purifiers: true } },
      });
    }

    // 3. Recovery -> release interventions that are no longer needed
    if ((z.diversion || z.extendGreens) && f.congestionNow < 0.3 && f.congestionPeak < 0.38) {
      recs.push({
        id: `rel-${z.id}`,
        zoneId: z.id,
        priority: 'low',
        title: `Release diversion in ${z.name}`,
        reason: `Traffic is back to ${pct(f.congestionNow)} and forecast to stay low.`,
        impact: 'Restores normal routing and signal timing.',
        actionLabel: 'Release',
        action: { kind: 'zone', zoneId: z.id, patch: { diversion: false, extendGreens: false } },
      });
    }
    if ((z.lez || z.purifiers) && f.aqiNow < 100 && f.aqiPeak < 115) {
      recs.push({
        id: `rel-air-${z.id}`,
        zoneId: z.id,
        priority: 'low',
        title: `Relax emission limits in ${z.name}`,
        reason: `AQI is ${f.aqiNow} and forecast to stay under ${Math.max(f.aqiPeak, 100)}.`,
        impact: 'Lifts the low-emission zone and turns mist cannons off.',
        actionLabel: 'Relax',
        action: { kind: 'zone', zoneId: z.id, patch: { lez: false, purifiers: false } },
      });
    }
  });

  // 4. Citywide: signals in fixed-time mode while the network is busy
  const avgCong = zones.reduce((a, z) => a + z.congestion, 0) / Math.max(1, zones.length);
  if (!input.isAdaptive && (avgCong >= 0.4 || input.isRushHour)) {
    recs.push({
      id: 'adaptive',
      zoneId: -1,
      priority: avgCong >= 0.55 ? 'high' : 'medium',
      title: 'Switch signals to Adaptive AI',
      reason: `Signals are on fixed timing while average congestion is ${pct(avgCong)}.`,
      impact: 'Adaptive timing shifts green time toward the busiest approaches.',
      actionLabel: 'Go adaptive',
      action: { kind: 'adaptive' },
    });
  }

  // 5. Citywide: rush hour -> pre-extend greens in the busiest zone
  if (input.isRushHour) {
    const busiest = [...zones].sort((a, b) => b.congestion - a.congestion).find((z) => !z.extendGreens);
    if (busiest) {
      recs.push({
        id: `rush-${busiest.id}`,
        zoneId: busiest.id,
        priority: 'medium',
        title: `Pre-extend greens in ${busiest.name}`,
        reason: `Rush hour is active and this is the busiest zone (${pct(busiest.congestion)}).`,
        impact: 'Longer greens now keep queues from building before the peak.',
        actionLabel: 'Extend greens',
        action: { kind: 'zone', zoneId: busiest.id, patch: { extendGreens: true } },
      });
    }
  }

  // 6. Advisories (no button)
  if (input.blockedRoadCount > 0) {
    recs.push({
      id: 'blocked',
      zoneId: -1,
      priority: 'medium',
      title: `${input.blockedRoadCount} road${input.blockedRoadCount > 1 ? 's' : ''} blocked`,
      reason: 'Vehicles are rerouting onto side streets, which raises load nearby.',
      impact: 'Send a response team; the ambulance router already avoids blocked roads.',
      actionLabel: '',
      action: { kind: 'none' },
    });
  }
  if (input.ambulanceActive) {
    recs.push({
      id: 'ambulance',
      zoneId: -1,
      priority: 'low',
      title: 'Ambulance en route',
      reason: 'A green corridor is active.',
      impact: 'Avoid manual signal holds on its path; they can force a reroute.',
      actionLabel: '',
      action: { kind: 'none' },
    });
  }

  // 7. Always say something useful
  if (recs.length === 0) {
    const watch = [...forecasts].sort((a, b) => b.congestionPeak - a.congestionPeak)[0];
    if (watch) {
      recs.push({
        id: 'all-clear',
        zoneId: -1,
        priority: 'low',
        title: 'Network is stable',
        reason: `No action needed. Watching ${watch.name}: ${pct(watch.congestionNow)} now, ${pct(watch.congestionPeak)} forecast.`,
        impact: 'The advisor re-checks every few seconds.',
        actionLabel: '',
        action: { kind: 'none' },
      });
    }
  }

  recs.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  return { recommendations: recs.slice(0, 6), forecasts };
}
