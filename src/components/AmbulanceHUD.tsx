import React from 'react';
import { AmbulanceTelemetry } from '../types/traffic';
import { formatClock, formatMinutes } from '../utils/eta';

interface Props {
  telemetry: AmbulanceTelemetry | null;
  follow: boolean;
  onToggleFollow: () => void;
}

const SIGNAL_STYLE: Record<AmbulanceTelemetry['nextSignalLabel'], string> = {
  'GREEN (PREEMPTED)': 'text-emerald-300 bg-emerald-950/70 border-emerald-500/50',
  GREEN: 'text-emerald-300 bg-emerald-950/50 border-emerald-700/50',
  RED: 'text-rose-300 bg-rose-950/60 border-rose-600/60',
};

export const AmbulanceHUD: React.FC<Props> = ({ telemetry: t, follow, onToggleFollow }) => {
  if (!t) return null;
  const recent = t.lastReroute && Date.now() - t.lastReroute.at < 12000;

  return (
    <div className="absolute top-14 left-3 z-30 w-[236px] pointer-events-auto rounded-xl border border-rose-500/40 bg-slate-950/90 backdrop-blur-md shadow-2xl text-[11px] text-slate-200">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="font-bold text-rose-300 tracking-wide flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
          AMBULANCE LIVE
        </span>
        <button
          onClick={onToggleFollow}
          className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${
            follow ? 'bg-sky-600 border-sky-400 text-white' : 'bg-slate-800 border-slate-600 text-slate-300'
          }`}
        >
          {follow ? '◎ Following' : '○ Follow'}
        </button>
      </div>

      <div className="px-3 pt-1.5">
        <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-rose-500 to-amber-400" style={{ width: `${Math.round(t.progress * 100)}%` }} />
        </div>
        <div className="flex items-end justify-between mt-1.5">
          <div>
            <div className="text-[10px] text-slate-400 uppercase">Arrives in</div>
            <div className="font-mono text-2xl font-bold text-white leading-none tabular-nums">{formatClock(t.etaSec)}</div>
            <div className="text-[10px] text-slate-400 mt-0.5">≈ {formatMinutes(t.etaRealMin)} real-world</div>
          </div>
          <div className="text-right font-mono text-slate-300 leading-tight">
            <div>{t.remainingKm.toFixed(1)} km left</div>
            <div>{t.speedKmh} km/h</div>
            <div className="text-slate-500 text-[10px]">elapsed {formatClock(t.elapsedSec)}</div>
          </div>
        </div>
      </div>

      <div className="px-3 pt-2">
        <div className="text-[10px] text-slate-400 uppercase">Next signal · {t.nextDistanceM} m</div>
        <div className={`mt-0.5 px-2 py-1 rounded border flex items-center justify-between gap-2 ${SIGNAL_STYLE[t.nextSignalLabel]}`}>
          <span className="truncate font-medium">{t.nextNodeName}</span>
          <span className="font-mono font-bold shrink-0">{t.nextSignalLabel}</span>
        </div>
      </div>

      {t.corridor.length > 1 && (
        <div className="px-3 pt-2 flex flex-col gap-0.5">
          <div className="text-[10px] text-slate-400 uppercase">Corridor ahead</div>
          {t.corridor.slice(1).map((c) => (
            <div key={c.id} className="flex items-center justify-between">
              <span className="truncate max-w-[140px]">{c.name}</span>
              <span
                className={`font-mono text-[10px] ${
                  c.state === 'cleared' ? 'text-emerald-400' : c.state === 'locked' ? 'text-rose-400' : 'text-slate-400'
                }`}
              >
                {c.state === 'cleared' ? '● cleared' : c.state === 'locked' ? '● LOCKED' : '○ pending'} · {c.distanceKm.toFixed(1)}km
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 py-2 flex items-center justify-between text-[10px] text-slate-400 border-t border-slate-800 mt-2">
        <span>
          Signals cleared: <b className="text-emerald-400">{t.signalsCleared}</b>
        </span>
        <span>
          Reroutes: <b className={t.reroutes > 0 ? 'text-amber-400' : 'text-slate-300'}>{t.reroutes}</b>
        </span>
      </div>

      {t.lastReroute && (
        <div className={`mx-3 mb-2 px-2 py-1 rounded text-[10px] leading-snug border ${recent ? 'bg-amber-950/70 border-amber-500/60 text-amber-200' : 'bg-slate-900 border-slate-700 text-slate-400'}`}>
          🔀 {t.lastReroute.reason}
        </div>
      )}
    </div>
  );
};
