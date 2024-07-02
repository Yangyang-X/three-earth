import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as turf from "@turf/turf";
import earcut from "earcut";
import { openDB } from "idb";
import { latLngTo3DPosition } from "./geoUtils.js";

// Constants for default values
const DEFAULT_RADIUS = 100;
const DEFAULT_COLOR = "red";

// var polygonCache = {};

// Save polygons to the cache
// function savePolygonsToCache(key, data) {
//   polygonCache[key] = data;
// }

// // Get polygons from the cache
// function getPolygonsFromCache(key) {
//   return polygonCache[key] || null;
// }

// // Convert polygons to storable data
// function convertPolygonsToData(polygons) {
//   return polygons.map((polygon) => ({
//     coordinates: polygon.geometry.coordinates,
//     properties: polygon.properties,
//   }));
// }

// // Recreate polygons from stored data
// function recreatePolygons(polygonData) {
//   return polygonData.map((data) =>
//     turf.polygon(data.coordinates, data.properties)
//   );
// }

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
    // const jsonData = JSON.stringify(result.value);
    // const sizeInBytes = new Blob([jsonData]).size;
    // const sizeInKilobytes = sizeInBytes / 1024;
    // console.log(`Data size: ${sizeInKilobytes.toFixed(2)} KB`);

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
  // Filter out any meshes that don't have geometry or are without material (assuming lines might not always have materials)
  const filteredMeshes = meshes.filter((mesh) => mesh.geometry);

  // Determine if these are line meshes by checking if any use a LineMaterial
  const areLines = filteredMeshes.some(
    (mesh) => mesh.material instanceof THREE.LineBasicMaterial
  );

  // Combine geometries based on their type
  if (areLines) {
    // Combine line geometries
    const materials = filteredMeshes.map((mesh) => mesh.material);
    const geometries = filteredMeshes.map((mesh) => mesh.geometry);

    // Since lines might not need to be merged in the same way, you might consider just grouping them
    const lineGroup = new THREE.Group();
    geometries.forEach((geometry, index) => {
      const lineMesh = new THREE.LineLoop(geometry, materials[index]);
      lineGroup.add(lineMesh);
    });
    return lineGroup;
  } else {
    // Combine solid geometries as before
    const geometries = filteredMeshes.map((mesh) => {
      if (mesh.geometry.isBufferGeometry) {
        return mesh.geometry;
      } else {
        return new THREE.BufferGeometry().fromGeometry(mesh.geometry);
      }
    });

    const mergedGeometry = mergeGeometries(geometries, false);
    const mergedMaterial = filteredMeshes[0].material; // Assuming all use the same material for simplicity
    return new THREE.Mesh(mergedGeometry, mergedMaterial);
  }
}

async function exportMeshToGLB(mesh) {
  if (!GLTFExporter) {
    console.error("GLTFExporter is not available");
    return;
  }
  const exporter = new GLTFExporter();

  return new Promise((resolve, reject) => {
    exporter.parse(
      mesh,
      function (gltf) {
        try {
          let blob;
          if (gltf instanceof ArrayBuffer) {
            blob = new Blob([gltf], { type: "model/gltf-binary" });
            // console.log("Export successful, GLB data is ready.");
          } else {
            blob = new Blob([JSON.stringify(gltf)], {
              type: "model/gltf-binary",
            });
            // console.log("Export successful, JSON converted to GLB.");
          }
          // console.log("GLB size:", (blob.size / 1024).toFixed(2), "KB");
          resolve(blob);
        } catch (error) {
          console.error("Export failed:", error);
          reject(error);
        }
      },
      { binary: true }
    );
  });
}

async function saveMeshDataAsBinary(key, blob) {
  const db = await openDatabase();
  const tx = db.transaction("meshData", "readwrite");
  const store = tx.objectStore("meshData");

  tx.onerror = (event) => {
    console.error("Failed to save blob:", event.target.error);
  };

  // Store the blob in IndexedDB
  await store.put({ key, value: blob });
  await tx.complete;
}

async function deserializeGLB(blob) {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    if (!blob) {
      reject("No blob provided for deserialization");
      return;
    }

    const reader = new FileReader();
    reader.readAsArrayBuffer(blob);
    reader.onload = () => {
      loader.parse(
        reader.result,
        "",
        (gltf) => {
          // console.log("GLB data deserialized successfully");
          const meshes = [];
          gltf.scene.traverse((child) => {
            if (child.isMesh) {
              meshes.push(child);
            }
          });
          resolve(meshes); // Resolves with an array of meshes
        },
        (error) => {
          console.error("Error deserializing GLB data:", error);
          reject(error);
        }
      );
    };
    reader.onerror = (error) => {
      console.error("Error reading blob:", error);
      reject(error);
    };
  });
}

async function loadMeshDataAsBinary(key) {
  console.log("Loading mesh data from database for:", key);
  try {
    const db = await openDatabase();
    const tx = db.transaction("meshData", "readonly");
    const store = tx.objectStore("meshData");
    const result = await store.get(key);

    if (result) {
      return await deserializeGLB(result.value); // Directly use the deserialized GLB to get meshes
    } else {
      console.error("Mesh data for", key, "is not available.");
      return null;
    }
  } catch (error) {
    console.error("Failed to load mesh data for", key, "with error:", error);
    return null;
  }
}

async function downloadFromIDB(key) {
  const db = await openDatabase(); // Ensure this uses your defined 'openDatabase' function
  const tx = db.transaction("meshData", "readonly");
  const store = tx.objectStore("meshData");
  const result = await store.get(key);

  if (result) {
    const blob = result.value;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = key + ".glb"; // Assuming the file is a GLB file
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } else {
    console.error("No data found for key:", key);
  }
}

async function loadMeshDataFromFile(name) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const path = `./data/${name}.glb`; // Adjust the path as necessary

    loader.load(
      path,
      (gltf) => {
        console.log("Mesh data loaded from file:", name);
        const meshes = [];
        gltf.scene.traverse((child) => {
          if (child.isMesh) {
            meshes.push(child);
          }
        });
        resolve(meshes);
      },
      undefined,
      (error) => {
        console.error("Failed to load mesh data from file:", error);
        reject(error);
      }
    );
  });
}

async function geoJsonTo3DMeshUsingEarcut(geoJson, radius = DEFAULT_RADIUS) {
  if (!geoJson || !geoJson.features) {
    console.error("Invalid GeoJSON data:", geoJson);
    return [];
  }

  let meshes = [];

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

      const data = earcut.flatten(rings);
      const { vertices, holes, dimensions } = data;
      const indices = earcut(vertices, holes, dimensions);
      const mesh = createMesh(vertices, indices, dimensions, radius);
      meshes.push(mesh);
    }
  }
  if (meshes.length > 1) {
    return combineMeshes(meshes);
  } else {
    return meshes[0];
  }
}

async function geoJsonTo3DMesh(geoJson, radius = DEFAULT_RADIUS) {
  if (!geoJson || !geoJson.features) {
    console.error("Invalid GeoJSON data:", geoJson);
    return [];
  }

  const name = geoJson.name;
  const meshMethod = geoJson.meshMethod;

  let meshes = [];
  const glbCountries = [
    "in",
    "ar",
    "kz",
    "dz",
    "cd",
    "sa",
    "mx",
    "sd",
    "ly",
    "ir",
    "mn",
    "pe",
    "td",
    "et",
    "cl",
    "ma",
    "af",
    "mm",
    "ml",
    "ao",
    "ne",
    "co",
    "za",
    "cg",
    "mr",
    "eg",
    "tz",
    "ng",
    "ve",
    "pk",
    "na",
    "mz",
    "tr",
    "us",
    "ca",
    "ru",
    "cn",
    "au",
    "br",
    "fr",
    "id",
  ];

  // Attempt to load precomputed meshes from the database
  if (glbCountries.includes(name)) {
    try {
      const meshes = await loadMeshDataFromFile(name);
      if (meshes) {
        return meshes; // Directly use the meshes loaded from the database
      }
    } catch (error) {
      console.error("Failed to load mesh data from database:", error);
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
      const usingTurf = meshMethod === "turf" || area >= 200000; //todo reset me
      // const usingTurf = false;
      if (!usingTurf) {
        const data = earcut.flatten(rings);
        const { vertices, holes, dimensions } = data;
        const indices = earcut(vertices, holes, dimensions);
        const mesh = createMesh(vertices, indices, dimensions, radius);
        meshes.push(mesh);
      } else {
        const cellSide = area > 1000000 ? 75.0 : 20.0;
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
  // if (
  //   [
  //     "IN",
  //     "AR",
  //     "KZ",
  //     "DZ",
  //     "CD",
  //     "SA",
  //     "MX",
  //     "SD",
  //     "LY",
  //     "IR",
  //     "MN",
  //     "PE",
  //     "TD", // existing 20 largest
  //     "ET",
  //     "CL",
  //     "MA",
  //     "AF",
  //     "MM",
  //     "ML",
  //     "AO",
  //     "NE",
  //     "CO",
  //     "ZA", // 20 additional large countries
  //     "CG",
  //     "MR",
  //     "EG",
  //     "TZ",
  //     "NG",
  //     "VE",
  //     "PK",
  //     "NA",
  //     "MZ",
  //     "TR", // 20 additional large countries
  //   ].includes(name.toUpperCase())
  // ) {
  //   const combinedMesh = combineMeshes(meshes);
  //   exportMeshToGLB(combinedMesh)
  //     .then((glbBlob) => {
  //       saveMeshDataAsBinary(name, glbBlob); // Save the GLB blob to IndexedDB
  //       setTimeout(() => {
  //         downloadFromIDB(name);
  //       }, 500);
  //     })
  //     .catch((error) => {
  //       console.error("Failed to save mesh data as GLB:", error);
  //     });
  // }
  return meshes;
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

// Function to highlight a region with different styles
async function polygonsToMesh(
  geoJson,
  radius = DEFAULT_RADIUS,
  style = "mesh",
  elevation = 1.0
) {

  if (style === "mesh") {
    return await geoJsonTo3DMesh(geoJson, radius * elevation);
    // return await geoJsonTo3DMeshUsingEarcut(geoJson, radius * elevation);
  } else if (style === "lines") {
    return geoJsonTo3DLines(geoJson, radius * elevation);
  } else if (style === "pin") {
    return geoJsonToSingle3DPin(geoJson, radius * elevation);
  }
}

function createOutlineMesh(vertices, radius, color) {
  const points = vertices.map(([lng, lat]) => {
    const [x, y, z] = latLngTo3DPosition(lat, lng, radius);
    return new THREE.Vector3(x, y, z);
  });
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: color });
  return new THREE.LineLoop(geometry, material);
}

async function geoJsonTo3DOutlineMesh(geoJson, radius = DEFAULT_RADIUS, color) {
  if (!geoJson || !geoJson.features) {
    console.error("Invalid GeoJSON data:", geoJson);
    return [];
  }

  let lineMeshes = [];

  for (const feature of geoJson.features) {
    if (!feature.geometry || !feature.geometry.coordinates) {
      console.error(`Feature does not have a valid geometry:`, feature);
      continue;
    }

    const geometryType = feature.geometry.type;
    let lines = [];

    if (geometryType === "Polygon") {
      lines = feature.geometry.coordinates;
    } else if (geometryType === "MultiPolygon") {
      // Correctly handle MultiPolygon by flattening only one level
      feature.geometry.coordinates.forEach((poly) => {
        lines.push(...poly);
      });
    } else {
      console.error(`Unsupported geometry type for outlines: ${geometryType}`);
      continue;
    }

    lines.forEach((lineCoords) => {
      if (lineCoords.length > 0 && Array.isArray(lineCoords[0])) {
        const outlineMesh = createOutlineMesh(lineCoords, radius, color);
        lineMeshes.push(outlineMesh);
      } else {
        console.error("Invalid line coordinates:", lineCoords);
      }
    });
  }

  return lineMeshes;
}

async function generateCountryOutlines(geoJson, color) {
  const outlines = await geoJsonTo3DOutlineMesh(geoJson, DEFAULT_RADIUS, color);
  const combinedOutlines = combineMeshes(outlines);
  return combinedOutlines;
}

export { polygonsToMesh, generateCountryOutlines };
