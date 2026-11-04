import React, { useRef, useEffect } from 'react';
import { TrafficZone } from '../types/traffic';
import { getAqiColor, getAqiCategory } from '../utils/trafficAlgorithms';

interface AirQualityPanelProps {
  zones: TrafficZone[];
  selectedZoneId: number;
  aqiHistory: number[][]; // [zoneId][samples]
  cityAqiHistory: number[];
  onSelectZone: (zoneId: number) => void;
  onToggleAction: (action: 'lez' | 'purifiers' | 'diversion' | 'clear') => void;
}

export const AirQualityPanel: React.FC<AirQualityPanelProps> = ({
  zones,
  selectedZoneId,
  aqiHistory,
  cityAqiHistory,
  onSelectZone,
  onToggleAction,
}) => {
  const chartCanvasRef = useRef<HTMLCanvasElement>(null);
  const currentZone = zones.find((z) => z.id === selectedZoneId) || zones[0];
  const cityAvgAqi = Math.round(zones.reduce((acc, z) => acc + z.aqi, 0) / zones.length);

  useEffect(() => {
    const cv = chartCanvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (w === 0 || h === 0) return;

    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const history = aqiHistory[selectedZoneId] || [];
    if (history.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Accumulating environmental telemetry data...', w / 2, h / 2);
      ctx.restore();
      return;
    }

    // Draw baseline grid lines
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    for (let yVal = 50; yVal <= 300; yVal += 50) {
      const y = h - 6 - (yVal / 350) * (h - 12);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      ctx.fillStyle = '#64748b';
      ctx.font = '8px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`${yVal}`, 4, y - 2);
    }
    ctx.setLineDash([]);

    // Draw city average line in faint cyan
    if (cityAqiHistory.length >= 2) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      cityAqiHistory.forEach((v, idx) => {
        const x = (idx / (cityAqiHistory.length - 1)) * w;
        const y = h - 6 - (Math.min(350, v) / 350) * (h - 12);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Draw selected zone AQI trajectory in vibrant amber/orange
    const zoneColor = getAqiColor(currentZone.aqi);
    ctx.strokeStyle = zoneColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    history.forEach((v, idx) => {
      const x = (idx / (history.length - 1)) * w;
      const y = h - 6 - (Math.min(350, v) / 350) * (h - 12);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill subtle gradient below curve
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `${zoneColor}33`);
    grad.addColorStop(1, `${zoneColor}00`);
    ctx.fillStyle = grad;
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }, [aqiHistory, cityAqiHistory, selectedZoneId, currentZone.aqi]);

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-slate-400">
        Live telemetry from West Bengal Pollution Control Board (WBPCB) stations across Kolkata.
      </div>

      {/* Grid of WBPCB Monitoring Stations */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {zones.map((zone) => {
          const isSelected = zone.id === selectedZoneId;
          const aqiCol = getAqiColor(zone.aqi);

          return (
            <div
              key={zone.id}
              onClick={() => onSelectZone(zone.id)}
              className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                isSelected
                  ? 'border-sky-400/80 bg-slate-800/90 shadow-md ring-1 ring-sky-400/40'
                  : 'border-slate-800 bg-slate-900/60 hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                <span className="font-semibold text-slate-200">Z{zone.id + 1}</span>
                <span className="text-[10px] truncate max-w-[100px]">{zone.name.split(' ')[0]}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <div className="text-xl font-mono font-bold" style={{ color: aqiCol }}>
                  {zone.aqi}
                </div>
                <div className="text-[10px] text-slate-400">
                  {getAqiCategory(zone.aqi)}
                </div>
              </div>
              <div className="text-[9px] text-slate-500 truncate mt-1">
                {zone.stationName.split(' ')[0]}
              </div>
            </div>
          );
        })}
      </div>

      {/* AQI history sparkline chart */}
      <div className="bg-slate-900/90 rounded-xl p-3 border border-slate-800 flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-white">Z{currentZone.id + 1} AQI Trend</span>
            <span className="text-slate-500 font-mono text-[10px]">(Historical Stream)</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="flex items-center gap-1 text-amber-400">
              <span className="w-2.5 h-0.5 bg-amber-400 inline-block"></span> Z{currentZone.id + 1} Station
            </span>
            <span className="flex items-center gap-1 text-sky-400">
              <span className="w-2.5 h-0.5 bg-sky-400 inline-block"></span> City Avg ({cityAvgAqi})
            </span>
          </div>
        </div>

        <canvas
          ref={chartCanvasRef}
          className="w-full h-[100px] rounded-lg bg-slate-950 border border-slate-800"
        />

        <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
          <span>Current Air Classification: <b style={{ color: getAqiColor(currentZone.aqi) }}>{getAqiCategory(currentZone.aqi)} ({currentZone.aqi} AQI)</b></span>
          <span className="font-mono text-slate-500">{currentZone.stationName}</span>
        </div>
      </div>

      {/* Fast environmental action triggers */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onToggleAction('lez')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
            currentZone.lez
              ? 'bg-emerald-600 border-emerald-500 text-white shadow'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
        >
          ♻ Low-Emission Zone (LEZ) {currentZone.lez ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => onToggleAction('purifiers')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
            currentZone.purifiers
              ? 'bg-cyan-600 border-cyan-500 text-white shadow'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
        >
          🌀 Smog Cannons / Water Purifiers {currentZone.purifiers ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => onToggleAction('diversion')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
            currentZone.diversion
              ? 'bg-sky-600 border-sky-500 text-white shadow'
              : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
        >
          ⤴ Divert Heavy Traffic {currentZone.diversion ? 'ON' : 'OFF'}
        </button>
        <button
          onClick={() => onToggleAction('clear')}
          className="px-3 py-1.5 text-xs font-medium bg-slate-800/60 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-colors ml-auto"
        >
          Clear Interventions
        </button>
      </div>
    </div>
  );
};
