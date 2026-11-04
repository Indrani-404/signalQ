import fs from 'fs';
import { KOLKATA_NODES, KOLKATA_ROADS } from '../src/data/kolkataData';

async function fetchRoute(uLng: number, uLat: number, vLng: number, vLat: number): Promise<[number, number][] | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${uLng},${uLat};${vLng},${vLat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
      return data.routes[0].geometry.coordinates.map(([lng, lat]: [number, number]) => [
        Number(lat.toFixed(6)),
        Number(lng.toFixed(6)),
      ]);
    }
  } catch (err) {
    console.error('Error fetching route:', err);
  }
  return null;
}

async function run() {
  console.log(`Fetching exact OSM geometries for ${KOLKATA_ROADS.length} Kolkata roads...`);
  const exactPaths: { [key: string]: [number, number][] } = {};

  for (let i = 0; i < KOLKATA_ROADS.length; i++) {
    const road = KOLKATA_ROADS[i];
    const uNode = KOLKATA_NODES.find((n) => n.id === road.u);
    const vNode = KOLKATA_NODES.find((n) => n.id === road.v);

    if (!uNode || !vNode) continue;

    console.log(`[${i + 1}/${KOLKATA_ROADS.length}] Fetching ${road.name} (${uNode.name} -> ${vNode.name})...`);
    const path = await fetchRoute(uNode.lng, uNode.lat, vNode.lng, vNode.lat);

    if (path && path.length >= 2) {
      exactPaths[road.id] = path;
      console.log(`  ✓ Got ${path.length} waypoints`);
    } else {
      console.log(`  ⚠ Fallback to existing path`);
      if (road.path) {
        exactPaths[road.id] = road.path;
      } else {
        exactPaths[road.id] = [[uNode.lat, uNode.lng], [vNode.lat, vNode.lng]];
      }
    }

    // Gentle delay to respect public OSRM server rate limits
    await new Promise((r) => setTimeout(r, 250));
  }

  fs.writeFileSync('./src/data/exactRoadPaths.json', JSON.stringify(exactPaths, null, 2));
  console.log('Saved exact road geometries to ./src/data/exactRoadPaths.json');
}

run();
