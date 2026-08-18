import {
  AnimationMixer,
  Group,
  LoopRepeat,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { LAYER, setLayerRecursive } from '../core/Layers.js';
import { disposeObject } from '../utils/dispose.js';
import {
  applyDefaultMageLoadout,
  fetchFirstClip,
  fitAndGroundFeet,
  MAGIC_CLIPS,
  prepareGltfMaterials,
  reGroundAfterAnimSample,
  rematchClipToKit,
  stripPositionTracks
} from './grudgeCharacter.js';

const TARGET_HEIGHT = 1.78;

const GRUDGE_CHARACTER_URL = {
  human: 'https://assets.grudge-studio.com/models/characters/human.glb',
  human_battle_mage_male: 'https://assets.grudge-studio.com/models/characters/human_battle_mage-male.glb',
  human_battle_mage_female: 'https://assets.grudge-studio.com/models/characters/human_battle_mage-female.glb',
  barbarian: 'https://assets.grudge-studio.com/models/grudge6/brb/BRB_Characters.glb',
  elf: 'https://assets.grudge-studio.com/models/grudge6/elf/ELF_Characters.glb',
  orc: 'https://assets.grudge-studio.com/models/grudge6/orc/ORC_Characters.glb',
  undead: 'https://assets.grudge-studio.com/models/grudge6/ud/UD_Characters.glb',
  dwarf: 'https://assets.grudge-studio.com/models/grudge6/dwf/DWF_Characters.glb',
  wraith_knight: 'https://assets.grudge-studio.com/models/grudge6/wk/WK_Characters.glb'
};

function resolveCharacterUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    const race = (q.get('race') || '').toLowerCase();
    if (race && GRUDGE_CHARACTER_URL[race]) return { url: GRUDGE_CHARACTER_URL[race], race };
    if (q.get('kit')) return { url: q.get('kit'), race: 'custom' };
  } catch {
    /* SSR / offline */
  }
  return { url: GRUDGE_CHARACTER_URL.human, race: 'human' };
}

/**
 * Loads a Grudge Studio GLB character, normalises it for the scene and drives
 * its animation.
 *
 * On top of the clip sits a procedural pose layer driven by `settings.character.pose`.
 */
export class CharacterController {
  constructor(environment) {
    this.environment = environment;
    this.root = new Group();
    this.root.name = 'Character';

    this.tilt = new Group();
    this.tilt.name = 'CharacterTilt';
    this.root.add(this.tilt);

    this.mixer = null;
    this.actions = new Map();
    this.current = null;
    this.height = 1.8;
    this.headPosition = new Vector3(0, 1.5, 0);
    this.forwardAxis = new Vector3(0, 0, 1);

    this._poseWeight = 0;
  }

  /** @param {import('../loaders/AssetLoader.js').AssetLoader} assets */
  async load(assets) {
    const source = resolveCharacterUrl();
    this.raceId = source.race;

    const gltf = await assets.loadGLTF(source.url);
    await assets.settled();
    const model = gltf.scene || gltf.scenes?.[0];
    if (!model) throw new Error('Character GLB contained no scene');

    applyDefaultMageLoadout(model);

    const fit = fitAndGroundFeet(model, TARGET_HEIGHT, 0);
    this.height = fit.height;

    prepareGltfMaterials(model);
    for (const m of this._collectMaterials(model)) {
      this.environment.registerShadowCaster(m);
    }

    setLayerRecursive(model, LAYER.WORLD);
    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) o.layers.enable(LAYER.CONTACT);
    });
    this.tilt.add(model);
    this.model = model;
    this.headPosition.set(0, this.height * 0.92, 0);

    // Prefer embedded animations; fall back to D1 baked magic clips.
    let clips = gltf.animations ?? [];
    const hasEmbedded = clips.length > 0;
    if (!hasEmbedded) {
      const idleClip = await fetchFirstClip(MAGIC_CLIPS.idle, 'idle');
      if (idleClip) clips = [idleClip];
    }

    if (clips.length) {
      this.mixer = new AnimationMixer(model);
      clips.forEach((clip, index) => {
        const rematched = rematchClipToKit(clip, model);
        // Only strip position tracks from fetched (external) clips.
        // Embedded GLB animations need their position tracks intact.
        const final = hasEmbedded ? rematched : stripPositionTracks(rematched);
        const name = final.name || (index === 0 ? 'idle' : `clip_${index}`);
        const action = this.mixer.clipAction(final);
        action.setLoop(LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        this.actions.set(name, action);
      });
      this.play([...this.actions.keys()][0], 0);

      this.mixer.update(0.001);
      reGroundAfterAnimSample(model, 0);
    }

    console.info(`[Character] Grudge D1 loaded race=${source.race} url=${source.url}`);
    return this;
  }

  _collectMaterials(root) {
    const mats = new Set();
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const m = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of m) if (mat) mats.add(mat);
    });
    return mats;
  }

  /** Cross-fade to a named action. */
  play(name, fadeDuration = 0.35) {
    const next = this.actions.get(name);
    if (!next || next === this.current) return;

    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);

    if (this.current && fadeDuration > 0) {
      next.crossFadeFrom(this.current, fadeDuration, true);
    }
    next.play();
    this.current = next;
  }

  /** @param {'idle'|'sitting'} pose */
  setPose(pose) {
    settings.character.pose = pose === 'sitting' ? 'sitting' : 'idle';
    return settings.character.pose;
  }

  togglePose() {
    return this.setPose(settings.character.pose === 'sitting' ? 'idle' : 'sitting');
  }

  get isSitting() {
    return settings.character.pose === 'sitting';
  }

  get poseWeight() {
    return this._poseWeight;
  }

  setFacing(yaw) {
    this.root.rotation.y = yaw;
  }

  get facing() {
    return this.root.rotation.y;
  }

  setLean(angle) {
    this.tilt.quaternion.setFromAxisAngle(this.forwardAxis, angle);
  }

  resetPlacement() {
    this.root.position.y = 0;
    this.setLean(0);
  }

  update(dt) {
    if (!this.mixer) return;

    this.mixer.timeScale = settings.global.animationSpeed;
    this.mixer.update(dt);
  }

  get position() {
    return this.root.position;
  }

  dispose() {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    disposeObject(this.root);
  }
}
