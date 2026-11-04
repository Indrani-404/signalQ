/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  KolkataNode,
  KolkataRoad,
  Vehicle,
  TrafficZone,
  AIRecommendation,
  ZoneForecast,
  LogMessage,
  AmbulanceTelemetry,
} from './types/traffic';
import {
  KOLKATA_NODES,
  KOLKATA_ROADS,
  KOLKATA_ZONES,
  KOLKATA_HOSPITALS,
} from './data/kolkataData';
import {
  dijkstra,
  getRoadKey,
  findRoad,
  buildAdjacencyList,
  holtDampedTrend,
  getAqiColor,
  getAqiCategory,
  findEmergencyRoute,
  getApproachPhase,
  routeLengthKm,
  routeCost,
} from './utils/trafficAlgorithms';
import { generateRecommendations } from './utils/recommendations';
import {
  AMBULANCE_CRUISE,
  etaRealMinutes,
  etaSeconds,
  formatClock,
  formatMinutes,
  smoothSpeed,
  speedToKmh,
} from './utils/eta';
import {
  KolkataMap,
  KolkataMapHandle,
  MapLayersState,
  TileProvider,
} from './components/KolkataMap';
import { LaneConflictView } from './components/LaneConflictView';
import { ZonesPanel } from './components/ZonesPanel';
import { AirQualityPanel } from './components/AirQualityPanel';
import { AIPredictorPanel } from './components/AIPredictorPanel';
import { HospitalQuickBar } from './components/HospitalQuickBar';
import { AmbulanceHUD } from './components/AmbulanceHUD';
import { sirenPlayer } from './utils/sirenAudio';

// Eight gently rising samples per zone so the Holt forecaster has a trend to read from the first second.
const seedRamp = (v: number) => Array.from({ length: 8 }, (_, i) => v * (0.92 + (0.08 * i) / 7));
const seedCongestionHistory = () => KOLKATA_ZONES.map((z) => seedRamp(z.congestion));
const seedAqiHistory = () => KOLKATA_ZONES.map((z) => seedRamp(z.aqi));

export default function App() {
  const mapRef = useRef<KolkataMapHandle>(null);

  // Latest-value refs: the 60 FPS loop lives in a long-lived effect, so anything it
  // reads has to come through a ref or it would be stuck on first-render values.
  const congestionHistoryRef = useRef<number[][]>([]);
  const aqiHistoryRef = useRef<number[][]>([]);
  const autopilotRef = useRef(false);
  const isAdaptiveRef = useRef(true);
  const isRushHourRef = useRef(false);
  const ambulanceActiveRef = useRef(false);
  const runAIAnalysisRef = useRef<() => void>(() => {});

  // Simulation core states
  const [nodes] = useState<KolkataNode[]>(KOLKATA_NODES);
  const [roads] = useState<KolkataRoad[]>(KOLKATA_ROADS);
  const [zones, setZones] = useState<TrafficZone[]>(KOLKATA_ZONES);
  // High-performance vehicle physics ref (60 FPS direct canvas sync without React GC spikes)
  const vehiclesRef = useRef<Vehicle[]>([]);
  const ambulanceRef = useRef<Vehicle | null>(null);
  const [vehicleCount, setVehicleCount] = useState<number>(55);
  const [ambulance, setAmbulance] = useState<Vehicle | null>(null);
  const [route, setRoute] = useState<number[]>([]);

  // Simulation parameters
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [simSpeed, setSimSpeed] = useState<number>(1);
  const [isAdaptive, setIsAdaptive] = useState<boolean>(true);
  const [isRushHour, setIsRushHour] = useState<boolean>(false);
  isAdaptiveRef.current = isAdaptive;
  isRushHourRef.current = isRushHour;
  const [selectedNodeId, setSelectedNodeId] = useState<number>(14); // Park Circus default
  const [startNodeId, setStartNodeId] = useState<number>(6); // Howrah Stn default
  const [selectedZoneId, setSelectedZoneId] = useState<number>(1); // CBD default
  const [activeTab, setActiveTab] = useState<'lane' | 'zone' | 'air' | 'ai'>('ai');

  // Road blockages (accidents) & loads
  const [blockedRoads, setBlockedRoads] = useState<Set<string>>(new Set());
  const [roadLoads, setRoadLoads] = useState<Map<string, number>>(new Map());

  // Intersections signal states: { nodeId: { ph: number, preempted: boolean, manual: boolean } }
  const [nodeSignalStates, setNodeSignalStates] = useState<{
    [key: number]: { ph: number; preempted: boolean; manual: boolean };
  }>({});

  // Stable references for 60fps simulation loop to avoid re-triggering effects
  const nodeSignalStatesRef = useRef(nodeSignalStates);
  nodeSignalStatesRef.current = nodeSignalStates;

  const blockedRoadsRef = useRef(blockedRoads);
  blockedRoadsRef.current = blockedRoads;

  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  const routeRef = useRef(route);
  routeRef.current = route;

  const throughputHistoryRef = useRef<number[]>([]);
  const simSpeedRef = useRef(1);
  simSpeedRef.current = simSpeed;

  // Ambulance live-tracking state
  const [ambTelemetry, setAmbTelemetry] = useState<AmbulanceTelemetry | null>(null);
  const [previousRoute, setPreviousRoute] = useState<number[]>([]);
  const [followAmbulance, setFollowAmbulance] = useState<boolean>(true);
  const followRef = useRef(true);
  followRef.current = followAmbulance;
  const roadLoadsRef = useRef<Map<string, number>>(new Map());
  const traveledKmRef = useRef(0);
  const rerouteCountRef = useRef(0);
  const signalsClearedRef = useRef(0);
  const lastRerouteRef = useRef<{ reason: string; at: number } | null>(null);
  const lastRerouteTimeRef = useRef(0);
  const monitorTimerRef = useRef(0);
  const congestionTimerRef = useRef(0);
  const telemetryTimerRef = useRef(0);
  const previousRouteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ambElapsedRef = useRef(0); // wall-clock seconds since dispatch (pauses with the sim)
  const ambSpeedAvgRef = useRef(0); // smoothed ambulance speed used by the ETA
  const arrivedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Layers & Tile provider
  const [mapLayers, setMapLayers] = useState<MapLayersState>({
    signals: true,
    hospitals: true,
    heatZones: true,
    airQuality: false,
    routeCorridor: true,
    accidents: true,
  });
  const [tileProvider, setTileProvider] = useState<TileProvider>('osm-standard');

  // AI & Telemetry
  const [autopilot, setAutopilot] = useState<boolean>(false);
  autopilotRef.current = autopilot;
  const [recommendations, setRecommendations] = useState<AIRecommendation[]>([]);
  const [forecasts, setForecasts] = useState<ZoneForecast[]>([]);
  const [congestionHistory, setCongestionHistory] = useState<number[][]>(seedCongestionHistory);
  const [aqiHistory, setAqiHistory] = useState<number[][]>(seedAqiHistory);
  congestionHistoryRef.current = congestionHistory;
  aqiHistoryRef.current = aqiHistory;
  const [cityAqiHistory, setCityAqiHistory] = useState<number[]>([140, 142]);

  // Operational metrics
  const [throughputHistory, setThroughputHistory] = useState<number[]>([]);
  const [ambulanceETA, setAmbulanceETA] = useState<string>('—');
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [showMoreControls, setShowMoreControls] = useState<boolean>(false);
  const [showAllLogs, setShowAllLogs] = useState<boolean>(false);

  const vehicleIdCounter = useRef<number>(1);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sampleTimerRef = useRef<number>(0);
  const aiTimerRef = useRef<number>(0);
  const signalTimerRef = useRef<number>(0);

  // Trigger Toast & Log
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToastMessage(null), 2500);
  }, []);

  const addLog = useCallback(
    (text: string, type: 'info' | 'alert' | 'emergency' | 'ai' | 'action' = 'info') => {
      showToast(text);
      const newLog: LogMessage = {
        id: `${Date.now()}-${Math.random()}`,
        timestamp: new Date().toLocaleTimeString('en-IN', { hour12: false }),
        text,
        type,
      };
      setLogs((prev) => [newLog, ...prev.slice(0, 49)]);
    },
    [showToast]
  );

  // Initialize signals for all nodes
  useEffect(() => {
    const initSignals: { [key: number]: { ph: number; preempted: boolean; manual: boolean } } = {};
    nodes.forEach((n) => {
      initSignals[n.id] = { ph: Math.random() < 0.5 ? 0 : 1, preempted: false, manual: false };
    });
    setNodeSignalStates(initSignals);
    addLog('SignalQ Intelligent Traffic & Air Command online on OpenStreetMap', 'info');
  }, [nodes, addLog]);

  // Adjacency map
  const adj = useRef(buildAdjacencyList(nodes, roads));
  useEffect(() => {
    adj.current = buildAdjacencyList(nodes, roads);
  }, [nodes, roads]);

  // Pick random next node for general traffic
  const pickNextNode = useCallback(
    (currNode: number, fromNode: number, zList: TrafficZone[]): number => {
      const neighbors = adj.current.get(currNode) || [];
      const valid = neighbors.filter((n) => n !== fromNode && !blockedRoadsRef.current.has(getRoadKey(currNode, n)));

      // Check diversion policies: avoid entering zones with active diversion
      const filtered = valid.filter((n) => {
        const targetNodeObj = nodes.find((node) => node.id === n);
        if (!targetNodeObj) return true;
        const targetZone = zList.find((z) => z.id === targetNodeObj.zoneId);
        if (targetZone && targetZone.diversion && Math.random() < 0.75) {
          return false;
        }
        return true;
      });

      const pool = filtered.length > 0 ? filtered : valid.length > 0 ? valid : neighbors;
      if (pool.length === 0) return fromNode;
      return pool[Math.floor(Math.random() * pool.length)];
    },
    [nodes]
  );

  // Spawn initial & ongoing vehicles
  const targetVehicleCount = isRushHour ? 110 : 60;

  const spawnVehicle = useCallback(() => {
    const startU = Math.floor(Math.random() * nodes.length);
    const destV = pickNextNode(startU, -1, zonesRef.current);
    if (destV === startU || destV === undefined) return;

    const types: ('taxi' | 'bus' | 'car' | 'auto')[] = ['taxi', 'taxi', 'bus', 'car', 'car', 'auto'];
    const chosenType = types[Math.floor(Math.random() * types.length)];
    const colors = {
      taxi: '#eab308', // Kolkata classic yellow taxi
      bus: '#38bdf8', // Blue-white CSTC bus
      car: '#f8fafc', // Private car
      auto: '#22c55e', // Auto rickshaw green
    };

    const spd = 0.85 + Math.random() * 0.4;
    const newVehicle: Vehicle = {
      id: vehicleIdCounter.current++,
      u: startU,
      v: destV,
      t: 0,
      speed: spd,
      currentSpeed: spd * 0.5,
      hold: false,
      type: chosenType,
      color: colors[chosenType],
    };

    vehiclesRef.current.push(newVehicle);
    setVehicleCount(vehiclesRef.current.length);
  }, [nodes, pickNextNode]);

  // Initial population of vehicles
  useEffect(() => {
    const initial: Vehicle[] = [];
    const types: ('taxi' | 'bus' | 'car' | 'auto')[] = ['taxi', 'taxi', 'bus', 'car', 'car', 'auto'];
    const colors = {
      taxi: '#eab308',
      bus: '#38bdf8',
      car: '#f8fafc',
      auto: '#22c55e',
    };
    for (let i = 0; i < 50; i++) {
      const startU = Math.floor(Math.random() * nodes.length);
      const destV = pickNextNode(startU, -1, zonesRef.current);
      if (destV !== startU && destV !== undefined) {
        const chosenType = types[Math.floor(Math.random() * types.length)];
        const spd = 0.85 + Math.random() * 0.45;
        initial.push({
          id: vehicleIdCounter.current++,
          u: startU,
          v: destV,
          t: Math.random() * 0.85,
          speed: spd,
          currentSpeed: spd,
          hold: false,
          type: chosenType,
          color: colors[chosenType],
        });
      }
    }
    vehiclesRef.current = initial;
    setVehicleCount(initial.length);
  }, [nodes, pickNextNode]);

  // ---------------------------------------------------------------------------
  // Emergency corridor engine: routing, signal preemption, live rerouting
  // ---------------------------------------------------------------------------

  const nodeName = useCallback(
    (id: number) => nodes.find((n) => n.id === id)?.name || `Node ${id}`,
    [nodes]
  );

  // A signal under operator (manual) hold on the wrong phase cannot be preempted
  const lockBlocksEntry = useCallback(
    (from: number, to: number) => {
      const st = nodeSignalStatesRef.current[to];
      if (!st || !st.manual) return false;
      return st.ph !== getApproachPhase(from, to, roads, nodes);
    },
    [roads, nodes]
  );

  // Route avoiding blocked roads and locked signals; falls back to emergency override of locks
  const computeRoute = useCallback(
    (start: number, dest: number) => {
      let res = findEmergencyRoute(
        start, dest, nodes, roads, roadLoadsRef.current, blockedRoadsRef.current,
        (f, t) => t === dest || !lockBlocksEntry(f, t)
      );
      let override = false;
      if (!res.found) {
        res = findEmergencyRoute(start, dest, nodes, roads, roadLoadsRef.current, blockedRoadsRef.current);
        override = res.found;
      }
      return { ...res, override };
    },
    [nodes, roads, lockBlocksEntry]
  );

  // Green wave: preempt the signal being approached + the next one, in the ambulance's direction.
  // Everything behind the ambulance is released back to normal control.
  const syncPreemption = useCallback(
    (routeNodes: number[], pathIndex: number) => {
      const wanted = new Map<number, number>();
      for (let k = pathIndex + 1; k <= Math.min(pathIndex + 2, routeNodes.length - 1); k++) {
        wanted.set(routeNodes[k], getApproachPhase(routeNodes[k - 1], routeNodes[k], roads, nodes));
      }
      setNodeSignalStates((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const idStr of Object.keys(prev)) {
          const id = Number(idStr);
          const st = prev[id];
          const phase = wanted.get(id);
          if (phase !== undefined) {
            if (!st.preempted || st.ph !== phase || st.manual) {
              next[id] = { ph: phase, preempted: true, manual: false };
              changed = true;
            }
          } else if (st.preempted) {
            next[id] = { ...st, preempted: false };
            changed = true;
          }
        }
        if (changed) nodeSignalStatesRef.current = next;
        return changed ? next : prev;
      });
    },
    [roads, nodes]
  );

  // Re-plan the ambulance's route from where it is *right now* (no teleporting)
  const rerouteAmbulance = useCallback(
    (reason: string): boolean => {
      const amb = vehiclesRef.current.find((v) => v.isAmbulance);
      if (!amb || amb.dst === undefined) return false;

      const oldRoute = routeRef.current;
      const oldRemaining = oldRoute.slice(amb.pathIndex || 0);
      const onBlockedEdge = blockedRoadsRef.current.has(getRoadKey(amb.u, amb.v));
      const uTurn = onBlockedEdge && amb.t <= 0.52; // hasn't passed the obstruction: turn back
      const from = uTurn ? amb.u : amb.v;

      const res = computeRoute(from, amb.dst);
      if (!res.found) {
        addLog('⚠ No unblocked route to the hospital — ambulance proceeding slowly through the obstruction', 'alert');
        return false;
      }

      const newU = uTurn ? amb.v : amb.u;
      const newV = uTurn ? amb.u : amb.v;
      const newT = uTurn ? 1 - amb.t : amb.t;
      const newRoute = [newU, ...res.path];

      // Nothing to change?
      if (!uTurn && newRoute.length === oldRemaining.length && newRoute.every((n, i) => n === oldRemaining[i])) {
        return false;
      }

      vehiclesRef.current = vehiclesRef.current.map((v) =>
        v.isAmbulance ? { ...v, u: newU, v: newV, t: newT, pathIndex: 0, hold: false } : v
      );
      ambulanceRef.current = vehiclesRef.current.find((v) => v.isAmbulance) || null;
      routeRef.current = newRoute;
      setRoute(newRoute);

      setPreviousRoute(oldRemaining);
      if (previousRouteTimeoutRef.current) clearTimeout(previousRouteTimeoutRef.current);
      previousRouteTimeoutRef.current = setTimeout(() => setPreviousRoute([]), 9000);

      rerouteCountRef.current += 1;
      lastRerouteRef.current = { reason, at: Date.now() };
      lastRerouteTimeRef.current = performance.now();

      syncPreemption(newRoute, 0);

      const extraKm = routeLengthKm(newRoute, roads) - routeLengthKm(oldRemaining, roads);
      addLog(
        `🔀 AMBULANCE REROUTED — ${reason}. New path: ${newRoute.length - 1} hops (${extraKm >= 0 ? '+' : ''}${extraKm.toFixed(1)} km)${
          uTurn ? ', U-turn at obstruction' : ''
        }${res.override ? ', signal lock overridden' : ''}`,
        'emergency'
      );
      return true;
    },
    [computeRoute, syncPreemption, addLog, roads]
  );
  const rerouteAmbulanceRef = useRef(rerouteAmbulance);
  rerouteAmbulanceRef.current = rerouteAmbulance;
  const syncPreemptionRef = useRef(syncPreemption);
  syncPreemptionRef.current = syncPreemption;
  const computeRouteRef = useRef(computeRoute);
  computeRouteRef.current = computeRoute;

  // Emergency Ambulance Dispatch via Green Corridor
  const dispatchAmbulance = useCallback(
    (src: number, dst: number, customTitle?: string) => {
      if (src === dst) {
        src = (dst + 3) % nodes.length;
      }

      const res = computeRoute(src, dst);
      const computedRoute = res.path;

      if (!res.found || computedRoute.length < 2) {
        addLog('No clear route found to destination hospital (all approaches blocked)', 'alert');
        return;
      }

      const ambVehicle: Vehicle = {
        id: 999999,
        u: computedRoute[0],
        v: computedRoute[1],
        t: 0,
        speed: 1.85, // Fast emergency speed
        currentSpeed: 1.2,
        hold: false,
        type: 'car',
        color: '#ef4444',
        isAmbulance: true,
        dst: dst,
        pathIndex: 0,
        t0: performance.now(),
      };

      traveledKmRef.current = 0;
      ambElapsedRef.current = 0;
      ambSpeedAvgRef.current = AMBULANCE_CRUISE * 0.8;
      if (arrivedTimeoutRef.current) clearTimeout(arrivedTimeoutRef.current);
      rerouteCountRef.current = 0;
      signalsClearedRef.current = 0;
      lastRerouteRef.current = null;
      lastRerouteTimeRef.current = performance.now();
      setPreviousRoute([]);

      setRoute(computedRoute);
      routeRef.current = computedRoute;
      setAmbulance(ambVehicle);
      ambulanceRef.current = ambVehicle;
      ambulanceActiveRef.current = true;
      setFollowAmbulance(true);

      // Filter out existing ambulance and add new one
      vehiclesRef.current = [...vehiclesRef.current.filter((v) => !v.isAmbulance), ambVehicle];
      setVehicleCount(vehiclesRef.current.length);

      const tripKm = routeLengthKm(computedRoute, roads);
      const firstEta = etaSeconds(tripKm, ambSpeedAvgRef.current, simSpeedRef.current);
      setAmbulanceETA(`${formatClock(firstEta)} · ${tripKm.toFixed(1)} km`);

      addLog(
        `🚨 GREEN CORRIDOR ACTIVATED: ${customTitle || `${nodeName(src)} → ${nodeName(dst)}`} (${tripKm.toFixed(1)} km, ETA ${formatClock(firstEta)}${
          res.override ? ', signal lock overridden' : ''
        })`,
        'emergency'
      );

      syncPreemption(computedRoute, 0);

      if (mapRef.current) {
        mapRef.current.flyToNode(src);
      }
    },
    [nodes, roads, computeRoute, syncPreemption, nodeName, addLog]
  );

  // Main ultra-smooth 60 FPS physics & telemetry simulation loop
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();

    const step = (time: number) => {
      const delta = Math.min(0.05, (time - lastTime) / 1000);
      lastTime = time;

      if (!isPaused) {
        const dt = delta * simSpeed;

        // 1. Advance vehicles along road polylines with smooth physical easing
        const currentList = vehiclesRef.current;
        const updated: Vehicle[] = [];

        // Build spatial road occupants map for O(1) following distance checks
        const roadOccupants = new Map<string, Vehicle[]>();
        for (let i = 0; i < currentList.length; i++) {
          const v = currentList[i];
          const rKey = getRoadKey(v.u, v.v);
          let list = roadOccupants.get(rKey);
          if (!list) {
            list = [];
            roadOccupants.set(rKey, list);
          }
          list.push(v);
        }

        for (let i = 0; i < currentList.length; i++) {
          const vehicle = currentList[i];
          const rKey = getRoadKey(vehicle.u, vehicle.v);
          const isRoadBlocked = blockedRoadsRef.current.has(rKey);

          // Red light check at target node v
          // Direction-aware: green only if the active phase serves this vehicle's approach
          const vState = nodeSignalStatesRef.current[vehicle.v] || { ph: 0, preempted: false };
          const isGreenAtDestination = vState.ph === getApproachPhase(vehicle.u, vehicle.v, roads, nodes);

          const roadObj = findRoad(roads, vehicle.u, vehicle.v);
          const roadLen = roadObj?.lengthKm || 1.5;

          let targetSpeed = vehicle.speed;
          let shouldHold = false;

          // Gentle braking zone on approaching red light
          const distToStopLine = 0.88 - vehicle.t;
          if (!isGreenAtDestination && !vehicle.isAmbulance && distToStopLine > 0 && distToStopLine < 0.25) {
            const brakeFactor = Math.max(0, distToStopLine / 0.25);
            targetSpeed = vehicle.speed * brakeFactor * 0.7;
            if (distToStopLine < 0.02) {
              targetSpeed = 0;
              shouldHold = true;
            }
          }

          // Safe car-following headway easing with vehicle ahead
          const sameRoadCars = roadOccupants.get(rKey) || [];
          for (let j = 0; j < sameRoadCars.length; j++) {
            const other = sameRoadCars[j];
            if (other.id !== vehicle.id && other.t > vehicle.t) {
              const gap = other.t - vehicle.t;
              // Traffic yields to the siren: ambulance only brakes when nearly touching
              const stopGap = vehicle.isAmbulance ? 0.015 : 0.04;
              const softGap = vehicle.isAmbulance ? 0.05 : 0.11;
              if (gap < softGap) {
                const gapFactor = Math.max(0, (gap - stopGap * 0.9) / (softGap - stopGap));
                const otherSpd = (other.currentSpeed ?? other.speed) * (vehicle.isAmbulance ? 1.6 : 1);
                targetSpeed = Math.min(targetSpeed, Math.max(otherSpd * gapFactor, vehicle.isAmbulance ? 0.5 : 0));
                if (gap < stopGap && !vehicle.isAmbulance) {
                  targetSpeed = 0;
                  shouldHold = true;
                }
              }
            }
          }

          // Accident blockage easing
          if (isRoadBlocked && vehicle.t < 0.52 && vehicle.t > 0.25) {
            if (vehicle.isAmbulance) {
              // Rerouting handles this; if no alternative exists it crawls through
              targetSpeed = Math.min(targetSpeed, 0.3);
            } else {
              targetSpeed = 0;
              shouldHold = true;
            }
          }

          // Smooth acceleration and deceleration curves
          let curSpd = vehicle.currentSpeed !== undefined ? vehicle.currentSpeed : vehicle.speed;
          if (curSpd < targetSpeed) {
            curSpd = Math.min(targetSpeed, curSpd + 2.5 * dt * vehicle.speed);
          } else if (curSpd > targetSpeed) {
            curSpd = Math.max(targetSpeed, curSpd - 3.8 * dt * vehicle.speed);
          }

          // Progress normalized by physical road length
          const progressDelta = (curSpd * 0.22 / roadLen) * dt;
          const nextT = vehicle.t + progressDelta;
          if (vehicle.isAmbulance) {
            traveledKmRef.current += Math.min(progressDelta, 1 - vehicle.t) * roadLen;
          }

          // Handle intersection arrival (t >= 1)
          if (nextT >= 1) {
            throughputHistoryRef.current.push(performance.now());

            if (vehicle.isAmbulance) {
              const currentRoute = routeRef.current;
              const nextHopIndex = (vehicle.pathIndex || 0) + 1;
              if (currentRoute && nextHopIndex >= currentRoute.length - 1) {
                // Ambulance reached destination hospital!
                const totalSecs = ambElapsedRef.current.toFixed(1);
                const hospitalName = nodes.find((n) => n.id === vehicle.dst)?.name || 'Destination Hospital';
                addLog(`✔ AMBULANCE ARRIVED AT ${hospitalName} in ${totalSecs}s! Green corridor released.`, 'emergency');
                sirenPlayer.stop();
                setAmbulance(null);
                setRoute([]);
                setPreviousRoute([]);
                setAmbTelemetry(null);
                setAmbulanceETA(`Arrived · ${totalSecs}s`);
                if (arrivedTimeoutRef.current) clearTimeout(arrivedTimeoutRef.current);
                arrivedTimeoutRef.current = setTimeout(() => setAmbulanceETA('—'), 8000);
                ambulanceRef.current = null;
                routeRef.current = [];

                // Release all preemptions
                syncPreemptionRef.current([], 0);
                continue; // Completed route
              } else {
                // Advance along route
                const nextU = currentRoute[nextHopIndex];
                const nextV = currentRoute[nextHopIndex + 1];
                updated.push({
                  ...vehicle,
                  u: nextU,
                  v: nextV,
                  t: 0,
                  currentSpeed: curSpd,
                  pathIndex: nextHopIndex,
                  hold: false,
                });

                // Slide the green wave forward; release the junction just cleared
                signalsClearedRef.current += 1;
                syncPreemptionRef.current(currentRoute, nextHopIndex);
                continue;
              }
            }

            // Normal vehicle: advance to next node preserving momentum
            const nextU = vehicle.v;
            const nextV = pickNextNode(nextU, vehicle.u, zonesRef.current);
            updated.push({
              ...vehicle,
              u: nextU,
              v: nextV,
              t: 0,
              currentSpeed: Math.max(0.4, curSpd),
              hold: false,
            });
          } else {
            updated.push({
              ...vehicle,
              t: Math.min(1, nextT),
              currentSpeed: curSpd,
              hold: shouldHold,
            });
          }
        }

        // Spawn new vehicles if below target
        while (updated.length < targetVehicleCount) {
          const startU = Math.floor(Math.random() * nodes.length);
          const destV = pickNextNode(startU, -1, zonesRef.current);
          if (destV !== startU && destV !== undefined) {
            const types: ('taxi' | 'bus' | 'car' | 'auto')[] = ['taxi', 'taxi', 'bus', 'car', 'auto'];
            const chosenType = types[Math.floor(Math.random() * types.length)];
            const colors = {
              taxi: '#eab308',
              bus: '#38bdf8',
              car: '#f8fafc',
              auto: '#22c55e',
            };
            const spd = 0.85 + Math.random() * 0.4;
            updated.push({
              id: vehicleIdCounter.current++,
              u: startU,
              v: destV,
              t: 0,
              speed: spd,
              currentSpeed: spd * 0.5,
              hold: false,
              type: chosenType,
              color: colors[chosenType],
            });
          } else {
            break;
          }
        }

        vehiclesRef.current = updated;
        ambulanceRef.current = updated.find((v) => v.isAmbulance) || null;

        // 1b. Live ambulance supervision: reroute triggers + telemetry
        const ambNow = ambulanceRef.current;
        ambulanceActiveRef.current = !!ambNow;
        if (ambNow) {
          const rt = routeRef.current;
          const idx = ambNow.pathIndex || 0;
          ambElapsedRef.current += delta;
          ambSpeedAvgRef.current = smoothSpeed(ambSpeedAvgRef.current, ambNow.currentSpeed ?? ambNow.speed, 0.02);

          monitorTimerRef.current += dt;
          if (monitorTimerRef.current > 0.5) {
            monitorTimerRef.current = 0;
            const dstId = ambNow.dst;
            let reasonText: string | null = null;

            for (let k = idx; k < rt.length - 1 && !reasonText; k++) {
              if (blockedRoadsRef.current.has(getRoadKey(rt[k], rt[k + 1]))) {
                reasonText = `road ${rt[k]}→${rt[k + 1]} ahead is blocked`;
              } else if (rt[k + 1] !== dstId && lockBlocksEntry(rt[k], rt[k + 1])) {
                reasonText = `signal at ${nodeName(rt[k + 1])} is locked RED (cannot be preempted)`;
              }
            }
            if (reasonText) rerouteAmbulanceRef.current(reasonText);
          }

          // Congestion-aware re-plan (hysteresis + cooldown to avoid flapping)
          congestionTimerRef.current += dt;
          if (congestionTimerRef.current > 2 && performance.now() - lastRerouteTimeRef.current > 6000) {
            congestionTimerRef.current = 0;
            const remaining = rt.slice(idx + 1);
            if (remaining.length > 2 && ambNow.dst !== undefined) {
              const alt = computeRouteRef.current(rt[idx + 1], ambNow.dst);
              const curCost = routeCost(remaining, roads, roadLoadsRef.current);
              if (alt.found && !alt.override && alt.cost < curCost * 0.75 && curCost - alt.cost > 0.6) {
                rerouteAmbulanceRef.current(`heavy congestion ahead (saves ~${Math.round(((curCost - alt.cost) / curCost) * 100)}% travel cost)`);
              }
            }
          }

          telemetryTimerRef.current += dt;
          if (telemetryTimerRef.current > 0.3) {
            telemetryTimerRef.current = 0;
            const rt2 = routeRef.current;
            const idx2 = ambNow.pathIndex || 0;
            const curRoad = findRoad(roads, ambNow.u, ambNow.v);
            const curLen = curRoad?.lengthKm || 1.5;
            const remainingKm = (1 - ambNow.t) * curLen + routeLengthKm(rt2.slice(idx2 + 1), roads);
            const spd = ambNow.currentSpeed ?? ambNow.speed;
            // ETA uses the smoothed speed, so a brief slowdown behind a car doesn't make it jump
            const etaSec = etaSeconds(remainingKm, ambSpeedAvgRef.current, simSpeed);
            const etaMin = etaRealMinutes(remainingKm, ambSpeedAvgRef.current);
            const traveled = traveledKmRef.current;
            const st = nodeSignalStatesRef.current[ambNow.v];
            const needed = getApproachPhase(ambNow.u, ambNow.v, roads, nodes);
            const label: AmbulanceTelemetry['nextSignalLabel'] =
              st?.preempted ? 'GREEN (PREEMPTED)' : st && st.ph === needed ? 'GREEN' : 'RED';

            const corridor: AmbulanceTelemetry['corridor'] = [];
            let accKm = (1 - ambNow.t) * curLen;
            for (let k = idx2 + 1; k < Math.min(idx2 + 4, rt2.length); k++) {
              const nid = rt2[k];
              const ns = nodeSignalStatesRef.current[nid];
              corridor.push({
                id: nid,
                name: nodeName(nid),
                state: ns?.preempted ? 'cleared' : ns?.manual && ns.ph !== getApproachPhase(rt2[k - 1], nid, roads, nodes) ? 'locked' : 'normal',
                distanceKm: accKm,
              });
              accKm += findRoad(roads, nid, rt2[k + 1] ?? nid)?.lengthKm ?? 0;
            }

            setAmbTelemetry({
              routeNodes: rt2,
              pathIndex: idx2,
              progress: traveled + remainingKm > 0 ? traveled / (traveled + remainingKm) : 0,
              remainingKm,
              etaSec,
              etaRealMin: etaMin,
              elapsedSec: ambElapsedRef.current,
              speedKmh: speedToKmh(spd),
              nextNodeId: ambNow.v,
              nextNodeName: nodeName(ambNow.v),
              nextSignalLabel: label,
              nextDistanceM: Math.round((1 - ambNow.t) * curLen * 1000),
              reroutes: rerouteCountRef.current,
              signalsCleared: signalsClearedRef.current,
              lastReroute: lastRerouteRef.current,
              corridor,
            });
            setAmbulanceETA(`${formatClock(etaSec)} · ${remainingKm.toFixed(1)} km`);
          }
        }

        // 2. Adaptive Traffic Signals Timer Cycle (throttled to update only when phases actually change)
        signalTimerRef.current += dt;
        if (signalTimerRef.current > 1.6) {
          signalTimerRef.current = 0;
          setNodeSignalStates((prev) => {
            let hasChange = false;
            const next = { ...prev };
            nodes.forEach((n) => {
              const st = next[n.id] || { ph: 0, preempted: false, manual: false };
              if (st.preempted || st.manual) return;

              const targetZone = zonesRef.current.find((z) => z.id === n.zoneId);
              const cycleDuration = targetZone?.extendGreens ? 8 : isAdaptive ? 5 : 6;

              if (Math.random() < 1.6 / cycleDuration) {
                next[n.id] = { ...st, ph: st.ph === 0 ? 1 : 0 };
                hasChange = true;
              }
            });
            return hasChange ? next : prev;
          });
        }

        // 3. Periodic Telemetry Sampling (Congestion, AQI, Holt forecasts, and Road Loads)
        sampleTimerRef.current += dt;
        if (sampleTimerRef.current > 1.4) {
          sampleTimerRef.current = 0;

          // Update road loads for Dijkstra routing
          const curRoadLoads = new Map<string, number>();
          const vehs = vehiclesRef.current;
          for (let i = 0; i < vehs.length; i++) {
            const v = vehs[i];
            const rKey = getRoadKey(v.u, v.v);
            curRoadLoads.set(rKey, (curRoadLoads.get(rKey) || 0) + 1);
          }
          roadLoadsRef.current = curRoadLoads;
          setRoadLoads(curRoadLoads);
          setVehicleCount(vehs.length);
          const nowMs = performance.now();
          throughputHistoryRef.current = throughputHistoryRef.current.filter((t) => nowMs - t < 60000);
          setThroughputHistory([...throughputHistoryRef.current]);

          setZones((prevZones) =>
            prevZones.map((z) => {
              // Count vehicles idling or moving inside this zone
              let heldVehicles = 0;
              let movingVehicles = 0;

              for (let i = 0; i < vehs.length; i++) {
                const v = vehs[i];
                const nodeObj = nodes.find((n) => n.id === v.u);
                if (nodeObj && nodeObj.zoneId === z.id) {
                  if (v.hold) heldVehicles++;
                  else movingVehicles++;
                }
              }

              // Update zone congestion (0.0 to 1.0)
              const rawCongestion = Math.min(1, (heldVehicles * 0.12) + (movingVehicles * 0.03));
              const newCongestion = z.congestion + (rawCongestion - z.congestion) * 0.35;

              // Update AQI based on emissions & purifiers
              const emissionFactor = z.lez ? 0.6 : 1.0;
              const purificationFactor = z.purifiers ? 2.5 : 1.0;
              const netChange = (heldVehicles * 0.8 + movingVehicles * 0.25) * emissionFactor - (3.2 * purificationFactor);
              const newAqi = Math.max(50, Math.min(420, Math.round(z.aqi + netChange * 0.35)));

              return {
                ...z,
                congestion: Math.max(0.1, Math.min(0.98, newCongestion)),
                aqi: newAqi,
              };
            })
          );

          // Update histories
          setCongestionHistory((ch) =>
            ch.map((hist, zId) => {
              const currentZoneVal = zonesRef.current[zId]?.congestion || 0.4;
              return [...hist.slice(-50), currentZoneVal];
            })
          );

          setAqiHistory((ah) =>
            ah.map((hist, zId) => {
              const currentZoneAqi = zonesRef.current[zId]?.aqi || 140;
              return [...hist.slice(-50), currentZoneAqi];
            })
          );

          setCityAqiHistory((cah) => {
            const avg = Math.round(zonesRef.current.reduce((a, b) => a + b.aqi, 0) / zonesRef.current.length);
            return [...cah.slice(-50), avg];
          });
        }

        // 4. AI Analyzer & Autopilot check (every 3.8s)
        aiTimerRef.current += dt;
        if (aiTimerRef.current > 3.8) {
          aiTimerRef.current = 0;
          runAIAnalysisRef.current();
        }
      }

      animId = requestAnimationFrame(step);
    };

    animId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animId);
  }, [
    isPaused,
    simSpeed,
    isAdaptive,
    isRushHour,
    targetVehicleCount,
    nodes,
    roads,
    pickNextNode,
    addLog,
    lockBlocksEntry,
    nodeName,
  ]);

  // Clean old throughput entries
  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now();
      setThroughputHistory((th) => th.filter((t) => now - t < 60000));
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  // Apply a single recommendation's action to the simulation
  const applyRecommendation = useCallback(
    (rec: AIRecommendation, viaAutopilot = false) => {
      const tag = viaAutopilot ? '🤖 Autopilot' : '🤖 AI';
      if (rec.action.kind === 'zone') {
        const { zoneId, patch } = rec.action;
        setZones((prev) => prev.map((zone) => (zone.id === zoneId ? { ...zone, ...patch } : zone)));
        // keep the ref in step so the very next analysis already sees the change
        zonesRef.current = zonesRef.current.map((zone) => (zone.id === zoneId ? { ...zone, ...patch } : zone));
        addLog(`${tag}: ${rec.title}`, 'ai');
      } else if (rec.action.kind === 'adaptive') {
        setIsAdaptive(true);
        isAdaptiveRef.current = true;
        addLog(`${tag}: Signals switched to Adaptive AI`, 'ai');
      }
      setRecommendations((prev) => prev.filter((r) => r.id !== rec.id));
    },
    [addLog]
  );

  // Holt forecasting -> ranked recommendations. Reads everything from refs, so it is never stale.
  const runAIAnalysis = useCallback(() => {
    const result = generateRecommendations({
      zones: zonesRef.current,
      congestionHistory: congestionHistoryRef.current,
      aqiHistory: aqiHistoryRef.current,
      blockedRoadCount: blockedRoadsRef.current.size,
      ambulanceActive: ambulanceActiveRef.current,
      isAdaptive: isAdaptiveRef.current,
      isRushHour: isRushHourRef.current,
    });

    setForecasts(result.forecasts);
    setRecommendations(result.recommendations);

    // Autopilot applies the top actionable items on its own
    if (autopilotRef.current) {
      result.recommendations
        .filter((r) => r.action.kind !== 'none')
        .slice(0, 3)
        .forEach((r) => applyRecommendation(r, true));
    }
  }, [applyRecommendation]);
  runAIAnalysisRef.current = runAIAnalysis;

  // First analysis shortly after load so the advisor is never empty on first view
  useEffect(() => {
    const t = setTimeout(() => runAIAnalysisRef.current(), 600);
    return () => clearTimeout(t);
  }, []);

  // Apply all pending actionable recommendations
  const applyAllRecommendations = () => {
    const actionable = recommendations.filter((r) => r.action.kind !== 'none');
    actionable.forEach((r) => applyRecommendation(r));
    if (actionable.length > 0) {
      addLog(`⚡ ${actionable.length} AI recommendation${actionable.length > 1 ? 's' : ''} applied`, 'ai');
    }
  };

  // Toggle accident on road (updates the ref synchronously so rerouting sees it immediately)
  const toggleRoadBlockage = (roadKey: string) => {
    const next = new Set(blockedRoadsRef.current);
    if (next.has(roadKey)) {
      next.delete(roadKey);
      blockedRoadsRef.current = next;
      setBlockedRoads(next);
      addLog(`Accident cleared on road corridor ${roadKey}`, 'action');
      return;
    }

    next.add(roadKey);
    blockedRoadsRef.current = next;
    setBlockedRoads(next);
    const road = roads.find((r) => getRoadKey(r.u, r.v) === roadKey);
    addLog(`🚧 Accident reported on ${road?.name || roadKey} – Traffic dynamically rerouted!`, 'alert');

    // Reroute the ambulance if the accident is on its remaining path
    const amb = vehiclesRef.current.find((v) => v.isAmbulance);
    if (amb) {
      const rt = routeRef.current;
      for (let k = amb.pathIndex || 0; k < rt.length - 1; k++) {
        if (getRoadKey(rt[k], rt[k + 1]) === roadKey) {
          rerouteAmbulance(`accident on ${road?.name || roadKey} blocks the corridor`);
          break;
        }
      }
    }
  };

  // Trigger random accident
  const triggerRandomAccident = () => {
    const unblocked = roads.filter((r) => !blockedRoadsRef.current.has(getRoadKey(r.u, r.v)));
    if (unblocked.length === 0) return;
    // With an ambulance en route, drop the accident on its path ahead (so the reroute is demonstrable)
    const amb = vehiclesRef.current.find((v) => v.isAmbulance);
    let pool = unblocked;
    if (amb) {
      const rt = routeRef.current;
      const ahead = new Set<string>();
      for (let k = (amb.pathIndex || 0) + 1; k < rt.length - 1; k++) ahead.add(getRoadKey(rt[k], rt[k + 1]));
      const onPath = unblocked.filter((r) => ahead.has(getRoadKey(r.u, r.v)));
      if (onPath.length > 0) pool = onPath;
    }
    const road = pool[Math.floor(Math.random() * pool.length)];
    const rKey = getRoadKey(road.u, road.v);
    toggleRoadBlockage(rKey);
  };

  // Clear all accidents
  const clearAllAccidents = () => {
    blockedRoadsRef.current = new Set();
    setBlockedRoads(new Set());
    addLog('All road accidents and obstacles cleared across Kolkata', 'action');
  };

  // Zone tactical action handler
  const handleZoneAction = (action: 'diversion' | 'extendGreens' | 'lez' | 'purifiers' | 'clear') => {
    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== selectedZoneId) return z;
        if (action === 'clear') {
          addLog(`Zone Z${z.id + 1} (${z.name}) interventions cleared`, 'action');
          return { ...z, diversion: false, extendGreens: false, lez: false, purifiers: false };
        }
        const updated = { ...z, [action]: !z[action] };
        addLog(`Zone Z${z.id + 1} (${z.name}) ${action}: ${updated[action] ? 'ON' : 'OFF'}`, 'action');
        return updated;
      })
    );
  };

  // Manual signal phase apply
  // `axis` is 0 = North/South green, 1 = East/West green
  const handleApplyManualPhase = (nodeId: number, axis: number) => {
    setNodeSignalStates((prev) => ({
      ...prev,
      [nodeId]: { ph: axis, preempted: false, manual: true },
    }));
    const nodeObj = nodes.find((n) => n.id === nodeId);
    addLog(`${nodeObj?.name}: holding ${axis === 0 ? 'North–South' : 'East–West'} green`, 'action');
  };

  const handleReleaseNode = (nodeId: number) => {
    setNodeSignalStates((prev) => ({
      ...prev,
      [nodeId]: { ph: 0, preempted: false, manual: false },
    }));
    const nodeObj = nodes.find((n) => n.id === nodeId);
    addLog(`${nodeObj?.name}: Released to adaptive AI signal control`, 'action');
  };

  const resetSimulation = () => {
    vehiclesRef.current = [];
    setVehicleCount(0);
    setBlockedRoads(new Set());
    blockedRoadsRef.current = new Set();
    setRoute([]);
    routeRef.current = [];
    setPreviousRoute([]);
    setAmbulance(null);
    ambulanceRef.current = null;
    ambulanceActiveRef.current = false;
    setAmbTelemetry(null);
    setAmbulanceETA('—');
    syncPreemptionRef.current([], 0);
    sirenPlayer.stop();
    setZones(KOLKATA_ZONES);
    zonesRef.current = KOLKATA_ZONES;
    setCongestionHistory(seedCongestionHistory());
    setAqiHistory(seedAqiHistory());
    congestionHistoryRef.current = seedCongestionHistory();
    aqiHistoryRef.current = seedAqiHistory();
    setRecommendations([]);
    setTimeout(() => runAIAnalysisRef.current(), 300);
    addLog('Network reset to default state', 'action');
  };

  // KPI calculations
  const avgCityCongestion = Math.round(
    (zones.reduce((a, b) => a + b.congestion, 0) / zones.length) * 100
  );
  const avgCityAqi = Math.round(zones.reduce((a, b) => a + b.aqi, 0) / zones.length);
  const actionableCount = recommendations.filter((r) => r.action.kind !== 'none').length;
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  const chip = (on: boolean, tone = 'sky') =>
    `px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
      on
        ? tone === 'rose'
          ? 'bg-rose-600 border-rose-500 text-white'
          : tone === 'amber'
          ? 'bg-amber-600 border-amber-500 text-white'
          : 'bg-sky-600 border-sky-500 text-white'
        : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
    }`;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-sky-500 selection:text-white">
      {/* Toast */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 max-w-[92vw] bg-slate-900/95 text-white border border-slate-700 px-4 py-2 rounded-full shadow-2xl text-xs font-medium flex items-center gap-2 backdrop-blur-md pointer-events-none">
          <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse shrink-0"></span>
          <span className="truncate">{toastMessage}</span>
        </div>
      )}

      {/* Header */}
      <header className="h-14 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-4 flex items-center justify-between shrink-0 sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center shadow-md shadow-sky-500/20">🚦</div>
          <div className="leading-tight">
            <div className="font-bold tracking-tight text-white text-base">SignalQ</div>
            <div className="text-[10px] text-slate-400 hidden sm:block">Kolkata traffic &amp; air command</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {autopilot && (
            <span className="px-2.5 py-1 rounded text-[11px] font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-500/40">
              AUTOPILOT
            </span>
          )}
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400">
            <span className={`w-2 h-2 rounded-full ${isPaused ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'}`}></span>
            {isPaused ? 'Paused' : 'Live'}
          </span>
        </div>
      </header>

      <main className="flex-1 p-3 max-w-[1720px] w-full mx-auto flex flex-col gap-3">
        {/* Key numbers */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="bg-slate-900/90 rounded-xl p-3 border border-slate-800">
            <div className="text-[11px] text-slate-400">Congestion</div>
            <div
              className={`text-2xl font-bold font-mono tabular-nums ${
                avgCityCongestion > 60 ? 'text-rose-400' : avgCityCongestion > 35 ? 'text-amber-400' : 'text-emerald-400'
              }`}
            >
              {avgCityCongestion}%
            </div>
            <div className="text-[10px] text-slate-500">{isRushHour ? 'Rush hour' : 'Normal flow'}</div>
          </div>

          <div className="bg-slate-900/90 rounded-xl p-3 border border-slate-800">
            <div className="text-[11px] text-slate-400">Air quality</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold font-mono tabular-nums" style={{ color: getAqiColor(avgCityAqi) }}>
                {avgCityAqi}
              </span>
              <span className="text-[10px] text-slate-400 truncate">{getAqiCategory(avgCityAqi)}</span>
            </div>
            <div className="text-[10px] text-slate-500">City average AQI</div>
          </div>

          <div className={`rounded-xl p-3 border ${ambulance ? 'bg-rose-950/30 border-rose-500/40' : 'bg-slate-900/90 border-slate-800'}`}>
            <div className="text-[11px] text-slate-400">Ambulance ETA</div>
            <div className="text-2xl font-bold font-mono text-rose-400 tabular-nums truncate">{ambulanceETA}</div>
            <div className="text-[10px] text-slate-500">
              {ambTelemetry
                ? `≈ ${formatMinutes(ambTelemetry.etaRealMin)} in real traffic · ${ambTelemetry.speedKmh} km/h`
                : ambulance
                ? 'Calculating…'
                : 'Ready — pick a hospital below'}
            </div>
          </div>

          <button
            onClick={() => setActiveTab('ai')}
            className="text-left bg-slate-900/90 rounded-xl p-3 border border-slate-800 hover:border-sky-600/60 transition-colors"
          >
            <div className="text-[11px] text-slate-400">AI advisor</div>
            <div className={`text-2xl font-bold font-mono tabular-nums ${actionableCount > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {actionableCount > 0 ? `${actionableCount} to do` : 'All clear'}
            </div>
            <div className="text-[10px] text-slate-500">{autopilot ? 'Autopilot is applying fixes' : 'Tap to review'}</div>
          </button>
        </div>

        {/* Controls */}
        <div className="bg-slate-900/80 rounded-xl p-2.5 border border-slate-800 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setIsPaused(!isPaused)} className={chip(isPaused, 'amber')}>
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              onClick={() => {
                setIsRushHour(!isRushHour);
                addLog(`Rush hour ${!isRushHour ? 'ON' : 'OFF'}`, 'alert');
              }}
              className={chip(isRushHour, 'rose')}
            >
              {isRushHour ? '🚨 Rush hour: ON' : 'Rush hour'}
            </button>
            <button onClick={triggerRandomAccident} className={chip(false)}>
              🚧 Report accident
            </button>
            {blockedRoads.size > 0 && (
              <button onClick={clearAllAccidents} className={chip(false)}>
                Clear accidents ({blockedRoads.size})
              </button>
            )}
            <button onClick={() => setShowMoreControls((v) => !v)} className={`${chip(showMoreControls)} ml-auto`}>
              ⚙ {showMoreControls ? 'Hide options' : 'Options'}
            </button>
            <button
              onClick={resetSimulation}
              className="px-3 py-1.5 text-xs font-medium bg-slate-800/60 hover:bg-slate-800 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              ↻ Reset
            </button>
          </div>

          {showMoreControls && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800">
              <button
                onClick={() => setSimSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : s === 4 ? 0.5 : 1))}
                className={`${chip(false)} font-mono`}
              >
                Speed {simSpeed}×
              </button>
              <button
                onClick={() => {
                  setIsAdaptive(!isAdaptive);
                  addLog(`Signals set to ${!isAdaptive ? 'Adaptive AI' : 'Fixed timing'}`, 'action');
                }}
                className={chip(isAdaptive)}
              >
                {isAdaptive ? 'Adaptive signals' : 'Fixed-time signals'}
              </button>
              <button
                onClick={() => {
                  setStartNodeId(selectedNodeId);
                  addLog(`Ambulance start set to ${selectedNode?.name}`, 'action');
                }}
                className={chip(false)}
              >
                📍 Use selected junction as map-dispatch start
              </button>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 ml-auto">
                Map
                <select
                  value={tileProvider}
                  onChange={(e) => setTileProvider(e.target.value as TileProvider)}
                  className="bg-slate-800 border border-slate-700 rounded-lg text-slate-200 text-xs px-2 py-1.5 focus:outline-none"
                >
                  <option value="osm-standard">Standard</option>
                  <option value="carto-dark">Dark</option>
                  <option value="carto-light">Light</option>
                </select>
              </label>
            </div>
          )}
        </div>

        {/* Ambulance dispatch */}
        <HospitalQuickBar
          nodes={nodes}
          selectedNodeId={selectedNodeId}
          onDispatchRoute={(start, end, title) => dispatchAmbulance(start, end, title)}
          isAmbulanceActive={!!ambulance}
          onSelectHospitalNode={(nodeId) => {
            setSelectedNodeId(nodeId);
            if (mapRef.current) mapRef.current.flyToNode(nodeId);
          }}
        />

        {/* Map + console */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-7 flex flex-col gap-2">
            <div className="min-h-[420px] h-[56vh] lg:h-[620px] relative">
              <AmbulanceHUD
                telemetry={ambTelemetry}
                follow={followAmbulance}
                onToggleFollow={() => setFollowAmbulance((f) => !f)}
              />
              <KolkataMap
                ref={mapRef}
                nodes={nodes}
                roads={roads}
                zones={zones}
                hospitals={KOLKATA_HOSPITALS}
                vehiclesRef={vehiclesRef}
                ambulance={ambulance}
                route={route}
                previousRoute={previousRoute}
                telemetry={ambTelemetry}
                followAmbulance={followAmbulance}
                onUserPan={() => setFollowAmbulance(false)}
                selectedNodeId={selectedNodeId}
                startNodeId={startNodeId}
                blockedRoads={blockedRoads}
                roadLoads={roadLoads}
                nodeStates={nodeSignalStates}
                layers={mapLayers}
                tileProvider={tileProvider}
                onSelectNode={(id) => {
                  setSelectedNodeId(id);
                  const nodeObj = nodes.find((n) => n.id === id);
                  if (nodeObj) {
                    setSelectedZoneId(nodeObj.zoneId);
                    addLog(`Inspecting junction: ${nodeObj.name}`, 'info');
                  }
                }}
                onToggleRoadBlock={toggleRoadBlockage}
                onSetStartNode={(id) => {
                  setStartNodeId(id);
                  const nodeObj = nodes.find((n) => n.id === id);
                  addLog(`Ambulance start point set to: ${nodeObj?.name}`, 'info');
                }}
                onDispatchAmbulanceTo={(id) => {
                  dispatchAmbulance(startNodeId, id);
                }}
                onSelectHospitalNode={(id) => {
                  setSelectedNodeId(id);
                  if (mapRef.current) mapRef.current.flyToNode(id);
                }}
              />
            </div>

            {/* Map layers */}
            <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-400 mr-1">Show:</span>
              {[
                { key: 'signals', label: 'Signals' },
                { key: 'hospitals', label: 'Hospitals' },
                { key: 'heatZones', label: 'Congestion' },
                { key: 'airQuality', label: 'Air quality' },
                { key: 'routeCorridor', label: 'Ambulance route' },
              ].map((layer) => {
                const k = layer.key as keyof MapLayersState;
                const isActive = mapLayers[k];
                return (
                  <button
                    key={layer.key}
                    onClick={() => setMapLayers((prev) => ({ ...prev, [k]: !prev[k] }))}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                      isActive ? 'bg-sky-600/80 border-sky-500 text-white' : 'bg-slate-800/80 border-slate-700 text-slate-400'
                    }`}
                  >
                    {layer.label}
                  </button>
                );
              })}
              {selectedNode && (
                <span className="ml-auto text-xs text-slate-400 truncate max-w-[220px]">
                  Selected: <b className="text-sky-400">{selectedNode.name}</b>
                </span>
              )}
            </div>
          </div>

          {/* Console */}
          <div className="lg:col-span-5 flex flex-col gap-2 bg-slate-900/90 rounded-xl p-3 border border-slate-800 shadow-xl min-w-0">
            <div className="grid grid-cols-4 gap-1 p-1 bg-slate-950/80 rounded-lg border border-slate-800/80">
              {[
                { id: 'ai', label: 'AI Advisor', badge: actionableCount },
                { id: 'lane', label: 'Junction', badge: 0 },
                { id: 'zone', label: 'Zones', badge: 0 },
                { id: 'air', label: 'Air', badge: 0 },
              ].map((tab) => {
                const isCurrent = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as typeof activeTab)}
                    className={`py-1.5 px-1 text-xs font-medium rounded-md transition-all text-center truncate ${
                      isCurrent ? 'bg-slate-800 text-white shadow-sm border border-slate-700' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                    {tab.badge > 0 && (
                      <span className="ml-1 px-1.5 rounded-full bg-amber-500 text-slate-950 text-[10px] font-bold">{tab.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 min-w-0">
              {activeTab === 'ai' && (
                <AIPredictorPanel
                  zones={zones}
                  selectedZoneId={selectedZoneId}
                  onSelectZone={(zId) => setSelectedZoneId(zId)}
                  congestionHistory={congestionHistory}
                  aqiHistory={aqiHistory}
                  forecasts={forecasts}
                  recommendations={recommendations}
                  autopilot={autopilot}
                  onApplyOne={(rec) => applyRecommendation(rec)}
                  onApplyAll={applyAllRecommendations}
                  onRefresh={() => runAIAnalysisRef.current()}
                  onToggleAutopilot={() => {
                    const next = !autopilot;
                    setAutopilot(next);
                    autopilotRef.current = next;
                    addLog(`🤖 Autopilot ${next ? 'ON' : 'OFF'}`, 'ai');
                    if (next) runAIAnalysisRef.current();
                  }}
                />
              )}

              {activeTab === 'lane' && (
                <LaneConflictView
                  selectedNode={selectedNode}
                  nodeState={nodeSignalStates[selectedNodeId]}
                  onApplyManualPhase={handleApplyManualPhase}
                  onReleaseNode={handleReleaseNode}
                  onLog={(msg) => addLog(msg, 'action')}
                />
              )}

              {activeTab === 'zone' && (
                <ZonesPanel
                  zones={zones}
                  selectedZoneId={selectedZoneId}
                  onSelectZone={(zId) => setSelectedZoneId(zId)}
                  onToggleAction={handleZoneAction}
                />
              )}

              {activeTab === 'air' && (
                <AirQualityPanel
                  zones={zones}
                  selectedZoneId={selectedZoneId}
                  aqiHistory={aqiHistory}
                  cityAqiHistory={cityAqiHistory}
                  onSelectZone={(zId) => setSelectedZoneId(zId)}
                  onToggleAction={handleZoneAction}
                />
              )}
            </div>
          </div>
        </div>

        {/* Activity */}
        <div className="bg-slate-900/90 rounded-xl p-3 border border-slate-800 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-200 text-[11px] uppercase tracking-wide">Activity</span>
            {logs.length > 3 && (
              <button onClick={() => setShowAllLogs((v) => !v)} className="text-[11px] text-sky-400 hover:text-sky-300">
                {showAllLogs ? 'Show less' : `Show all (${logs.length})`}
              </button>
            )}
          </div>
          <div className={`${showAllLogs ? 'max-h-60' : ''} overflow-y-auto flex flex-col gap-1 font-mono text-[11px]`}>
            {logs.length > 0 ? (
              (showAllLogs ? logs : logs.slice(0, 3)).map((log) => {
                const colorClass =
                  log.type === 'emergency'
                    ? 'text-rose-400 bg-rose-950/20 border-rose-900/30'
                    : log.type === 'alert'
                    ? 'text-amber-400 bg-amber-950/20 border-amber-900/30'
                    : log.type === 'ai'
                    ? 'text-sky-400 bg-sky-950/20 border-sky-900/30'
                    : log.type === 'action'
                    ? 'text-emerald-400 bg-emerald-950/20 border-emerald-900/30'
                    : 'text-slate-300 bg-slate-950/40 border-slate-900';
                return (
                  <div key={log.id} className={`px-2 py-1 rounded border flex items-center gap-3 ${colorClass}`}>
                    <span className="text-slate-500 shrink-0">{log.timestamp}</span>
                    <span className="truncate">{log.text}</span>
                  </div>
                );
              })
            ) : (
              <div className="text-slate-500 italic p-2">Monitoring network…</div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
