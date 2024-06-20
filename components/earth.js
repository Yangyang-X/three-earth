import * as THREE from 'three';

const textureLoader = new THREE.TextureLoader();

function createMaterial() {
  const material = new THREE.MeshPhongMaterial();

  // Earth map
  const earthMap = textureLoader.load(
    "./src/world/assets/textures/earth/earth_map.jpg"
  );
  material.map = earthMap;

  // Optionally include bump and specular maps if needed
  // const earthBump = textureLoader.load(
  //   "/src/world/assets/textures/earth/earth_bump.jpg"
  // );
  // material.bumpMap = earthBump;
  // material.bumpScale = 0.005;

  // const earthSpecular = textureLoader.load(
  //   "/src/world/assets/textures/earth/earth_specular.png"
  // );
  // material.specularMap = earthSpecular;
  // material.specular = new THREE.Color("grey");

  return material;
}

function createEarth(radius = 100, segments = 32) {
  const geometry = new THREE.SphereGeometry(radius, segments, segments);
  const material = createMaterial();
  const earth = new THREE.Mesh(geometry, material);

  // Rotation speed can be adjusted as needed
  earth.tick = (delta) => {
    earth.rotation.y += (1 / 28) * delta;
  };

  return earth;
}

export { createEarth };
