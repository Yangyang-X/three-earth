// Calculate the centroid of a GeoJSON polygon
export function calculatePolygonCentroid(geometry) {

    let polygon;
    switch (geometry.type) {
      case "Polygon":
        polygon = geometry.coordinates;
        break;
      case "MultiPolygon":
        polygon = geometry.coordinates[0];
        break;
      default:
        console.error(`Unsupported geometry type for centroid calculation: ${geometry.type}`);
        return { lat: 0, lng: 0 };
    }

    let totalLat = 0;
    let totalLng = 0;
    let count = 0;

    polygon.forEach((ring) => {
        ring.forEach(([lng, lat]) => {
            totalLat += lat;
            totalLng += lng;
            count++;
        });
    });

    return {
        lat: totalLat / count,
        lng: totalLng / count
    };
}

// Convert latitude and longitude to a 3D position on a sphere
export function latLngTo3DPosition(lat, lng, radius = 100) {
    const phi = ((90 - lat) * Math.PI) / 180; // Polar angle in radians
    const theta = ((180 + lng) * Math.PI) / 180; // Azimuthal angle in radians

    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);

    return [x, y, z];
}
