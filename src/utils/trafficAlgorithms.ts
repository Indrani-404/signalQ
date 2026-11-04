import { KolkataNode, KolkataRoad, HospitalFacility } from '../types/traffic';

export interface DijkstraResult {
  path: number[];
  cost: number;
}

export function buildAdjacencyList(nodes: KolkataNode[], roads: KolkataRoad[]): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  nodes.forEach((n) => adj.set(n.id, []));

  roads.forEach((r) => {
    const listU = adj.get(r.u) || [];
    if (!listU.includes(r.v)) listU.push(r.v);
    adj.set(r.u, listU);

    const listV = adj.get(r.v) || [];
    if (!listV.includes(r.u)) listV.push(r.u);
    adj.set(r.v, listV);
  });

  return adj;
}

export function getRoadKey(u: number, v: number): string {
  return u < v ? `${u}-${v}` : `${v}-${u}`;
}

export function findRoad(roads: KolkataRoad[], u: number, v: number): KolkataRoad | undefined {
  const key = getRoadKey(u, v);
  return roads.find((r) => getRoadKey(r.u, r.v) === key);
}

export function dijkstra(
  start: number,
  dest: number,
  nodes: KolkataNode[],
  roads: KolkataRoad[],
  roadLoads: Map<string, number>,
  blockedRoads: Set<string>
): DijkstraResult {
  const n = nodes.length;
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const unvisited = new Set<number>(nodes.map((node) => node.id));

  dist[start] = 0;
  const adj = buildAdjacencyList(nodes, roads);

  while (unvisited.size > 0) {
    let u = -1;
    let minDist = Infinity;
    for (const v of unvisited) {
      if (dist[v] < minDist) {
        minDist = dist[v];
        u = v;
      }
    }

    if (u === -1 || u === dest || minDist === Infinity) break;
    unvisited.delete(u);

    const neighbors = adj.get(u) || [];
    for (const v of neighbors) {
      if (!unvisited.has(v)) continue;

      const rKey = getRoadKey(u, v);
      const road = findRoad(roads, u, v);
      const baseKm = road ? road.lengthKm : 1.5;
      const load = roadLoads.get(rKey) || 0;
      const isBlocked = blockedRoads.has(rKey);

      // Weight combines road length, traffic density, and blockage
      const weight = isBlocked ? 10000 : baseKm * (1 + 0.35 * load);
      const alt = dist[u] + weight;

      if (alt < dist[v]) {
        dist[v] = alt;
        prev[v] = u;
      }
    }
  }

  const path: number[] = [];
  let curr = dest;
  while (curr !== -1) {
    path.unshift(curr);
    curr = prev[curr];
  }

  // If destination unreachable or not connected
  if (path.length <= 1 && start !== dest) {
    return { path: [start, dest], cost: 999 };
  }

  return { path, cost: dist[dest] };
}

// Holt damped-trend time series forecasting (identical to traffic research standard)
export interface HoltForecast {
  forecast: number[];
  mae: number;
  trendSlope: number;
}

export function holtDampedTrend(series: number[], horizon = 10): HoltForecast {
  if (series.length < 4) {
    const last = series[series.length - 1] ?? 0;
    return { forecast: Array(horizon).fill(last), mae: 0, trendSlope: 0 };
  }

  const phi = 0.9;
  let level = series[0];
  let trend = series[1] - series[0];
  let errorAccum = 0;

  for (let i = 1; i < series.length; i++) {
    const pred = level + phi * trend;
    errorAccum += Math.abs(series[i] - pred);
    const newLevel = 0.5 * series[i] + 0.5 * pred;
    trend = 0.3 * (newLevel - level) + 0.7 * phi * trend;
    level = newLevel;
  }

  const forecast: number[] = [];
  let cum = 0;
  let power = 1;
  for (let k = 1; k <= horizon; k++) {
    power *= phi;
    cum += power;
    forecast.push(Math.max(0, level + trend * cum));
  }

  return {
    forecast,
    mae: errorAccum / (series.length - 1),
    trendSlope: trend,
  };
}

// 8-lane conflict graph for a junction micro-simulation (Kolkata drives on the LEFT).
// Each approach has a Through lane and a Right-turn lane. In left-hand traffic the right
// turn is the movement that has to cross the oncoming stream.
export const LANE_NAMES = ['North-Through', 'North-Right', 'South-Through', 'South-Right', 'East-Through', 'East-Right', 'West-Through', 'West-Right'] as const;
export const LANE_SHORT = ['NT', 'NR', 'ST', 'SR', 'ET', 'ER', 'WT', 'WR'] as const;
export const LANE_APPROACH = [0, 0, 1, 1, 2, 2, 3, 3]; // 0=N, 1=S, 2=E, 3=W
export const LANE_MOVEMENT = [0, 1, 0, 1, 0, 1, 0, 1]; // 0=Through, 1=Right turn

export function lanesConflict(a: number, b: number): boolean {
  if (a === b) return false;
  const pa = LANE_APPROACH[a];
  const pb = LANE_APPROACH[b];
  if (pa === pb) return false; // same approach never conflicts
  if ((pa >> 1) === (pb >> 1)) return LANE_MOVEMENT[a] !== LANE_MOVEMENT[b]; // opposing: turn crosses oncoming through
  return true; // crossing approaches always conflict
}

// Build conflict edge set
export const CONFLICT_EDGES: [number, number][] = (() => {
  const edges: [number, number][] = [];
  for (let a = 0; a < 8; a++) {
    for (let b = a + 1; b < 8; b++) {
      if (lanesConflict(a, b)) edges.push([a, b]);
    }
  }
  return edges;
})();

// Greedy graph coloring: lanes that share a color can safely get green together.
// The visiting order puts both through lanes first, which yields the classic 4-phase plan:
// P1 NT+ST, P2 NR+SR, P3 ET+WT, P4 ER+WR.
export const LANE_PHASES: number[] = (() => {
  const order = [0, 2, 1, 3, 4, 6, 5, 7];
  const colors = Array(8).fill(-1);
  for (const v of order) {
    const used = new Set<number>();
    for (let u = 0; u < 8; u++) {
      if (colors[u] >= 0 && lanesConflict(u, v)) used.add(colors[u]);
    }
    let k = 0;
    while (used.has(k)) k++;
    colors[v] = k;
  }
  return colors;
})();

export const NUM_PHASES = Math.max(...LANE_PHASES) + 1;

/** Which map-signal axis a lane phase belongs to: 0 = North/South green, 1 = East/West green. */
export function phaseAxis(phase: number): number {
  const lane = LANE_PHASES.findIndex((p) => p === phase);
  return lane >= 0 && LANE_APPROACH[lane] < 2 ? 0 : 1;
}

export const PHASE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];

export function getAqiColor(aqi: number): string {
  if (aqi <= 50) return '#22c55e'; // Good
  if (aqi <= 100) return '#eab308'; // Moderate
  if (aqi <= 150) return '#f97316'; // Unhealthy sensitive
  if (aqi <= 200) return '#ef4444'; // Unhealthy
  if (aqi <= 300) return '#a855f7'; // Very unhealthy
  return '#881337'; // Hazardous
}

export function getAqiCategory(aqi: number): string {
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Poor (Sensitive)';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very Unhealthy';
  return 'Severe / Hazardous';
}

export interface PositionAndHeading {
  lat: number;
  lng: number;
  heading: number; // in radians
}

interface CachedGeometry {
  pts: [number, number][];
  cumDist: number[];
  totalDist: number;
}

const GEOMETRY_CACHE = new Map<string, { forward: CachedGeometry; reverse: CachedGeometry }>();

export function clearGeometryCache() {
  GEOMETRY_CACHE.clear();
}

export function getCachedRoadGeometry(u: number, v: number, roads: KolkataRoad[], nodes: KolkataNode[]): CachedGeometry {
  const rKey = getRoadKey(u, v);
  let entry = GEOMETRY_CACHE.get(rKey);
  if (!entry) {
    const road = findRoad(roads, u, v);
    const uNode = nodes.find((n) => n.id === (road ? road.u : u));
    const vNode = nodes.find((n) => n.id === (road ? road.v : v));
    let basePts: [number, number][];

    if (road && road.path && road.path.length >= 2) {
      basePts = road.path.map((p) => [p[0], p[1]] as [number, number]);
      // Ensure basePts is oriented from road.u to road.v
      if (uNode && vNode) {
        const dFirstU = Math.hypot(basePts[0][0] - uNode.lat, basePts[0][1] - uNode.lng);
        const dLastU = Math.hypot(basePts[basePts.length - 1][0] - uNode.lat, basePts[basePts.length - 1][1] - uNode.lng);
        if (dLastU < dFirstU) {
          basePts.reverse();
        }
        // Snap endpoints exactly to junction node coordinates
        basePts[0] = [uNode.lat, uNode.lng];
        basePts[basePts.length - 1] = [vNode.lat, vNode.lng];
      }
    } else if (uNode && vNode) {
      basePts = [
        [uNode.lat, uNode.lng],
        [vNode.lat, vNode.lng],
      ];
    } else {
      basePts = [
        [22.56, 88.36],
        [22.56, 88.36],
      ];
    }

    const computeCum = (pts: [number, number][]): CachedGeometry => {
      const cumDist: number[] = [0];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        total += d;
        cumDist.push(total);
      }
      return { pts, cumDist, totalDist: Math.max(0.00001, total) };
    };

    entry = {
      forward: computeCum(basePts),
      reverse: computeCum([...basePts].reverse()),
    };
    GEOMETRY_CACHE.set(rKey, entry);
  }

  const road = findRoad(roads, u, v);
  const forwardMatch = road ? road.u === u : u < v;
  return forwardMatch ? entry.forward : entry.reverse;
}

export function getVehicleCoordinateAndHeading(
  uId: number,
  vId: number,
  t: number,
  nodes: KolkataNode[],
  roads: KolkataRoad[]
): PositionAndHeading | null {
  const geom = getCachedRoadGeometry(uId, vId, roads, nodes);
  const { pts, cumDist, totalDist } = geom;

  const targetDist = Math.max(0, Math.min(1, t)) * totalDist;

  // Fast binary search to find segment index in O(log N) with zero array allocation
  let low = 0;
  let high = cumDist.length - 1;
  let segIdx = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cumDist[mid] <= targetDist) {
      segIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (segIdx >= pts.length - 1) {
    segIdx = Math.max(0, pts.length - 2);
  }

  const d0 = cumDist[segIdx];
  const d1 = cumDist[segIdx + 1] || totalDist;
  const segLen = Math.max(0.00001, d1 - d0);
  const segFraction = Math.max(0, Math.min(1, (targetDist - d0) / segLen));

  const p0 = pts[segIdx];
  const p1 = pts[segIdx + 1] || pts[segIdx];

  const dLat = p1[0] - p0[0];
  const dLng = p1[1] - p0[1];

  let rawLat = p0[0] + dLat * segFraction;
  let rawLng = p0[1] + dLng * segFraction;

  // Screen angle accounting for Mercator latitude scale
  const angle0 = Math.atan2(-dLat * 1.082, dLng);

  // Smooth steering curvature blending into upcoming waypoint
  let heading = angle0;
  if (segIdx < pts.length - 2) {
    const p2 = pts[segIdx + 2];
    const dLatNext = p2[0] - p1[0];
    const dLngNext = p2[1] - p1[1];
    const angle1 = Math.atan2(-dLatNext * 1.082, dLngNext);

    let diff = angle1 - angle0;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    // Blend gently across the final 35% of the current segment
    if (segFraction > 0.65) {
      const blend = (segFraction - 0.65) / 0.35;
      const smoothBlend = blend * blend * (3 - 2 * blend);
      heading = angle0 + diff * smoothBlend;
    }
  }

  // Left-Hand Traffic (LHT) rule: vehicles drive on the left side of the two-way road
  const len = Math.hypot(dLat, dLng) || 0.0001;
  const normLat = dLng / len;
  const normLng = -dLat / len;

  // Calibrated lane offset for subpixel alignment on OSM carriageway
  const road = findRoad(roads, uId, vId);
  const lanes = road?.lanes || 4;
  const laneOffset = lanes >= 6 ? 0.000045 : lanes >= 4 ? 0.000032 : 0.000022;
  rawLat += normLat * laneOffset;
  rawLng += normLng * laneOffset;

  return { lat: rawLat, lng: rawLng, heading };
}

export function buildCurvedRoutePolyline(
  route: number[],
  nodes: KolkataNode[],
  roads: KolkataRoad[]
): [number, number][] {
  if (route.length < 2) return [];
  const fullPath: [number, number][] = [];

  for (let i = 0; i < route.length - 1; i++) {
    const u = route[i];
    const v = route[i + 1];
    const road = findRoad(roads, u, v);
    const uNode = nodes.find((n) => n.id === u);
    const vNode = nodes.find((n) => n.id === v);
    if (!uNode || !vNode) continue;

    let pts: [number, number][];
    if (road && road.path && road.path.length >= 2) {
      const copy = road.path.map((p) => [p[0], p[1]] as [number, number]);
      // Geometric alignment check
      const dStartU = Math.hypot(copy[0][0] - uNode.lat, copy[0][1] - uNode.lng);
      const dEndU = Math.hypot(copy[copy.length - 1][0] - uNode.lat, copy[copy.length - 1][1] - uNode.lng);
      pts = dStartU <= dEndU ? copy : copy.reverse();
      // Snap to intersection nodes
      pts[0] = [uNode.lat, uNode.lng];
      pts[pts.length - 1] = [vNode.lat, vNode.lng];
    } else {
      pts = [
        [uNode.lat, uNode.lng],
        [vNode.lat, vNode.lng],
      ];
    }

    pts.forEach((pt, idx) => {
      if (i > 0 && idx === 0) return; // avoid duplicate point at junction
      fullPath.push(pt);
    });
  }

  return fullPath;
}

/**
 * Great-circle distance between two geographic coordinates in kilometers (Haversine formula).
 */
export function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(2));
}

/**
 * Finds the nearest hospital facility based on latitude and longitude coordinates.
 */
export function findNearestHospital(
  lat: number,
  lng: number,
  hospitals: HospitalFacility[]
): { hospital: HospitalFacility; distanceKm: number } | null {
  if (!hospitals || hospitals.length === 0) return null;
  let nearest = hospitals[0];
  let minDistance = calculateDistanceKm(lat, lng, nearest.lat, nearest.lng);

  for (let i = 1; i < hospitals.length; i++) {
    const d = calculateDistanceKm(lat, lng, hospitals[i].lat, hospitals[i].lng);
    if (d < minDistance) {
      minDistance = d;
      nearest = hospitals[i];
    }
  }

  return { hospital: nearest, distanceKm: minDistance };
}

/**
 * Finds the nearest traffic signal intersection node to any given coordinates.
 */
export function findNearestSignalNode(
  lat: number,
  lng: number,
  nodes: KolkataNode[]
): { node: KolkataNode; distanceKm: number } | null {
  if (!nodes || nodes.length === 0) return null;
  let nearest = nodes[0];
  let minDistance = calculateDistanceKm(lat, lng, nearest.lat, nearest.lng);

  for (let i = 1; i < nodes.length; i++) {
    const d = calculateDistanceKm(lat, lng, nodes[i].lat, nodes[i].lng);
    if (d < minDistance) {
      minDistance = d;
      nearest = nodes[i];
    }
  }

  return { node: nearest, distanceKm: minDistance };
}

/**
 * Which signal phase (0 = North/South green, 1 = East/West green) serves traffic
 * arriving at node v along road u -> v. Based on the bearing of the final segment.
 */
const APPROACH_PHASE_CACHE = new Map<string, number>();

export function getApproachPhase(u: number, v: number, roads: KolkataRoad[], nodes: KolkataNode[]): number {
  const key = `${u}>${v}`;
  const cached = APPROACH_PHASE_CACHE.get(key);
  if (cached !== undefined) return cached;

  const { pts } = getCachedRoadGeometry(u, v, roads, nodes);
  let dLat = 0;
  let dLng = 0;
  // Use the last non-degenerate segment (the actual approach to the stop line)
  for (let i = pts.length - 1; i > 0; i--) {
    dLat = pts[i][0] - pts[i - 1][0];
    dLng = pts[i][1] - pts[i - 1][1];
    if (Math.hypot(dLat, dLng) > 0.00002) break;
  }
  const phase = Math.abs(dLat) * 1.082 > Math.abs(dLng) ? 0 : 1;
  APPROACH_PHASE_CACHE.set(key, phase);
  return phase;
}

export function routeLengthKm(route: number[], roads: KolkataRoad[]): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += findRoad(roads, route[i], route[i + 1])?.lengthKm ?? 1.5;
  }
  return total;
}

/** Travel-cost of a specific route using the same weights the router uses. */
export function routeCost(route: number[], roads: KolkataRoad[], roadLoads: Map<string, number>): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const road = findRoad(roads, route[i], route[i + 1]);
    const load = roadLoads.get(getRoadKey(route[i], route[i + 1])) || 0;
    total += (road?.lengthKm ?? 1.5) * (1 + 0.35 * load);
  }
  return total;
}

export interface EmergencyRouteResult {
  path: number[];
  cost: number;
  found: boolean;
}

/**
 * Emergency routing: blocked roads are hard-excluded (never "expensive but allowed"),
 * and an optional edgeAllowed callback can veto movements (e.g. into a locked signal).
 */
export function findEmergencyRoute(
  start: number,
  dest: number,
  nodes: KolkataNode[],
  roads: KolkataRoad[],
  roadLoads: Map<string, number>,
  blockedRoads: Set<string>,
  edgeAllowed?: (from: number, to: number) => boolean
): EmergencyRouteResult {
  if (start === dest) return { path: [start], cost: 0, found: true };

  const adj = buildAdjacencyList(nodes, roads);
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const open = new Set<number>(nodes.map((n) => n.id));
  nodes.forEach((n) => dist.set(n.id, Infinity));
  dist.set(start, 0);

  while (open.size > 0) {
    let u = -1;
    let best = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < best) {
        best = d;
        u = id;
      }
    }
    if (u === -1 || best === Infinity || u === dest) break;
    open.delete(u);

    for (const v of adj.get(u) || []) {
      if (!open.has(v)) continue;
      const rKey = getRoadKey(u, v);
      if (blockedRoads.has(rKey)) continue;
      if (edgeAllowed && !edgeAllowed(u, v)) continue;
      const road = findRoad(roads, u, v);
      const load = roadLoads.get(rKey) || 0;
      const alt = best + (road?.lengthKm ?? 1.5) * (1 + 0.35 * load);
      if (alt < dist.get(v)!) {
        dist.set(v, alt);
        prev.set(v, u);
      }
    }
  }

  if (!prev.has(dest)) return { path: [start, dest], cost: Infinity, found: false };

  const path: number[] = [];
  let cur: number | undefined = dest;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return { path, cost: dist.get(dest)!, found: path[0] === start };
}
