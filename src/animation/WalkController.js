import { MathUtils, Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { WindSurfer } from '../effects/WindSurfer.js';
import { WindSurferIK } from './WindSurferIK.js';
import { DecalType } from '../effects/GroundDecals.js';
import { getColor } from '../utils/color.js';
import { clamp, damp, Easing, saturate } from '../utils/math.js';

const TAU = Math.PI * 2;

const _p = new Vector3();
const _t = new Vector3();
const _side = new Vector3();
const _fwd = new Vector3();
const _footL = new Vector3();
const _footR = new Vector3();
const _handL = new Vector3();
const _handR = new Vector3();
const _boom = new Vector3();

/** Shortest signed angle from `a` to `b`. */
const wrapAngle = (angle) => MathUtils.euclideanModulo(angle + Math.PI, TAU) - Math.PI;

/**
 * Phases of a ride. `idle` is the only one in which the character is back under
 * the animation clip's control alone (no board IK).
 */
const Phase = Object.freeze({
  IDLE: 'idle',
  LEAP: 'leap',
  RIDE: 'ride',
  DISMOUNT: 'dismount'
});

/**
 * Walk mode: drawn path → windsurf ride.
 *
 *   leap onto board → plant feet on deck + hands on boom (IK) →
 *   ride path banking into turns → dismount → standing idle
 *
 * Vehicle: {@link WindSurfer} (board + mast + metal boom + sail).
 * Pose: {@link WindSurferIK} applied **after** the mixer (see `applyRiderIk`).
 */
export class WalkController {
  /**
   * @param {import('./CharacterController.js').CharacterController} character
   * @param {object} ctx { scene, particles, lights, decals, bursts, shake }
   */
  constructor(character, ctx) {
    this.character = character;
    this.ctx = ctx;

    this.surfer = new WindSurfer(ctx);
    ctx.scene.add(this.surfer.group);

    /** @type {WindSurferIK|null} */
    this.ik = null;
    this._ikWeight = 0;
    this._ikTargetWeight = 0;

    this.phase = Phase.IDLE;
    this.curve = null;
    this.length = 0;
    this.distance = 0;
    this.speed = 0;

    this._from = new Vector3();
    this._target = new Vector3();
    this._home = new Vector3();
    this._exit = new Vector3();
    this._anchor = new Vector3();
    this._leapTime = 0;
    this._leapDuration = 0;
    this._rideTime = 0;
    this._dismountTime = 0;
    this._yaw = 0;
    this._lean = 0;
    this._landStanding = false;

    // World targets refreshed every ride frame for applyRiderIk
    this._targets = {
      footL: _footL,
      footR: _footR,
      handL: _handL,
      handR: _handR,
      boomMid: _boom
    };
  }

  get active() {
    return this.phase !== Phase.IDLE;
  }

  /** Board deck surface height (world) while riding. */
  get deckHeight() {
    const hover = settings.walk.hover ?? 0.06;
    return hover + (this.surfer.deckHeightLocal || 0.12);
  }

  /**
   * Rider root Y while on board: feet plant on deck via IK, so root stays at
   * deck height (same contract as grounded standing — not a sit seat).
   */
  get rideRootY() {
    return this.deckHeight;
  }

  /** Ensure IK is bound to the loaded rig (call after character.load). */
  bindCharacter() {
    const model = this.character.model;
    if (!model) return;
    if (!this.ik) this.ik = new WindSurferIK(model);
    else this.ik.rebind(model);
  }

  /* ------------------------------------------------------------------ */
  /* entry points                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Ride `curve`. Re-triggering mid-ride leaps onto the new path head.
   * @returns {boolean}
   */
  begin(curve) {
    const length = curve.getLength();
    if (length < 0.5) return false;

    this.bindCharacter();
    this.surfer.cancel();

    this.curve = curve;
    this.length = length;
    this.distance = 0;
    this.speed = 0;
    this._rideTime = 0;
    this._landStanding = false;
    this._ikTargetWeight = 0;

    if (!this.active) this._home.copy(this.character.position);

    this._from.copy(this.character.position);
    // Leap lands standing on the board deck at path start
    curve.getPointAt(0, this._target).setY(this.rideRootY);
    this._startLeap();
    return true;
  }

  cancel() {
    if (!this.active && this._ikWeight <= 0) return;
    this.surfer.cancel();
    this.phase = Phase.IDLE;
    this.curve = null;
    this._ikTargetWeight = 0;
    this._ikWeight = 0;
    this.character.setPose?.('idle', settings.walk.poseBlend);
    this.character.resetPlacement();
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    if (dt > 0) {
      switch (this.phase) {
        case Phase.LEAP:
          this._updateLeap(dt);
          break;
        case Phase.RIDE:
          this._updateRide(dt);
          break;
        case Phase.DISMOUNT:
          this._updateDismount(dt);
          break;
        default:
          break;
      }
    }

    // Blend IK weight (smooth mount/dismount)
    const ikBlend = Math.max(0.05, settings.walk.windsurf?.ikBlend ?? 0.35);
    if (dt > 0) {
      const step = dt / ikBlend;
      this._ikWeight = MathUtils.clamp(
        this._ikWeight + MathUtils.clamp(this._ikTargetWeight - this._ikWeight, -step, step),
        0,
        1
      );
    }

    if (this.surfer.active) {
      if (this.phase === Phase.RIDE) {
        this._anchor.set(this.character.position.x, this.rideRootY, this.character.position.z);
      }
      _side.set(Math.cos(this._yaw), 0, -Math.sin(this._yaw));
      this.surfer.update(
        dt,
        this._anchor,
        _side,
        this.distance,
        this.speed,
        this._yaw,
        this._lean
      );
      this._refreshIkTargets();
    }
  }

  /**
   * MUST run after CharacterController.update (mixer). Plants feet on deck and
   * hands on the boom metal bar.
   */
  applyRiderIk(_dt) {
    if (!this.ik?.valid || this._ikWeight <= 0) return;

    this._refreshIkTargets();

    _fwd.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    _side.set(Math.cos(this._yaw), 0, -Math.sin(this._yaw));

    const ws = settings.walk.windsurf || {};
    this.ik.apply(this._ikWeight, this._targets, {
      boardForward: _fwd,
      boardLeft: _side,
      hipDrop: ws.hipDrop ?? 0.08,
      spineLean: (ws.spineLeanDeg ?? 12) * MathUtils.DEG2RAD
    });
  }

  _refreshIkTargets() {
    if (!this.surfer.active) return;
    this.surfer.getSocketWorld('footL', _footL);
    this.surfer.getSocketWorld('footR', _footR);
    this.surfer.getSocketWorld('handL', _handL);
    this.surfer.getSocketWorld('handR', _handR);
    this.surfer.getSocketWorld('boomMid', _boom);
  }

  /* ------------------------------------------------------------------ */
  /* leap                                                                */
  /* ------------------------------------------------------------------ */

  _startLeap() {
    const c = settings.walk;
    const reach = _p.copy(this._target).setY(0).distanceTo(_t.copy(this._from).setY(0));

    this.phase = Phase.LEAP;
    this._leapTime = 0;
    this._leapDuration = clamp(reach / Math.max(0.5, c.jumpSpeed), c.jumpMin, c.jumpMax);
    this._yaw = this.character.facing;
    this._ikTargetWeight = 0;

    // Standing stance for windsurf (not meditation sit)
    this.character.setPose?.('idle', c.poseBlend);

    _p.set(this._from.x, 0.02, this._from.z);
    this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
      radius: 1.4,
      life: 0.8,
      intensity: 0.5,
      colorA: getColor(c.colorInner),
      colorB: getColor(c.colorOuter)
    });
  }

  _updateLeap(dt) {
    const c = settings.walk;
    this._leapTime += dt;
    const t = saturate(this._leapTime / Math.max(0.05, this._leapDuration));

    _p.lerpVectors(this._from, this._target, t);
    _p.y += c.jumpHeight * 4 * t * (1 - t);
    this.character.root.position.copy(_p);

    this._faceLeap(dt, t);
    this._lean = damp(this._lean, 0, 0.01, dt);
    this.character.setLean(this._lean);

    // Blend onto board grips as he lands
    if (!this._landStanding && t >= (c.tuck ?? 0.62)) {
      this._ikTargetWeight = saturate((t - (c.tuck ?? 0.62)) / 0.35);
    }

    if (t < 1) return;

    this.character.root.position.copy(this._target);

    if (this._landStanding) {
      this.character.resetPlacement();
      this.phase = Phase.IDLE;
      this.curve = null;
      this._ikTargetWeight = 0;
      this._land(0.5);
      return;
    }

    this._anchor.set(this._target.x, this.rideRootY, this._target.z);
    this.surfer.spawn(this._anchor, this._yaw);
    this._ikTargetWeight = 1;
    this.phase = Phase.RIDE;
    this._rideTime = 0;
    this.distance = 0;
    this.speed = 0;
    this._land(1);
  }

  _faceLeap(dt, t) {
    _t.copy(this._target).sub(this._from).setY(0);
    const travel = _t.lengthSq() > 1e-4 ? Math.atan2(_t.x, _t.z) : this._yaw;

    let target = travel;
    if (this.curve && !this._landStanding) {
      this.curve.getTangentAt(0, _t).setY(0);
      if (_t.lengthSq() > 1e-6) {
        const along = Math.atan2(_t.x, _t.z);
        target = travel + wrapAngle(along - travel) * (t * t);
      }
    }
    this._turnTo(target, dt, 0.0005);
  }

  _land(scale) {
    const c = settings.walk;
    _p.set(this.character.position.x, 0.02, this.character.position.z);
    this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
      radius: 2.2 * scale,
      life: 1.0,
      intensity: 0.6 * scale,
      colorA: getColor(c.colorInner),
      colorB: getColor(c.colorOuter)
    });
    this.ctx.shake.add(0.22 * c.landShake * settings.global.explosionIntensity * scale, 1.0, 24);
  }

  /* ------------------------------------------------------------------ */
  /* ride                                                                */
  /* ------------------------------------------------------------------ */

  _updateRide(dt) {
    const c = settings.walk;
    this._rideTime += dt;
    this._ikTargetWeight = 1;

    const remaining = Math.max(0, this.length - this.distance);
    const rampIn = Easing.outCubic(saturate(this._rideTime / Math.max(0.01, c.accel)));
    const brakeDistance = Math.max(0.05, c.speed * c.brake);
    const rampOut = MathUtils.lerp(0.22, 1, Easing.outQuad(saturate(remaining / brakeDistance)));
    this.speed = c.speed * rampIn * rampOut;
    this.distance += this.speed * dt;

    const u = saturate(this.distance / this.length);
    this.curve.getPointAt(u, _p);
    this.curve.getTangentAt(u, _t).setY(0);

    const heading = _t.lengthSq() > 1e-6 ? Math.atan2(_t.x, _t.z) : this._yaw;
    const turn = this._turnTo(heading, dt, c.turnDamping);

    const bob =
      Math.sin(this._rideTime * c.bobRate * TAU) * c.bob * saturate(this.speed / Math.max(0.5, c.speed));
    // Stand on deck — root at deck height (feet IK down to straps)
    this.character.root.position.set(_p.x, this.rideRootY + bob, _p.z);

    const rate = Math.max(0.05, c.leanRate);
    const target = -clamp(turn / rate, -1, 1) * c.lean * MathUtils.DEG2RAD;
    this._lean = damp(this._lean, target, c.leanDamping, dt);
    this.character.setLean(this._lean);

    if (this.distance >= this.length - 1e-4) this._startDismount();
  }

  /* ------------------------------------------------------------------ */
  /* dismount                                                            */
  /* ------------------------------------------------------------------ */

  _startDismount() {
    this.phase = Phase.DISMOUNT;
    this._dismountTime = 0;
    this._exit.copy(this.character.position);
    this.surfer.release();
    this._ikTargetWeight = 0;
    this.character.setPose?.('idle', settings.walk.poseBlend);
  }

  _updateDismount(dt) {
    const c = settings.walk;
    this._dismountTime += dt;
    const t = saturate(this._dismountTime / Math.max(0.05, c.dismountTime));
    const e = Easing.outCubic(t);

    _t.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
    _p.copy(this._exit).addScaledVector(_t, e * 0.55);
    _p.y = MathUtils.lerp(this._exit.y, 0, e);
    this.character.root.position.copy(_p);

    this._lean = damp(this._lean, 0, 0.0005, dt);
    this.character.setLean(this._lean);

    if (t < 1) return;

    this.character.resetPlacement();
    this._ikWeight = 0;
    this._land(0.7);

    if (settings.walk.returnHome && this._home.distanceTo(this.character.position) > 0.5) {
      this._from.copy(this.character.position);
      this._target.copy(this._home).setY(0);
      this._landStanding = true;
      this._startLeap();
      return;
    }

    this.phase = Phase.IDLE;
    this.curve = null;
  }

  /* ------------------------------------------------------------------ */

  _turnTo(target, dt, rate) {
    const delta = wrapAngle(target - this._yaw);
    const step = delta * (1 - Math.pow(rate, dt));
    this._yaw += step;
    this.character.setFacing(this._yaw);
    return step / Math.max(dt, 1e-4);
  }

  dispose() {
    this.surfer.dispose();
    this.ctx.scene.remove(this.surfer.group);
    this.ik = null;
  }
}
