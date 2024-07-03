import * as THREE from "three";
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

    this.previousGeometries = [];
    this.meshDict = {}; // Dictionary to store country meshes
    this.sphereDict = {}; // Dictionary to store bounding spheres
    this.currentlyHighlighted = null; // Store the currently highlighted country mesh

    this.loadCountryCenters();
  }

  async loadCountryCenters() {
    try {
      const response = await fetch("./countryCenter.json");
      this.countryCenters = await response.json();
      console.log("Country centers loaded successfully.");
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

  getEarthRadius() {
    return this.earthRadius;
  }

  resetGlobePosition() {
    const [x, y, z] = latLngTo3DPosition(0, -90, this.earthRadius);
    const direction = new THREE.Vector3(x, y, z).normalize();
    this.earth.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction
    );
  }

  positionToLatLng(vector) {
    const phi = Math.acos(vector.y / this.earthRadius);
    const theta = Math.atan2(vector.z, vector.x);

    const lat = 90 - phi * (180 / Math.PI);
    const lng = ((theta * (180 / Math.PI) + 180) % 360) - 180;

    console.log(
      `Vector: ${vector.toArray()}, Latitude: ${lat}, Longitude: ${lng}`
    );
    return { lat, lng };
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
      this.previousGeometries.length = 0;
    }
  }

  async drawCountryOutlines(geojson, color) {
    const mesh = await generateCountryOutlines(geojson, color);
    this.earth.add(mesh);
  }

  async prepareCountryMeshes(geoJsons) {
    for (let i = 0; i < geoJsons.length; i++) {
      const geoJson = geoJsons[i];
      await polygonsToMesh(geoJson);
    }
  }

  async prepareBoundingBoxes(geoJsons) {
    for (let i = 0; i < geoJsons.length; i++) {
      const geoJson = geoJsons[i];
      const mesh = await polygonsToMesh(geoJson);

      if (mesh instanceof THREE.Mesh) {
        const boundingBox = new THREE.Box3().setFromObject(mesh);
        const boxSize = boundingBox.getSize(new THREE.Vector3());
        const boxCenter = boundingBox.getCenter(new THREE.Vector3());

        boundingBoxes[geoJson.name] = {
          size: boxSize.toArray(),
          center: boxCenter.toArray(),
        };
      }
    }

    this.saveBoundingBoxesToFile(boundingBoxes);
  }

  saveBoundingBoxesToFile(boundingBoxes) {
    const jsonContent = JSON.stringify(boundingBoxes, null, 2);

    if (typeof window === "undefined") {
      const fs = require("fs");
      fs.writeFile("boundingBoxes.json", jsonContent, "utf8", (err) => {
        if (err) {
          console.error(
            "An error occurred while writing the bounding boxes to file:",
            err
          );
        } else {
          console.log(
            "Bounding boxes have been successfully saved to boundingBoxes.json"
          );
        }
      });
    } else {
      const a = document.createElement("a");
      const file = new Blob([jsonContent], { type: "application/json" });
      a.href = URL.createObjectURL(file);
      a.download = "boundingBoxes.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  async loadBoundingBoxes() {
    let boundingBoxes;
    console.log("Starting to load bounding boxes.");

    if (typeof window === "undefined") {
      // Node.js environment
      const fs = require("fs").promises;
      try {
        const data = await fs.readFile("/boundingBoxes.json", "utf8");
        boundingBoxes = JSON.parse(data);
      } catch (err) {
        console.error(
          "An error occurred while reading the bounding boxes file:",
          err
        );
        return;
      }
    } else {
      // Browser environment
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
    }

    for (const name in boundingBoxes) {
      const { size, center } = boundingBoxes[name];

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
    }

    console.log("Finished loading and processing bounding boxes.");
  }

  onPointerDown(event) {
    console.log("onPointerDown event triggered");
    // event.preventDefault();

    // Calculate mouse position in normalized device coordinates (-1 to +1) for both components
    const mouse = new THREE.Vector2(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
    console.log(`Mouse coordinates: x=${mouse.x}, y=${mouse.y}`);

    // Create a raycaster and set it from the camera and mouse position
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    raycaster.params.Line.threshold = 0.1;

    // Check for intersections with objects in the scene
    const intersects = raycaster.intersectObjects(this.earth.children, true);
    console.log(`Intersections found: ${intersects.length}, ${intersects}}`);

    intersects.sort((a, b) => {
      const aBox = new THREE.Box3().setFromObject(a.object);
      const bBox = new THREE.Box3().setFromObject(b.object);
      return (
        aBox.getSize(new THREE.Vector3()).length() -
        bBox.getSize(new THREE.Vector3()).length()
      );
    });

    // Find the intersected object that is a bounding box
    const boxIntersect = intersects.find(
      (intersect) => intersect.object.userData.isBoundingBox
    );

    if (boxIntersect) {
      const countryName = boxIntersect.object.userData.name;
      console.log(`Click on country box: ${countryName}`);
      this.highlightCountry(countryName);
    } else {
      console.log("No intersect with bounding boxes");
    }
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
        console.log(`Loading GLB mesh for country: ${countryName}`);
        meshPromise = loadGlbMesh(countryName, this.getEarthRadius());
      } else {
        const countryGeoJsonPath = `/country/${countryName}.json`;
        console.log(
          `Fetching GeoJSON for country: ${countryName} from ${countryGeoJsonPath}`
        );

        const response = await fetch(countryGeoJsonPath);
        const geoJson = await response.json();

        if (!geoJson) {
          console.error("No GeoJSON data found");
          return;
        }

        geoJson.name = countryName;
        console.log(`Generating mesh from GeoJSON for country: ${countryName}`);
        meshPromise = polygonsToMesh(geoJson, style, this.getEarthRadius());
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

        console.log(`Country ${countryName} highlighted successfully.`);
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
