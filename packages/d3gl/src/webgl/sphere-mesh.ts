/** A UV-sphere as parallel arrays. Each vertex carries its lon/lat (degrees) so the
 *  globe shader can both place it (lon/lat → 3D direction → rotate → orthographic)
 *  and sample the equirectangular texture (lon/lat → uv). Unit radius. */
export interface SphereMesh {
  lonLat: Float32Array;   // stride 2: [lonDeg, latDeg] per vertex
  indices: Uint32Array;
}

export function buildSphereMesh(lonSegments = 96, latSegments = 48): SphereMesh {
  const lonLat: number[] = [];
  for (let j = 0; j <= latSegments; j++) {
    const lat = 90 - (180 * j) / latSegments;
    for (let i = 0; i <= lonSegments; i++) {
      const lon = -180 + (360 * i) / lonSegments;
      lonLat.push(lon, lat);
    }
  }
  const idx: number[] = [];
  const row = lonSegments + 1;
  for (let j = 0; j < latSegments; j++) {
    for (let i = 0; i < lonSegments; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { lonLat: new Float32Array(lonLat), indices: new Uint32Array(idx) };
}
