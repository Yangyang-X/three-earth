import * as THREE from "three";
import * as turf from "@turf/turf";
import { createEarth } from "./components/earth.js";
import { createCamera } from "./components/camera.js";
import { createScene } from "./components/scene.js";
import { createLight } from "./components/light.js";
import { createRenderer } from "./systems/renderer.js";
import { createControls } from "./systems/cameraControls.js";
import { Resizer } from "./systems/resizer.js";
import {
  generateCountryOutlines,
  loadGlbMesh,
  polygonsToMesh,
} from "./utils/meshUtils.js";
import {
  calculatePolygonCentroid,
  latLngTo3DPosition,
} from "./utils/geoUtils.js";

const MARGIN = 24; // Margin in units on each side
const INITIAL_EARTH_RADIUS = 100;
const MAX_EARTH_RADIUS = 200;

let controls;
let resizer;

let boundingBoxes = {};

class World {
  constructor(container) {
    const containerWidth = container.clientWidth;
    this.earthRadius = Math.min(
      (containerWidth - MARGIN * 2) / 2,
      INITIAL_EARTH_RADIUS
    );

    this.camera = createCamera(container);
    this.scene = createScene();
    this.earth = createEarth(this.earthRadius, 32);
    this.renderer = createRenderer();
    container.append(this.renderer.domElement);

    this.scene.add(this.earth);

    const { mainLight, ambientLight } = createLight();
    this.scene.add(mainLight, ambientLight);

    controls = createControls(this.camera, container);
    controls.enableZoom = true;
    controls.minDistance = 50; // Minimum zoom distance
    controls.maxDistance = MAX_EARTH_RADIUS * 2;
    resizer = new Resizer(container, this.camera, this.renderer);

    this.previousTargetLatLng = { lat: 0, lng: -90 };

    window.addEventListener("mousedown", this.onPointerDown.bind(this), false);
    window.addEventListener("touchstart", this.onPointerDown.bind(this), false);

    this.currentlyHighlighted = null; // Store the currently highlighted country mesh
    this.previousGeometries = [];
    this.loadCountryCenters();
    this.countriesGeoJsonCache = {};
  }

  async loadCountryCenters() {
    try {
      const response = await fetch("./countryCenter.json");
      this.countryCenters = await response.json();
      console.log("Country centers loaded.");
    } catch (err) {
      console.error("Error loading country centers:", err);
    }
  }

  start() {
    this.renderer.setAnimationLoop(() => {
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop() {
    this.renderer.setAnimationLoop(null);
  }

  async drawCountryOutlines(geojson, color) {
    const mesh = await generateCountryOutlines(geojson, color);
    this.earth.add(mesh);
  }
  resetGlobePosition() {
    const [x, y, z] = latLngTo3DPosition(0, -90, this.earthRadius);
    const direction = new THREE.Vector3(x, y, z).normalize();
    this.earth.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction
    );
  }

  positionToLatLng(position) {
    // Create a quaternion to hold the inverse of the Earth's rotation
    const inverseQuaternion = this.earth.quaternion.clone().invert();

    // Apply the inverse rotation to the position vector
    const rotatedPosition = position.clone().applyQuaternion(inverseQuaternion);

    // Normalize the rotated position vector
    const normalizedPosition = rotatedPosition.normalize();

    // Calculate the latitude
    const lat = Math.asin(normalizedPosition.y) * (180 / Math.PI);

    // Calculate the longitude
    const lng =
      Math.atan2(normalizedPosition.z, normalizedPosition.x) * (180 / Math.PI);
    const adjustedLng = ((lng + 180) % 360) - 180;
    console.log(lng, adjustedLng);

    return { lat, lng: 0 - adjustedLng };
  }

  getGlobeCenterLatLng() {
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(
      this.earth.quaternion
    );
    const adjustedDirection = direction.applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(90)
    );
    const latLng = this.positionToLatLng(adjustedDirection);

    console.log(
      `Globe center direction: ${direction.toArray()}, Adjusted direction: ${adjustedDirection.toArray()}, LatLng: ${
        latLng.lat
      }, ${latLng.lng}`
    );
    return latLng;
  }

  rotateGlobeTo(targetLatLng, onComplete) {
    // Current globe center point in lat/lng
    // const currentLatLng = this.getGlobeCenterLatLng();

    const initialLatLng = this.previousTargetLatLng;
    // Normalize the longitude difference for the shortest path
    const normalizeAngle = (angle) => {
      return ((angle + 180) % 360) - 180;
    };

    const azimuthalAngle = normalizeAngle(targetLatLng.lng - initialLatLng.lng);
    const azimuthalRotation = THREE.MathUtils.degToRad(azimuthalAngle);

    // Calculate polar rotation based on latitudinal change
    const polarAngle = targetLatLng.lat - initialLatLng.lat;
    const polarRotation = THREE.MathUtils.degToRad(polarAngle);

    // Create quaternions for each rotation
    const azimuthalQuaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), // Rotate around Y-axis for longitude
      -azimuthalRotation
    );

    const polarQuaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), // Rotate around X-axis for latitude
      polarRotation
    );

    // Combine rotations: first apply polar rotation, then azimuthal
    const finalRotation = polarQuaternion.multiply(azimuthalQuaternion);

    this.animateRotation(finalRotation, onComplete);
  }

  animateRotation(finalRotation, onComplete) {
    let duration = 800;
    const startTime = Date.now();

    const startRotation = this.earth.quaternion.clone(); // Clone the initial quaternion

    const animate = () => {
      const currentTime = Date.now();
      const fraction = (currentTime - startTime) / duration;

      if (fraction < 1) {
        // Update the quaternion by interpolating between the start and the target
        this.earth.quaternion
          .copy(startRotation)
          .slerp(finalRotation, fraction);
        requestAnimationFrame(animate);
      } else {
        // Make sure we end precisely at the final rotation
        this.earth.quaternion.copy(finalRotation);
        if (typeof onComplete === "function") {
          onComplete(); // Call the completion callback if provided
        }
      }
    };

    animate();
  }

  removePreviousGeometries() {
    if (this.previousGeometries.length > 0) {
      this.previousGeometries.forEach((geometryId) => {
        const geometry = this.earth.getObjectByProperty("uuid", geometryId);
        if (geometry) {
          this.earth.remove(geometry);
        }
      });
      this.previousGeometries = []; // Reset the array to an empty state
    }
  }

  async prepareCountryMeshes(geoJsons) {
    for (let i = 0; i < geoJsons.length; i++) {
      const geoJson = geoJsons[i];
      await polygonsToMesh(geoJson);
    }
  }

  async generateBoundingBoxes(geoJsons) {
    const boundingBoxes = {};

    for (let i = 0; i < geoJsons.length; i++) {
      const geoJson = geoJsons[i];
      console.log("Generating bounding boxes for", geoJson.name, i);
      const meshes = await polygonsToMesh(geoJson, undefined, false); // `false` indicates not to merge meshes

      if (Array.isArray(meshes)) {
        boundingBoxes[geoJson.name] = meshes
          .map((mesh) => {
            if (mesh instanceof THREE.Mesh) {
              // Validate the geometry before computing the bounding box
              if (
                mesh.geometry &&
                mesh.geometry.attributes &&
                mesh.geometry.attributes.position
              ) {
                const positionArray = mesh.geometry.attributes.position.array;
                const validPositions = Array.from(positionArray).every(
                  (val) => !isNaN(val)
                );

                if (validPositions) {
                  const boundingBox = new THREE.Box3().setFromObject(mesh);
                  const boxSize = boundingBox.getSize(new THREE.Vector3());
                  const boxCenter = boundingBox.getCenter(new THREE.Vector3());

                  // Return bounding box data for each mesh
                  return {
                    size: boxSize.toArray(),
                    center: boxCenter.toArray(),
                  };
                } else {
                  console.warn(
                    `Invalid positions detected in geometry for ${geoJson.name}`
                  );
                }
              }
            }
          })
          .filter(Boolean); // Remove undefined entries
      }
    }

    this.saveBoundingBoxesToFile(boundingBoxes);
  }

  saveBoundingBoxesToFile(boundingBoxes) {
    const jsonContent = JSON.stringify(boundingBoxes, null, 2);
    const blob = new Blob([jsonContent], { type: "application/json" });

    // Create a link element
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "boundingBoxes.json";

    // Append the link to the body
    document.body.appendChild(a);

    // Programmatically click the link to trigger the download
    a.click();

    // Remove the link from the document
    document.body.removeChild(a);
  }

  async loadBoundingBoxes() {
    let boundingBoxes;

    try {
      const response = await fetch("/boundingBoxes.json");
      boundingBoxes = await response.json();
    } catch (err) {
      console.error(
        "An error occurred while fetching the bounding boxes file:",
        err
      );
      return;
    }

    for (const name in boundingBoxes) {
      const boxes = boundingBoxes[name];
      if (Array.isArray(boxes)) {
        boxes.forEach((box) => {
          const { size, center } = box;

          const boxGeometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
          const boxMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0,
          });
          const boundingBoxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
          boundingBoxMesh.position.set(center[0], center[1], center[2]);
          boundingBoxMesh.userData.name = name;
          boundingBoxMesh.userData.isBoundingBox = true;

          // Add the bounding box to the earth
          this.earth.add(boundingBoxMesh);
        });
      }
    }

    console.log("Finished loading and processing bounding boxes.");
  }

  async loadCountryGeoJson(countryName) {
    if (!this.countriesGeoJsonCache[countryName]) {
      try {
        const response = await fetch(`/country/${countryName}.json`);
        if (response.ok) {
          const geoJson = await response.json();
          this.countriesGeoJsonCache[countryName] = geoJson;
        } else {
          console.error(`Failed to load GeoJSON for country: ${countryName}`);
        }
      } catch (error) {
        console.error(
          `Error loading GeoJSON for country: ${countryName}`,
          error
        );
      }
    }
    return this.countriesGeoJsonCache[countryName];
  }

  async onPointerDown(event) {
    // Calculate mouse position in normalized device coordinates (-1 to +1) for both components
    const mouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );

    // Create a raycaster and set it from the camera and mouse position
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    raycaster.params.Line.threshold = 0.1;

    // Check for intersections with objects in the scene
    const intersects = raycaster.intersectObjects(this.earth.children, true);

    if (intersects.length === 0) {
      console.log("No intersections found.");
      return;
    }

    // Find all intersected objects that are bounding boxes
    const boxIntersects = intersects.filter(
      (intersect) => intersect.object.userData.isBoundingBox
    );

    if (boxIntersects.length === 0) {
      console.log("No bounding boxes intersected.");
      return;
    }

    // Log all bounding boxes
    console.log(
      "Intersected bounding boxes:",
      boxIntersects.map((intersect) => intersect.object.userData.name)
    );

    if (boxIntersects.length === 1) {
      const countryName = boxIntersects[0].object.userData.name;
      console.log(`Only one bounding box intersected: ${countryName}`);
      this.highlightCountry(countryName);
      return;
    }

    // If there are multiple bounding boxes, find the intersection point with the Earth
    const earthIntersect = raycaster.intersectObject(this.earth, true);

    if (earthIntersect.length === 0) {
      console.log("No intersection with the Earth found.");
      return;
    }

    // Convert the intersection point to latitude and longitude
    const point = earthIntersect[0].point;
    const latLng = this.positionToLatLng(point);
    console.log(`Intersection point: ${point}, ${latLng.lat}, ${latLng.lng}`);
    const turfPoint = turf.point([latLng.lng, latLng.lat]);

    // Sort intersects by bounding box size (smallest first)
    boxIntersects.sort((a, b) => {
      const aBox = new THREE.Box3().setFromObject(a.object);
      const bBox = new THREE.Box3().setFromObject(b.object);
      return (
        aBox.getSize(new THREE.Vector3()).length() -
        bBox.getSize(new THREE.Vector3()).length()
      );
    });

    // Iterate over all intersected bounding boxes to find the country
    for (const boxIntersect of boxIntersects) {
      const countryName = boxIntersect.object.userData.name;
      // console.log(`Checking country box: ${countryName}`);

      const geoJson = await this.loadCountryGeoJson(countryName);
      if (geoJson) {
        console.log(geoJson);
        // Check if the point is within the bounding box's country polygons
        for (const feature of geoJson.features) {
          const geometryType = feature.geometry.type;
          if (geometryType === "Polygon" || geometryType === "MultiPolygon") {
            if (turf.booleanPointInPolygon(turfPoint, feature)) {
              // console.log(`The point is inside the country: ${countryName}`);
              this.highlightCountry(countryName);
              return;
            }
          } else {
            console.warn(`Unexpected geometry type: ${geometryType}`);
          }
        }
      }
    }

    console.log("The point is not inside any country");
  }

  async highlightCountry(countryName, style) {
    this.removePreviousGeometries();

    let meshPromise;
    const meshCountries = [
      "ps",
      "er",
      "fi",
      "gm",
      "ee",
      "iq",
      "hu",
      "ht",
      "es",
      "pe",
      "qa",
      "si",
      "sk",
      "ro",
      "pg",
      "gn",
      "fj",
      "gy",
      "ir",
      "kz",
      "ie",
      "id",
      "is",
      "eg",
      "sy",
      "sn",
      "ec",
      "et",
      "kh",
      "jm",
      "hr",
      "pt",
      "so",
      "pa",
      "sz",
      "gh",
      "jo",
      "it",
      "de",
      "sl",
      "cf",
      "mm",
      "na",
      "mz",
      "ml",
      "cg",
      "ao",
      "bt",
      "tn",
      "tl",
      "am",
      "cr",
      "az",
      "ba",
      "mn",
      "my",
      "mx",
      "lk",
      "cd",
      "al",
      "bw",
      "tz",
      "ve",
      "tm",
      "uz",
      "bd",
      "bs",
      "ng",
      "mk",
      "np",
      "ly",
      "cv",
      "br",
      "ca",
      "be",
      "ws",
      "th",
      "za",
      "uy",
      "tj",
      "vu",
      "bg",
      "ne",
      "cu",
      "bf",
      "zw",
      "zm",
      "vn",
      "co",
      "md",
      "la",
      "me",
      "lv",
      "om",
      "mr",
      "ni",
      "cy",
      "af",
      "cn",
      "bj",
      "tg",
      "tr",
      "ua",
      "cl",
      "lt",
      "mg",
      "lb",
      "lu",
      "ae",
      "cz",
      "bi",
      "ar",
      "cm",
      "td",
      "us",
      "bz",
      "ci",
      "no",
      "ch",
      "ug",
      "tt",
      "by",
      "au",
      "bn",
      "ma",
      "nz",
      "lr",
      "ls",
      "mw",
      "nl",
      "bo",
      "at",
      "ye",
      "sv",
      "sa",
      "kp",
      "kg",
      "in",
      "ge",
      "gr",
      "rs",
      "pl",
      "sb",
      "py",
      "dk",
      "il",
      "ke",
      "kr",
      "dj",
      "gq",
      "pk",
      "gb",
      "kw",
      "do",
      "gt",
      "ru",
      "sd",
      "ph",
      "ss",
      "rw",
      "dz",
      "ga",
      "fr",
      "hn",
      "jp",
      "gw",
      "sr",
      "se",
    ];

    try {
      if (meshCountries.includes(countryName)) {
        // console.log(`Loading GLB mesh for country: ${countryName}`);
        meshPromise = loadGlbMesh(countryName, this.earthRadius);
      } else {
        const countryGeoJsonPath = `/country/${countryName}.json`;
        // console.log(
        //   `Fetching GeoJSON for country: ${countryName} from ${countryGeoJsonPath}`
        // );

        const response = await fetch(countryGeoJsonPath);
        const geoJson = await response.json();

        if (!geoJson) {
          console.error("No GeoJSON data found");
          return;
        }

        geoJson.name = countryName;
        // console.log(`Generating mesh from GeoJSON for country: ${countryName}`);
        meshPromise = polygonsToMesh(geoJson, style, this.earthRadius);
      }

      const targetLatLng = this.countryCenters[countryName];
      if (!targetLatLng) {
        console.error(`No coordinates found for country code: ${countryName}`);
        return;
      }

      this.rotateGlobeTo(targetLatLng, async () => {
        const meshes = await meshPromise;

        if (Array.isArray(meshes)) {
          meshes.forEach((geometry) => {
            geometry.visible = true; // Ensure the mesh is set to be visible
            this.earth.add(geometry);
            this.previousGeometries.push(geometry.uuid);
          });
        } else {
          meshes.material.color.setHex(0xff0000); // Make the mesh red
          meshes.visible = true; // Ensure the mesh is set to be visible
          this.earth.add(meshes);
          this.previousGeometries.push(meshes.uuid);
        }

        // console.log(`Country ${countryName} highlighted successfully.`);
      });
    } catch (err) {
      console.error(
        `An error occurred while highlighting the country ${countryName}:`,
        err
      );
    }
  }
}

export { World };
