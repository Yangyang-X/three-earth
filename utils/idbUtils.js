function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('MeshDatabase', 1);

        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('meshes')) {
                db.createObjectStore('meshes', { keyPath: 'key' });
            }
        };

        request.onsuccess = event => {
            resolve(event.target.result);
        };

        request.onerror = event => {
            reject(event.target.error);
        };
    });
}

async function saveMeshData(key, data) {
    const db = await openDatabase();
    const jsonData = JSON.stringify(data);
    const dataSize = new Blob([jsonData]).size; // Calculate the size of the data
    console.log(`Saving mesh data for key: ${key}, Size: ${dataSize} bytes`);

    return await new Promise((resolve, reject) => {
        const transaction = db.transaction('meshes', 'readwrite');
        const store = transaction.objectStore('meshes');
        store.put({ key, data });

        transaction.oncomplete = () => {
            resolve();
        };

        transaction.onerror = event => {
            reject(event.target.error);
        };
    });
}

async function loadMeshData(key) {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
        const transaction = db.transaction('meshes', 'readonly');
        const store = transaction.objectStore('meshes');
        const request = store.get(key);

        request.onsuccess = event => {
            resolve(event.target.result ? event.target.result.data : null);
        };

        request.onerror = event => {
            reject(event.target.error);
        };
    });
}

export { saveMeshData, loadMeshData };
