import {
  AnimationMixer,
  Box3,
  Group,
  LinearMipmapLinearFilter,
  LoopRepeat,
  MathUtils,
  MeshStandardMaterial,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { LAYER, setLayerRecursive } from '../core/Layers.js';
import { disposeObject } from '../utils/dispose.js';
import { SittingPose } from './SittingPose.js';
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

const CHARACTER_URL = './models/Standing Idle.fbx';
/** Hand-authored albedo atlas replacing the FBX's unresolvable texture refs. */
const CHARACTER_TEXTURE_URL = './angtexture.png';
/** Mixamo exports in centimetres. */
const FBX_SCALE = 0.01;
/** Rigs vary; normalise to a believable human height so the world scale holds. */
const TARGET_HEIGHT = 1.78;

/**
 * Grudge Studio D1 character registry (SSOT).
 * Docs: https://info.grudge-studio.com/docs
 * Registry: https://api.grudge-studio.com/assets/category/character
 * CDN: https://assets.grudge-studio.com/models/characters/<name>.glb
 *
 * Default character is the Mixamo-rigged human from the D1 registry.
 * Override with ?race=<key> (grudge6 Bip001 kits) or ?kit=<url> (custom GLB).
 * Fallback to the local FBX if the CDN is unreachable.
 */
const GRUDGE_CHARACTER_URL = {
  human: 'https://assets.grudge-studio.com/models/characters/human.glb',
  human_battle_mage_male: 'https://assets.grudge-studio.com/models/characters/human_battle_mage-male.glb',
  human_battle_mage_female: 'https://assets.grudge-studio.com/models/characters/human_battle_mage-female.glb',
  // grudge6 Bip001 race kits (Toon RTS)
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
    const race = (q.get('race') || (q.get('toon') === '1' ? 'human' : '')).toLowerCase();
    if (race && GRUDGE_CHARACTER_URL[race]) return { kind: 'gltf', url: GRUDGE_CHARACTER_URL[race], race };
    if (q.get('kit')) return { kind: 'gltf', url: q.get('kit'), race: 'custom' };
  } catch {
    /* SSR / offline */
  }
  // Default: the local FBX (known-good Mixamo rig). CDN models require ?race= or ?kit=.
  return { kind: 'fbx', url: CHARACTER_URL, race: null };
}

/**
 * Loads the rigged FBX, normalises it for the scene and drives its animation.
 *
 * The character is intentionally stationary — it only ever idles. The class is
 * still built around a small action registry with cross-fading so additional
 * clips (a casting flourish, a reaction) can be dropped in without touching
 * anything else.
 *
 * On top of the clip sits a second, procedural layer: `SittingPose` bakes a
 * cross-legged meditation pose straight onto the skeleton, and `settings.
 * character.pose` cross-fades the two. Because that layer runs *after* the
 * mixer each frame it needs no clip of its own.
 */
export class CharacterController {
  constructor(environment) {
    this.environment = environment;
    this.root = new Group();
    this.root.name = 'Character';

    // Position and heading live on `root`; the bank (walk mode leans into its
    // turns) lives on a joint underneath it, so the two never fight over the
    // same rotation.
    this.tilt = new Group();
    this.tilt.name = 'CharacterTilt';
    this.root.add(this.tilt);

    this.mixer = null;
    this.actions = new Map();
    this.current = null;
    this.height = 1.8;
    this.headPosition = new Vector3(0, 1.5, 0);
    /** The rig's own forward, in model space — the axis a bank rotates about. */
    this.forwardAxis = new Vector3(0, 0, 1);

    this.sitting = null;
    this._poseWeight = 0; // 0 = idle clip, 1 = seated
    this._poseTime = 0;
    this._poseBlend = null; // seconds, overrides settings for one transition
  }

  /**
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    const source = resolveCharacterUrl();
    this.sourceKind = source.kind;
    this.raceId = source.race;

    if (source.kind === 'gltf' && typeof assets.loadGLTF === 'function') {
      try {
        const gltf = await assets.loadGLTF(source.url);
        await assets.settled();
        const model = gltf.scene || gltf.scenes?.[0];
        if (!model) throw new Error('empty gltf');

        // grudge6 Bip001 kits are modular: hide weapon/shield/xtra variants,
        // pick one body/head/arms/legs/shoulder so a single silhouette remains.
        applyDefaultMageLoadout(model);

        // Fit to uniform SI height and plant feet on y=0 using structural bones.
        const fit = fitAndGroundFeet(model, TARGET_HEIGHT, 0);
        this.height = fit.height;

        // Prep materials for PBR lighting + shadow system.
        prepareGltfMaterials(model);
        for (const m of this._collectMaterials(model)) {
          this.environment.registerShadowCaster(m);
        }

        setLayerRecursive(model, LAYER.WORLD);
        // Contact-shadow pass needs the layer enabled on every mesh too
        model.traverse((o) => {
          if (o.isMesh || o.isSkinnedMesh) o.layers.enable(LAYER.CONTACT);
        });
        this.tilt.add(model);
        this.model = model;
        this.headPosition.set(0, this.height * 0.92, 0);

        // Prefer embedded animations; fall back to D1 baked magic clips.
        let clips = gltf.animations ?? [];
        if (!clips.length) {
          const idleClip = await fetchFirstClip(MAGIC_CLIPS.idle, 'idle');
          if (idleClip) clips = [idleClip];
        }

        if (clips.length) {
          this.mixer = new AnimationMixer(model);
          clips.forEach((clip, index) => {
            const rematched = rematchClipToKit(clip, model);
            const stripped = stripPositionTracks(rematched);
            const name = stripped.name || (index === 0 ? 'idle' : `clip_${index}`);
            const action = this.mixer.clipAction(stripped);
            action.setLoop(LoopRepeat, Infinity);
            action.clampWhenFinished = false;
            this.actions.set(name, action);
          });
          this.play([...this.actions.keys()][0], 0);

          // Sample the first frame so bind-pose hip-float dies before grounding.
          this.mixer.update(0.001);
          reGroundAfterAnimSample(model, 0);
        }

        // Bake the seated pose from the rig's own bones so meditation still works.
        this.sitting = new SittingPose(model);
        if (this.sitting.valid) this.forwardAxis.copy(this.sitting.forward);

        console.info(`[Character] Grudge D1 loaded race=${source.race} url=${source.url}`);
        return;
      } catch (err) {
        console.warn('[Character] Grudge D1 load failed, falling back to FBX', err);
      }
    }

    const [fbx, albedo] = await Promise.all([
      assets.loadFBX(CHARACTER_URL),
      assets.loadTexture(CHARACTER_TEXTURE_URL)
    ]);
    // The FBX resolves before its textures do; material prep inspects them.
    await assets.settled();

    // A small pixel-art atlas: keep the texels hard under magnification, but
    // let mipmaps handle minification so the face doesn't shimmer at distance.
    albedo.colorSpace = SRGBColorSpace;
    albedo.magFilter = NearestFilter;
    albedo.minFilter = LinearMipmapLinearFilter;
    albedo.generateMipmaps = true;
    albedo.anisotropy = 4;
    // The rig's UVs run outside the unit square (u ∈ [-1, 1], v ∈ [1, 2]), so
    // the default clamp would drag one edge row across the whole body.
    albedo.wrapS = RepeatWrapping;
    albedo.wrapT = RepeatWrapping;
    albedo.needsUpdate = true;
    this.albedo = albedo;

    fbx.scale.setScalar(FBX_SCALE);
    fbx.updateMatrixWorld(true);

    const box = new Box3().setFromObject(fbx);
    const size = new Vector3();
    const center = new Vector3();
    box.getSize(size);

    // Normalise the rig's height, then drop it onto y = 0 and centre it.
    fbx.scale.setScalar(FBX_SCALE * (TARGET_HEIGHT / Math.max(0.001, size.y)));
    fbx.updateMatrixWorld(true);
    box.setFromObject(fbx);
    box.getSize(size);
    box.getCenter(center);
    this.height = size.y;
    fbx.position.x -= center.x;
    fbx.position.z -= center.z;
    fbx.position.y -= box.min.y;

    this._prepareMaterials(fbx);

    this.tilt.add(fbx);
    this.model = fbx;
    this.headPosition.set(0, size.y * 0.86, 0);

    // Bake the seated pose while the rig is still untouched by the mixer.
    this.sitting = new SittingPose(fbx);
    if (this.sitting.valid) this.forwardAxis.copy(this.sitting.forward);

    // The idle clip ships inside the same file.
    this.mixer = new AnimationMixer(fbx);
    const clips = fbx.animations ?? [];
    if (clips.length === 0) {
      console.warn('[CharacterController] no animation clips found in the FBX');
    } else {
      clips.forEach((clip, index) => {
        const name = clip.name && clip.name !== 'mixamo.com' ? clip.name : index === 0 ? 'idle' : `clip_${index}`;
        const action = this.mixer.clipAction(clip);
        action.setLoop(LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        this.actions.set(name, action);
      });
      this.play([...this.actions.keys()][0], 0);
    }

    return this;
  }

  /** Collect unique materials from a model for shadow caster registration. */
  _collectMaterials(root) {
    const mats = new Set();
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const m = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of m) if (mat) mats.add(mat);
    });
    return mats;
  }

  /** Convert imported materials to PBR and hook them into the shadow system. */
  _prepareMaterials(root) {
    const converted = new Map();

    root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      node.layers.enable(LAYER.CONTACT); // captured by the contact shadow pass

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (!material) return material;
        if (converted.has(material)) return converted.get(material);

        // FBX gives us Phong/Lambert; move to Standard so IBL and CSM apply.
        // The FBX references its own textures by absolute local path, so they
        // never resolve — the authored atlas is substituted wholesale, with a
        // white base colour so the map's tones come through untinted.
        const standard = new MeshStandardMaterial({
          name: material.name,
          color: 0xffffff,
          map: this.albedo,
          normalMap: material.normalMap ?? null,
          roughness: 0.85,
          metalness: 0,
          transparent: material.transparent ?? false,
          opacity: material.opacity ?? 1,
          side: material.side
        });

        this.environment.registerShadowCaster(standard);
        material.dispose();
        converted.set(material, standard);
        return standard;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });
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

  /* ------------------------------------------------------------------ */
  /* pose layer                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {'idle'|'sitting'} pose
   * @param {number|null} [blend] seconds for *this* transition only; the
   *   configured blend time is used again as soon as the pose is set without one.
   */
  setPose(pose, blend = null) {
    this._poseBlend = blend;
    settings.character.pose = pose === 'sitting' ? 'sitting' : 'idle';
    return settings.character.pose;
  }

  /** Flip between the idle clip and the meditation sit. @returns {string} the new pose */
  togglePose() {
    return this.setPose(settings.character.pose === 'sitting' ? 'idle' : 'sitting');
  }

  get isSitting() {
    return settings.character.pose === 'sitting';
  }

  /** How far the seated pose has actually blended in, 0..1. */
  get poseWeight() {
    return this._poseWeight;
  }

  /* ------------------------------------------------------------------ */
  /* placement — driven by walk mode, inert otherwise                    */
  /* ------------------------------------------------------------------ */

  /** Heading, radians about world +Y. 0 faces +Z. */
  setFacing(yaw) {
    this.root.rotation.y = yaw;
  }

  get facing() {
    return this.root.rotation.y;
  }

  /**
   * Bank the body about its own forward axis. Positive angles roll the head to
   * the rig's right, so leaning into a left-hand turn is a negative angle.
   */
  setLean(angle) {
    this.tilt.quaternion.setFromAxisAngle(this.forwardAxis, angle);
  }

  /** Put the character back on the floor, upright and facing where it was. */
  resetPlacement() {
    this.root.position.y = 0;
    this.setLean(0);
  }

  update(dt) {
    if (!this.mixer) return;

    // Editing the tuning sliders re-bakes the pose; cheap and rare.
    if (this.sitting?.valid && this.sitting.stale) this.sitting.build();

    this.mixer.timeScale = settings.global.animationSpeed;
    this.mixer.update(dt);

    if (!this.sitting?.valid) return;
    this._poseTime += dt;

    const target = this.isSitting ? 1 : 0;
    const step = dt / Math.max(0.001, this._poseBlend ?? settings.character.blendTime);
    this._poseWeight = MathUtils.clamp(
      this._poseWeight + MathUtils.clamp(target - this._poseWeight, -step, step),
      0,
      1
    );

    // Ease the blend so the sit settles instead of arriving at constant speed.
    this.sitting.apply(MathUtils.smoothstep(this._poseWeight, 0, 1), this._poseTime);
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
