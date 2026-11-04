import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  LANE_NAMES,
  LANE_SHORT,
  LANE_APPROACH,
  LANE_MOVEMENT,
  lanesConflict,
  CONFLICT_EDGES,
  LANE_PHASES,
  NUM_PHASES,
  PHASE_COLORS,
  phaseAxis,
} from '../utils/trafficAlgorithms';
import { KolkataNode } from '../types/traffic';

interface LaneConflictViewProps {
  selectedNode: KolkataNode | undefined;
  nodeState: { ph: number; preempted: boolean; manual: boolean } | undefined;
  onApplyManualPhase: (nodeId: number, axis: number) => void;
  onReleaseNode: (nodeId: number) => void;
  onLog: (msg: string) => void;
}

interface LaneCar {
  d: number; // distance back from the stop line (world units)
  amb: boolean;
}

interface InFlightCar {
  i: number; // lane index
  p: number; // progress across the junction (0..1 inside the box, >1 leaving it)
  amb: boolean;
}

// ---------------------------------------------------------------------------
// Junction geometry, in a fixed 260 x 260 "world" that is scaled to fit the canvas.
// Traffic drives on the LEFT (Kolkata): each approach keeps to its own left-hand side,
// the through lane is the outer (kerb) lane and the right-turn lane is next to the centre line.
// ---------------------------------------------------------------------------
const WORLD = 260;
const SS = 36; // stop line distance from the centre
const OFFSETS = [24, 8]; // lane offset from centre: [through, right-turn]
const FORWARD = [
  [0, 1], // N approach travels south (+y)
  [0, -1], // S approach travels north
  [-1, 0], // E approach travels west
  [1, 0], // W approach travels east
];

const laneBasis = (i: number) => {
  const f = FORWARD[LANE_APPROACH[i]];
  const fx = f[0];
  const fy = f[1];
  return { fx, fy, lx: fy, ly: -fx, off: OFFSETS[LANE_MOVEMENT[i]] }; // l = driver's left-hand side
};

/** Position of a queued car, `d` units back from the stop line. */
const queuePos = (i: number, d: number) => {
  const b = laneBasis(i);
  return { x: -b.fx * (SS + d) + b.lx * b.off, y: -b.fy * (SS + d) + b.ly * b.off };
};

/** Position of a car that is crossing (or leaving) the junction. */
const crossingPos = (c: InFlightCar) => {
  const b = laneBasis(c.i);
  const x0 = -b.fx * SS + b.lx * b.off;
  const y0 = -b.fy * SS + b.ly * b.off;
  if (LANE_MOVEMENT[c.i] === 0) {
    return { x: x0 + b.fx * 2 * SS * c.p, y: y0 + b.fy * 2 * SS * c.p };
  }
  // Right turn: curve through the centre onto the exit arm, keeping left on the new road
  const rx = -b.fy;
  const ry = b.fx; // direction of the turn
  const x2 = rx * SS + ry * 8; // exit point; the driver's left of (rx, ry) is (ry, -rx)
  const y2 = ry * SS + -rx * 8;
  if (c.p > 1) {
    return { x: x2 + rx * (c.p - 1) * 2 * SS, y: y2 + ry * (c.p - 1) * 2 * SS };
  }
  const t = c.p;
  const u = 1 - t;
  return { x: u * u * x0 + t * t * x2, y: u * u * y0 + t * t * y2 };
};

const AXIS_NAME = ['North–South', 'East–West'];

export const LaneConflictView: React.FC<LaneConflictViewProps> = ({
  selectedNode,
  nodeState,
  onApplyManualPhase,
  onReleaseNode,
  onLog,
}) => {
  const interCanvasRef = useRef<HTMLCanvasElement>(null);
  const graphCanvasRef = useRef<HTMLCanvasElement>(null);

  const [selectedLane, setSelectedLane] = useState<number>(-1);
  const [activePhase, setActivePhase] = useState<number>(0);
  const [autoCycle, setAutoCycle] = useState<boolean>(true);
  const [emergencyLane, setEmergencyLane] = useState<number>(-1);

  // Everything the animation loop reads goes through refs, so it never works on stale values.
  const activePhaseRef = useRef(activePhase);
  activePhaseRef.current = activePhase;
  const autoCycleRef = useRef(autoCycle);
  autoCycleRef.current = autoCycle;
  const emergencyLaneRef = useRef(emergencyLane);
  emergencyLaneRef.current = emergencyLane;
  const selectedLaneRef = useRef(selectedLane);
  selectedLaneRef.current = selectedLane;
  const nodeNameRef = useRef(selectedNode?.name ?? 'Junction');
  nodeNameRef.current = selectedNode?.name ?? 'Junction';

  const laneQueuesRef = useRef<LaneCar[][]>(Array.from({ length: 8 }, () => []));
  const inFlightRef = useRef<InFlightCar[]>([]);
  const cycleTimerRef = useRef(0);

  // New junction selected -> fresh queues and automatic cycling
  useEffect(() => {
    laneQueuesRef.current = Array.from({ length: 8 }, () => []);
    inFlightRef.current = [];
    cycleTimerRef.current = 0;
    setSelectedLane(-1);
    setEmergencyLane(-1);
    setAutoCycle(true);
    setActivePhase(0);
  }, [selectedNode?.id]);

  // ---- drawing -------------------------------------------------------------
  const sizeCanvas = (cv: HTMLCanvasElement) => {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (w === 0 || h === 0) return null;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  };

  const drawJunction = () => {
    const cv = interCanvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dim = sizeCanvas(cv);
    if (!dim) return;
    const { w, h, dpr } = dim;
    const sc = Math.min(w, h) / WORLD;
    const phase = activePhaseRef.current;
    const sel = selectedLaneRef.current;
    const emg = emergencyLaneRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Caption (screen space)
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const greens = LANE_SHORT.filter((_, i) => LANE_PHASES[i] === phase).join(' + ');
    ctx.fillText(`Phase P${phase + 1} green: ${greens}`, 8, 15);
    if (emg >= 0) {
      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText('Ambulance priority: conflicting lanes held red', 8, 30);
    }

    // World space
    ctx.translate(w / 2, h / 2);
    ctx.scale(sc, sc);
    const reach = Math.max(w, h) / sc;

    // Roads
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(-reach, -SS, reach * 2, SS * 2);
    ctx.fillRect(-SS, -reach, SS * 2, reach * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(-SS, -SS, SS * 2, SS * 2);

    // Centre lines
    ctx.strokeStyle = 'rgba(148,163,184,0.45)';
    ctx.lineWidth = 1 / sc;
    ctx.setLineDash([5 / sc, 4 / sc]);
    ctx.beginPath();
    ctx.moveTo(0, -reach);
    ctx.lineTo(0, -SS);
    ctx.moveTo(0, SS);
    ctx.lineTo(0, reach);
    ctx.moveTo(-reach, 0);
    ctx.lineTo(-SS, 0);
    ctx.moveTo(SS, 0);
    ctx.lineTo(reach, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Stop bars, lane labels, selection rings
    for (let i = 0; i < 8; i++) {
      const b = laneBasis(i);
      const p = queuePos(i, 0);
      const isGreen = LANE_PHASES[i] === phase;
      const px = -b.fy; // bar runs across the lane
      const py = b.fx;

      ctx.strokeStyle = isGreen ? (emg === i ? '#f59e0b' : '#22c55e') : '#ef4444';
      ctx.lineWidth = 4 / sc;
      ctx.beginPath();
      ctx.moveTo(p.x - px * 8, p.y - py * 8);
      ctx.lineTo(p.x + px * 8, p.y + py * 8);
      ctx.stroke();

      if (sel >= 0 && (i === sel || lanesConflict(i, sel))) {
        ctx.strokeStyle = i === sel ? '#38bdf8' : '#ef4444';
        ctx.lineWidth = 2 / sc;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.stroke();
      }

      const lp = queuePos(i, 90);
      ctx.fillStyle = i === sel ? '#38bdf8' : '#94a3b8';
      ctx.font = `bold ${11 / sc}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(LANE_SHORT[i], lp.x, lp.y);
    }

    const drawCar = (x: number, y: number, amb: boolean, lane: number) => {
      ctx.beginPath();
      ctx.arc(x, y, amb ? 6.5 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = amb ? '#ef4444' : PHASE_COLORS[LANE_PHASES[lane] % 4];
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1 / sc;
      ctx.stroke();
    };

    laneQueuesRef.current.forEach((q, i) => {
      q.forEach((car) => {
        const pt = queuePos(i, car.d);
        drawCar(pt.x, pt.y, car.amb, i);
      });
    });
    inFlightRef.current.forEach((c) => {
      const pt = crossingPos(c);
      drawCar(pt.x, pt.y, c.amb, c.i);
    });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  const graphPoint = (i: number, w: number, h: number): [number, number, number] => {
    const R = Math.min(w, h) * 0.34;
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const nodeR = Math.max(13, Math.min(20, R * 0.2));
    return [w / 2 + Math.cos(angle) * R, h / 2 + Math.sin(angle) * R, nodeR];
  };

  const drawGraph = () => {
    const cv = graphCanvasRef.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dim = sizeCanvas(cv);
    if (!dim) return;
    const { w, h, dpr } = dim;
    const phase = activePhaseRef.current;
    const sel = selectedLaneRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Conflict edges
    for (const [a, b] of CONFLICT_EDGES) {
      const hl = sel >= 0 && (a === sel || b === sel);
      const [ax, ay] = graphPoint(a, w, h);
      const [bx, by] = graphPoint(b, w, h);
      ctx.strokeStyle = hl ? '#ef4444' : 'rgba(100,116,139,0.28)';
      ctx.lineWidth = hl ? 2.5 : 1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Lane nodes
    for (let i = 0; i < 8; i++) {
      const [nx, ny, r] = graphPoint(i, w, h);
      const isGreen = LANE_PHASES[i] === phase;
      const isSel = sel === i;
      const isConf = sel >= 0 && lanesConflict(i, sel);

      ctx.globalAlpha = isGreen || isSel || isConf ? 1 : 0.5;
      ctx.beginPath();
      ctx.arc(nx, ny, r, 0, Math.PI * 2);
      ctx.fillStyle = PHASE_COLORS[LANE_PHASES[i] % 4];
      ctx.fill();
      if (isGreen) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      if (isSel || isConf) {
        ctx.strokeStyle = isSel ? '#ffffff' : '#ef4444';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(nx, ny, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(LANE_SHORT[i], nx, ny);
    }

    // Centre label
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${NUM_PHASES} phases needed`, w / 2, h / 2 - 4);
    ctx.fillStyle = PHASE_COLORS[phase % 4];
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText(`Now: P${phase + 1}`, w / 2, h / 2 + 12);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  // ---- simulation + render loop -------------------------------------------
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const loop = (time: number) => {
      const dt = Math.min(0.05, (time - last) / 1000);
      last = time;

      // Automatic phase cycling
      if (autoCycleRef.current && emergencyLaneRef.current === -1) {
        cycleTimerRef.current += dt;
        if (cycleTimerRef.current > 3.5) {
          cycleTimerRef.current = 0;
          const next = (activePhaseRef.current + 1) % NUM_PHASES;
          activePhaseRef.current = next;
          setActivePhase(next);
        }
      }

      const phase = activePhaseRef.current;
      const queues = laneQueuesRef.current;
      const inFlight = inFlightRef.current;

      for (let i = 0; i < 8; i++) {
        const q = queues[i];

        // Random arrivals at the back of the queue
        if (Math.random() < dt * 0.5 && q.length < 5) {
          const tail = q.length > 0 ? q[q.length - 1].d : 80;
          if (tail < 66) q.push({ d: 80, amb: false });
        }

        // Advance toward the stop line, keeping a gap to the car ahead
        for (let k = 0; k < q.length; k++) {
          const minD = k === 0 ? 0 : q[k - 1].d + 13;
          q[k].d = Math.max(minD, q[k].d - 65 * dt);
        }

        // Enter the junction on green, but only if no conflicting car is still crossing
        if (q.length > 0 && q[0].d <= 0.8 && LANE_PHASES[i] === phase) {
          const clear = !inFlight.some((c) => c.i !== i && lanesConflict(c.i, i) && c.p < 1);
          if (clear) {
            const car = q.shift()!;
            inFlight.push({ i, p: 0, amb: car.amb });
          }
        }
      }

      for (const c of inFlight) c.p += dt * 0.95;
      inFlightRef.current = inFlight.filter((c) => c.p < 1.9);

      // Ambulance has cleared the junction -> release priority and go back to automatic cycling
      if (emergencyLaneRef.current >= 0) {
        const ambPresent =
          queues.some((q) => q.some((c) => c.amb)) || inFlightRef.current.some((c) => c.amb);
        if (!ambPresent) {
          emergencyLaneRef.current = -1;
          autoCycleRef.current = true;
          cycleTimerRef.current = 0;
          setEmergencyLane(-1);
          setAutoCycle(true);
        }
      }

      drawJunction();
      drawGraph();
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- interaction ---------------------------------------------------------
  const selectLane = useCallback(
    (lane: number) => {
      setSelectedLane(lane);
      const conflicts = LANE_SHORT.filter((_, idx) => lanesConflict(idx, lane));
      onLog(`Lane ${LANE_SHORT[lane]} (${LANE_NAMES[lane]}) conflicts with ${conflicts.join(', ')}`);
    },
    [onLog]
  );

  const onJunctionClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = interCanvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const sc = Math.min(r.width, r.height) / WORLD;
    const x = (e.clientX - r.left - r.width / 2) / sc;
    const y = (e.clientY - r.top - r.height / 2) / sc;
    let best = -1;
    let bestDist = 22;
    for (let i = 0; i < 8; i++) {
      for (const d of [0, 20, 40, 60, 80]) {
        const pt = queuePos(i, d);
        const dist = Math.hypot(pt.x - x, pt.y - y);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
    }
    if (best >= 0) selectLane(best);
  };

  const onGraphClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = graphCanvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = -1;
    let bestDist = 28;
    for (let i = 0; i < 8; i++) {
      const [px, py] = graphPoint(i, r.width, r.height);
      const d = Math.hypot(px - x, py - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best >= 0) selectLane(best);
  };

  const holdPhase = (p: number) => {
    setAutoCycle(false);
    autoCycleRef.current = false;
    setEmergencyLane(-1);
    emergencyLaneRef.current = -1;
    setActivePhase(p);
    activePhaseRef.current = p;
  };

  const addCar = () => {
    const l = selectedLane >= 0 ? selectedLane : 0;
    const q = laneQueuesRef.current[l];
    if (q.length < 6) {
      q.push({ d: q.length ? Math.min(80, q[q.length - 1].d + 14) : 35, amb: false });
    }
  };

  const addAmbulance = () => {
    const l = selectedLane >= 0 ? selectedLane : 0;
    laneQueuesRef.current[l].unshift({ d: 30, amb: true });
    setAutoCycle(false);
    autoCycleRef.current = false;
    setEmergencyLane(l);
    emergencyLaneRef.current = l;
    setActivePhase(LANE_PHASES[l]);
    activePhaseRef.current = LANE_PHASES[l];
    onLog(`🚑 Ambulance in lane ${LANE_SHORT[l]}: phase P${LANE_PHASES[l] + 1} held, conflicting lanes red`);
  };

  const clearCars = () => {
    laneQueuesRef.current = Array.from({ length: 8 }, () => []);
    inFlightRef.current = [];
    setEmergencyLane(-1);
    emergencyLaneRef.current = -1;
    setAutoCycle(true);
    autoCycleRef.current = true;
  };

  // ---- live signal badge ---------------------------------------------------
  const live = (() => {
    if (!nodeState) return { text: 'Signal state unavailable', cls: 'text-slate-400 bg-slate-800 border-slate-700' };
    const dir = AXIS_NAME[nodeState.ph] ?? AXIS_NAME[0];
    if (nodeState.preempted) {
      return { text: `Ambulance green wave · ${dir} green`, cls: 'text-emerald-300 bg-emerald-950/70 border-emerald-500/50' };
    }
    if (nodeState.manual) {
      return { text: `Operator hold · ${dir} green`, cls: 'text-amber-300 bg-amber-950/60 border-amber-500/50' };
    }
    return { text: `Live on map · ${dir} green`, cls: 'text-sky-300 bg-sky-950/50 border-sky-600/40' };
  })();

  const lanePhaseLists = Array.from({ length: NUM_PHASES }, (_, p) =>
    LANE_SHORT.filter((_, i) => LANE_PHASES[i] === p).join(' + ')
  );

  return (
    <div className="flex flex-col gap-3 @container">
      {/* Junction header */}
      <div className="bg-slate-900/90 rounded-lg p-2.5 border border-slate-800 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="font-bold text-sm text-sky-400 truncate">{selectedNode ? selectedNode.name : 'Pick a junction on the map'}</div>
            {selectedNode?.bengaliName && <div className="text-[11px] text-slate-500">{selectedNode.bengaliName}</div>}
          </div>
          <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${live.cls}`}>{live.text}</span>
        </div>
        <div className="text-[11px] text-slate-400 leading-snug">
          Lanes that share a colour can be green together without crossing paths. Tap any lane to see what it conflicts with.
        </div>
      </div>

      {/* Visuals */}
      <div className="grid grid-cols-1 @lg:grid-cols-2 gap-3">
        <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800">
          <div className="text-[11px] font-semibold text-slate-300 mb-1 px-1">Junction view</div>
          <canvas
            ref={interCanvasRef}
            onClick={onJunctionClick}
            className="w-full aspect-square max-h-[300px] rounded-lg cursor-pointer bg-slate-950 border border-slate-800"
          />
        </div>
        <div className="bg-slate-900/90 rounded-xl p-2 border border-slate-800">
          <div className="text-[11px] font-semibold text-slate-300 mb-1 px-1 flex items-center justify-between">
            <span>Conflict graph</span>
            <span className="text-[10px] text-slate-500 font-normal">{CONFLICT_EDGES.length} conflicts</span>
          </div>
          <canvas
            ref={graphCanvasRef}
            onClick={onGraphClick}
            className="w-full aspect-square max-h-[300px] rounded-lg cursor-pointer bg-slate-950 border border-slate-800"
          />
        </div>
      </div>

      {/* Selected lane */}
      <div className="bg-slate-900/80 rounded-lg px-3 py-2 border border-slate-800/80 text-xs">
        {selectedLane >= 0 ? (
          <span className="text-slate-200">
            <b className="text-sky-400">
              {LANE_NAMES[selectedLane]} ({LANE_SHORT[selectedLane]})
            </b>{' '}
            runs in <b style={{ color: PHASE_COLORS[LANE_PHASES[selectedLane] % 4] }}>P{LANE_PHASES[selectedLane] + 1}</b>. Must wait
            for: <span className="text-rose-400 font-mono">{LANE_SHORT.filter((_, i) => lanesConflict(i, selectedLane)).join(', ')}</span>
          </span>
        ) : (
          <span className="text-slate-400">No lane selected.</span>
        )}
      </div>

      {/* Phase chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {lanePhaseLists.map((lanes, p) => (
          <button
            key={p}
            onClick={() => holdPhase(p)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors ${
              p === activePhase ? 'bg-sky-500/20 text-sky-200 border-sky-400/50' : 'text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
          >
            <span style={{ color: PHASE_COLORS[p % 4] }}>●</span> P{p + 1} {lanes}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => {
            setAutoCycle(!autoCycle);
            autoCycleRef.current = !autoCycle;
            setEmergencyLane(-1);
            emergencyLaneRef.current = -1;
          }}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            autoCycle ? 'bg-sky-600 border-sky-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300'
          }`}
        >
          {autoCycle ? 'Auto cycle' : 'Phase held'}
        </button>
        <button onClick={addCar} className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700">
          + Car
        </button>
        <button onClick={addAmbulance} className="px-3 py-1.5 text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white rounded-lg border border-rose-500">
          🚑 Ambulance
        </button>
        <button onClick={clearCars} className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700">
          Clear
        </button>
        {selectedNode && (
          <div className="flex gap-1.5 ml-auto">
            {nodeState?.manual && (
              <button
                onClick={() => onReleaseNode(selectedNode.id)}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg border border-amber-700/50"
              >
                Release hold
              </button>
            )}
            <button
              onClick={() => onApplyManualPhase(selectedNode.id, phaseAxis(activePhase))}
              className="px-3 py-1.5 text-xs font-medium bg-indigo-600/80 hover:bg-indigo-600 text-white rounded-lg border border-indigo-500/50"
              title="Hold this junction on the map on the same direction as the active phase"
            >
              Hold {AXIS_NAME[phaseAxis(activePhase)]} green on map
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
