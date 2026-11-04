import React, { useEffect, useMemo, useState } from 'react';
import { KolkataNode } from '../types/traffic';
import { KOLKATA_HOSPITALS } from '../data/kolkataData';
import { calculateDistanceKm } from '../utils/trafficAlgorithms';
import { sirenPlayer } from '../utils/sirenAudio';

interface HospitalQuickBarProps {
  nodes: KolkataNode[];
  selectedNodeId: number;
  onDispatchRoute: (startId: number, endId: number, routeTitle: string) => void;
  isAmbulanceActive: boolean;
  onSelectHospitalNode?: (nodeId: number) => void;
}

// Rough road-distance and time guess before a route exists (the live ETA replaces it once dispatched)
const guessMinutes = (straightKm: number) => Math.max(1, Math.round(((straightKm * 1.35) / 55) * 60));

export const HospitalQuickBar: React.FC<HospitalQuickBarProps> = ({
  nodes,
  selectedNodeId,
  onDispatchRoute,
  isAmbulanceActive,
  onSelectHospitalNode,
}) => {
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const origin = useMemo(() => nodes.find((n) => n.id === selectedNodeId) || nodes[0], [nodes, selectedNodeId]);

  useEffect(() => {
    if (isAmbulanceActive && soundEnabled) sirenPlayer.start();
    else sirenPlayer.stop();
  }, [isAmbulanceActive, soundEnabled]);

  const hospitals = useMemo(() => {
    if (!origin) return [];
    return KOLKATA_HOSPITALS.map((h) => ({
      ...h,
      distanceKm: calculateDistanceKm(origin.lat, origin.lng, h.lat, h.lng),
    })).sort((a, b) => a.distanceKm - b.distanceKm);
  }, [origin]);

  const nearest = hospitals[0];
  if (!origin || !nearest) return null;

  const dispatch = (h: (typeof hospitals)[number]) => {
    // If the origin junction *is* the hospital's junction there is nothing to route
    onDispatchRoute(origin.id, h.nearestNodeId, `${origin.name.split('/')[0].trim()} → ${h.name.split('/')[0].trim()}`);
  };

  return (
    <div className="bg-slate-900/95 rounded-xl p-3 border border-rose-900/40 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-rose-300">
          <span>🚑</span>
          <span>Ambulance dispatch</span>
          {isAmbulanceActive && (
            <span className="text-[10px] font-mono font-bold text-emerald-300 bg-emerald-950/70 border border-emerald-500/40 px-1.5 py-0.5 rounded animate-pulse">
              EN ROUTE
            </span>
          )}
        </div>
        <button
          onClick={() => setSoundEnabled((v) => !v)}
          className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
            soundEnabled ? 'bg-rose-950 text-rose-300 border-rose-600/70' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
          }`}
        >
          {soundEnabled ? '🔊 Siren on' : '🔇 Siren off'}
        </button>
      </div>

      {/* One-tap: nearest hospital */}
      <div className="rounded-lg border border-rose-500/30 bg-rose-950/20 p-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] text-slate-400">
            From <b className="text-sky-300">{origin.name}</b> (tap a junction on the map to change)
          </div>
          <div className="text-sm font-semibold text-white truncate">
            🏥 {nearest.name}
            <span className="ml-2 text-[11px] font-mono font-normal text-emerald-400">
              {nearest.distanceKm} km · ~{guessMinutes(nearest.distanceKm)} min
            </span>
          </div>
        </div>
        <button
          onClick={() => dispatch(nearest)}
          className="px-4 py-2 text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white rounded-lg shadow-lg shadow-rose-950/50 transition-colors shrink-0"
        >
          {isAmbulanceActive ? 'Re-dispatch to nearest' : 'Dispatch to nearest'}
        </button>
      </div>

      <button onClick={() => setShowAll((v) => !v)} className="self-start text-[11px] text-sky-400 hover:text-sky-300">
        {showAll ? 'Hide other hospitals' : `Choose another hospital (${hospitals.length - 1})`}
      </button>

      {showAll && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-[200px] overflow-y-auto pr-1">
          {hospitals.slice(1).map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-slate-800 bg-slate-950/70">
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-200 truncate">{h.name}</div>
                <div className="text-[10px] text-slate-400">
                  {h.distanceKm} km · ICU {h.icuAvailable}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {onSelectHospitalNode && (
                  <button onClick={() => onSelectHospitalNode(h.nearestNodeId)} className="text-[10px] text-slate-400 hover:text-white underline">
                    Map
                  </button>
                )}
                <button onClick={() => dispatch(h)} className="text-[11px] font-bold text-rose-400 hover:text-rose-300">
                  Send →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
