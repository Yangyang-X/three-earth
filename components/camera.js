import * as THREE from 'three';

function createCamera(container, earthRadius = 100, distanceMultiplier = 3.5) {
    const WIDTH = container.clientWidth;
    const HEIGHT = container.clientHeight;
    
    // Field of View (45 is a good moderate value)
    const FOV = 45;
    
    // Perspective Camera: (FOV, Aspect Ratio, Near Clip, Far Clip)
    const camera = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 1, 10000);

    // Positioning the camera
    const distanceFromEarth = earthRadius * distanceMultiplier;
    camera.position.set(0, 0, distanceFromEarth);

    return camera;
}

export { createCamera };
