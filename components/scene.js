import * as THREE from 'three';

function createScene(){
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('black');

    return scene;
}

export { createScene };