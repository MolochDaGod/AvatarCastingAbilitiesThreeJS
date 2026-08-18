/**
 * grudge6 / Toon RTS correctness helpers for the casting sandbox.
 * SSOT: grudge-character-correctness + grudge6-full-stack + grudge6-cdn-ssot.
 * Feet = structural min.y (bones), never pelvis-as-feet. Strip hip .position tracks.
 */
import {
  AnimationClip,
  Box3,
  MathUtils,
  QuaternionKeyframeTrack,
  SRGBColorSpace,
  Vector3,
  VectorKeyframeTrack
} from 'three';

export const CDN = 'https://assets.grudge-studio.com';
export const OPEN = 'https://open.grudge-studio.com';
export const HUMAN_HEIGHT_M = 1.78;

/** Race display names for nameplate / root.userData */
export const RACE_NAMES = {
  human: 'Human Mage',
  barbarian: 'Barbarian Mage',
  elf: 'Elf Mage',
  orc: 'Orc Mage',
  undead: 'Undead Mage',
  dwarf: 'Dwarf Mage',
  custom: 'Custom Kit'
};

/**
 * Baked Bip001 magic pack (open CDN space-names + assets prod dash-names).
 * First URL that loads wins.
 */
export const MAGIC_CLIPS = {
  idle: [
    `${OPEN}/anims/baked/magic/standing%20idle.json`,
    `${CDN}/prod/anims/magic/standing-idle.json`,
    `${OPEN}/anims/baked/locomotion/idle.json`
  ],
  walk: [
    `${OPEN}/anims/baked/magic/Standing%20Walk%20Forward.json`,
    `${CDN}/prod/anims/magic/standing-walk-forward.json`,
    `${OPEN}/anims/baked/locomotion/walking.json`
  ],
  run: [
    `${OPEN}/anims/baked/magic/Standing%20Run%20Forward.json`,
    `${OPEN}/anims/baked/locomotion/run_forward.json`
  ],
  cast: [
    `${OPEN}/anims/baked/magic/standing%201h%20cast%20spell%2001.json`,
    `${CDN}/prod/anims/magic/standing-1h-cast-spell-01.json`,
    `${OPEN}/anims/baked/magic/standing%202h%20cast%20spell%2001.json`,
    `${CDN}/prod/anims/magic/standing-2h-cast-spell-01.json`
  ]
};

const BONE_ALIASES = {
  pelvis: ['Bip001 Pelvis', 'Bip001_Pelvis', 'Pelvis', 'mixamorig:Hips', 'Hips'],
  spine: ['Bip001 Spine', 'Bip001_Spine', 'Spine'],
  head: ['Bip001 Head', 'Bip001_Head', 'Head', 'mixamorig:Head'],
  lFoot: ['Bip001 L Foot', 'Bip001_L_Foot', 'LeftFoot', 'mixamorig:LeftFoot'],
  rFoot: ['Bip001 R Foot', 'Bip001_R_Foot', 'RightFoot', 'mixamorig:RightFoot'],
  lToe: ['Bip001 L Toe0', 'Bip001_L_Toe0', 'LeftToeBase', 'mixamorig:LeftToeBase'],
  rToe: ['Bip001 R Toe0', 'Bip001_R_Toe0', 'RightToeBase', 'mixamorig:RightToeBase'],
  lHand: ['Bip001 L Hand', 'Bip001_L_Hand', 'LeftHand', 'mixamorig:LeftHand', 'L_hand_container'],
  rHand: ['Bip001 R Hand', 'Bip001_R_Hand', 'RightHand', 'mixamorig:RightHand', 'R_hand_container'],
  root: ['Bip001', 'Bip001_Pelvis', 'Armature', 'Root']
};

export function findBone(root, names) {
  for (const n of names) {
    const o = root.getObjectByName(n);
    if (o) return o;
  }
  return null;
}

export function resolveBones(root) {
  const bones = {};
  for (const [key, names] of Object.entries(BONE_ALIASES)) {
    bones[key] = findBone(root, names);
  }
  return bones;
}

/** Structural body height from bone chain (feet→head). Avoids modular mesh explode. */
export function measureBoneStructuralBox(root) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) o.skeleton.update();
  });

  const groups = [
    BONE_ALIASES.head,
    BONE_ALIASES.pelvis,
    BONE_ALIASES.lFoot,
    BONE_ALIASES.rFoot,
    BONE_ALIASES.lToe,
    BONE_ALIASES.rToe,
    BONE_ALIASES.lHand,
    BONE_ALIASES.rHand
  ];

  const box = new Box3();
  const p = new Vector3();
  let n = 0;
  for (const names of groups) {
    const bone = findBone(root, names);
    if (!bone) continue;
    bone.getWorldPosition(p);
    if (!Number.isFinite(p.x + p.y + p.z)) continue;
    if (n === 0) {
      box.min.copy(p);
      box.max.copy(p);
    } else box.expandByPoint(p);
    n++;
  }
  if (n < 2) return null;

  const h = Math.max(box.max.y - box.min.y, 1e-4);
  const pad = Math.max(h * 0.1, 0.02);
  box.min.y -= pad * 0.55;
  box.max.y += pad * 0.45;
  return box;
}

/**
 * Hide modular equip variants so only one body silhouette remains.
 * Prefer *_A / first body; hide weapons, shields, bags, extra armor letters.
 */
export function applyDefaultMageLoadout(root) {
  const byKind = {
    body: [],
    head: [],
    arms: [],
    legs: [],
    shoulder: [],
    weapon: [],
    shield: [],
    xtra: []
  };

  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const n = (o.name || '').toLowerCase();
    if (/weapon_|_weapon|wpn_/.test(n)) byKind.weapon.push(o);
    else if (/shield/.test(n)) byKind.shield.push(o);
    else if (/_xtra_|quiver|bag|wood|lumber/.test(n)) byKind.xtra.push(o);
    else if (/units_body_|_body_/.test(n)) byKind.body.push(o);
    else if (/units_head_|_head_/.test(n)) byKind.head.push(o);
    else if (/units_arm|_arms_/.test(n)) byKind.arms.push(o);
    else if (/units_leg|_legs_/.test(n)) byKind.legs.push(o);
    else if (/shoulder/.test(n)) byKind.shoulder.push(o);
  });

  const pickOne = (list) => {
    if (!list.length) return;
    list.sort((a, b) => a.name.localeCompare(b.name));
    // Prefer A / 01 variants for a clean mage silhouette
    const preferred =
      list.find((m) => /_a$|_a_|body_a|head_a|arms_a|legs_a/i.test(m.name)) || list[0];
    for (const m of list) m.visible = m === preferred;
  };

  for (const m of byKind.weapon) m.visible = false;
  for (const m of byKind.shield) m.visible = false;
  for (const m of byKind.xtra) m.visible = false;
  pickOne(byKind.body);
  pickOne(byKind.head);
  pickOne(byKind.arms);
  pickOne(byKind.legs);
  pickOne(byKind.shoulder);
}

/**
 * Uniform SI fit on model root + plant feet at groundY. Never pelvis-as-feet.
 * @returns {{ height: number, scale: number }}
 */
export function fitAndGroundFeet(model, targetH = HUMAN_HEIGHT_M, groundY = 0) {
  model.position.set(0, 0, 0);
  model.rotation.set(0, 0, 0);
  model.scale.setScalar(1);
  model.updateMatrixWorld(true);

  let box = measureBoneStructuralBox(model);
  if (!box) {
    box = new Box3().setFromObject(model);
  }
  let h = Math.max(box.max.y - box.min.y, 1e-4);

  // Classic 100× (cm as m)
  if (h > 40) {
    model.scale.setScalar(0.01);
    model.updateMatrixWorld(true);
    box = measureBoneStructuralBox(model) || new Box3().setFromObject(model);
    h = Math.max(box.max.y - box.min.y, 1e-4);
  }

  const s = targetH / h;
  model.scale.multiplyScalar(s);
  model.updateMatrixWorld(true);
  box = measureBoneStructuralBox(model) || new Box3().setFromObject(model);

  // Center XZ on pelvis if present
  const pelvis = findBone(model, BONE_ALIASES.pelvis);
  if (pelvis) {
    const wp = new Vector3();
    pelvis.getWorldPosition(wp);
    model.position.x -= wp.x;
    model.position.z -= wp.z;
    model.updateMatrixWorld(true);
    box = measureBoneStructuralBox(model) || new Box3().setFromObject(model);
  } else {
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    model.position.x -= cx;
    model.position.z -= cz;
    model.updateMatrixWorld(true);
    box = measureBoneStructuralBox(model) || new Box3().setFromObject(model);
  }

  // Feet on ground — structural min.y, NOT hip
  model.position.y += groundY - box.min.y;
  model.updateMatrixWorld(true);
  box = measureBoneStructuralBox(model) || new Box3().setFromObject(model);
  const height = box.max.y - box.min.y;
  return { height, scale: model.scale.x };
}

/** Re-plant after idle/cast sample so hip-float from residual tracks dies. */
export function reGroundAfterAnimSample(model, groundY = 0) {
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) o.skeleton.update();
  });
  const box = measureBoneStructuralBox(model) || new Box3().setFromObject(model);
  model.position.y += groundY - box.min.y;
  model.updateMatrixWorld(true);
  return box;
}

/**
 * Strip translation (and scale) tracks — keeps rotation-only on grounded kit.
 * Prevents hip-float when playing Mixamo-baked packs on SI-planted grudge6.
 */
export function stripPositionTracks(clip) {
  if (!clip?.tracks?.length) return clip;
  const tracks = clip.tracks.filter((t) => {
    const n = t.name || '';
    if (/\.position$/.test(n)) return false;
    if (/\.scale$/.test(n)) return false;
    return true;
  });
  if (tracks.length === clip.tracks.length) return clip;
  return new AnimationClip(clip.name, clip.duration, tracks);
}

/** Normalize Bip001 space/underscore and Mixamo → Bip001 rematch against kit. */
export function rematchClipToKit(clip, model) {
  if (!clip?.tracks?.length || !model) return clip;

  const boneNames = new Set();
  model.traverse((o) => {
    if (o.isBone || o.type === 'Bone') boneNames.add(o.name);
  });
  if (!boneNames.size) return clip;

  const resolve = (raw) => {
    if (boneNames.has(raw)) return raw;
    const space = raw.replace(/_/g, ' ');
    if (boneNames.has(space)) return space;
    const under = raw.replace(/ /g, '_');
    if (boneNames.has(under)) return under;
    // mixamorig:Hips → try Bip001 Pelvis etc.
    const short = raw.replace(/^mixamorig:?/i, '');
    const map = {
      Hips: ['Bip001 Pelvis', 'Bip001_Pelvis'],
      Spine: ['Bip001 Spine', 'Bip001_Spine'],
      Spine1: ['Bip001 Spine1', 'Bip001_Spine1'],
      Spine2: ['Bip001 Spine2', 'Bip001_Spine2'],
      Neck: ['Bip001 Neck', 'Bip001_Neck'],
      Head: ['Bip001 Head', 'Bip001_Head'],
      LeftUpLeg: ['Bip001 L Thigh', 'Bip001_L_Thigh'],
      LeftLeg: ['Bip001 L Calf', 'Bip001_L_Calf'],
      LeftFoot: ['Bip001 L Foot', 'Bip001_L_Foot'],
      LeftToeBase: ['Bip001 L Toe0', 'Bip001_L_Toe0'],
      RightUpLeg: ['Bip001 R Thigh', 'Bip001_R_Thigh'],
      RightLeg: ['Bip001 R Calf', 'Bip001_R_Calf'],
      RightFoot: ['Bip001 R Foot', 'Bip001_R_Foot'],
      RightToeBase: ['Bip001 R Toe0', 'Bip001_R_Toe0'],
      LeftShoulder: ['Bip001 L Clavicle', 'Bip001_L_Clavicle'],
      LeftArm: ['Bip001 L UpperArm', 'Bip001_L_UpperArm'],
      LeftForeArm: ['Bip001 L Forearm', 'Bip001_L_Forearm'],
      RightShoulder: ['Bip001 R Clavicle', 'Bip001_R_Clavicle'],
      RightArm: ['Bip001 R UpperArm', 'Bip001_R_UpperArm'],
      RightForeArm: ['Bip001 R Forearm', 'Bip001_R_Forearm'],
      LeftHand: ['Bip001 L Hand', 'Bip001_L_Hand'],
      RightHand: ['Bip001 R Hand', 'Bip001_R_Hand']
    };
    const aliases = map[short];
    if (aliases) {
      for (const a of aliases) if (boneNames.has(a)) return a;
    }
    for (const b of boneNames) {
      if (b.replace(/ /g, '_') === under || b.replace(/_/g, ' ') === space) return b;
    }
    return null;
  };

  const tracks = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    if (dot < 0) {
      tracks.push(track);
      continue;
    }
    const bone = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const matched = resolve(bone);
    if (!matched) continue;
    const name = `${matched}.${prop}`;
    if (name === track.name) {
      tracks.push(track);
    } else if (track instanceof QuaternionKeyframeTrack) {
      tracks.push(new QuaternionKeyframeTrack(name, track.times, track.values));
    } else if (track instanceof VectorKeyframeTrack) {
      tracks.push(new VectorKeyframeTrack(name, track.times, track.values));
    } else {
      tracks.push(track.clone());
      tracks[tracks.length - 1].name = name;
    }
  }
  if (!tracks.length) return clip;
  return new AnimationClip(clip.name, clip.duration, tracks);
}

/** Parse Three.AnimationClip JSON (baked Bip001). */
export function clipFromBakedJson(data, name = 'clip') {
  if (!data) return null;
  try {
    if (data.tracks) {
      const clip = AnimationClip.parse(data);
      if (name) clip.name = name;
      return clip;
    }
  } catch (err) {
    console.warn('[grudgeCharacter] AnimationClip.parse failed', err);
  }
  return null;
}

export async function fetchFirstClip(urls, name) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) continue;
      const data = await res.json();
      const clip = clipFromBakedJson(data, name);
      if (clip) {
        console.info(`[grudgeCharacter] clip ${name} ← ${url}`);
        return clip;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Soft feet plant: if either foot world Y is below ground, lift model slightly.
 * Full dual-foot CCD IK is optional fleet tech — this kills dig-in without a second solver.
 */
export function softFeetPlant(model, bones, groundY = 0, maxLift = 0.12) {
  if (!model || !bones) return;
  const l = bones.lFoot || bones.lToe;
  const r = bones.rFoot || bones.rToe;
  if (!l && !r) return;
  const p = new Vector3();
  let minY = Infinity;
  for (const b of [l, r]) {
    if (!b) continue;
    b.getWorldPosition(p);
    if (p.y < minY) minY = p.y;
  }
  if (!Number.isFinite(minY)) return;
  const dig = groundY - minY;
  if (dig > 0.002 && dig < maxLift) {
    model.position.y += dig;
  }
}

export function prepareGltfMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.map) {
        m.map.colorSpace = SRGBColorSpace;
        m.map.needsUpdate = true;
      }
      if (m.emissiveMap) {
        m.emissiveMap.colorSpace = SRGBColorSpace;
        m.emissiveMap.needsUpdate = true;
      }
      if (!m.map && m.color?.setHex) m.color.setHex(0xffffff);
      if ('metalness' in m) m.metalness = Math.min(m.metalness ?? 0, 0.15);
      if ('roughness' in m) m.roughness = Math.max(m.roughness ?? 0.75, 0.55);
      m.needsUpdate = true;
    }
  });
}

export function diagnoseCharacter(model, bones) {
  const box = measureBoneStructuralBox(model) || new Box3().setFromObject(model);
  const h = box.max.y - box.min.y;
  const feetErr = Math.abs(box.min.y);
  return {
    height: h,
    feetMinY: box.min.y,
    pelvis: !!bones?.pelvis,
    hands: !!(bones?.lHand || bones?.rHand),
    feet: !!(bones?.lFoot || bones?.rFoot),
    heightOk: h >= 1.45 && h <= 2.2,
    feetOk: feetErr < 0.12
  };
}

export { MathUtils };
