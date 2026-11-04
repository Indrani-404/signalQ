import React, { useEffect, useMemo, useRef } from 'react';
import { AIRecommendation, RecPriority, TrafficZone, ZoneForecast } from '../types/traffic';
import { holtDampedTrend } from '../utils/trafficAlgorithms';

interface AIPredictorPanelProps {
  zones: TrafficZone[];
  selectedZoneId: number;
  onSelectZone: (zoneId: number) => void;
  congestionHistory: number[][]; // [zoneId][samples]
  aqiHistory: number[][]; // [zoneId][samples]
  forecasts: ZoneForecast[];
  recommendations: AIRecommendation[];
  autopilot: boolean;
  onApplyOne: (rec: AIRecommendation) => void;
  onApplyAll: () => void;
  onRefresh: () => void;
  onToggleAutopilot: () => void;
}

const PRIORITY_STYLE: Record<RecPriority, { badge: string; border: string; label: string }> = {
  critical: { badge: 'bg-rose-600 text-white', border: 'border-rose-500/50 bg-rose-950/30', label: 'Urgent' },
  high: { badge: 'bg-orange-500 text-slate-950', border: 'border-orange-500/40 bg-orange-950/20', label: 'High' },
  medium: { badge: 'bg-amber-400 text-slate-950', border: 'border-amber-500/30 bg-amber-950/10', label: 'Medium' },
  low: { badge: 'bg-slate-600 text-slate-100', border: 'border-slate-700 bg-slate-900/60', label: 'Info' },
};

const TREND_ICON = { rising: '↗', falling: '↘', stable: '→' } as const;

export const AIPredictorPanel: React.FC<AIPredictorPanelProps> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  congestionHistory,
  aqiHistory,
  forecasts,
  recommendations,
  autopilot,
  onApplyOne,
  onApplyAll,
  onRefresh,
  onToggleAutopilot,
}) => {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const zone = zones.find((z) => z.id === selectedZoneId) || zones[0];
  const selForecast = forecasts.find((f) => f.zoneId === zone.id);

  const cHist = congestionHistory[zone.id] || [];
  const aHist = aqiHistory[zone.id] || [];
  const cForecast = useMemo(() => holtDampedTrend(cHist, 10), [cHist]);
  const aForecast = useMemo(() => holtDampedTrend(aHist.map((v) => v / 300), 10), [aHist]);

  const actionable = recommendations.filter((r) => r.action.kind !== 'none');
  const urgent = recommendations.filter((r) => r.priority === 'critical' || r.priority === 'high').length;

  // Forecast chart for the selected zone
  useEffect(() => {
    const cv = chartRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (w === 0 || h === 0) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const H = 40;
    const F = 10;
    const tot = H + F;
    const X = (i: number) => (i / (tot - 1)) * w;
    const Y = (v: number) => h - 14 - Math.min(1, Math.max(0, v)) * (h - 28);

    // light grid
    ctx.strokeStyle = 'rgba(100,116,139,0.15)';
    ctx.lineWidth = 1;
    for (const g of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, Y(g));
      ctx.lineTo(w, Y(g));
      ctx.stroke();
    }

    const splitX = X(H - 1);
    ctx.strokeStyle = 'rgba(100,116,139,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(splitX, 0);
    ctx.lineTo(splitX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Past', splitX - 6, 11);
    ctx.textAlign = 'left';
    ctx.fillText('Forecast', splitX + 6, 11);

    const series = (hist: number[], fore: number[], color: string) => {
      if (hist.length < 2) return;
      const offset = H - hist.length;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      hist.forEach((v, i) => {
        const x = X(i + offset);
        const y = Y(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(X(H - 1), Y(hist[hist.length - 1]));
      fore.forEach((v, i) => ctx.lineTo(X(H + i), Y(v)));
      ctx.stroke();
      ctx.setLineDash([]);
    };

    series(cHist.slice(-H), cForecast.forecast, '#38bdf8');
    series(aHist.slice(-H).map((v) => Math.min(1, v / 300)), aForecast.forecast, '#f59e0b');
    ctx.restore();
  }, [cHist, aHist, cForecast, aForecast]);

  return (
    <div className="flex flex-col gap-3">
      {/* Summary */}
      <div
        className={`rounded-xl p-3 border flex items-center gap-3 ${
          urgent > 0 ? 'bg-amber-950/20 border-amber-500/30' : actionable.length > 0 ? 'bg-sky-950/20 border-sky-500/30' : 'bg-emerald-950/20 border-emerald-500/30'
        }`}
      >
        <span className="text-2xl">{urgent > 0 ? '⚠️' : actionable.length > 0 ? '💡' : '✅'}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">
            {actionable.length > 0
              ? `${actionable.length} recommended action${actionable.length > 1 ? 's' : ''}`
              : 'Network is stable'}
          </div>
          <div className="text-[11px] text-slate-400">
            Forecast from the last minute of congestion and AQI trends. Updates every few seconds.
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="px-2.5 py-1 text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 shrink-0"
        >
          Refresh
        </button>
      </div>

      {/* Recommendations */}
      <div className="flex flex-col gap-2">
        {recommendations.length === 0 && (
          <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-500">
            Analysing the network…
          </div>
        )}
        {recommendations.map((rec) => {
          const st = PRIORITY_STYLE[rec.priority];
          return (
            <div key={rec.id} className={`rounded-lg border p-2.5 flex flex-col gap-1.5 ${st.border}`}>
              <div className="flex items-start gap-2">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${st.badge}`}>{st.label}</span>
                <div className="text-xs font-semibold text-slate-100 leading-snug">{rec.title}</div>
              </div>
              <div className="text-[11px] text-slate-300 leading-snug">{rec.reason}</div>
              <div className="text-[11px] text-slate-400 leading-snug">{rec.impact}</div>
              {rec.action.kind !== 'none' && (
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  {rec.zoneId >= 0 ? (
                    <button
                      onClick={() => onSelectZone(rec.zoneId)}
                      className="text-[11px] text-slate-400 hover:text-white underline"
                    >
                      View zone
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    onClick={() => onApplyOne(rec)}
                    className="px-3 py-1 text-[11px] font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded-lg transition-colors"
                  >
                    {rec.actionLabel || 'Apply'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onApplyAll}
          disabled={actionable.length === 0}
          className="px-3 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:hover:bg-sky-600 text-white rounded-lg border border-sky-500 transition-colors"
        >
          Apply all{actionable.length > 0 ? ` (${actionable.length})` : ''}
        </button>
        <button
          onClick={onToggleAutopilot}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
            autopilot
              ? 'bg-emerald-600 border-emerald-500 text-white'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
          }`}
        >
          🤖 Autopilot {autopilot ? 'ON' : 'OFF'}
        </button>
        <span className="text-[10px] text-slate-500">
          {autopilot ? 'Applies the top fixes automatically.' : 'Turn on to apply fixes automatically.'}
        </span>
      </div>

      {/* Zone outlook */}
      <div className="flex flex-col gap-1.5 pt-1">
        <div className="text-[11px] font-semibold text-slate-300">Zone outlook</div>
        {forecasts.map((f) => {
          const selected = f.zoneId === zone.id;
          const cong = Math.round(f.congestionPeak * 100);
          const color = f.congestionPeak > 0.6 ? 'bg-rose-500' : f.congestionPeak > 0.4 ? 'bg-amber-500' : 'bg-emerald-500';
          return (
            <button
              key={f.zoneId}
              onClick={() => onSelectZone(f.zoneId)}
              className={`text-left rounded-lg border px-2.5 py-1.5 transition-colors ${
                selected ? 'bg-sky-500/10 border-sky-500/40' : 'bg-slate-900/50 border-slate-800 hover:bg-slate-800/60'
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-slate-200">{f.name}</span>
                <span className="font-mono text-slate-400 shrink-0">
                  {Math.round(f.congestionNow * 100)}% → <b className="text-slate-100">{cong}%</b> {TREND_ICON[f.trend]}
                </span>
              </div>
              <div className="h-1 mt-1 rounded-full bg-slate-800 overflow-hidden">
                <div className={`h-full ${color}`} style={{ width: `${Math.min(100, cong)}%` }} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Chart for selected zone */}
      <div className="bg-slate-900/90 rounded-xl p-3 border border-slate-800 flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-white truncate">{zone.name}</span>
          {selForecast && <span className="font-mono text-[11px] text-slate-400">Confidence {selForecast.confidence}%</span>}
        </div>
        <canvas ref={chartRef} className="w-full h-[120px] rounded-lg bg-slate-950 border border-slate-800" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono">
          <span className="text-sky-400">
            ● Congestion {Math.round(zone.congestion * 100)}% → {Math.round((selForecast?.congestionPeak ?? zone.congestion) * 100)}%
          </span>
          <span className="text-amber-400">
            ● AQI {zone.aqi} → {selForecast?.aqiPeak ?? zone.aqi}
          </span>
          <span className="text-slate-500">Dashed = forecast</span>
        </div>
      </div>
    </div>
  );
};
