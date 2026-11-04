import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import L from 'leaflet';
import { KolkataNode, KolkataRoad, TrafficZone, Vehicle, HospitalFacility, AmbulanceTelemetry } from '../types/traffic';
import { KOLKATA_HOSPITALS } from '../data/kolkataData';
import {
  getRoadKey,
  getAqiColor,
  getVehicleCoordinateAndHeading,
  buildCurvedRoutePolyline,
  findNearestHospital,
  calculateDistanceKm,
} from '../utils/trafficAlgorithms';

export interface MapLayersState {
  signals: boolean;
  hospitals: boolean;
  heatZones: boolean;
  airQuality: boolean;
  routeCorridor: boolean;
  accidents: boolean;
}

export type TileProvider = 'carto-dark' | 'osm-standard' | 'carto-light';

interface KolkataMapProps {
  nodes: KolkataNode[];
  roads: KolkataRoad[];
  zones: TrafficZone[];
  hospitals?: HospitalFacility[];
  vehicles?: Vehicle[];
  vehiclesRef?: React.MutableRefObject<Vehicle[]>;
  ambulance: Vehicle | null;
  route: number[];
  previousRoute?: number[];
  telemetry?: AmbulanceTelemetry | null;
  followAmbulance?: boolean;
  onUserPan?: () => void;
  selectedNodeId: number;
  startNodeId: number;
  blockedRoads: Set<string>;
  roadLoads: Map<string, number>;
  nodeStates: { [key: number]: { ph: number; preempted: boolean; manual: boolean } };
  layers: MapLayersState;
  tileProvider: TileProvider;
  onSelectNode: (nodeId: number) => void;
  onToggleRoadBlock: (roadKey: string) => void;
  onSetStartNode: (nodeId: number) => void;
  onDispatchAmbulanceTo: (nodeId: number) => void;
  onSelectHospitalNode?: (nodeId: number) => void;
}

export interface KolkataMapHandle {
  flyToNode: (nodeId: number) => void;
  flyToCoords: (lat: number, lng: number) => void;
  fitAll: () => void;
}

// Helper to generate authentic Kolkata Traffic Police 3-aspect vertical signal icon
function createSignalIcon(
  node: KolkataNode,
  state: { ph: number; preempted: boolean; manual: boolean },
  isSelected: boolean,
  isStart: boolean,
  showSignals: boolean
): L.DivIcon {
  if (!showSignals) {
    const bg = isSelected ? '#0284c7' : isStart ? '#10b981' : state.preempted ? '#eab308' : '#475569';
    return L.divIcon({
      className: 'custom-node-icon',
      html: `
        <div style="width: 14px; height: 14px; border-radius: 50%; background: ${bg}; border: 2px solid #ffffff; box-shadow: 0 0 8px ${bg}; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 8px; font-weight: bold; cursor: pointer;">
          ${node.isHospitalZone ? 'H' : ''}
        </div>
      `,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  // Red, Amber, Green light status based on real phase
  const isRed = !state.preempted && state.ph === 1;
  const isAmber = state.preempted;
  const isGreen = state.preempted || state.ph === 0;

  const redColor = isRed ? '#ef4444' : '#1c1917';
  const redGlow = isRed ? 'box-shadow: 0 0 12px #ef4444, inset 0 0 3px #ffffff;' : 'opacity: 0.35;';
  const amberColor = isAmber ? '#f59e0b' : '#1c1917';
  const amberGlow = isAmber ? 'box-shadow: 0 0 14px #f59e0b, inset 0 0 4px #ffffff; animation: pulse 0.6s infinite;' : 'opacity: 0.35;';
  const greenColor = isGreen && !isAmber ? '#10b981' : '#1c1917';
  const greenGlow = isGreen && !isAmber ? 'box-shadow: 0 0 12px #10b981, inset 0 0 3px #ffffff;' : 'opacity: 0.35;';

  const ringBorder = isSelected
    ? '#38bdf8'
    : state.preempted
    ? '#f59e0b'
    : isStart
    ? '#10b981'
    : isGreen
    ? '#10b981'
    : '#ef4444';

  const ringBg = isSelected
    ? 'rgba(56, 189, 248, 0.3)'
    : state.preempted
    ? 'rgba(245, 158, 11, 0.35)'
    : isStart
    ? 'rgba(16, 185, 129, 0.28)'
    : 'rgba(15, 23, 42, 0.85)';

  // Short readable name for junction badge
  const shortName = node.name.split(' ')[0] + (node.name.includes('5-Point') ? ' 5-Pt' : node.name.includes('7-Point') ? ' 7-Pt' : '');

  // Exact anchor at crossroads tarmac:
  // Container: width 44px, height 70px
  // Intersection ground ring center: x=22, y=50
  // iconAnchor: [22, 50] -> places (22, 50) directly onto the intersection GPS coordinates!
  const html = `
    <div style="position: relative; width: 44px; height: 70px; pointer-events: auto; cursor: pointer; user-select: none;">
      <!-- Crossroads Tarmac Ground Sensor Ring (Dead-center at anchor x=22, y=50) -->
      <div style="
        position: absolute;
        left: 22px;
        top: 50px;
        transform: translate(-50%, -50%);
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: ${ringBg};
        border: 2px solid ${ringBorder};
        box-shadow: ${isSelected ? '0 0 16px #38bdf8' : state.preempted ? '0 0 18px #f59e0b' : '0 2px 8px rgba(0,0,0,0.7)'};
        z-index: 2;
      ">
        <div style="width: 100%; height: 100%; border-radius: 50%; border: 1px dashed rgba(255,255,255,0.35);"></div>
      </div>

      <!-- Preemption Siren Wave / Active Emergency Ripple -->
      ${state.preempted ? `
        <div style="
          position: absolute;
          left: 22px;
          top: 50px;
          transform: translate(-50%, -50%);
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: 2px solid #f59e0b;
          animation: ping 1.2s cubic-bezier(0, 0, 0.2, 1) infinite;
          opacity: 0.85;
          z-index: 1;
        "></div>
        <div style="position: absolute; top: -2px; right: -2px; font-size: 13px; z-index: 30; filter: drop-shadow(0 0 6px #ef4444); animation: bounce 0.6s infinite;">🚨</div>
      ` : node.isHospitalZone ? `
        <div style="position: absolute; top: 1px; right: 0px; background: #dc2626; color: #fff; font-size: 8px; font-weight: 900; padding: 0.5px 3.5px; border-radius: 999px; border: 1.5px solid #fff; box-shadow: 0 0 8px rgba(220, 38, 38, 0.9); z-index: 22; line-height: 1.1;">H</div>
      ` : ''}

      <!-- Authentic Steel Signal Mast Post connecting ground ring to signal head -->
      <div style="
        position: absolute;
        left: 21px;
        top: 33px;
        width: 2px;
        height: 18px;
        background: #475569;
        border-left: 1px solid #94a3b8;
        z-index: 4;
      "></div>

      <!-- Authentic 3-Aspect Vertical ATC Signal Head with Sun-Shield Visors -->
      <div style="
        position: absolute;
        left: 22px;
        top: 1px;
        transform: translateX(-50%);
        z-index: 15;
        background: #090d16;
        border-radius: 6px;
        border: 1.5px solid ${isSelected ? '#38bdf8' : state.preempted ? '#f59e0b' : '#334155'};
        padding: 2.5px 2px;
        display: flex;
        flex-direction: column;
        gap: 2.5px;
        align-items: center;
        box-shadow: 0 3px 10px rgba(0,0,0,0.85);
      ">
        <!-- Red Lens with arched sun visor brow -->
        <div style="position: relative; width: 8px; height: 8px;">
          <div style="position: absolute; top: -1px; left: 0; right: 0; height: 2px; border-top: 1px solid #64748b; border-radius: 2px 2px 0 0;"></div>
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${redColor}; ${redGlow}; border: 0.5px solid rgba(0,0,0,0.8);"></div>
        </div>
        <!-- Amber Lens with visor brow -->
        <div style="position: relative; width: 8px; height: 8px;">
          <div style="position: absolute; top: -1px; left: 0; right: 0; height: 2px; border-top: 1px solid #64748b; border-radius: 2px 2px 0 0;"></div>
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${amberColor}; ${amberGlow}; border: 0.5px solid rgba(0,0,0,0.8);"></div>
        </div>
        <!-- Green Lens with visor brow -->
        <div style="position: relative; width: 8px; height: 8px;">
          <div style="position: absolute; top: -1px; left: 0; right: 0; height: 2px; border-top: 1px solid #64748b; border-radius: 2px 2px 0 0;"></div>
          <div style="width: 8px; height: 8px; border-radius: 50%; background: ${greenColor}; ${greenGlow}; border: 0.5px solid rgba(0,0,0,0.8);"></div>
        </div>
      </div>

      <!-- Crisp Junction Nameplate Label -->
      <div style="
        position: absolute;
        top: 61px;
        left: 22px;
        transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.96);
        color: #f1f5f9;
        font-size: 8px;
        font-weight: 700;
        padding: 0.5px 4.5px;
        border-radius: 3px;
        border: 1px solid ${isSelected ? '#38bdf8' : 'rgba(255,255,255,0.2)'};
        white-space: nowrap;
        pointer-events: none;
        z-index: 20;
        box-shadow: 0 1px 4px rgba(0,0,0,0.7);
      ">
        ${shortName}
      </div>
    </div>
  `;

  return L.divIcon({
    className: 'custom-node-icon',
    html,
    iconSize: [44, 70],
    iconAnchor: [22, 50],
  });
}

function createSignalPopupContent(
  node: KolkataNode,
  state: { ph: number; preempted: boolean; manual: boolean },
  nearestHosp: HospitalFacility | undefined,
  distanceKm: number,
  onSelectNode: (id: number) => void,
  onDispatchAmbulanceTo: (id: number) => void,
  onSetStartNode: (id: number) => void,
  map: L.Map
): HTMLElement {
  const popupContent = document.createElement('div');
  popupContent.style.fontFamily = 'system-ui, sans-serif';
  popupContent.style.fontSize = '12px';
  popupContent.style.minWidth = '260px';
  popupContent.innerHTML = `
    <div style="font-weight: 700; font-size: 13px; color: #0f172a;">${node.name}</div>
    <div style="color: #64748b; font-size: 11px; margin-bottom: 4px;">${node.bengaliName || ''}</div>
    <div style="font-size: 10px; color: #2563eb; font-weight: 600; margin-bottom: 2px;">
      👮 ${node.trafficGuard || 'Kolkata Traffic Police'}
    </div>
    <div style="font-size: 10px; color: #64748b; margin-bottom: 4px; font-family: monospace;">
      GPS: ${node.lat.toFixed(6)}° N, ${node.lng.toFixed(6)}° E
    </div>
    ${node.landmark ? `<div style="font-size: 10px; color: #475569; margin-bottom: 6px;">📍 Landmark: ${node.landmark}</div>` : ''}

    <!-- Signal State Card -->
    <div style="margin-bottom: 6px; padding: 6px; background: #0f172a; color: #f8fafc; border-radius: 6px; font-size: 11px; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <div style="font-weight: 700; color: ${state.preempted ? '#f59e0b' : '#38bdf8'}; font-size: 10px;">
          ${state.preempted ? '🚨 PREEMPTED (EMERGENCY WAVE)' : state.manual ? 'MANUAL TIMING' : 'ADAPTIVE AI (ATC)'}
        </div>
        <div style="font-size: 11px;">Active Phase: <b>P${state.ph + 1} (${state.ph === 0 ? 'N/S Green' : 'E/W Green'})</b></div>
      </div>
      <div style="background: #1e293b; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-family: monospace; color: #94a3b8;">
        ${node.signalCycleSec || 90}s
      </div>
    </div>

    <!-- Location-based Nearest Hospital Link -->
    ${nearestHosp ? `
      <div style="margin-bottom: 8px; padding: 5px 8px; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 6px; font-size: 11px;">
        <div style="font-size: 10px; color: #be123c; font-weight: 700; text-transform: uppercase;">Nearest Hospital from this Signal:</div>
        <div style="font-weight: 700; color: #0f172a;">${nearestHosp.name.split('/')[0]}</div>
        <div style="display: flex; justify-content: space-between; font-size: 10px; color: #475569; margin-top: 2px;">
          <span>Distance: <b>${distanceKm} km</b></span>
          <span>ICU Beds: <b style="color: #047857;">${nearestHosp.icuAvailable}</b></span>
        </div>
      </div>
    ` : ''}

    <div style="display: flex; gap: 4px; margin-top: 8px;">
      <button id="pop-select-${node.id}" style="flex:1; padding: 5px 6px; font-size: 10px; font-weight: 600; background: #0f172a; color: #fff; border: none; border-radius: 4px; cursor: pointer;">
        🚦 Controller
      </button>
      <button id="pop-amb-${node.id}" style="flex:1.2; padding: 5px 6px; font-size: 10px; font-weight: 600; background: #dc2626; color: #fff; border: none; border-radius: 4px; cursor: pointer;">
        🚑 Dispatch Here
      </button>
      <button id="pop-start-${node.id}" style="flex:1; padding: 5px 6px; font-size: 10px; font-weight: 600; background: #10b981; color: #fff; border: none; border-radius: 4px; cursor: pointer;">
        📍 Set Origin
      </button>
    </div>
  `;

  popupContent.querySelector(`#pop-select-${node.id}`)?.addEventListener('click', (e) => {
    e.stopPropagation();
    onSelectNode(node.id);
    map.closePopup();
  });

  popupContent.querySelector(`#pop-amb-${node.id}`)?.addEventListener('click', (e) => {
    e.stopPropagation();
    onDispatchAmbulanceTo(node.id);
    map.closePopup();
  });

  popupContent.querySelector(`#pop-start-${node.id}`)?.addEventListener('click', (e) => {
    e.stopPropagation();
    onSetStartNode(node.id);
    map.closePopup();
  });

  return popupContent;
}

export const KolkataMap = forwardRef<KolkataMapHandle, KolkataMapProps>(({
  nodes,
  roads,
  zones,
  hospitals = KOLKATA_HOSPITALS,
  vehicles,
  vehiclesRef: externalVehiclesRef,
  ambulance,
  route,
  previousRoute = [],
  telemetry = null,
  followAmbulance = false,
  onUserPan,
  selectedNodeId,
  startNodeId,
  blockedRoads,
  roadLoads,
  nodeStates,
  layers,
  tileProvider,
  onSelectNode,
  onToggleRoadBlock,
  onSetStartNode,
  onDispatchAmbulanceTo,
  onSelectHospitalNode,
}, ref) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const overlayLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const signalsLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const ambLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const roadPolysRef = useRef<Map<string, { poly: L.Polyline; road: KolkataRoad }>>(new Map());
  const zoneRectsRef = useRef<Map<number, L.Rectangle>>(new Map());
  const roadLoadsRef = useRef(roadLoads);
  roadLoadsRef.current = roadLoads;
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const signalMarkersMapRef = useRef<Map<number, L.Marker>>(new Map());
  const animCanvasRef = useRef<HTMLCanvasElement>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showSearchResults, setShowSearchResults] = useState<boolean>(false);

  // Expose imperative handles to parent
  useImperativeHandle(ref, () => ({
    flyToNode: (nodeId: number) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (node && mapInstanceRef.current) {
        mapInstanceRef.current.flyTo([node.lat, node.lng], 15.5, { duration: 1.2 });
      }
    },
    flyToCoords: (lat: number, lng: number) => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.flyTo([lat, lng], 15.8, { duration: 1.2 });
      }
    },
    fitAll: () => {
      if (mapInstanceRef.current && nodes.length > 0) {
        const bounds = L.latLngBounds(nodes.map((n) => [n.lat, n.lng]));
        mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50] });
      }
    },
  }));

  // Initialize Leaflet map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [22.5560, 88.3620],
      zoom: 13,
      minZoom: 11,
      maxZoom: 18,
      zoomControl: false,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      inertia: true,
      inertiaDeceleration: 3400,
      inertiaMaxSpeed: 1600,
      wheelDebounceTime: 40,
      wheelPxPerZoomLevel: 100,
    });

    L.control.zoom({ position: 'topright' }).addTo(map);

    const getTileConfig = (provider: TileProvider) => {
      if (provider === 'osm-standard') {
        return {
          url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          subdomains: ['a', 'b', 'c'],
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        };
      }
      if (provider === 'carto-light') {
        return {
          url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
          subdomains: 'abcd',
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
          maxZoom: 19,
        };
      }
      return {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        subdomains: 'abcd',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 19,
      };
    };

    const config = getTileConfig(tileProvider);
    const tile = L.tileLayer(config.url, {
      attribution: config.attribution,
      subdomains: config.subdomains,
      maxZoom: config.maxZoom,
    }).addTo(map);

    tileLayerRef.current = tile;

    const layerGroup = L.layerGroup().addTo(map);
    overlayLayerGroupRef.current = layerGroup;

    const signalsGroup = L.layerGroup().addTo(map);
    signalsLayerGroupRef.current = signalsGroup;

    // Live ambulance layer sits above roads/hospitals and never intercepts clicks
    map.createPane('ambulancePane').style.zIndex = '450';
    ambLayerGroupRef.current = L.layerGroup().addTo(map);

    mapInstanceRef.current = map;

    const resizeTimer = setTimeout(() => {
      map.invalidateSize();
    }, 150);

    return () => {
      clearTimeout(resizeTimer);
      signalMarkersMapRef.current.clear();
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Update base map tiles when tileProvider changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }

    const getTileConfig = (provider: TileProvider) => {
      if (provider === 'osm-standard') {
        return {
          url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          subdomains: ['a', 'b', 'c'],
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 19,
        };
      }
      if (provider === 'carto-light') {
        return {
          url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
          subdomains: 'abcd',
          attribution: '&copy; OpenStreetMap &copy; CARTO',
          maxZoom: 19,
        };
      }
      return {
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        subdomains: 'abcd',
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        maxZoom: 19,
      };
    };

    const config = getTileConfig(tileProvider);
    tileLayerRef.current = L.tileLayer(config.url, {
      attribution: config.attribution,
      subdomains: config.subdomains,
      maxZoom: config.maxZoom,
    }).addTo(map);

    if (overlayLayerGroupRef.current) {
      overlayLayerGroupRef.current.eachLayer((l: any) => {
        if (typeof l.bringToFront === 'function') l.bringToFront();
      });
    }
  }, [tileProvider]);

  // Render static layers, polylines, signals, and hospitals
  useEffect(() => {
    const group = overlayLayerGroupRef.current;
    const map = mapInstanceRef.current;
    if (!group || !map) return;

    group.clearLayers();
    roadPolysRef.current.clear();
    zoneRectsRef.current.clear();

    // 1. Kolkata Traffic Zones / Air Quality Heatmap Layer
    if (layers.heatZones || layers.airQuality) {
      zones.forEach((z) => {
        let color = '#38bdf8';
        let opacity = 0.12;

        if (layers.airQuality) {
          color = getAqiColor(z.aqi);
          opacity = 0.22;
        } else if (layers.heatZones) {
          if (z.congestion > 0.6) color = '#ef4444';
          else if (z.congestion > 0.4) color = '#f59e0b';
          else color = '#10b981';
          opacity = 0.14;
        }

        const rect = L.rectangle(z.bounds, {
          color: color,
          weight: 1.5,
          dashArray: '4, 4',
          fillColor: color,
          fillOpacity: opacity,
        });

        const zoneId = z.id;
        zoneRectsRef.current.set(zoneId, rect);
        rect.bindTooltip(
          () => {
            const z = zonesRef.current.find((q) => q.id === zoneId)!;
            return `<div style="font-family: system-ui; font-size: 11px;">
            <b>${z.name}</b> (${z.bengaliName})<br/>
            Station: <b>${z.stationName}</b><br/>
            Congestion: <b>${Math.round(z.congestion * 100)}%</b> | AQI: <b>${z.aqi}</b><br/>
            ${z.diversion ? '<span style="color:#0284c7;font-weight:600;">⤴ Diversion active</span> ' : ''}
            ${z.lez ? '<span style="color:#10b981;font-weight:600;">♻ Low Emission Zone</span> ' : ''}
            ${z.purifiers ? '<span style="color:#06b6d4;font-weight:600;">🌀 Mist Purifiers</span> ' : ''}
          </div>`;
          },
          { sticky: true }
        );

        group.addLayer(rect);
      });
    }

    // 2. Accurate Curved Road Segments tracing OSM waypoints
    roads.forEach((road) => {
      const uNode = nodes.find((n) => n.id === road.u);
      const vNode = nodes.find((n) => n.id === road.v);
      if (!uNode || !vNode) return;

      const rKey = getRoadKey(road.u, road.v);
      const isBlocked = blockedRoads.has(rKey);
      const load = roadLoads.get(rKey) || 0;

      let roadColor = tileProvider === 'osm-standard' ? '#475569' : '#64748b';
      let roadWeight = road.isFlyover ? 7 : 5;
      let opacity = 0.85;

      if (isBlocked) {
        roadColor = '#ef4444';
        roadWeight = 7;
      } else if (load > 4) {
        roadColor = '#dc2626';
      } else if (load > 2) {
        roadColor = '#d97706';
      } else {
        roadColor = road.isFlyover ? '#2563eb' : (tileProvider === 'carto-dark' ? '#334155' : '#475569');
      }

      let roadCoords: [number, number][];
      if (road.path && road.path.length >= 2) {
        roadCoords = road.path.map((p) => [p[0], p[1]] as [number, number]);
        const dStartU = Math.hypot(roadCoords[0][0] - uNode.lat, roadCoords[0][1] - uNode.lng);
        const dEndU = Math.hypot(roadCoords[roadCoords.length - 1][0] - uNode.lat, roadCoords[roadCoords.length - 1][1] - uNode.lng);
        if (dEndU < dStartU) {
          roadCoords.reverse();
        }
        roadCoords[0] = [uNode.lat, uNode.lng];
        roadCoords[roadCoords.length - 1] = [vNode.lat, vNode.lng];
      } else {
        roadCoords = [
          [uNode.lat, uNode.lng],
          [vNode.lat, vNode.lng],
        ];
      }

      const poly = L.polyline(roadCoords, {
        color: roadColor,
        weight: roadWeight,
        opacity: opacity,
        dashArray: road.isFlyover ? '8, 5' : undefined,
        lineCap: 'round',
        lineJoin: 'round',
      });

      poly.on('click', () => {
        onToggleRoadBlock(rKey);
      });

      roadPolysRef.current.set(rKey, { poly, road });
      poly.bindTooltip(
        () => {
          const load = roadLoadsRef.current.get(rKey) || 0;
          return `<div style="font-family: system-ui; font-size: 11px;">
          <b>${road.name}</b> ${road.isFlyover ? '🌉 (Elevated Flyover)' : ''}<br/>
          Traffic Guard: <span style="color:#2563eb;font-weight:bold;">${road.trafficGuard || 'Kolkata Traffic Police'}</span><br/>
          Lanes: ${road.lanes} | Speed Limit: <b>${road.speedLimit} km/h</b> | Length: ${road.lengthKm} km<br/>
          Live Vehicles on corridor: <b>${load}</b> ${isBlocked ? '<br/><span style="color:#ef4444;font-weight:bold;">🚧 ROAD BLOCKED (Incident)</span>' : '<br/><span style="color:#64748b;">Click to report incident / closure</span>'}
        </div>`;
        },
        { sticky: true }
      );

      group.addLayer(poly);

      if (isBlocked) {
        const midIdx = Math.floor(roadCoords.length / 2);
        const midPt = roadCoords[midIdx] || [(uNode.lat + vNode.lat) / 2, (uNode.lng + vNode.lng) / 2];
        const incidentIcon = L.divIcon({
          className: 'incident-icon',
          html: `<div style="background:#ef4444;color:#fff;border-radius:999px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 0 10px #ef4444;border:2px solid #fff;">🚧</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        const marker = L.marker(midPt, { icon: incidentIcon });
        marker.on('click', () => onToggleRoadBlock(rKey));
        group.addLayer(marker);
      }
    });

    // 4. Dedicated Kolkata Hospitals Layer based on precise GPS locations
    if (layers.hospitals) {
      hospitals.forEach((hospital) => {
        const linkedSignalNode = nodes.find((n) => n.id === hospital.nearestNodeId);

        // Draw dashed medical corridor link to nearest controlling signal junction
        if (linkedSignalNode) {
          const medLink = L.polyline(
            [
              [hospital.lat, hospital.lng],
              [linkedSignalNode.lat, linkedSignalNode.lng],
            ],
            {
              color: '#f43f5e',
              weight: 2,
              dashArray: '4, 4',
              opacity: 0.7,
            }
          );
          medLink.bindTooltip(
            `<div style="font-family: system-ui; font-size: 10px;">
              <b>Medical Arterial Link</b> (${hospital.distanceToSignalMeters}m)<br/>
              Connecting <b>${hospital.name.split('/')[0]}</b> to <b>${linkedSignalNode.name}</b>
            </div>`,
            { sticky: true }
          );
          group.addLayer(medLink);
        }

        // Realistic Hospital Marker with emergency cross and glowing perimeter
        const hospitalIcon = L.divIcon({
          className: 'custom-hospital-icon',
          html: `
            <div style="position: relative; display: flex; flex-direction: column; align-items: center; cursor: pointer;">
              <div style="
                background: #ffffff;
                color: #dc2626;
                width: 26px;
                height: 26px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 15px;
                font-weight: 900;
                box-shadow: 0 0 12px rgba(220, 38, 38, 0.75), 0 2px 6px rgba(0,0,0,0.5);
                border: 2px solid #ef4444;
                transition: transform 0.15s ease;
              ">
                <span style="transform: scale(1.15);">🏥</span>
              </div>
              <div style="
                background: rgba(15, 23, 42, 0.92);
                color: #fecdd3;
                font-size: 9px;
                font-weight: bold;
                padding: 1px 5px;
                border-radius: 4px;
                border: 1px solid rgba(244, 63, 94, 0.4);
                margin-top: 2px;
                white-space: nowrap;
                box-shadow: 0 2px 4px rgba(0,0,0,0.4);
                max-width: 110px;
                overflow: hidden;
                text-overflow: ellipsis;
              ">
                ${hospital.name.split(' ')[0]} ${hospital.name.split(' ')[1] || ''}
              </div>
            </div>
          `,
          iconSize: [28, 42],
          iconAnchor: [14, 13],
        });

        const hospMarker = L.marker([hospital.lat, hospital.lng], { icon: hospitalIcon });

        const hospPopupContent = document.createElement('div');
        hospPopupContent.style.fontFamily = 'system-ui, sans-serif';
        hospPopupContent.style.fontSize = '12px';
        hospPopupContent.style.minWidth = '270px';
        hospPopupContent.innerHTML = `
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 3px;">
            <span style="font-size: 16px;">🏥</span>
            <div>
              <div style="font-weight: 800; font-size: 13px; color: #0f172a; line-height: 1.2;">${hospital.name}</div>
              <div style="color: #64748b; font-size: 11px;">${hospital.bengaliName}</div>
            </div>
          </div>
          <div style="display: inline-block; background: #ffe4e6; color: #be123c; font-size: 10px; font-weight: 700; padding: 2px 6px; rounded: 4px; border-radius: 4px; margin-bottom: 6px;">
            ${hospital.traumaLevel}
          </div>
          <div style="font-size: 11px; color: #334155; margin-bottom: 4px;">
            📍 <b>Location:</b> ${hospital.address}
          </div>
          <div style="font-size: 10px; color: #64748b; margin-bottom: 4px; font-family: monospace;">
            GPS: ${hospital.lat.toFixed(4)}° N, ${hospital.lng.toFixed(4)}° E
          </div>
          <div style="font-size: 11px; color: #0369a1; margin-bottom: 6px; background: #f0f9ff; padding: 4px 6px; border-radius: 4px; border-left: 3px solid #0284c7;">
            🚦 <b>Controlling Signal:</b> ${linkedSignalNode ? linkedSignalNode.name : 'Primary Junction'} (${hospital.distanceToSignalMeters}m away)
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; margin-bottom: 8px; font-size: 10px; text-align: center;">
            <div style="background: #f8fafc; padding: 4px; border-radius: 4px; border: 1px solid #e2e8f0;">
              <span style="color: #64748b; display: block;">Total Beds</span>
              <b style="color: #0f172a; font-size: 12px;">${hospital.availableBeds}</b>
            </div>
            <div style="background: #ecfdf5; padding: 4px; border-radius: 4px; border: 1px solid #a7f3d0;">
              <span style="color: #047857; display: block;">ICU Ready</span>
              <b style="color: #065f46; font-size: 12px;">${hospital.icuAvailable}</b>
            </div>
            <div style="background: #fff1f2; padding: 4px; border-radius: 4px; border: 1px solid #fecdd3;">
              <span style="color: #be123c; display: block;">Amb. Bays</span>
              <b style="color: #9f1239; font-size: 12px;">${hospital.ambulanceBays}</b>
            </div>
          </div>
          <div style="font-size: 10px; color: #475569; margin-bottom: 6px;">
            🚨 <b>Emergency Gate:</b> ${hospital.emergencyGate}<br/>
            📞 <b>24/7 Hotline:</b> <span style="font-weight: 600; color: #e11d48;">${hospital.hotline}</span>
          </div>
          <div style="display: flex; gap: 6px; margin-top: 6px;">
            <button id="pop-amb-hosp-${hospital.id}" style="flex: 1; padding: 6px 10px; font-size: 11px; font-weight: bold; background: #e11d48; color: #fff; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px;">
              🚑 Dispatch Corridor
            </button>
            <button id="pop-sig-hosp-${hospital.id}" style="padding: 6px 10px; font-size: 11px; background: #0f172a; color: #fff; border: none; border-radius: 6px; cursor: pointer;">
              🚦 Signal
            </button>
          </div>
        `;

        hospPopupContent.querySelector(`#pop-amb-hosp-${hospital.id}`)?.addEventListener('click', (e) => {
          e.stopPropagation();
          onDispatchAmbulanceTo(hospital.nearestNodeId);
          map.closePopup();
        });

        hospPopupContent.querySelector(`#pop-sig-hosp-${hospital.id}`)?.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelectNode(hospital.nearestNodeId);
          if (onSelectHospitalNode) onSelectHospitalNode(hospital.nearestNodeId);
          map.closePopup();
        });

        hospMarker.bindPopup(hospPopupContent);
        group.addLayer(hospMarker);
      });
    }
  }, [
    nodes,
    roads,
    hospitals,
    blockedRoads,
    layers.heatZones,
    layers.airQuality,
    layers.hospitals,
    layers.routeCorridor,
    layers.accidents,
    tileProvider,
  ]);

  // In-place restyle of roads & zones on every telemetry tick (no layer rebuild => popups stay open)
  useEffect(() => {
    roadPolysRef.current.forEach(({ poly, road }, rKey) => {
      const load = roadLoads.get(rKey) || 0;
      const blocked = blockedRoads.has(rKey);
      const color = blocked
        ? '#ef4444'
        : load > 4
        ? '#dc2626'
        : load > 2
        ? '#d97706'
        : road.isFlyover
        ? '#2563eb'
        : tileProvider === 'carto-dark'
        ? '#334155'
        : '#475569';
      poly.setStyle({ color, weight: blocked ? 7 : road.isFlyover ? 7 : 5 });
    });
    zoneRectsRef.current.forEach((rect, id) => {
      const z = zones.find((q) => q.id === id);
      if (!z) return;
      const color = layers.airQuality
        ? getAqiColor(z.aqi)
        : z.congestion > 0.6
        ? '#ef4444'
        : z.congestion > 0.4
        ? '#f59e0b'
        : '#10b981';
      rect.setStyle({ color, fillColor: color, fillOpacity: layers.airQuality ? 0.22 : 0.14 });
    });
  }, [roadLoads, zones, blockedRoads, tileProvider, layers.heatZones, layers.airQuality]);

  // 5. Intersections / Authentic Traffic Signals layer with in-place updates (ultra-smooth 60fps)
  useEffect(() => {
    const signalsGroup = signalsLayerGroupRef.current;
    const map = mapInstanceRef.current;
    if (!signalsGroup || !map) return;

    if (!layers.signals) {
      signalsGroup.clearLayers();
      signalMarkersMapRef.current.clear();
      return;
    }

    if (signalMarkersMapRef.current.size !== nodes.length) {
      signalsGroup.clearLayers();
      signalMarkersMapRef.current.clear();

      nodes.forEach((node) => {
        const state = nodeStates[node.id] || { ph: 0, preempted: false, manual: false };
        const isSelected = node.id === selectedNodeId;
        const isStart = node.id === startNodeId;
        const icon = createSignalIcon(node, state, isSelected, isStart, true);

        const marker = L.marker([node.lat, node.lng], { icon });

        marker.on('click', () => {
          onSelectNode(node.id);
        });

        const nearestHospData = findNearestHospital(node.lat, node.lng, hospitals);
        const nearestHosp = nearestHospData?.hospital;
        const distanceKm = nearestHospData ? nearestHospData.distanceKm : 0.5;

        marker.bindTooltip(
          `<div style="font-family: system-ui; font-size: 11px;">
            <b>${node.name}</b><br/>
            🚦 ${node.signalName || 'ATC Signal #' + node.id} (${node.signalCycleSec || 90}s cycle)<br/>
            Phase: <b>P${state.ph + 1} (${state.ph === 0 ? 'North-South Green' : 'East-West Green'})</b><br/>
            ${state.preempted ? '<span style="color:#eab308;font-weight:bold;">🚨 EMERGENCY PREEMPTION ACTIVE</span><br/>' : ''}
            ${nearestHosp ? `🏥 Nearest: <b>${nearestHosp.name.split('/')[0]}</b> (${distanceKm} km)` : ''}
          </div>`,
          { sticky: true }
        );

        marker.bindPopup(() =>
          createSignalPopupContent(
            node,
            nodeStates[node.id] || state,
            nearestHosp,
            distanceKm,
            onSelectNode,
            onDispatchAmbulanceTo,
            onSetStartNode,
            map
          )
        );

        signalsGroup.addLayer(marker);
        signalMarkersMapRef.current.set(node.id, marker);
      });
    } else {
      // In-place ultra-fast icon update: ZERO layer recreation!
      nodes.forEach((node) => {
        const marker = signalMarkersMapRef.current.get(node.id);
        if (!marker) return;

        const state = nodeStates[node.id] || { ph: 0, preempted: false, manual: false };
        const isSelected = node.id === selectedNodeId;
        const isStart = node.id === startNodeId;
        const icon = createSignalIcon(node, state, isSelected, isStart, true);
        marker.setIcon(icon);
      });
    }
  }, [
    nodes,
    hospitals,
    layers.signals,
    selectedNodeId,
    startNodeId,
    nodeStates,
    onSelectNode,
    onDispatchAmbulanceTo,
    onSetStartNode,
  ]);

  // Internal fallback ref if externalVehiclesRef is not passed
  const internalVehiclesRef = useRef<Vehicle[]>(vehicles || []);
  const activeVehiclesRef = externalVehiclesRef || internalVehiclesRef;
  if (!externalVehiclesRef && vehicles) {
    internalVehiclesRef.current = vehicles;
  }

  // Synchronize dynamic canvas overlay for vehicles animation on map
  useEffect(() => {
    const map = mapInstanceRef.current;
    const canvas = animCanvasRef.current;
    if (!map || !canvas) return;

    let animId: number;

    const renderVehicles = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx || !map) return;

      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;

      if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
        canvas.width = size.x * dpr;
        canvas.height = size.y * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, size.x, size.y);

      const currentVehicles = activeVehiclesRef.current;

      for (let i = 0; i < currentVehicles.length; i++) {
        const v = currentVehicles[i];
        const coord = getVehicleCoordinateAndHeading(v.u, v.v, v.t, nodes, roads);
        if (!coord) continue;

        const pt = map.latLngToContainerPoint([coord.lat, coord.lng]);
        if (pt.x < -30 || pt.x > size.x + 30 || pt.y < -30 || pt.y > size.y + 30) {
          continue;
        }

        // Smooth vehicle steering angular interpolation
        if (v.heading === undefined) {
          v.heading = coord.heading;
        } else {
          let diff = coord.heading - v.heading;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          v.heading += diff * 0.2;
        }

        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(v.heading);

        // Subtle contact shadow under the vehicle
        const isBraking = v.hold || (v.currentSpeed !== undefined && v.currentSpeed < 0.2);

        if (v.isAmbulance) {
          // Emergency pulsating siren ring
          const pulse = (Math.sin(performance.now() * 0.012) + 1) * 0.5;
          ctx.beginPath();
          ctx.arc(0, 0, 16 + pulse * 8, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(239, 68, 68, ${0.3 + pulse * 0.35})`;
          ctx.fill();

          // Contact shadow
          ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
          ctx.beginPath();
          ctx.ellipse(0, 1.5, 9, 5, 0, 0, Math.PI * 2);
          ctx.fill();

          // Ambulance chassis
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#dc2626';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.roundRect(-8.5, -4.5, 17, 9, 2.5);
          ctx.fill();
          ctx.stroke();

          // Red medical cross
          ctx.fillStyle = '#ef4444';
          ctx.fillRect(-4, -1.2, 8, 2.4);
          ctx.fillRect(-1.2, -4, 2.4, 8);

          // Headlights
          ctx.fillStyle = 'rgba(254, 240, 138, 0.75)';
          ctx.beginPath();
          ctx.arc(8.5, -2.5, 1.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(8.5, 2.5, 1.4, 0, Math.PI * 2);
          ctx.fill();

          // Alternating red/blue roof lights
          const flash = Math.floor(performance.now() / 120) % 2 === 0;
          ctx.fillStyle = flash ? '#ef4444' : '#38bdf8';
          ctx.beginPath();
          ctx.arc(2, 0, 2.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Regular vehicle
          const w = v.type === 'bus' ? 15 : v.type === 'auto' ? 7.5 : 9.5;
          const h = v.type === 'bus' ? 5.8 : v.type === 'auto' ? 4.2 : 4.8;

          // Contact shadow
          ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
          ctx.beginPath();
          ctx.ellipse(0, 1.2, w / 2 + 0.8, h / 2 + 0.6, 0, 0, Math.PI * 2);
          ctx.fill();

          // Chassis body
          ctx.fillStyle = v.color;
          ctx.strokeStyle = '#020617';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.roundRect(-w / 2, -h / 2, w, h, 2);
          ctx.fill();
          ctx.stroke();

          // Windshield
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(w / 2 - 3.2, -h / 2 + 0.8, 1.8, h - 1.6);

          // Soft forward headlights
          ctx.fillStyle = 'rgba(254, 240, 138, 0.6)';
          ctx.beginPath();
          ctx.arc(w / 2, -h / 3, 1, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(w / 2, h / 3, 1, 0, Math.PI * 2);
          ctx.fill();

          // Rear brake lights (glowing crimson when decelerating or stopped at red signal)
          if (isBraking) {
            ctx.fillStyle = '#ef4444';
            ctx.shadowColor = '#ef4444';
            ctx.shadowBlur = 4;
            ctx.beginPath();
            ctx.arc(-w / 2, -h / 3, 1.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(-w / 2, h / 3, 1.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }

        ctx.restore();
      }

      ctx.restore();
      animId = requestAnimationFrame(renderVehicles);
    };

    animId = requestAnimationFrame(renderVehicles);

    // Sync directly with Leaflet movement & zoom events for silky smooth map tracking
    map.on('move', renderVehicles);
    map.on('zoom', renderVehicles);
    map.on('viewreset', renderVehicles);
    map.on('resize', renderVehicles);

    return () => {
      cancelAnimationFrame(animId);
      map.off('move', renderVehicles);
      map.off('zoom', renderVehicles);
      map.off('viewreset', renderVehicles);
      map.off('resize', renderVehicles);
    };
  }, [nodes, roads]);

  // Live ambulance layer: traveled / remaining route, abandoned route after a reroute, corridor signals
  useEffect(() => {
    const g = ambLayerGroupRef.current;
    if (!g) return;
    g.clearLayers();
    const opts = { pane: 'ambulancePane', interactive: false } as const;

    if (previousRoute.length > 1) {
      const old = buildCurvedRoutePolyline(previousRoute, nodes, roads);
      if (old.length > 1) {
        g.addLayer(L.polyline(old, { ...opts, color: '#f43f5e', weight: 5, opacity: 0.75, dashArray: '2, 10', lineCap: 'round' }));
      }
    }

    if (layers.routeCorridor && route.length > 1) {
      const idx = telemetry?.pathIndex ?? 0;
      const done = buildCurvedRoutePolyline(route.slice(0, idx + 1), nodes, roads);
      const ahead = buildCurvedRoutePolyline(route.slice(idx), nodes, roads);
      if (done.length > 1) {
        g.addLayer(L.polyline(done, { ...opts, color: '#64748b', weight: 4, opacity: 0.7 }));
      }
      if (ahead.length > 1) {
        g.addLayer(L.polyline(ahead, { ...opts, color: '#06b6d4', weight: 14, opacity: 0.4, lineCap: 'round', lineJoin: 'round' }));
        g.addLayer(L.polyline(ahead, { ...opts, color: '#22d3ee', weight: 4.5, opacity: 0.95, dashArray: '6, 6', lineCap: 'round' }));
      }
    }

    telemetry?.corridor.forEach((c, i) => {
      const n = nodes.find((x) => x.id === c.id);
      if (!n) return;
      const color = c.state === 'cleared' ? '#10b981' : c.state === 'locked' ? '#ef4444' : '#94a3b8';
      g.addLayer(
        L.circleMarker([n.lat, n.lng], {
          ...opts,
          radius: i === 0 ? 24 : 18,
          color,
          weight: i === 0 ? 3 : 2,
          fillColor: color,
          fillOpacity: 0.12,
          dashArray: c.state === 'normal' ? '3, 4' : undefined,
        })
      );
    });
  }, [route, previousRoute, telemetry, nodes, roads, layers.routeCorridor]);

  // Follow camera: keep the ambulance in view; any manual drag releases it
  const followRef = useRef(followAmbulance);
  followRef.current = followAmbulance;
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    const onDrag = () => onUserPan?.();
    map.on('dragstart', onDrag);
    const timer = window.setInterval(() => {
      if (!followRef.current) return;
      const amb = activeVehiclesRef.current.find((v) => v.isAmbulance);
      if (!amb) return;
      const c = getVehicleCoordinateAndHeading(amb.u, amb.v, amb.t, nodes, roads);
      if (!c) return;
      const size = map.getSize();
      const pt = map.latLngToContainerPoint([c.lat, c.lng]);
      const off = Math.hypot(pt.x - size.x / 2, pt.y - size.y / 2);
      if (off > Math.min(size.x, size.y) * 0.18) {
        map.panTo([c.lat, c.lng], { animate: true, duration: 0.6, easeLinearity: 0.8, noMoveStart: true });
      }
    }, 350);
    return () => {
      map.off('dragstart', onDrag);
      clearInterval(timer);
    };
  }, [nodes, roads, onUserPan]);

  // Search autocomplete for both Signals and Hospitals
  const matchingItems = searchQuery.trim()
    ? [
        ...hospitals
          .filter((h) =>
            h.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            h.bengaliName.includes(searchQuery) ||
            h.specialties.some((s) => s.toLowerCase().includes(searchQuery.toLowerCase())) ||
            h.address.toLowerCase().includes(searchQuery.toLowerCase())
          )
          .map((h) => ({
            type: 'hospital' as const,
            id: h.id,
            nodeId: h.nearestNodeId,
            name: h.name,
            sub: `${h.traumaLevel} · ${h.address}`,
            lat: h.lat,
            lng: h.lng,
          })),
        ...nodes
          .filter((n) =>
            n.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (n.bengaliName && n.bengaliName.includes(searchQuery)) ||
            (n.trafficGuard && n.trafficGuard.toLowerCase().includes(searchQuery.toLowerCase())) ||
            (n.landmark && n.landmark.toLowerCase().includes(searchQuery.toLowerCase()))
          )
          .map((n) => ({
            type: 'node' as const,
            id: `node-${n.id}`,
            nodeId: n.id,
            name: n.name,
            sub: `${n.trafficGuard || 'Kolkata Traffic Police'} · ${n.landmark || ''}`,
            lat: n.lat,
            lng: n.lng,
          })),
      ].slice(0, 7)
    : [];

  return (
    <div className="relative w-full h-full min-h-[420px] rounded-xl overflow-hidden border border-slate-700/60 shadow-xl bg-slate-950">
      {/* Leaflet DOM container */}
      <div ref={mapContainerRef} className="absolute inset-0 z-0" />

      {/* Transparent canvas layer overlaying leaflet for 60fps vehicle animation */}
      <canvas
        ref={animCanvasRef}
        className="absolute inset-0 pointer-events-none z-10 w-full h-full"
      />

      {/* Floating map search bar & quick jump */}
      <div className="absolute top-3 left-3 z-20 flex flex-col gap-1.5 pointer-events-auto max-w-[340px] w-full">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setShowSearchResults(true);
            }}
            onFocus={() => setShowSearchResults(true)}
            placeholder="Search signals, hospitals, junctions..."
            className="w-full bg-slate-900/95 backdrop-blur-md text-white placeholder-slate-400 text-xs px-3 py-2 pl-8 rounded-lg border border-slate-700 shadow-xl focus:outline-none focus:border-sky-400"
          />
          <span className="absolute left-2.5 top-2 text-slate-400 text-xs">🔍</span>
          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery('');
                setShowSearchResults(false);
              }}
              className="absolute right-2.5 top-2 text-slate-400 hover:text-white text-xs"
            >
              ✕
            </button>
          )}

          {/* Autocomplete dropdown */}
          {showSearchResults && matchingItems.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-slate-900/98 backdrop-blur-md border border-slate-700 rounded-lg shadow-2xl overflow-hidden z-30 max-h-[300px] overflow-y-auto">
              {matchingItems.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    if (mapInstanceRef.current) {
                      mapInstanceRef.current.flyTo([item.lat, item.lng], 16, { duration: 1.2 });
                    }
                    onSelectNode(item.nodeId);
                    setSearchQuery('');
                    setShowSearchResults(false);
                  }}
                  className="px-3 py-2 hover:bg-slate-800 cursor-pointer border-b border-slate-800 last:border-b-0 text-xs"
                >
                  <div className="font-semibold text-white flex items-center justify-between">
                    <span>{item.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${item.type === 'hospital' ? 'bg-rose-950 text-rose-300 border border-rose-800' : 'bg-sky-950 text-sky-300 border border-sky-800'}`}>
                      {item.type === 'hospital' ? '🏥 Hospital' : '🚦 Signal'}
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    {item.sub}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Floating Map Legend */}
      <div className="absolute top-3 right-12 z-20 pointer-events-auto hidden sm:flex items-center gap-2 bg-slate-900/90 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-slate-700/80 text-[10px] text-slate-300 shadow-lg">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span> Green
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span> Red
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"></span> Emergency
        </span>
        <span className="flex items-center gap-1 pl-1 border-l border-slate-700">
          <span>🏥</span> Hospital Gate
        </span>
        <span className="flex items-center gap-1 pl-1 border-l border-slate-700">
          <span className="w-3 border-b-2 border-dashed border-rose-400 inline-block"></span> Medical Link
        </span>
      </div>

      {/* Floating landmark jump buttons based on real locations */}
      <div className="absolute bottom-3 left-3 z-20 flex flex-wrap gap-1.5 pointer-events-auto max-w-[85%]">
        <span className="text-[10px] text-slate-300 bg-slate-900/90 px-2 py-1 rounded border border-slate-700 self-center font-medium">Quick Jump:</span>
        {[
          { label: 'Howrah Bridge', id: 5 },
          { label: 'SSKM Trauma (IPGMER)', id: 16 },
          { label: 'Calcutta Medical College', id: 7 },
          { label: 'Khanna / APC Rd Signal', id: 1 },
          { label: 'Park Circus 7-Pt', id: 14 },
          { label: 'Apollo EM Bypass', id: 21 },
          { label: 'Ruby Hospital', id: 23 },
          { label: 'Salt Lake Sector V', id: 22 },
        ].map((item, idx) => (
          <button
            key={idx}
            onClick={() => {
              const targetNode = nodes.find((n) => n.id === item.id);
              if (targetNode && mapInstanceRef.current) {
                mapInstanceRef.current.flyTo([targetNode.lat, targetNode.lng], 16, { duration: 1.2 });
                onSelectNode(item.id);
              }
            }}
            className="text-[11px] bg-slate-900/90 hover:bg-slate-800 text-slate-200 hover:text-white px-2.5 py-1 rounded-md border border-slate-700/80 shadow backdrop-blur-sm transition-colors whitespace-nowrap font-medium"
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
});
