import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Vector3
} from 'three';
import { LAYER, setLayerRecursive } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';
import { AirScooter } from './AirScooter.js';

const BIRTH_TIME = 0.32;
const DEATH_TIME = 0.5;

const _side = new Vector3();
const _pos = new Vector3();

/**
 * Procedural windsurfer vehicle (SI metres): board + mast + metal boom + sail.
 *
 * Named sockets (Object3D, world-updated every frame) are the IK targets:
 *   footL / footR  — deck foot straps
 *   handL / handR  — grip points on the boom (metal bar)
 *   boomMid        — boom centre (torso lean reference)
 *
 * Motion is driven by WalkController; optional AirScooter under the board is
 * wind-cushion VFX only (not the seat).
 */
export class WindSurfer {
  /**
   * @param {object} ctx { scene, particles, lights, decals, bursts, shake }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new Group();
    this.group.name = 'WindSurfer';
    this.group.visible = false;

    this.rig = new Group();
    this.rig.name = 'WindSurferRig';
    this.group.add(this.rig);

    this._buildMeshes();
    this._buildSockets();

    /** Optional air cushion under the board (existing wind-ball look). */
    this.cushion = new AirScooter(ctx);
    this.cushion.group.name = 'WindSurferCushion';
    // World-space VFX — add to scene so it renders under the board
    ctx.scene.add(this.cushion.group);

    this._birth = 0;
    this._death = 0;
    this._releasing = false;
    this._yaw = 0;
    this._anchor = new Vector3();
    this.light = null;
  }

  get active() {
    return this.group.visible;
  }

  /* ------------------------------------------------------------------ */
  /* build                                                               */
  /* ------------------------------------------------------------------ */

  _buildMeshes() {
    const c = () => settings.walk.windsurf || settings.walk;
    // Defaults live in settings.walk.windsurf — fall back to sane SI if missing.
    const boardLen = () => c().boardLength ?? 2.8;
    const boardW = () => c().boardWidth ?? 0.72;
    const boardT = () => c().boardThickness ?? 0.12;
    const mastH = () => c().mastHeight ?? 3.6;
    const boomLen = () => c().boomLength ?? 1.55;
    const boomH = () => c().boomHeight ?? 1.12;
    const boomR = () => c().boomRadius ?? 0.028;

    const deckMat = new MeshStandardMaterial({
      color: 0xc8b48a,
      roughness: 0.72,
      metalness: 0.05
    });
    const metalMat = new MeshStandardMaterial({
      color: 0xb0b8c0,
      roughness: 0.28,
      metalness: 0.85
    });
    const mastMat = new MeshStandardMaterial({
      color: 0x9aa3ad,
      roughness: 0.35,
      metalness: 0.7
    });
    const sailMat = new MeshStandardMaterial({
      color: 0x5cc8ee,
      roughness: 0.55,
      metalness: 0.05,
      side: DoubleSide,
      transparent: true,
      opacity: 0.72,
      emissive: new Color(0x1a4060),
      emissiveIntensity: 0.15
    });
    const strapMat = new MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.9, metalness: 0 });

    this.materials = { deckMat, metalMat, mastMat, sailMat, strapMat };

    // Board: long axis +Z (path forward), deck up +Y
    this.board = new Mesh(new BoxGeometry(1, 1, 1), deckMat);
    this.board.name = 'Board';
    this.board.castShadow = true;
    this.board.receiveShadow = true;
    this.rig.add(this.board);

    // Foot strap visual pads
    this.strapL = new Mesh(new BoxGeometry(1, 1, 1), strapMat);
    this.strapL.name = 'FootStrapL';
    this.strapR = new Mesh(new BoxGeometry(1, 1, 1), strapMat);
    this.strapR.name = 'FootStrapR';
    this.rig.add(this.strapL, this.strapR);

    // Mast (vertical tube at deck mid, slightly windward +X)
    this.mast = new Mesh(new CylinderGeometry(1, 1, 1, 12), mastMat);
    this.mast.name = 'Mast';
    this.mast.castShadow = true;
    this.rig.add(this.mast);

    // Boom = metal bar (horizontal, along board length ≈ ±Z, at boom height)
    this.boom = new Mesh(new CylinderGeometry(1, 1, 1, 10), metalMat);
    this.boom.name = 'Boom';
    this.boom.castShadow = true;
    // Cylinder default is Y-up; rotate to Z-axis bar
    this.boom.rotation.x = Math.PI / 2;
    this.rig.add(this.boom);

    // Sail cloth between mast and boom (simple plane)
    this.sail = new Mesh(new PlaneGeometry(1, 1, 1, 1), sailMat);
    this.sail.name = 'Sail';
    this.sail.castShadow = false;
    this.sail.receiveShadow = false;
    this.rig.add(this.sail);

    this._layout = { boardLen, boardW, boardT, mastH, boomLen, boomH, boomR };
    this._applyLayout();
    setLayerRecursive(this.rig, LAYER.WORLD);
    // Sail stays visible as soft VFX-ish surface but still world-lit
    this.sail.layers.set(LAYER.WORLD);
  }

  /** Resize/reposition meshes from live settings (editor-friendly). */
  _applyLayout() {
    const { boardLen, boardW, boardT, mastH, boomLen, boomH, boomR } = this._layout;
    const L = boardLen();
    const W = boardW();
    const T = boardT();
    const MH = mastH();
    const BL = boomLen();
    const BH = boomH();
    const BR = boomR();
    const mastX = settings.walk.windsurf?.mastOffsetX ?? 0.18;

    // Deck top ≈ T; board centre at y = T/2 so deck is at y=T
    this.board.scale.set(W, T, L);
    this.board.position.set(0, T * 0.5, 0);

    this.mast.scale.set(BR * 1.1, MH, BR * 1.1);
    this.mast.position.set(mastX, T + MH * 0.5, 0);

    this.boom.scale.set(BR, BL, BR);
    // boom along Z, centre slightly aft of mast for classic hold
    this.boom.position.set(mastX + 0.04, T + BH, -0.05);

    // Sail: spans mast height below boom + boom length
    const sailH = Math.max(0.6, BH * 0.95);
    const sailW = BL * 0.92;
    this.sail.scale.set(sailW, sailH, 1);
    this.sail.position.set(mastX + 0.02, T + BH - sailH * 0.45, -0.05);
    this.sail.rotation.y = Math.PI / 2; // face sideways (windward)

    // Foot straps on deck
    const fs = settings.walk.windsurf || {};
    const deckY = T + 0.01;
    const footLZ = fs.footL_z ?? -0.35;
    const footRZ = fs.footR_z ?? 0.28;
    const footX = fs.footSpreadX ?? 0.12;
    this.strapL.scale.set(0.14, 0.03, 0.22);
    this.strapR.scale.set(0.14, 0.03, 0.22);
    this.strapL.position.set(-footX, deckY, footLZ);
    this.strapR.position.set(footX, deckY, footRZ);

    // Cache for sockets
    this._dims = {
      L,
      W,
      T,
      MH,
      BL,
      BH,
      BR,
      mastX,
      deckY,
      footLZ,
      footRZ,
      footX,
      boomY: T + BH,
      boomX: mastX + 0.04,
      boomZ: -0.05
    };
  }

  _buildSockets() {
    this.sockets = {
      footL: new Object3D(),
      footR: new Object3D(),
      handL: new Object3D(),
      handR: new Object3D(),
      boomMid: new Object3D(),
      deck: new Object3D()
    };
    for (const [name, o] of Object.entries(this.sockets)) {
      o.name = `Socket_${name}`;
      this.rig.add(o);
    }
    this._placeSockets();
  }

  _placeSockets() {
    const d = this._dims;
    if (!d) return;
    const hs = settings.walk.windsurf || {};
    // Hands: front (right / toward nose +Z) closer to mast, rear (left) further aft
    const handLZ = hs.handL_z ?? d.boomZ - d.BL * 0.28;
    const handRZ = hs.handR_z ?? d.boomZ + d.BL * 0.22;
    const handY = d.boomY + (hs.handLift ?? 0.02);
    const handX = d.boomX;

    this.sockets.footL.position.set(-d.footX, d.deckY + 0.02, d.footLZ);
    this.sockets.footR.position.set(d.footX, d.deckY + 0.02, d.footRZ);
    this.sockets.handL.position.set(handX, handY, handLZ);
    this.sockets.handR.position.set(handX, handY, handRZ);
    this.sockets.boomMid.position.set(d.boomX, d.boomY, d.boomZ);
    this.sockets.deck.position.set(0, d.deckY, (d.footLZ + d.footRZ) * 0.5);
  }

  /** World position of a named socket into `out`. */
  getSocketWorld(name, out = new Vector3()) {
    const s = this.sockets[name];
    if (!s) return out.set(0, 0, 0);
    s.getWorldPosition(out);
    return out;
  }

  /**
   * Deck height under the rider (world Y of feet plane) when board is placed.
   * Character root should sit so feet can plant on deck sockets.
   */
  get deckHeightLocal() {
    return this._dims?.deckY ?? 0.12;
  }

  /** Rider root Y while standing on board (feet on deck; body above). */
  get riderRootY() {
    // Board group is at board centre height ≈ hover; deck is local deckY.
    // WalkController sets group.position.y so deck world Y ≈ deck surface.
    return this.deckHeightLocal;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Vector3} position  world position of board centre (y = deck/cushion)
   * @param {number} yaw        heading about +Y (0 = +Z)
   */
  spawn(position, yaw = 0) {
    this._applyLayout();
    this._placeSockets();

    this._birth = 0;
    this._death = 0;
    this._releasing = false;
    this._yaw = yaw;
    this._anchor.copy(position);

    this.group.visible = true;
    this.group.position.copy(position);
    this.group.position.y = Math.max(0.02, position.y);
    this.group.rotation.y = yaw;
    this.group.scale.setScalar(0.001);

    this.light = this.light ?? this.ctx.lights.acquire();

    // Soft wind cushion under board (reuse air scooter VFX)
    _pos.copy(position);
    _pos.y = Math.max(0.05, (settings.walk.hover ?? 0.06) + (settings.walk.radius ?? 0.3) * 0.35);
    this.cushion.spawn(_pos);

    this.ctx.shake.add(0.12 * (settings.walk.landShake ?? 0.35) * settings.global.explosionIntensity, 0.85, 18);
  }

  /**
   * @param {number} dt
   * @param {Vector3} position board centre world (xz path, y height)
   * @param {Vector3} side rider left (horizontal) — for cushion dust
   * @param {number} distance metres ridden
   * @param {number} speed m/s
   * @param {number} yaw heading
   * @param {number} lean bank radians (positive = roll to left)
   */
  update(dt, position, side, distance, speed, yaw, lean = 0) {
    if (!this.group.visible) return;

    // Live editor retune
    this._applyLayout();
    this._placeSockets();

    if (this._releasing) {
      this._death = saturate(this._death + dt / DEATH_TIME);
      if (this._death >= 1) {
        this._retire();
        return;
      }
    } else {
      this._birth = saturate(this._birth + dt / BIRTH_TIME);
    }

    const birth = Easing.outBack(this._birth);
    const fade = 1 - Easing.outQuad(this._death);
    const grow = birth * (1 + this._death * 0.15);

    this._yaw = yaw;
    this._anchor.copy(position);

    this.group.position.x = position.x;
    this.group.position.z = position.z;
    // Board floats slightly above floor
    const hover = settings.walk.hover ?? 0.06;
    this.group.position.y = hover;
    this.group.rotation.y = yaw;
    // Bank board into turns with the rider
    this.group.rotation.z = lean * 0.55;
    this.group.scale.setScalar(Math.max(0.001, grow));

    // Sail tint from walk colors
    const outer = getColor(settings.walk.colorOuter);
    this.materials.sailMat.color.copy(outer);
    this.materials.sailMat.opacity = 0.55 + 0.25 * fade;
    this.materials.sailMat.emissiveIntensity = 0.12 * settings.global.glow * fade;

    // Boom metal stays metallic
    this.materials.metalMat.metalness = 0.85;
    this.materials.metalMat.color.setHex(0xb8c0c8);

    if (this.light) {
      this.getSocketWorld('boomMid', _pos);
      this.ctx.lights.set(
        this.light,
        _pos,
        getColor(settings.walk.lightColor),
        settings.walk.lightIntensity * 0.55 * birth * fade,
        settings.walk.lightRadius * 0.85,
        dt
      );
    }

    // Wind cushion under board
    if (this.cushion.active) {
      _pos.set(position.x, hover + (settings.walk.radius ?? 0.35) * 0.45, position.z);
      _side.copy(side);
      this.cushion.update(dt, _pos, _side, distance, speed);
    }
  }

  release() {
    if (!this.group.visible || this._releasing) return;
    this._releasing = true;
    this._death = 0;
    this.cushion.release();
    this.ctx.shake.add(0.1 * (settings.walk.landShake ?? 0.35) * settings.global.explosionIntensity, 0.7, 16);
  }

  cancel() {
    this.cushion.cancel();
    this._retire();
  }

  _retire() {
    this.group.visible = false;
    this._releasing = false;
    this._birth = 0;
    this._death = 0;
    this.group.scale.setScalar(1);
    if (this.light) {
      this.ctx.lights.release(this.light);
      this.light = null;
    }
  }

  dispose() {
    this.cancel();
    this.ctx.scene.remove(this.cushion.group);
    this.cushion.dispose();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
