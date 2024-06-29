import * as THREE from "three";
import { createEarth } from "./components/earth.js";
import { createCamera } from "./components/camera.js";
import { createScene } from "./components/scene.js";
import { createLight } from "./components/light.js";
import { createRenderer } from "./systems/renderer.js";
import { createControls } from "./systems/cameraControls.js";
import { Resizer } from "./systems/resizer.js";
import { polygonsToMesh } from "./utils/meshUtils.js";
import {
  calculatePolygonCentroid,
  latLngTo3DPosition,
} from "./utils/geoUtils.js";

const MARGIN = 24; // Margin in units on each side
const MAX_EARTH_RADIUS = 100;

let controls;
let resizer;
var previousGeometries = [];

class World {
  constructor(container) {
    const containerWidth = container.clientWidth;
    this.earthRadius = Math.min(
      (containerWidth - MARGIN * 2) / 2,
      MAX_EARTH_RADIUS
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
    resizer = new Resizer(container, this.camera, this.renderer);

    this.previousTargetLatLng = { lat: 0, lng: -90 };
    this.resetPosition();
  }

  resetPosition() {
    const [x, y, z] = latLngTo3DPosition(0, -90, this.earthRadius);
    const direction = new THREE.Vector3(x, y, z).normalize();
    this.earth.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction
    );
  }

  removePreviousGeometries(earth) {
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

  async showCountry(name, geoJsonData, style, meshMethod) {
    if (!geoJsonData) {
      console.error("No GeoJSON data provided");
      return;
    }

    removePreviousGeometries(this.earth);

    // Start loading meshes asynchronously
    geoJsonData.name = name;
    const meshPromise = polygonsToMesh(geoJsonData, 100, style, 1.0);

    const firstFeature = geoJsonData.features[0];
    const centroid = calculatePolygonCentroid(firstFeature.geometry);
    geoJsonData["meshMethod"] = meshMethod;
    const targetLatLng = { lat: centroid.lat, lng: centroid.lng };

    // Rotate the globe immediately
    this.rotateGlobeTo(targetLatLng, async () => {
      // Wait for the mesh data to be ready
      const meshes = await meshPromise;
      meshes.forEach((geometry) => {
        this.earth.add(geometry);
        previousGeometries.push(geometry.uuid);
      });

      console.log("Mesh data loaded and displayed after globe rotation.");
    });
  }

  rotateGlobeTo(targetLatLng, onComplete) {
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

  start() {
    this.renderer.setAnimationLoop(() => {
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop() {
    this.renderer.setAnimationLoop(null);
  }
}

export { World };
