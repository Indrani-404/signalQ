export interface HospitalFacility {
  id: string;
  name: string;
  bengaliName: string;
  lat: number;
  lng: number;
  address: string;
  zoneId: number; // 0 to 5
  nearestNodeId: number; // Linked traffic signal intersection
  distanceToSignalMeters: number;
  emergencyGate: string;
  traumaLevel: 'Level 1 Trauma' | 'Level 2 Trauma' | 'Super Specialty' | 'Tertiary Care';
  hotline: string;
  availableBeds: number;
  icuAvailable: number;
  ambulanceBays: number;
  trafficGuard: string;
  specialties: string[];
}

export interface KolkataNode {
  id: number;
  name: string;
  bengaliName?: string;
  lat: number;
  lng: number;
  zoneId: number; // 0 to 5
  isHospital?: boolean;
  hospitalName?: string;
  isMajorJunction?: boolean;
  trafficGuard?: string;
  landmark?: string;
  isHospitalZone?: boolean; // Signal located in hospital silent/priority zone
  nearestHospitalId?: string; // Nearest hospital based on GPS coordinates
  distanceToHospitalKm?: number;
  signalName?: string; // Official Kolkata Traffic Police junction name
  signalCycleSec?: number;
}

export interface KolkataRoad {
  id: string;
  u: number;
  v: number;
  name: string;
  lanes: number;
  speedLimit: number; // km/h
  lengthKm: number;
  isFlyover?: boolean;
  trafficGuard?: string;
  path?: [number, number][]; // High-precision waypoints tracing authentic OSM road curves
}

export interface Vehicle {
  id: number;
  u: number;
  v: number;
  t: number; // progress 0 to 1
  speed: number;
  currentSpeed?: number;
  hold: boolean;
  type: 'taxi' | 'bus' | 'car' | 'auto';
  color: string;
  heading?: number; // radians
  isAmbulance?: boolean;
  dst?: number;
  pathIndex?: number;
  t0?: number;
}

export interface NodeState {
  ph: number; // current phase (0 or 1 for standard 2-phase, or up to 3)
  t: number; // time in current phase
  preemptedPhase: number | null; // emergency override
  manualPhase: number | null; // manual override
  queueNorthSouth: number;
  queueEastWest: number;
}

export interface TrafficZone {
  id: number;
  name: string;
  bengaliName: string;
  description: string;
  center: [number, number];
  bounds: [[number, number], [number, number]];
  stationName: string;
  diversion: boolean;
  extendGreens: boolean;
  lez: boolean; // Low emission zone
  purifiers: boolean; // Anti-smog water purifiers
  congestion: number; // 0.0 - 1.0
  aqi: number; // 0 - 500
}

export type RecPriority = 'critical' | 'high' | 'medium' | 'low';

export type RecAction =
  | {
      kind: 'zone';
      zoneId: number;
      patch: Partial<Pick<TrafficZone, 'diversion' | 'extendGreens' | 'lez' | 'purifiers'>>;
    }
  | { kind: 'adaptive' }
  | { kind: 'none' }; // advisory only, nothing to apply

export interface AIRecommendation {
  id: string; // stable per situation, so the list doesn't flicker between analysis runs
  zoneId: number; // -1 = citywide
  priority: RecPriority;
  title: string;
  reason: string;
  impact: string;
  actionLabel: string;
  action: RecAction;
}

export interface ZoneForecast {
  zoneId: number;
  name: string;
  congestionNow: number; // 0..1
  congestionPeak: number; // 0..1
  aqiNow: number;
  aqiPeak: number;
  trend: 'rising' | 'falling' | 'stable';
  confidence: number; // 0..100
}

export interface LogMessage {
  id: string;
  timestamp: string;
  text: string;
  type: 'info' | 'alert' | 'emergency' | 'ai' | 'action';
}

export interface CorridorSignal {
  id: number;
  name: string;
  // cleared = preempted green for the ambulance, locked = operator-held red, normal = not yet reached
  state: 'cleared' | 'locked' | 'normal';
  distanceKm: number;
}

export interface AmbulanceTelemetry {
  routeNodes: number[];
  pathIndex: number;
  progress: number; // 0..1
  remainingKm: number;
  etaSec: number; // seconds of simulation the viewer will wait
  etaRealMin: number; // same trip expressed in real-world minutes
  elapsedSec: number;
  speedKmh: number;
  nextNodeId: number;
  nextNodeName: string;
  nextSignalLabel: 'GREEN (PREEMPTED)' | 'GREEN' | 'RED';
  nextDistanceM: number;
  reroutes: number;
  signalsCleared: number;
  lastReroute: { reason: string; at: number } | null;
  corridor: CorridorSignal[];
}
