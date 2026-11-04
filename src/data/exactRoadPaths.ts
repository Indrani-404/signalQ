import exactRoadPathsJson from './exactRoadPaths.json';

// Exact street-level OpenStreetMap road geometries for Kolkata
export const EXACT_ROAD_PATHS = exactRoadPathsJson as unknown as Record<string, [number, number][]>;
