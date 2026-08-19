import { LoadingManager, TextureLoader } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * Central asset loading with a single progress stream.
 */
export class AssetLoader {
  constructor() {
    this.manager = new LoadingManager();

    this.gltf = new GLTFLoader(this.manager);
    this.hdr = new HDRLoader(this.manager);
    this.texture = new TextureLoader(this.manager);

    this._onProgress = null;
    this._loaded = 0;
    this._total = 0;
    this._settleWaiters = [];

    this.manager.onStart = (url, loaded, total) => {
      this._loaded = loaded;
      this._total = total;
    };
    this.manager.onProgress = (url, loaded, total) => {
      this._loaded = loaded;
      this._total = total;
      this._onProgress?.(total ? loaded / total : 0, url);
    };
    this.manager.onLoad = () => {
      this._loaded = this._total;
      this._settleWaiters.splice(0).forEach((resolve) => resolve());
    };
    this.manager.onError = (url) => console.error(`[AssetLoader] failed: ${url}`);
  }

  onProgress(callback) {
    this._onProgress = callback;
  }

  /**
   * Resolves once every queued request has settled.
   */
  settled() {
    if (this._total === 0 || this._loaded >= this._total) return Promise.resolve();
    return new Promise((resolve) => this._settleWaiters.push(resolve));
  }

  /**
   * Load GLB/GLTF.
   * @returns {Promise<import('three').GLTF>}
   */
  loadGLTF(url) {
    return new Promise((resolve, reject) => {
      this.gltf.load(
        encodeURI(url),
        resolve,
        (event) => {
          if (event.lengthComputable) this._onProgress?.(event.loaded / event.total, url);
        },
        reject
      );
    });
  }

  /** @returns {Promise<THREE.Texture>} */
  loadTexture(url) {
    return new Promise((resolve, reject) => {
      this.texture.load(encodeURI(url), resolve, undefined, reject);
    });
  }

  /** @returns {Promise<THREE.DataTexture>} */
  loadHDR(url) {
    return new Promise((resolve, reject) => {
      this.hdr.load(encodeURI(url), resolve, undefined, reject);
    });
  }
}
