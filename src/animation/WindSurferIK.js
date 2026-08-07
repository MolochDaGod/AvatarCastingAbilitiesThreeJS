import { MathUtils, Quaternion, Vector3 } from 'three';

/**
 * Post-mixer two-bone IK for a real windsurf stance:
 *   feet → board deck straps
 *   hands → boom (metal bar) grip points
 *
 * Bone aliases cover Mixamo (`mixamorig:LeftArm`) and grudge6 Bip001
 * (`Bip001 L UpperArm`). Apply AFTER AnimationMixer each frame while riding.
 *
 * SSOT pattern: same two-bone law-of-cosines as SittingPose arm solve /
 * gameopen footIk — no second physics stack.
 */

const _root = new Vector3();
const _mid = new Vector3();
const _end = new Vector3();
const _target = new Vector3();
const _pole = new Vector3();
const _toTarget = new Vector3();
const _elbow = new Vector3();
const _dir = new Vector3();
const _from = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qc = new Quaternion();
const _qd = new Quaternion();
const _parentInv = new Quaternion();
const _up = new Vector3(0, 1, 0);

/** Mixamo short name / Bip001 candidates for each chain joint. */
const CHAIN = {
  leftLeg: {
    upper: ['LeftUpLeg', 'mixamorig:LeftUpLeg', 'Bip001 L Thigh', 'Bip001_L_Thigh'],
    mid: ['LeftLeg', 'mixamorig:LeftLeg', 'Bip001 L Calf', 'Bip001_L_Calf'],
    end: ['LeftFoot', 'mixamorig:LeftFoot', 'Bip001 L Foot', 'Bip001_L_Foot']
  },
  rightLeg: {
    upper: ['RightUpLeg', 'mixamorig:RightUpLeg', 'Bip001 R Thigh', 'Bip001_R_Thigh'],
    mid: ['RightLeg', 'mixamorig:RightLeg', 'Bip001 R Calf', 'Bip001_R_Calf'],
    end: ['RightFoot', 'mixamorig:RightFoot', 'Bip001 R Foot', 'Bip001_R_Foot']
  },
  leftArm: {
    upper: ['LeftArm', 'mixamorig:LeftArm', 'Bip001 L UpperArm', 'Bip001_L_UpperArm'],
    mid: ['LeftForeArm', 'mixamorig:LeftForeArm', 'Bip001 L Forearm', 'Bip001_L_Forearm'],
    end: ['LeftHand', 'mixamorig:LeftHand', 'Bip001 L Hand', 'Bip001_L_Hand', 'L_hand_container']
  },
  rightArm: {
    upper: ['RightArm', 'mixamorig:RightArm', 'Bip001 R UpperArm', 'Bip001_R_UpperArm'],
    mid: ['RightForeArm', 'mixamorig:RightForeArm', 'Bip001 R Forearm', 'Bip001_R_Forearm'],
    end: ['RightHand', 'mixamorig:RightHand', 'Bip001 R Hand', 'Bip001_R_Hand', 'R_hand_container']
  },
  hips: ['Hips', 'mixamorig:Hips', 'Bip001 Pelvis', 'Bip001_Pelvis', 'Pelvis'],
  spine: ['Spine', 'mixamorig:Spine', 'Bip001 Spine', 'Bip001_Spine']
};

function findNamed(root, names) {
  for (const n of names) {
    const o = root.getObjectByName(n);
    if (o) return o;
  }
  // Fallback: strip colons / match endsWith
  let found = null;
  const lower = names.map((n) => n.toLowerCase().replace(/^mixamorig:?/i, ''));
  root.traverse((o) => {
    if (found || !o.isBone) return;
    const short = o.name.replace(/^mixamorig:?/i, '');
    if (lower.includes(short.toLowerCase()) || lower.includes(o.name.toLowerCase())) {
      found = o;
    }
  });
  return found;
}

/**
 * Orient `bone` so its child direction aligns with world `targetDir`.
 * Mirrors SittingPose._orient.
 */
function orientBone(bone, child, targetDir, twist = 0) {
  child.getWorldPosition(_from).sub(bone.getWorldPosition(_root));
  if (_from.lengthSq() < 1e-10) return;
  _from.normalize();

  bone.getWorldQuaternion(_qa);
  _qb.setFromUnitVectors(_from, targetDir);
  if (twist) {
    _qc.setFromAxisAngle(targetDir, twist);
    _qb.premultiply(_qc);
  }
  _qa.premultiply(_qb);
  bone.parent.getWorldQuaternion(_parentInv).invert();
  bone.quaternion.copy(_parentInv.multiply(_qa));
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK: place `end` at world `target`, elbow/knee toward `poleHint`.
 * @returns {boolean} whether chain was solved
 */
function solveTwoBoneChain(upper, mid, end, target, poleHint) {
  if (!upper || !mid || !end) return false;

  upper.getWorldPosition(_root);
  mid.getWorldPosition(_mid);
  end.getWorldPosition(_end);

  const upperLen = _root.distanceTo(_mid);
  const lowerLen = _mid.distanceTo(_end);
  if (upperLen < 1e-4 || lowerLen < 1e-4) return false;

  _target.copy(target);
  _toTarget.subVectors(_target, _root);
  let dist = _toTarget.length();
  const maxReach = upperLen + lowerLen - 1e-3;
  const minReach = Math.abs(upperLen - lowerLen) + 1e-3;
  dist = MathUtils.clamp(dist, minReach, maxReach);
  if (_toTarget.lengthSq() < 1e-8) _toTarget.set(0, -1, 0);
  _toTarget.normalize();

  // Pole: project hint onto plane ⊥ hip→target so knee/elbow bends correctly
  _pole.copy(poleHint);
  _pole.addScaledVector(_toTarget, -_pole.dot(_toTarget));
  if (_pole.lengthSq() < 1e-8) {
    _pole.crossVectors(_toTarget, _up);
    if (_pole.lengthSq() < 1e-8) _pole.set(1, 0, 0);
  }
  _pole.normalize();

  const along = (upperLen * upperLen - lowerLen * lowerLen + dist * dist) / (2 * dist);
  const out = Math.sqrt(Math.max(0, upperLen * upperLen - along * along));
  _elbow.copy(_root).addScaledVector(_toTarget, along).addScaledVector(_pole, out);

  orientBone(upper, mid, _dir.copy(_elbow).sub(_root).normalize(), 0);
  mid.getWorldPosition(_mid);
  orientBone(mid, end, _dir.copy(_target).sub(_mid).normalize(), 0);
  return true;
}

export class WindSurferIK {
  /**
   * @param {import('three').Object3D} model skinned kit root
   */
  constructor(model) {
    this.model = model;
    this.weight = 0;
    this.valid = false;
    this.chains = {};
    this.hips = null;
    this.spine = null;
    this._hipsRestLocalY = 0;

    this._bind(model);
  }

  _bind(model) {
    if (!model) return;
    this.model = model;

    for (const key of ['leftLeg', 'rightLeg', 'leftArm', 'rightArm']) {
      const def = CHAIN[key];
      this.chains[key] = {
        upper: findNamed(model, def.upper),
        mid: findNamed(model, def.mid),
        end: findNamed(model, def.end)
      };
    }
    this.hips = findNamed(model, CHAIN.hips);
    this.spine = findNamed(model, CHAIN.spine);
    if (this.hips) this._hipsRestLocalY = this.hips.position.y;

    const legs =
      this.chains.leftLeg.upper &&
      this.chains.leftLeg.end &&
      this.chains.rightLeg.upper &&
      this.chains.rightLeg.end;
    const arms =
      this.chains.leftArm.upper &&
      this.chains.leftArm.end &&
      this.chains.rightArm.upper &&
      this.chains.rightArm.end;

    this.valid = !!(legs || arms);
    if (!this.valid) {
      console.warn('[WindSurferIK] no usable arm/leg chains on rig — ride IK disabled');
    } else {
      console.info(
        '[WindSurferIK] bound',
        {
          legs: !!legs,
          arms: !!arms,
          hips: !!this.hips,
          sample: this.chains.leftLeg.upper?.name
        }
      );
    }
  }

  /** Re-index bones after a late model swap. */
  rebind(model) {
    this._bind(model);
  }

  /**
   * Apply stance. Targets are world-space Vector3 (from WindSurfer sockets).
   *
   * @param {number} weight 0..1 blend (0 = pure clip, 1 = full plant on board)
   * @param {object} targets { footL, footR, handL, handR, boomMid? }
   * @param {object} [opts]
   * @param {Vector3} [opts.boardForward] path forward (horizontal)
   * @param {Vector3} [opts.boardLeft] rider-left / windward
   * @param {number} [opts.hipDrop] metres to drop pelvis onto deck stance
   * @param {number} [opts.spineLean] radians torso toward boom
   */
  apply(weight, targets, opts = {}) {
    if (!this.valid || weight <= 0 || !targets) return;
    const w = MathUtils.clamp(weight, 0, 1);

    const forward = opts.boardForward || new Vector3(0, 0, 1);
    const left = opts.boardLeft || new Vector3(1, 0, 0);

    // Soft hip drop so legs can bend into foot straps without stretching
    if (this.hips && opts.hipDrop) {
      const y = this.hips.position.y;
      this.hips.position.y = MathUtils.lerp(y, y - opts.hipDrop, w * 0.85);
      this.hips.updateMatrixWorld(true);
    }

    // Mild spine lean toward boom (hands on metal bar)
    if (this.spine && opts.spineLean && targets.boomMid) {
      this.spine.getWorldPosition(_root);
      _dir.subVectors(targets.boomMid, _root).setY(0);
      if (_dir.lengthSq() > 1e-6) {
        // Blend a small local pitch; keep simple axis tilt in parent space
        const lean = opts.spineLean * w;
        _qa.setFromAxisAngle(left, -lean);
        this.spine.quaternion.slerp(_qb.copy(this.spine.quaternion).premultiply(_qa), w * 0.35);
        this.spine.updateMatrixWorld(true);
      }
    }

    // Legs: knees bend forward along board (+Z), slightly out
    if (targets.footL && this.chains.leftLeg.upper) {
      _pole.copy(forward).multiplyScalar(0.55).addScaledVector(left, 0.45).addScaledVector(_up, 0.15);
      this._blendSolve(this.chains.leftLeg, targets.footL, _pole, w);
    }
    if (targets.footR && this.chains.rightLeg.upper) {
      _pole.copy(forward).multiplyScalar(0.55).addScaledVector(left, -0.45).addScaledVector(_up, 0.15);
      this._blendSolve(this.chains.rightLeg, targets.footR, _pole, w);
    }

    // Arms: elbows drop slightly below boom, out to sides
    if (targets.handL && this.chains.leftArm.upper) {
      _pole.copy(left).multiplyScalar(0.8).addScaledVector(_up, -0.55).addScaledVector(forward, -0.2);
      this._blendSolve(this.chains.leftArm, targets.handL, _pole, w);
    }
    if (targets.handR && this.chains.rightArm.upper) {
      _pole.copy(left).multiplyScalar(-0.8).addScaledVector(_up, -0.55).addScaledVector(forward, -0.2);
      this._blendSolve(this.chains.rightArm, targets.handR, _pole, w);
    }
  }

  /**
   * Solve full IK then slerp from pre-solve pose by weight.
   * Snapshot rest quats → solve → slerp.
   */
  _blendSolve(chain, target, pole, weight) {
    const { upper, mid, end } = chain;
    if (!upper || !mid || !end) return;

    // Snapshot mixer pose, solve full IK, then slerp by weight
    const u0 = upper.quaternion.clone();
    const m0 = mid.quaternion.clone();
    const e0 = end.quaternion.clone();

    solveTwoBoneChain(upper, mid, end, target, pole);

    const u1 = upper.quaternion.clone();
    const m1 = mid.quaternion.clone();
    const e1 = end.quaternion.clone();
    upper.quaternion.copy(u0).slerp(u1, weight);
    mid.quaternion.copy(m0).slerp(m1, weight);
    end.quaternion.copy(e0).slerp(e1, weight);
    upper.updateMatrixWorld(true);
    mid.updateMatrixWorld(true);
    end.updateMatrixWorld(true);
  }
}
