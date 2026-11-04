import React from 'react';
import { TrafficZone } from '../types/traffic';
import { getAqiColor } from '../utils/trafficAlgorithms';

interface ZonesPanelProps {
  zones: TrafficZone[];
  selectedZoneId: number;
  onSelectZone: (zoneId: number) => void;
  onToggleAction: (action: 'diversion' | 'extendGreens' | 'lez' | 'purifiers' | 'clear') => void;
}

export const ZonesPanel: React.FC<ZonesPanelProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  onToggleAction,
}) => {
  const currentZone = zones.find((z) => z.id === selectedZoneId) || zones[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-slate-400">
        Kolkata Municipal &amp; Traffic Police administrative zones. Tap a zone row to inspect or apply tactical traffic interventions.
      </div>

      {/* Zone list rows */}
      <div className="flex flex-col gap-1.5 max-h-[220px] overflow-y-auto pr-1">
        {zones.map((zone) => {
          const isSelected = zone.id === selectedZoneId;
          const congPercent = Math.round(zone.congestion * 100);
          const barColor =
            zone.congestion > 0.6
              ? 'bg-rose-500'
              : zone.congestion > 0.35
              ? 'bg-amber-500'
              : 'bg-emerald-500';

          return (
            <div
              key={zone.id}
              onClick={() => onSelectZone(zone.id)}
              className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-all ${
                isSelected
                  ? 'bg-sky-500/15 border-sky-500/50 text-white'
                  : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:bg-slate-800/60'
              }`}
            >
              <div className="w-6 text-center font-mono text-xs font-semibold text-slate-400">
                Z{zone.id + 1}
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium flex items-center gap-1.5 truncate">
                  <span className="truncate">{zone.name}</span>
                  <span className="text-[10px] text-slate-400 shrink-0">({zone.bengaliName})</span>
                </div>
                {/* Micro badges for active interventions */}
                <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
                  {zone.diversion && <span className="text-sky-400">⤴ Diversion</span>}
                  {zone.extendGreens && <span className="text-indigo-400">⏱ Ext Greens</span>}
                  {zone.lez && <span className="text-emerald-400">♻ LEZ</span>}
                  {zone.purifiers && <span className="text-cyan-400">🌀 Mist Purifier</span>}
                  {!zone.diversion && !zone.extendGreens && !zone.lez && !zone.purifiers && (
                    <span className="text-slate-500">Normal operations</span>
                  )}
                </div>
              </div>

              {/* Congestion progress bar */}
              <div className="w-24 flex flex-col gap-0.5 shrink-0">
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span>Congestion</span>
                  <span>{congPercent}%</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${barColor} transition-all duration-300`}
                    style={{ width: `${Math.min(100, congPercent)}%` }}
                  />
                </div>
              </div>

              {/* AQI indicator */}
              <div
                className="w-12 text-center text-xs font-mono font-bold px-1.5 py-0.5 rounded shrink-0 border"
                style={{
                  color: getAqiColor(zone.aqi),
                  borderColor: `${getAqiColor(zone.aqi)}40`,
                  backgroundColor: `${getAqiColor(zone.aqi)}15`,
                }}
              >
                {zone.aqi}
              </div>
            </div>
          );
        })}
      </div>

      {/* Selected zone details & tactical actions */}
      <div className="bg-slate-900/90 rounded-xl p-3 border border-slate-800 flex flex-col gap-2.5">
        <div className="flex items-center justify-between text-xs">
          <div>
            <span className="text-slate-400">Selected Zone: </span>
            <span className="font-semibold text-white">
              Z{currentZone.id + 1} - {currentZone.name}
            </span>
          </div>
          <span className="text-slate-400 font-mono text-[11px]">
            Station: {currentZone.stationName}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          <button
            onClick={() => onToggleAction('diversion')}
            className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-all text-center ${
              currentZone.diversion
                ? 'bg-sky-600 border-sky-500 text-white shadow-md shadow-sky-900/40'
                : 'bg-slate-800/80 hover:bg-slate-800 border-slate-700 text-slate-300'
            }`}
          >
            ⤴ Divert Traffic
          </button>

          <button
            onClick={() => onToggleAction('extendGreens')}
            className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-all text-center ${
              currentZone.extendGreens
                ? 'bg-indigo-600 border-indigo-500 text-white shadow-md shadow-indigo-900/40'
                : 'bg-slate-800/80 hover:bg-slate-800 border-slate-700 text-slate-300'
            }`}
          >
            ⏱ Extend Greens
          </button>

          <button
            onClick={() => onToggleAction('lez')}
            className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-all text-center ${
              currentZone.lez
                ? 'bg-emerald-600 border-emerald-500 text-white shadow-md shadow-emerald-900/40'
                : 'bg-slate-800/80 hover:bg-slate-800 border-slate-700 text-slate-300'
            }`}
          >
            ♻ Low-Emission Zone
          </button>

          <button
            onClick={() => onToggleAction('purifiers')}
            className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-all text-center ${
              currentZone.purifiers
                ? 'bg-cyan-600 border-cyan-500 text-white shadow-md shadow-cyan-900/40'
                : 'bg-slate-800/80 hover:bg-slate-800 border-slate-700 text-slate-300'
            }`}
          >
            🌀 Smog Cannons
          </button>

          <button
            onClick={() => onToggleAction('clear')}
            className="px-2.5 py-2 text-xs font-medium rounded-lg border border-slate-700 bg-slate-800/50 hover:bg-slate-800 text-slate-400 hover:text-white transition-all text-center col-span-2 sm:col-span-1"
          >
            ↻ Reset Zone
          </button>
        </div>

        <div className="text-[11px] text-slate-400 italic">
          * Tactical actions apply immediately to all intersections in Z{currentZone.id + 1}. Traffic Diversion redirects vehicles to bypass ring roads, LEZ cuts heavy vehicle emissions by 40%, and Mist Purifiers accelerate AQI restoration 2.5× faster.
        </div>
      </div>
    </div>
  );
};
