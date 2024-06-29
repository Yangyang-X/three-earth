import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as turf from "@turf/turf";
import earcut from "earcut";
import { openDB } from "idb";
import { latLngTo3DPosition } from "./geoUtils.js";

// Constants for default values
const DEFAULT_RADIUS = 100;
const DEFAULT_COLOR = "red";

var previousGeometries = [];
var polygonCache = {};

// Save polygons to the cache
function savePolygonsToCache(key, data) {
  polygonCache[key] = data;
}

// Get polygons from the cache
function getPolygonsFromCache(key) {
  return polygonCache[key] || null;
}

// Convert polygons to storable data
function convertPolygonsToData(polygons) {
  return polygons.map((polygon) => ({
    coordinates: polygon.geometry.coordinates,
    properties: polygon.properties,
  }));
}

// Recreate polygons from stored data
function recreatePolygons(polygonData) {
  return polygonData.map((data) =>
    turf.polygon(data.coordinates, data.properties)
  );
}

async function openDatabase() {
  return openDB("meshData", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("meshData")) {
        db.createObjectStore("meshData", { keyPath: "key" });
      }
    },
  });
}

function serializeMesh(mesh) {
  if (!mesh.geometry || !mesh.material) {
    throw new Error("Mesh geometry or material is undefined");
  }

  return {
    geometry: mesh.geometry.toJSON(),
    material: mesh.material.toJSON(),
    position: mesh.position.toArray(),
    rotation: mesh.rotation.toArray(),
    scale: mesh.scale.toArray(),
  };
}

function deserializeMesh(data) {
  const geometryLoader = new THREE.BufferGeometryLoader();
  const materialLoader = new THREE.MaterialLoader();

  const mesh = new THREE.Mesh(
    geometryLoader.parse(data.geometry),
    materialLoader.parse(data.material)
  );

  mesh.position.fromArray(data.position);
  mesh.rotation.fromArray(data.rotation);
  mesh.scale.fromArray(data.scale);

  return mesh;
}

async function saveMeshData(key, meshes) {
  const db = await openDatabase();
  const tx = db.transaction("meshData", "readwrite");
  const store = tx.objectStore("meshData");
  const serializedMeshes = meshes.map((mesh) => serializeMesh(mesh)); // Ensure this handles an array
  await store.put({ key, value: serializedMeshes });
  await tx.complete;
  console.log("Saved meshes to database for:", key);
}

async function loadMeshData(key) {
  console.log("Load... mesh data for:", key);
  const db = await openDatabase();
  const tx = db.transaction("meshData", "readonly");
  const store = tx.objectStore("meshData");
  const result = await store.get(key);

  if (result && Array.isArray(result.value)) {
    const meshes = result.value.map((serializedMesh) =>
      deserializeMesh(serializedMesh)
    );
    console.log(`${new Date().toISOString()}: Meshes loaded for ${key}`);

    // Calculate the size of the data in kilobytes
    const jsonData = JSON.stringify(result.value);
    const sizeInBytes = new Blob([jsonData]).size;
    const sizeInKilobytes = sizeInBytes / 1024;
    console.log(`Data size: ${sizeInKilobytes.toFixed(2)} KB`);

    return meshes;
  } else {
    console.error(
      "Mesh data for ",
      key,
      "is not properly formatted or is missing."
    );
    return null;
  }
}

function combineMeshes(meshes) {
  // Filter out any meshes that don't have geometry or material to avoid errors
  const filteredMeshes = meshes.filter(
    (mesh) => mesh.geometry && mesh.material
  );
  console.log(
    "Meshes count: %s, filtered count: %s",
    meshes.length,
    filteredMeshes.length
  );

  // Convert Mesh to BufferGeometry if necessary
  const geometries = filteredMeshes.map((mesh) => {
    if (mesh.geometry.isBufferGeometry) {
      return mesh.geometry;
    } else {
      return new THREE.BufferGeometry().fromGeometry(mesh.geometry);
    }
  });

  // Merge all geometries into one
  const mergedGeometry = mergeGeometries(geometries, false);

  // Assuming all meshes share the same material (for simplicity)
  const mergedMaterial = filteredMeshes[0].material;

  // Create a new mesh with the merged geometry and material
  return new THREE.Mesh(mergedGeometry, mergedMaterial);
}

async function geoJsonTo3DMesh(name, geoJson, radius = DEFAULT_RADIUS) {
  if (!geoJson || !geoJson.features) {
    console.error("Invalid GeoJSON data:", geoJson);
    return [];
  }

  let meshes = [];
  const meshMethod = geoJson["meshMethod"];

  // Attempt to load precomputed meshes from the database
  if (["ru", "ca", "us", "cn", "br", "au"].includes(name)) {
    const data = await loadMeshData(name);
    if (data) {
      console.log("Meshed data loaded from database:", name);
      return data;
    }
  }

  // Process each feature in the GeoJSON
  for (const feature of geoJson.features) {
    if (!feature.geometry || !feature.geometry.coordinates) {
      console.error(`Feature does not have a valid geometry:`, feature);
      continue;
    }

    const geometryType = feature.geometry.type;
    let polygons =
      geometryType === "Polygon"
        ? [feature.geometry.coordinates]
        : geometryType === "MultiPolygon"
        ? feature.geometry.coordinates
        : null;

    if (!polygons) {
      console.error(`Unsupported geometry type: ${geometryType}`);
      continue;
    }

    // Process each polygon or multipolygon
    for (const polygonCoords of polygons) {
      // Ensure each ring has at least four coordinates and closes properly
      const rings = polygonCoords
        .map((ring) => {
          const ringClosed = ring[0].every(
            (val, index) => val === ring[ring.length - 1][index]
          )
            ? ring
            : [...ring, ring[0]];
          return ringClosed.length >= 4 ? ringClosed : null;
        })
        .filter((ring) => ring !== null);

      if (rings.length === 0) {
        console.error(
          "Invalid or too few coordinates to form a polygon:",
          polygonCoords
        );
        continue;
      }

      const polygon = turf.polygon(rings);
      const area = turf.area(polygon) / 1000000; // Convert area to square kilometers

      // Check the area to determine processing method
      if (meshMethod === "earcut" || area < 200000) {
        const data = earcut.flatten(rings);
        const { vertices, holes, dimensions } = data;
        const indices = earcut(vertices, holes, dimensions);
        const mesh = createMesh(vertices, indices, dimensions, radius);
        meshes.push(mesh);
      } else {
        const cellSide = area > 1000000 ? 75.0 : 30.0;
        const bbox = turf.bbox(polygon);
        const squareGrid = turf.squareGrid(bbox, cellSide, {
          units: "kilometers",
        });

        const clippedPolygons = squareGrid.features
          .map((cell) => {
            const intersection = turf.intersect(
              turf.featureCollection([cell, polygon])
            );
            return intersection &&
              intersection.geometry &&
              intersection.geometry.coordinates.length > 0
              ? intersection
              : null;
          })
          .filter(Boolean);

        // Process each clipped polygon
        for (const clipped of clippedPolygons) {
          const data = earcut.flatten(clipped.geometry.coordinates);
          const { vertices, holes, dimensions } = data;
          const indices = earcut(vertices, holes, dimensions);
          const mesh = createMesh(vertices, indices, dimensions, radius);
          meshes.push(mesh);
        }
      }
    }
  }

  // Optionally save the computed meshes for large countries
  if (["ru", "ca", "us", "cn", "br", "au"].includes(name)) {
    const combinedMesh = combineMeshes(meshes);
    saveMeshData(name, [combinedMesh]); // Save the combined mesh as an array
  }

  return meshes;
}

async function largePolygonToMeshes(polygon, area, radius) {
  const cellSide = area > 1000000 ? 75.0 : 30.0;
  const bbox = turf.bbox(polygon);
  const squareGrid = turf.squareGrid(bbox, cellSide, { units: "kilometers" });

  const clippedPolygons = squareGrid.features
    .map((cell) => {
      const intersection = turf.intersect(
        turf.featureCollection([cell, polygon])
      );
      return intersection &&
        intersection.geometry &&
        intersection.geometry.coordinates.length > 0
        ? intersection
        : null;
    })
    .filter(Boolean);

  console.log("Polygon splitted. Length:", clippedPolygons.length);

  const meshes = [];
  clippedPolygons.forEach((clipped) => {
    const mesh = polygonToMesh(clipped, radius);
    meshes.push(mesh);
  });
  return meshes;
}

function polygonToMesh(polygon, radius) {
  const data = earcut.flatten(polygon.geometry.coordinates);
  return createMesh(data.vertices, data.indices, data.dimensions, radius);
}

function createMesh(vertices, indices, dimensions, radius) {
  const vertices3D = [];
  for (let i = 0; i < vertices.length; i += dimensions) {
    const lat = vertices[i + 1];
    const lng = vertices[i];
    const [x, y, z] = latLngTo3DPosition(lat, lng, radius);
    vertices3D.push(x, y, z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices3D.flat(), 3)
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: DEFAULT_COLOR,
    side: THREE.DoubleSide,
  });

  return new THREE.Mesh(geometry, material);
}

function geoJsonTo3DLines(geoJson, radius = DEFAULT_RADIUS) {
  if (!geoJson || !geoJson.features) {
    console.error("Invalid GeoJSON data:", geoJson);
    return [];
  }

  const lines = [];

  geoJson.features.forEach((feature, featureIndex) => {
    if (feature.geometry && feature.geometry.coordinates) {
      feature.geometry.coordinates.forEach((polygon, polyIndex) => {
        polygon.forEach((ring, ringIndex) => {
          const vertices3D = [];
          ring.forEach(([lng, lat]) => {
            const [x, y, z] = latLngTo3DPosition(lat, lng, radius);
            vertices3D.push(x, y, z);
          });

          // Ensure the polygon is closed
          const firstPoint = vertices3D.slice(0, 3);
          vertices3D.push(...firstPoint);

          // Create geometry for the line
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(vertices3D, 3)
          );

          const material = new THREE.LineBasicMaterial({
            color: DEFAULT_COLOR,
          });
          const line = new THREE.LineLoop(geometry, material);
          lines.push(line);
        });
      });
    } else {
      console.error(`Feature does not have a valid geometry:`, feature);
    }
  });

  return lines;
}

function geoJsonToSingle3DPin(geoJson, radius = DEFAULT_RADIUS) {
  if (!geoJson || !geoJson.features) {
    console.error("Invalid GeoJSON data:", geoJson);
    return [];
  }
  const pins = [];
  const firstFeature = geoJson.features[0];

  if (
    firstFeature &&
    firstFeature.geometry &&
    firstFeature.geometry.coordinates
  ) {
    // Function to calculate the centroid of a polygon
    const calculateCentroid = (coordinates) => {
      let totalLng = 0;
      let totalLat = 0;
      let count = 0;

      coordinates.forEach((ring) => {
        ring.forEach(([lng, lat]) => {
          totalLng += lng;
          totalLat += lat;
          count++;
        });
      });

      return [totalLat / count, totalLng / count];
    };

    // Extract coordinates based on geometry type
    let centroidLatLng;
    if (firstFeature.geometry.type === "Polygon") {
      const firstPolygon = firstFeature.geometry.coordinates;
      centroidLatLng = calculateCentroid(firstPolygon);
    } else if (firstFeature.geometry.type === "MultiPolygon") {
      const firstPolygon = firstFeature.geometry.coordinates[0];
      centroidLatLng = calculateCentroid(firstPolygon);
    } else {
      console.error(`Unsupported geometry type:`, firstFeature.geometry.type);
      return [];
    }

    // Convert the centroid to 3D coordinates
    const [centroidLat, centroidLng] = centroidLatLng;
    const [x, y, z] = latLngTo3DPosition(centroidLat, centroidLng, radius);

    // Create a custom pin
    const pin = createClassicPin(DEFAULT_COLOR);

    // Set the position of the pin
    pin.position.set(x, y, z);

    // Calculate the normal vector and align the pin outward
    const normal = new THREE.Vector3(x, y, z).normalize();
    const up = new THREE.Vector3(0, 1, 0);

    // Create a quaternion to align the pin with the normal vector
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, normal);
    pin.setRotationFromQuaternion(quaternion);

    pins.push(pin);
  } else {
    console.error(
      `First feature does not have a valid geometry:`,
      firstFeature
    );
  }

  return pins;
}

function createClassicPin(color) {
  const pinGroup = new THREE.Group();

  const stickHeight = 4;
  const stickGeometry = new THREE.CylinderGeometry(0.1, 0.1, stickHeight, 16);
  const stickMaterial = new THREE.MeshBasicMaterial({ color });
  const stick = new THREE.Mesh(stickGeometry, stickMaterial);

  const ballRadius = 1.5;
  const ballGeometry = new THREE.SphereGeometry(ballRadius, 16, 16);
  const ballMaterial = new THREE.MeshBasicMaterial({ color });
  const ball = new THREE.Mesh(ballGeometry, ballMaterial);

  const baseRadius = 0.5;
  const baseHeight = 0.2;
  const baseGeometry = new THREE.CylinderGeometry(
    baseRadius,
    baseRadius,
    baseHeight,
    16
  );
  const baseMaterial = new THREE.MeshBasicMaterial({ color });
  const base = new THREE.Mesh(baseGeometry, baseMaterial);

  stick.position.set(0, stickHeight / 2, 0);
  ball.position.set(0, stickHeight + ballRadius, 0);
  base.position.set(0, -baseHeight / 2, 0);

  pinGroup.add(stick);
  pinGroup.add(ball);
  pinGroup.add(base);

  return pinGroup;
}

// Function to adjust the scale of existing meshes
function adjustMeshScale(meshes, newRadius, oldRadius) {
  const scaleRatio = newRadius / oldRadius;
  meshes.forEach((mesh) => {
    mesh.scale.set(scaleRatio, scaleRatio, scaleRatio);
  });
}

// Function to remove previous geometries
function removePreviousGeometries(earth) {
  if (previousGeometries.length > 0) {
    previousGeometries.forEach((geometryId) => {
      const previousGeometry = earth.getObjectByProperty("uuid", geometryId);
      if (previousGeometry) {
        earth.remove(previousGeometry);
      }
    });
    previousGeometries.length = 0;
  }
}

// Function to highlight a region with different styles
async function highlightPolygons(
  name,
  geoJson,
  earth,
  radius = DEFAULT_RADIUS,
  style = "mesh",
  elevation = 1.0
) {
  // Resize the Earth to the initial radius if zoomed
  earth.scale.set(1, 1, 1);

  // Highlight new polygons after a delay
  let polygonMeshes = [];

  // Check if the meshes are already stored and reuse them if possible
  if (style === "mesh") {
    polygonMeshes = await geoJsonTo3DMesh(name, geoJson, radius * elevation);
  } else if (style === "lines") {
    polygonMeshes = geoJsonTo3DLines(geoJson, radius * elevation);
  } else if (style === "pin") {
    polygonMeshes = geoJsonToSingle3DPin(geoJson, radius * elevation);
  }

  // Add polygon meshes to the Earth
  polygonMeshes.forEach((geometry) => {
    previousGeometries.push(geometry.uuid);
    earth.add(geometry);
  });
}

export { highlightPolygons, removePreviousGeometries };
