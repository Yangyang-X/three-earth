import * as THREE from 'three';
function createRenderer(){
    const renderer = new THREE.WebGLRenderer({
        antialias : true
    });
    renderer.physicallyCorrectLights = true;

    
    return renderer;
}

export { createRenderer };
