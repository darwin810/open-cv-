'use strict';
/* =====================================================================================
   BUBBLE BODY — app.js
   Arquitectura modular en un único archivo (sin bundler, sin frameworks).
   Secciones:
     0. Configuración y estado global
     1. Utilidades sin asignación por frame
     2. Motor de física (Matter.js)
     3. Sistema de burbujas (pool reutilizable)
     4. Landmarks / anclas corporales
     5. Definición de segmentos y slots volumétricos
     6. Tracking (MediaPipe Pose) + suavizado + interpolación
     7. Calibración de pared (homografía 4 puntos)
     8. Render (Canvas 2D)
     9. Telemetría
    10. UI / bindings del panel
    11. Bucle principal
    12. Inicialización
   ===================================================================================== */

/* =====================================================================================
   0. CONFIGURACIÓN Y ESTADO GLOBAL
   ===================================================================================== */

const MAX_BUBBLES = 2000;
const TWO_PI = Math.PI * 2;
const POSE_TIMEOUT_MS = 1200;

// --- Cascada de integración orgánica ---
// Cuando cambia el "modo de movimiento" (aparece una persona, se pierde, o entra el
// texto), las burbujas NO parten todas al mismo tiempo hacia su destino: cada una tiene
// un pequeño retraso propio (formationDelay) repartido a lo largo de CASCADE_WINDOW, y
// tras su "disparo" tarda ARRIVAL_RAMP segundos en acelerar de "flotando libre" a
// "llegando a destino". El resultado es un efecto de ensamblaje progresivo tipo oleada.
const CASCADE_WINDOW = 0.85; // seg: ventana en la que se reparten los disparos de todas las burbujas
const ARRIVAL_RAMP   = 0.55; // seg: rampa de aceleración individual tras el disparo de cada burbuja

const CONFIG = {
  bubbleCount:   1500,
  bubbleSize:    4.0,
  adhesion:      0.85,
  smoothing:     0.35,
  arrivalSpeed:  0.30,
  bounce:        0.6,
  floatStrength: 0.55,
  distMode:      'text',      // text | wander | cluster | disperse
  colorMode:     'azul',      // custom | azul | verde | rojo | morado | dorado | blanco | multicolor
  color:         '#5ad8ff',
  showSkeleton:  false,
  mirror:        true,
  useCalibration:false,
  showBackground:false
};

const COLOR_PRESETS = {
  azul:    '#3aa0ff',
  verde:   '#39e28a',
  rojo:    '#ff5b5b',
  morado:  '#b16bff',
  dorado:  '#ffcf5c',
  blanco:  '#f2f6fa'
};

const SYS = { OFF:'off', DETECTING:'detecting', DETECTED:'detected', CALIBRATING:'calibrating' };

const runtime = {
  systemState:      SYS.OFF,
  cameraActive:      false,
  personPresent:     false,
  lastPoseTimestamp: 0,
  lastSendTimestamp: 0,
  poseLatencyMs:     0,
  landmarksVisible:  0,
  activeBubbleCount: 0, // arranca en 0: la primera llamada a setActiveBubbleCount() debe AGREGAR todas las burbujas al mundo físico
  fps:               0,
  stageW:            0,
  stageH:            0,
  calibrating:       false,
  calibClicks:       0,
  calibSrcPoints:    [0,0,0,0,0,0,0,0], // 4 pares x,y (flat)
  calibMatrix:       null,               // homografía 3x3 (9 floats) o null

  // --- Bloqueo de identidad (evita que alguien que cruza por delante/detrás robe el foco) ---
  locked:            false,
  lockedHipX:        0,
  lockedHipY:        0,
  lockedScale:       200,
  mismatchFrames:    0,
  refShoulderDist:   200,

  // --- Cascada de integración: detecta cambios de modo (attached/text/free) para
  // relanzar la oleada de ensamblaje en vez de "teletransportar" todo el enjambre ---
  motionMode:        'boot',
  modeStartTime:     0
};

/* =====================================================================================
   1. UTILIDADES SIN ASIGNACIÓN POR FRAME
   ===================================================================================== */

// Objetos reutilizados para llamadas a Matter.js que exigen {x,y}
const _tmpPos = { x: 0, y: 0 };
const _tmpVel = { x: 0, y: 0 };
const _tmpHomo = { x: 0, y: 0 };

function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

function lerp(a, b, t) { return a + (b - a) * t; }

// Easing suave para que la "llegada" de cada burbuja no sea un arranque brusco lineal
// sino una aceleración orgánica (lento -> rápido -> se asienta).
function easeOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }

// Secuencia de Weyl (cuasi-aleatoria determinista, sin Math.random, estable entre frames)
function weyl1D(i) {
  const v = i * 0.6180339887498949;
  return v - Math.floor(v);
}
function weyl2D(i) {
  const v = i * 0.4142135623730951;
  return v - Math.floor(v);
}

// Generador pseudoaleatorio determinista por semilla (para wander persistente sin Math.random en el loop)
// Generador pseudoaleatorio determinista por semilla (para wander persistente sin Math.random en el loop)
function hashNoise(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Genera una posición cerca del centro del stage (spread acotado), usada para el spawn
// inicial y cuando las burbujas deben "regresar a flotar en el medio".
const _tmpSpawn = { x: 0, y: 0 };
function spawnNearCenter(i, salt) {
  const spread = 0.30; // fracción del ancho/alto del stage usada como radio de dispersión
  _tmpSpawn.x = runtime.stageW * 0.5 + (weyl1D(i + salt) - 0.5) * runtime.stageW * spread;
  _tmpSpawn.y = runtime.stageH * 0.5 + (weyl2D(i + salt) - 0.5) * runtime.stageH * spread;
  return _tmpSpawn;
}

/* =====================================================================================
   2. MOTOR DE FÍSICA (MATTER.JS)
   ===================================================================================== */

const Engine = Matter.Engine, World = Matter.World, Bodies = Matter.Bodies,
      Body = Matter.Body, Composite = Matter.Composite;

const engine = Engine.create({
  positionIterations: 3, // default 6: con las burbujas sin colisión mutua, no se necesita tanta precisión
  velocityIterations: 2  // default 4
});
engine.gravity.x = 0;
engine.gravity.y = 0; // la flotación/gravedad se controla manualmente por burbuja

let wallTop, wallBottom, wallLeft, wallRight;

function buildWalls(w, h) {
  const thickness = 80;
  if (wallTop) {
    Composite.remove(engine.world, [wallTop, wallBottom, wallLeft, wallRight]);
  }
  const opts = { isStatic: true, restitution: CONFIG.bounce, friction: 0.01, label: 'wall' };
  wallTop    = Bodies.rectangle(w / 2, -thickness / 2, w + thickness * 2, thickness, opts);
  wallBottom = Bodies.rectangle(w / 2, h + thickness / 2, w + thickness * 2, thickness, opts);
  wallLeft   = Bodies.rectangle(-thickness / 2, h / 2, thickness, h + thickness * 2, opts);
  wallRight  = Bodies.rectangle(w + thickness / 2, h / 2, thickness, h + thickness * 2, opts);
  Composite.add(engine.world, [wallTop, wallBottom, wallLeft, wallRight]);
}

/* =====================================================================================
   3. SISTEMA DE BURBUJAS (POOL REUTILIZABLE)
   ===================================================================================== */

const bubbles = new Array(MAX_BUBBLES);      // cuerpos Matter, creados una sola vez
const inWorld = new Uint8Array(MAX_BUBBLES);  // 1 si el cuerpo está agregado al mundo

// Arrays paralelos (sin objetos) para comportamiento libre y visual
const wanderAngle  = new Float32Array(MAX_BUBBLES);
const wanderSpeed  = new Float32Array(MAX_BUBBLES);
const visualAlpha  = new Float32Array(MAX_BUBBLES);

// Fases y frecuencias fijas por burbuja (antes se recalculaban con hashNoise()+trig en
// CADA frame dentro de attachedStep/textFormStep, dando siempre el mismo resultado para
// el mismo índice: puro trabajo repetido). Al precalcularlas una sola vez se elimina ese
// costo del bucle caliente. Además, variar ligeramente la frecuencia por burbuja hace que
// la "respiración" deje de moverse en bloque (todas en fase) y se sienta más orgánica.
const breathPhaseA = new Float32Array(MAX_BUBBLES);
const breathPhaseB = new Float32Array(MAX_BUBBLES);
const breathFreqA  = new Float32Array(MAX_BUBBLES);
const breathFreqB  = new Float32Array(MAX_BUBBLES);
const textPhaseA   = new Float32Array(MAX_BUBBLES);
const textPhaseB   = new Float32Array(MAX_BUBBLES);

// Retraso individual (0..1) usado por la cascada de integración: define en qué momento,
// dentro de CASCADE_WINDOW, "despierta" cada burbuja y empieza a acelerar hacia su target.
const formationDelay = new Float32Array(MAX_BUBBLES);

// Arrays de destino (target) recalculados cada frame sin crear objetos
const targetX = new Float32Array(MAX_BUBBLES);
const targetY = new Float32Array(MAX_BUBBLES);

// Color por burbuja precalculado (solo se usa/recalcula en modo multicolor; el resto de
// modos usan un único fillStyle para toda la escena, mucho más barato).
const bubbleColorCache = new Array(MAX_BUBBLES).fill('#5ad8ff');
function rebuildColorCache() {
  const count = runtime.activeBubbleCount;
  for (let i = 0; i < count; i++) {
    const hue = (i / count) * 330 + hashNoise(i * 3.71) * 22;
    bubbleColorCache[i] = 'hsl(' + Math.round(hue) + ',82%,62%)';
  }
}

function currentSolidColor() {
  if (CONFIG.colorMode === 'custom') return CONFIG.color;
  return COLOR_PRESETS[CONFIG.colorMode] || CONFIG.color;
}

// Grupo de colisión "no colisionante": todos los cuerpos que comparten este mismo grupo
// negativo NUNCA colisionan entre sí (regla de Matter.js), pero sí siguen colisionando
// normalmente con cuerpos de otros grupos (las paredes). Con 1500-2000 círculos, resolver
// colisiones burbuja-contra-burbuja era, con diferencia, el cálculo más pesado del motor
// físico en cada frame; visualmente las burbujas nunca necesitaron "chocarse" entre ellas
// (se superponen y no se nota), así que desactivarlo es una ganancia enorme de rendimiento
// sin ningún costo visual.
const bubbleNonCollidingGroup = Matter.Body.nextGroup(true);

function initBubblePool() {
  for (let i = 0; i < MAX_BUBBLES; i++) {
    const body = Bodies.circle(
      -9999, -9999, CONFIG.bubbleSize,
      {
        restitution: CONFIG.bounce,
        friction: 0.015,
        frictionAir: 0.028,
        density: 0.0018,
        slop: 0.4,
        collisionFilter: { group: bubbleNonCollidingGroup }
      }
    );
    bubbles[i] = body;
    wanderAngle[i] = hashNoise(i) * TWO_PI;
    wanderSpeed[i] = 0.5 + hashNoise(i * 7.31) * 0.8;
    visualAlpha[i] = 0.65 + hashNoise(i * 3.17) * 0.35;

    breathPhaseA[i] = hashNoise(i * 12.37) * TWO_PI;
    breathPhaseB[i] = hashNoise(i * 4.21 + 5) * TWO_PI;
    breathFreqA[i]  = 1.7 + hashNoise(i * 2.03) * 0.9;   // ~1.7 .. 2.6
    breathFreqB[i]  = 1.3 + hashNoise(i * 6.47 + 1) * 0.8; // ~1.3 .. 2.1

    textPhaseA[i] = hashNoise(i * 8.77) * TWO_PI;
    textPhaseB[i] = hashNoise(i * 3.31 + 2) * TWO_PI;

    formationDelay[i] = weyl1D(i * 0.917 + 0.271);
  }
}

function setActiveBubbleCount(newCount) {
  newCount = Math.round(clamp(newCount, 1000, MAX_BUBBLES));
  const old = runtime.activeBubbleCount;

  if (newCount > old) {
    const toAdd = [];
    for (let i = old; i < newCount; i++) {
      if (!inWorld[i]) {
        const p = spawnNearCenter(i, 0);
        Body.setPosition(bubbles[i], { x: p.x, y: p.y });
        Body.setVelocity(bubbles[i], { x: 0, y: 0 });
        toAdd.push(bubbles[i]);
        inWorld[i] = 1;
      }
    }
    if (toAdd.length) Composite.add(engine.world, toAdd);
  } else if (newCount < old) {
    const toRemove = [];
    for (let i = newCount; i < old; i++) {
      if (inWorld[i]) {
        toRemove.push(bubbles[i]);
        inWorld[i] = 0;
      }
    }
    if (toRemove.length) Composite.remove(engine.world, toRemove);
  }

  runtime.activeBubbleCount = newCount;
  CONFIG.bubbleCount = newCount;
  buildSlots(newCount);
  buildTextSlots(newCount);
  rebuildColorCache();
}

let currentBubbleRadius = CONFIG.bubbleSize;
function setBubbleSize(newSize) {
  newSize = clamp(newSize, 1.5, 9);
  const factor = newSize / currentBubbleRadius;
  if (Math.abs(factor - 1) < 0.001) return;
  for (let i = 0; i < runtime.activeBubbleCount; i++) {
    Body.scale(bubbles[i], factor, factor);
  }
  currentBubbleRadius = newSize;
  CONFIG.bubbleSize = newSize;
}

function setBounce(value) {
  CONFIG.bounce = value;
  for (let i = 0; i < runtime.activeBubbleCount; i++) {
    bubbles[i].restitution = value;
  }
  if (wallTop) {
    wallTop.restitution = value; wallBottom.restitution = value;
    wallLeft.restitution = value; wallRight.restitution = value;
  }
}

/* =====================================================================================
   4. LANDMARKS / ANCLAS CORPORALES
   ===================================================================================== */

// 33 landmarks de MediaPipe + 7 anclas derivadas (cuello, cabeza, manos, pies)
const NUM_LANDMARKS = 33;
const ANCHOR = {
  NECK_TOP: 33, SHOULDER_MID: 34, HEAD_CENTER: 35,
  L_HAND: 36, R_HAND: 37, L_FOOT: 38, R_FOOT: 39
};
const TOTAL_POINTS = 40;

const LM = {
  NOSE:0, LEFT_EYE_INNER:1, LEFT_EYE:2, LEFT_EYE_OUTER:3, RIGHT_EYE_INNER:4, RIGHT_EYE:5, RIGHT_EYE_OUTER:6,
  LEFT_EAR:7, RIGHT_EAR:8, MOUTH_LEFT:9, MOUTH_RIGHT:10,
  LEFT_SHOULDER:11, RIGHT_SHOULDER:12, LEFT_ELBOW:13, RIGHT_ELBOW:14, LEFT_WRIST:15, RIGHT_WRIST:16,
  LEFT_PINKY:17, RIGHT_PINKY:18, LEFT_INDEX:19, RIGHT_INDEX:20, LEFT_THUMB:21, RIGHT_THUMB:22,
  LEFT_HIP:23, RIGHT_HIP:24, LEFT_KNEE:25, RIGHT_KNEE:26, LEFT_ANKLE:27, RIGHT_ANKLE:28,
  LEFT_HEEL:29, RIGHT_HEEL:30, LEFT_FOOT_INDEX:31, RIGHT_FOOT_INDEX:32
};

// Conexiones para dibujar el esqueleto de referencia
const POSE_CONNECTIONS = [
  [11,12],[11,13],[13,15],[12,14],[14,16],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[27,29],[27,31],[29,31],
  [24,26],[26,28],[28,30],[28,32],[30,32],
  [15,17],[15,19],[15,21],[16,18],[16,20],[16,22],
  [7,0],[8,0]
];

// Coordenadas crudas (recibidas de MediaPipe, en espacio de canvas del stage)
const rawX = new Float32Array(NUM_LANDMARKS);
const rawY = new Float32Array(NUM_LANDMARKS);
const rawZ = new Float32Array(NUM_LANDMARKS); // profundidad relativa (MediaPipe), misma escala aprox. que X
const rawVisible = new Uint8Array(NUM_LANDMARKS);
// Confianza suavizada por landmark (0..1). Modula la velocidad de adaptación en vez de congelar el punto,
// así una caída temporal de confianza (movimiento rápido, semi-oclusión) no "atrapa" la burbuja.
const landmarkConfidence = new Float32Array(NUM_LANDMARKS).fill(1);

// Coordenadas suavizadas (interpolación exponencial, se actualizan cada frame de render)
const PX = new Float32Array(TOTAL_POINTS);
const PY = new Float32Array(TOTAL_POINTS);
const PZ = new Float32Array(NUM_LANDMARKS);

let poseInitialized = false;
let bodyScale = 200;       // escala de referencia general (para radios de extremidades), evita división por cero
let torsoHalfWidth = 110;  // semiancho de torso reconstruido en 3D (no colapsa al ponerse de perfil)

function primeSmoothedFromRaw() {
  for (let i = 0; i < NUM_LANDMARKS; i++) { PX[i] = rawX[i]; PY[i] = rawY[i]; PZ[i] = rawZ[i]; }
  poseInitialized = true;
}

function updateSmoothedLandmarks() {
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    // Confianza alta -> sigue al raw rápido. Confianza baja -> sigue más lento (menos jitter)
    // pero NUNCA se detiene del todo, para que no quede "capturado".
    const conf = clamp(landmarkConfidence[i], 0.25, 1);
    const a = CONFIG.smoothing * conf;
    PX[i] += (rawX[i] - PX[i]) * a;
    PY[i] += (rawY[i] - PY[i]) * a;
    PZ[i] += (rawZ[i] - PZ[i]) * a;
  }
}

function updateAnchors() {
  // Cuello: punto medio de orejas, desplazado hacia arriba
  PX[ANCHOR.NECK_TOP] = (PX[LM.LEFT_EAR] + PX[LM.RIGHT_EAR]) * 0.5;
  PY[ANCHOR.NECK_TOP] = (PY[LM.LEFT_EAR] + PY[LM.RIGHT_EAR]) * 0.5 - bodyScale * 0.10;

  // Punto medio de hombros
  PX[ANCHOR.SHOULDER_MID] = (PX[LM.LEFT_SHOULDER] + PX[LM.RIGHT_SHOULDER]) * 0.5;
  PY[ANCHOR.SHOULDER_MID] = (PY[LM.LEFT_SHOULDER] + PY[LM.RIGHT_SHOULDER]) * 0.5;

  // Centro de cabeza: nariz + orejas, desplazado hacia arriba
  PX[ANCHOR.HEAD_CENTER] = PX[LM.NOSE] * 0.5 + PX[LM.LEFT_EAR] * 0.25 + PX[LM.RIGHT_EAR] * 0.25;
  PY[ANCHOR.HEAD_CENTER] = (PY[LM.NOSE] * 0.5 + PY[LM.LEFT_EAR] * 0.25 + PY[LM.RIGHT_EAR] * 0.25) - bodyScale * 0.30;

  // Centros de manos
  PX[ANCHOR.L_HAND] = PX[LM.LEFT_WRIST] * 0.5 + PX[LM.LEFT_INDEX] * 0.25 + PX[LM.LEFT_PINKY] * 0.25;
  PY[ANCHOR.L_HAND] = PY[LM.LEFT_WRIST] * 0.5 + PY[LM.LEFT_INDEX] * 0.25 + PY[LM.LEFT_PINKY] * 0.25;
  PX[ANCHOR.R_HAND] = PX[LM.RIGHT_WRIST] * 0.5 + PX[LM.RIGHT_INDEX] * 0.25 + PX[LM.RIGHT_PINKY] * 0.25;
  PY[ANCHOR.R_HAND] = PY[LM.RIGHT_WRIST] * 0.5 + PY[LM.RIGHT_INDEX] * 0.25 + PY[LM.RIGHT_PINKY] * 0.25;

  // Centros de pies
  PX[ANCHOR.L_FOOT] = PX[LM.LEFT_ANKLE] * 0.4 + PX[LM.LEFT_FOOT_INDEX] * 0.4 + PX[LM.LEFT_HEEL] * 0.2;
  PY[ANCHOR.L_FOOT] = PY[LM.LEFT_ANKLE] * 0.4 + PY[LM.LEFT_FOOT_INDEX] * 0.4 + PY[LM.LEFT_HEEL] * 0.2;
  PX[ANCHOR.R_FOOT] = PX[LM.RIGHT_ANKLE] * 0.4 + PX[LM.RIGHT_FOOT_INDEX] * 0.4 + PX[LM.RIGHT_HEEL] * 0.2;
  PY[ANCHOR.R_FOOT] = PY[LM.RIGHT_ANKLE] * 0.4 + PY[LM.RIGHT_FOOT_INDEX] * 0.4 + PY[LM.RIGHT_HEEL] * 0.2;

  // --- Reconstrucción de ancho real de hombros/cadera usando la profundidad (z) ---
  // MediaPipe entrega z en una escala aproximada a x, lo que —sin corrección— hace que de
  // perfil la profundidad hombro-a-hombro se reconstruya casi tan grande como el ancho de
  // frente, y el torso se vea como un CILINDRO (mismo grosor sin importar la orientación).
  // Un torso real es más angosto de perfil (la profundidad pecho-espalda es menor que el
  // ancho de hombros): TORSO_DEPTH_RATIO limita cuánto puede "engordar" el ancho a partir
  // de Z para que el cuerpo se angoste de forma realista al girar, en vez de mantenerse
  // constante.
  const DEPTH_FACTOR = 0.5;
  const TORSO_DEPTH_RATIO = 0.6;

  const shDx = PX[LM.RIGHT_SHOULDER] - PX[LM.LEFT_SHOULDER];
  const shDy = PY[LM.RIGHT_SHOULDER] - PY[LM.LEFT_SHOULDER];
  const shDz = (PZ[LM.RIGHT_SHOULDER] - PZ[LM.LEFT_SHOULDER]) * runtime.stageW * DEPTH_FACTOR * TORSO_DEPTH_RATIO;
  const shoulder2D = Math.sqrt(shDx * shDx + shDy * shDy);
  const shoulderDist3D = Math.sqrt(shDx * shDx + shDy * shDy + shDz * shDz);

  const hpDx = PX[LM.RIGHT_HIP] - PX[LM.LEFT_HIP];
  const hpDy = PY[LM.RIGHT_HIP] - PY[LM.LEFT_HIP];
  const hpDz = (PZ[LM.RIGHT_HIP] - PZ[LM.LEFT_HIP]) * runtime.stageW * DEPTH_FACTOR * TORSO_DEPTH_RATIO;
  const hip2D = Math.sqrt(hpDx * hpDx + hpDy * hpDy);
  const hipDist3D = Math.sqrt(hpDx * hpDx + hpDy * hpDy + hpDz * hpDz);

  const rawWidthEstimate = shoulderDist3D * 0.55 + hipDist3D * 0.45;
  const frontalRef = Math.max(shoulder2D, hip2D);

  // Referencia de ancho "de frente": sube de inmediato si se ve un ancho mayor, pero baja
  // muy lentamente, así un giro momentáneo de perfil no la reduce (y por tanto no colapsa).
  if (frontalRef > runtime.refShoulderDist) {
    runtime.refShoulderDist = frontalRef;
  } else {
    runtime.refShoulderDist = lerp(runtime.refShoulderDist, frontalRef, 0.0015);
  }
  runtime.refShoulderDist = clamp(runtime.refShoulderDist, 60, 900);

  // Techo apenas por encima del ancho de frente (ya no +12%, que dejaba "engordar" el
  // torso al girar) y un piso mucho más bajo (antes 0.9x, ahora 0.5x) para que sí se
  // permita angostar de verdad en perfil, en vez de quedar forzado a un grosor mínimo.
  const widthCeiling = runtime.refShoulderDist * 1.02;
  const reconstructedWidth = clamp(rawWidthEstimate, frontalRef * 0.5, widthCeiling);

  bodyScale = clamp(reconstructedWidth, 60, 900);
  torsoHalfWidth = clamp(reconstructedWidth * 0.5, 35, 500);
}

/* =====================================================================================
   5. DEFINICIÓN DE SEGMENTOS Y SLOTS VOLUMÉTRICOS
   ===================================================================================== */

const SEG_KIND = { CAPSULE: 0, QUAD: 1, CLUSTER: 2, SPHERE: 3 };

const SEGMENTS = [
  { kind: SEG_KIND.SPHERE,  a: ANCHOR.HEAD_CENTER, b: -1, r0: 0.30, r1: 0.30, weight: 0.07 },
  { kind: SEG_KIND.CAPSULE, a: ANCHOR.NECK_TOP,     b: ANCHOR.SHOULDER_MID, r0: 0.16, r1: 0.20, weight: 0.02 },
  { kind: SEG_KIND.QUAD,    a: LM.LEFT_SHOULDER, b: LM.RIGHT_SHOULDER, c: LM.RIGHT_HIP, d: LM.LEFT_HIP, weight: 0.24 },

  { kind: SEG_KIND.CAPSULE, a: LM.LEFT_SHOULDER,  b: LM.LEFT_ELBOW,  r0: 0.16, r1: 0.12, weight: 0.055 },
  { kind: SEG_KIND.CAPSULE, a: LM.LEFT_ELBOW,      b: LM.LEFT_WRIST,  r0: 0.12, r1: 0.095, weight: 0.045 },
  { kind: SEG_KIND.CLUSTER, a: ANCHOR.L_HAND, b: -1, r0: 0.14, r1: 0.14, weight: 0.02 },

  { kind: SEG_KIND.CAPSULE, a: LM.RIGHT_SHOULDER, b: LM.RIGHT_ELBOW, r0: 0.16, r1: 0.12, weight: 0.055 },
  { kind: SEG_KIND.CAPSULE, a: LM.RIGHT_ELBOW,     b: LM.RIGHT_WRIST, r0: 0.12, r1: 0.095, weight: 0.045 },
  { kind: SEG_KIND.CLUSTER, a: ANCHOR.R_HAND, b: -1, r0: 0.14, r1: 0.14, weight: 0.02 },

  { kind: SEG_KIND.CAPSULE, a: LM.LEFT_HIP,   b: LM.LEFT_KNEE,  r0: 0.21, r1: 0.16, weight: 0.09 },
  { kind: SEG_KIND.CAPSULE, a: LM.LEFT_KNEE,   b: LM.LEFT_ANKLE, r0: 0.16, r1: 0.10, weight: 0.065 },
  { kind: SEG_KIND.CLUSTER, a: ANCHOR.L_FOOT, b: -1, r0: 0.15, r1: 0.15, weight: 0.03 },

  { kind: SEG_KIND.CAPSULE, a: LM.RIGHT_HIP,  b: LM.RIGHT_KNEE, r0: 0.21, r1: 0.16, weight: 0.09 },
  { kind: SEG_KIND.CAPSULE, a: LM.RIGHT_KNEE,  b: LM.RIGHT_ANKLE, r0: 0.16, r1: 0.10, weight: 0.065 },
  { kind: SEG_KIND.CLUSTER, a: ANCHOR.R_FOOT, b: -1, r0: 0.15, r1: 0.15, weight: 0.03 }
];

let segWeightSum = 0;
for (let s = 0; s < SEGMENTS.length; s++) segWeightSum += SEGMENTS[s].weight;

// Descriptores de slot: por burbuja i -> segmento, parámetro t, parámetro radial/angular
const slotSegment = new Uint8Array(MAX_BUBBLES);
const slotT       = new Float32Array(MAX_BUBBLES);
const slotA       = new Float32Array(MAX_BUBBLES); // radial (-1..1) o v (0..1) según el tipo
const slotJitter  = new Float32Array(MAX_BUBBLES); // pequeño ruido tangencial fijo

function buildSlots(count) {
  let cursor = 0;
  for (let s = 0; s < SEGMENTS.length; s++) {
    const isLast = (s === SEGMENTS.length - 1);
    let n = isLast ? (count - cursor) : Math.round((SEGMENTS[s].weight / segWeightSum) * count);
    n = Math.max(0, Math.min(n, count - cursor));
    for (let k = 0; k < n; k++) {
      const idx = cursor + k;
      slotSegment[idx] = s;
      slotT[idx] = weyl1D(idx + s * 977);
      slotA[idx] = (weyl2D(idx + s * 613) * 2) - 1;
      slotJitter[idx] = (hashNoise(idx * 5.11 + s) * 2 - 1) * 0.35;
    }
    cursor += n;
  }
  // Cualquier remanente (por redondeo) se asigna al último segmento válido
  for (let idx = cursor; idx < count; idx++) {
    slotSegment[idx] = SEGMENTS.length - 1;
    slotT[idx] = weyl1D(idx);
    slotA[idx] = (weyl2D(idx) * 2) - 1;
    slotJitter[idx] = 0;
  }
}

// Calcula target world-space para la burbuja i, escribe en targetX/targetY[i]. Sin allocaciones.
// nowSec anima una ondulación de superficie COHERENTE EN EL ESPACIO: depende de (t, rad),
// no del índice de la burbuja, así que burbujas vecinas del mismo segmento ondulan juntas,
// como una ola recorriendo la piel. Esto es lo que rompe la sensación de "geometría rígida":
// en vez de una cápsula/cuadrilátero perfectos y estáticos, la superficie respira y fluye.
function computeTargetFor(i, nowSec) {
  const segId = slotSegment[i];
  const seg = SEGMENTS[segId];
  const t = slotT[i];
  const rad = slotA[i];

  if (seg.kind === SEG_KIND.CAPSULE) {
    const sx = PX[seg.a], sy = PY[seg.a];
    const ex = PX[seg.b], ey = PY[seg.b];
    let dx = ex - sx, dy = ey - sy;
    let len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.0001) len = 0.0001;
    const nx = -dy / len, ny = dx / len;
    const tx = dx / len, ty = dy / len;

    const ripple = Math.sin(t * 6.0 + nowSec * 1.15 + segId * 2.3) * 0.16
                  + Math.sin(rad * 3.2 - nowSec * 0.8 + segId) * 0.12
                  + Math.sin(t * 13.7 - nowSec * 1.9 + segId * 4.1) * 0.06;
    // El jitter estático (fijo por burbuja) se suma también al radio, no solo tangencial:
    // así el borde del miembro deja de ser una línea perfectamente lisa y se ve difuso/
    // irregular, como piel o tejido en vez de un contorno matemático.
    const effRad = clamp(rad + ripple + slotJitter[i] * 0.16, -1.18, 1.18);

    const px = sx + dx * t;
    const py = sy + dy * t;
    // El propio radio "respira" a lo largo del miembro (misma onda para toda la
    // circunferencia local) evitando el cono perfectamente liso de una cápsula matemática.
    const rWobble = 1 + Math.sin(t * 8.0 - nowSec * 1.4 + segId * 1.7) * 0.05;
    const r = (seg.r0 + (seg.r1 - seg.r0) * t) * bodyScale * rWobble;
    targetX[i] = px + nx * effRad * r + tx * slotJitter[i] * r * 0.5;
    targetY[i] = py + ny * effRad * r + ty * slotJitter[i] * r * 0.5;

  } else if (seg.kind === SEG_KIND.QUAD) {
    // Torso/abdomen: en vez de interpolar directamente entre los 4 puntos proyectados
    // (lo cual colapsa a una línea cuando la persona está de perfil), se construye un eje
    // central vertical (hombros -> cadera) y se distribuye el ancho usando torsoHalfWidth,
    // que ya reconstruye el ancho real del cuerpo combinando X y Z. Así el torso conserva
    // volumen visible sin importar la orientación de la persona.
    const u = clamp(t * 1.08 - 0.04, -0.06, 1.06);          // a lo largo del torso (hombro->cadera)
    let v = clamp(rad * 1.15, -1.15, 1.15);                 // a lo ancho del torso (-1..1)

    const ripple = Math.sin(u * 5.0 + nowSec * 1.05) * 0.14
                 + Math.sin(v * 3.0 - nowSec * 0.75) * 0.11
                 + Math.sin(u * 11.3 - nowSec * 1.6) * 0.05;
    v = clamp(v + ripple + slotJitter[i] * 0.14, -1.3, 1.3);

    const topCx = (PX[seg.a] + PX[seg.b]) * 0.5;
    const topCy = (PY[seg.a] + PY[seg.b]) * 0.5;
    const botCx = (PX[seg.d] + PX[seg.c]) * 0.5;
    const botCy = (PY[seg.d] + PY[seg.c]) * 0.5;

    const cx = lerp(topCx, botCx, u);
    const cy = lerp(topCy, botCy, u);

    let axDx = botCx - topCx, axDy = botCy - topCy;
    const axLen = Math.sqrt(axDx * axDx + axDy * axDy) || 1;
    const sideX = -axDy / axLen, sideY = axDx / axLen; // perpendicular al eje del torso

    const width = torsoHalfWidth * (0.92 + 0.16 * Math.sin(u * Math.PI)); // ligeramente más ancho al centro (pecho)
    targetX[i] = cx + sideX * v * width + sideX * slotJitter[i] * width * 0.12;
    targetY[i] = cy + sideY * v * width + sideY * slotJitter[i] * width * 0.12;

  } else if (seg.kind === SEG_KIND.CLUSTER) {
    const cx = PX[seg.a], cy = PY[seg.a];
    const r = seg.r0 * bodyScale * Math.sqrt(t);
    const ang = rad * Math.PI * 2 + slotJitter[i] + Math.sin(nowSec * 0.7 + t * 5) * 0.14;
    targetX[i] = cx + Math.cos(ang) * r;
    targetY[i] = cy + Math.sin(ang) * r;

  } else { // SPHERE (cabeza)
    const cx = PX[seg.a], cy = PY[seg.a];
    const r = seg.r0 * bodyScale * Math.sqrt(t);
    const ang = rad * Math.PI * 2 + slotJitter[i] + Math.sin(nowSec * 0.6 + t * 4.5) * 0.12;
    targetX[i] = cx + Math.cos(ang) * r;
    targetY[i] = cy + Math.sin(ang) * r * 1.12;
  }
}

/* =====================================================================================
   5b. FORMACIÓN DE TEXTO "SENATI" (estado sin persona detectada)
   ===================================================================================== */

// Puntos candidatos (silueta del texto) generados UNA sola vez con un canvas fuera de
// pantalla. No se recalculan por frame: solo cuando cambia el tamaño del stage.
let textCandidatesX = [];
let textCandidatesY = [];

function generateTextCandidates() {
  const w = Math.max(200, Math.floor(runtime.stageW));
  const h = Math.max(150, Math.floor(runtime.stageH));

  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.clearRect(0, 0, w, h);
  octx.fillStyle = '#ffffff';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';

  const fontSize = Math.round(w * 0.115);
  octx.font = '900 ' + fontSize + 'px "Segoe UI", Arial, sans-serif';
  octx.fillText('SENATI', w / 2, h / 2);

  const img = octx.getImageData(0, 0, w, h).data;
  // Muestreo fino: antes se usaba un paso grande (~w/260) que dejaba muy pocos candidatos
  // por letra, así que la asignación de burbujas dejaba huecos visibles en los trazos.
  // Con un paso más fino hay muchos más candidatos que burbujas, lo que permite repartirlas
  // de forma pareja (ver buildTextSlots) y que las letras salgan completas y definidas.
  const step = Math.max(1, Math.round(w / 700));

  const candX = [];
  const candY = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const idx = (y * w + x) * 4;
      if (img[idx + 3] > 120) { candX.push(x); candY.push(y); }
    }
  }
  textCandidatesX = candX;
  textCandidatesY = candY;
}

const textTargetX = new Float32Array(MAX_BUBBLES);
const textTargetY = new Float32Array(MAX_BUBBLES);

function buildTextSlots(count) {
  const n = textCandidatesX.length;
  if (n === 0) {
    for (let i = 0; i < count; i++) {
      textTargetX[i] = runtime.stageW * 0.5;
      textTargetY[i] = runtime.stageH * 0.5;
    }
    return;
  }
  // Muestreo estratificado: divide la lista de candidatos (ordenada por barrido de imagen,
  // por lo que índices consecutivos caen en zonas espacialmente cercanas) en "count" tramos
  // iguales y toma un candidato dentro de cada tramo. Esto GARANTIZA cobertura uniforme de
  // principio a fin del texto (a diferencia del hash anterior, que con más burbujas que
  // huecos podía dejar candidatos sin asignar y aparecer como huecos en las letras).
  // Dentro de cada tramo se sigue usando una secuencia de Weyl para variar cuál candidato
  // exacto se toma, evitando un patrón demasiado regular tipo rejilla.
  const step = n / count;
  for (let i = 0; i < count; i++) {
    const segStart = i * step;
    const idx = Math.min(n - 1, Math.floor(segStart + weyl1D(i * 0.6180339887 + 0.5) * step));
    // Pequeño jitter espacial (en píxeles de pantalla) para que el borde de las letras no
    // se vea como una rejilla perfecta de puntos, sino con un contorno suave/orgánico.
    const jx = (hashNoise(i * 5.19) - 0.5) * 3.2;
    const jy = (hashNoise(i * 7.83 + 1) - 0.5) * 3.2;
    textTargetX[i] = textCandidatesX[idx] + jx;
    textTargetY[i] = textCandidatesY[idx] + jy;
  }
}

/* =====================================================================================
   6. TRACKING (MEDIAPIPE POSE) + SUAVIZADO + INTERPOLACIÓN
   ===================================================================================== */

let pose = null;
let mpCamera = null;

function initPose() {
  pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`
  });
  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6
  });
  pose.onResults(onPoseResults);
}

// Objetos reutilizados para transformar landmarks clave sin crear basura por frame
const _tmpHip = { x: 0, y: 0 };
const _tmpHip2 = { x: 0, y: 0 };
const _tmpSh1 = { x: 0, y: 0 };
const _tmpSh2 = { x: 0, y: 0 };

function transformLandmark(lm, out) {
  let x = CONFIG.mirror ? (1 - lm.x) : lm.x;
  x *= runtime.stageW;
  let y = lm.y * runtime.stageH;
  if (CONFIG.useCalibration && runtime.calibMatrix) {
    applyHomography(x, y, runtime.calibMatrix, _tmpHomo);
    x = _tmpHomo.x; y = _tmpHomo.y;
  }
  out.x = x; out.y = y;
}

// Cuenta un frame sin persona confirmada. Tras ~90 frames seguidos (varios segundos)
// se libera el bloqueo de identidad, para no quedar "congelados" si la persona se fue de verdad.
function registerMismatch() {
  runtime.mismatchFrames++;
  if (runtime.mismatchFrames > 90) {
    runtime.locked = false;
    runtime.mismatchFrames = 0;
  }
}

function onPoseResults(results) {
  const now = performance.now();
  runtime.poseLatencyMs = now - runtime.lastSendTimestamp;
  runtime.lastPoseTimestamp = now;

  const lms = results.poseLandmarks;
  const hasPerson = lms && lms.length === NUM_LANDMARKS;

  let presence = 0;
  if (hasPerson) {
    presence = (
      lms[LM.LEFT_SHOULDER].visibility + lms[LM.RIGHT_SHOULDER].visibility +
      lms[LM.LEFT_HIP].visibility + lms[LM.RIGHT_HIP].visibility
    ) / 4;
  }

  if (!hasPerson || presence <= 0.5) {
    runtime.landmarksVisible = 0;
    runtime.personPresent = false;
    registerMismatch();
    return;
  }

  // Referencia espacial de esta detección (centro de cadera + ancho de hombros)
  transformLandmark(lms[LM.LEFT_HIP], _tmpHip);
  transformLandmark(lms[LM.RIGHT_HIP], _tmpHip2);
  const hipMidX = (_tmpHip.x + _tmpHip2.x) * 0.5;
  const hipMidY = (_tmpHip.y + _tmpHip2.y) * 0.5;
  transformLandmark(lms[LM.LEFT_SHOULDER], _tmpSh1);
  transformLandmark(lms[LM.RIGHT_SHOULDER], _tmpSh2);
  const shDist = Math.hypot(_tmpSh2.x - _tmpSh1.x, _tmpSh2.y - _tmpSh1.y) || bodyScale;

  // --- Bloqueo de identidad ---
  // Si ya se estaba siguiendo a alguien y esta detección aparece "de golpe" muy lejos de
  // donde estaba (típico de otra persona cruzando por delante o por detrás), se ignora esta
  // detección y se conserva la pose anterior, en vez de saltar a seguir a la persona nueva.
  if (runtime.locked) {
    const jump = Math.hypot(hipMidX - runtime.lockedHipX, hipMidY - runtime.lockedHipY);
    const threshold = Math.max(runtime.lockedScale * 1.8, 140);
    if (jump > threshold) {
      registerMismatch();
      if (runtime.locked) return; // seguimos dentro de la ventana de tolerancia: se ignora este frame
    }
  }

  runtime.mismatchFrames = 0;
  runtime.locked = true;
  runtime.lockedHipX = hipMidX;
  runtime.lockedHipY = hipMidY;
  runtime.lockedScale = shDist;

  let visibleCount = 0;
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const lm = lms[i];
    const vis = (lm.visibility === undefined) ? 1 : lm.visibility;
    landmarkConfidence[i] = landmarkConfidence[i] * 0.7 + vis * 0.3;

    // Solo se congela el punto ante oclusión casi total. Cualquier confianza mayor
    // sigue actualizando la posición (el suavizado ya se encarga de filtrar el ruido).
    if (vis > 0.1) {
      let x = CONFIG.mirror ? (1 - lm.x) : lm.x;
      x *= runtime.stageW;
      let y = lm.y * runtime.stageH;
      if (CONFIG.useCalibration && runtime.calibMatrix) {
        applyHomography(x, y, runtime.calibMatrix, _tmpHomo);
        x = _tmpHomo.x; y = _tmpHomo.y;
      }
      rawX[i] = x; rawY[i] = y;
      rawZ[i] = lm.z || 0;
      rawVisible[i] = 1;
    } else {
      rawVisible[i] = 0;
    }
    if (vis > 0.5) visibleCount++;
  }
  runtime.landmarksVisible = visibleCount;

  if (!poseInitialized) primeSmoothedFromRaw();
  runtime.personPresent = true;
}

async function startCamera() {
  const videoEl = document.getElementById('input-video');
  try {
    if (!mpCamera) {
      mpCamera = new Camera(videoEl, {
        onFrame: async () => {
          runtime.lastSendTimestamp = performance.now();
          await pose.send({ image: videoEl });
        },
        width: 960,
        height: 720
      });
    }
    await mpCamera.start();
    runtime.cameraActive = true;
    setSystemState(SYS.DETECTING);
    document.getElementById('btn-camera').textContent = 'Detener cámara';
    document.getElementById('btn-camera').classList.add('active');
  } catch (err) {
    console.error('No se pudo iniciar la cámara:', err);
    alert('No se pudo acceder a la cámara. Revisa los permisos del navegador.');
  }
}

function stopCamera() {
  if (mpCamera) mpCamera.stop();
  runtime.cameraActive = false;
  runtime.personPresent = false;
  runtime.locked = false;
  runtime.mismatchFrames = 0;
  setSystemState(SYS.OFF);
  document.getElementById('btn-camera').textContent = 'Iniciar cámara';
  document.getElementById('btn-camera').classList.remove('active');
}

/* =====================================================================================
   7. CALIBRACIÓN DE PARED (HOMOGRAFÍA 4 PUNTOS)
   ===================================================================================== */

// Resuelve el sistema lineal 8x8 (A·h = b) por eliminación gaussiana con pivoteo parcial.
function solve8x8(A, b) {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let maxVal = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r][col]);
      if (v > maxVal) { maxVal = v; pivot = r; }
    }
    if (pivot !== col) {
      const tmpRow = A[col]; A[col] = A[pivot]; A[pivot] = tmpRow;
      const tmpB = b[col]; b[col] = b[pivot]; b[pivot] = tmpB;
    }
    const diag = A[col][col] || 1e-9;
    for (let r = col + 1; r < n; r++) {
      const factor = A[r][col] / diag;
      for (let c = col; c < n; c++) A[r][c] -= factor * A[col][c];
      b[r] -= factor * b[col];
    }
  }
  const h = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= A[r][c] * h[c];
    h[r] = sum / (A[r][r] || 1e-9);
  }
  return h;
}

function computeHomography(src, dst) {
  // src, dst: arrays de 4 puntos [{x,y}, ...]
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i].x, sy = src[i].y;
    const dx = dst[i].x, dy = dst[i].y;
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]); b.push(dy);
  }
  const h = solve8x8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function applyHomography(x, y, H, out) {
  const w = H[6] * x + H[7] * y + H[8];
  const safeW = Math.abs(w) < 1e-9 ? 1e-9 : w;
  out.x = (H[0] * x + H[1] * y + H[2]) / safeW;
  out.y = (H[3] * x + H[4] * y + H[5]) / safeW;
}

function startCalibration() {
  runtime.calibrating = true;
  runtime.calibClicks = 0;
  setSystemState(SYS.CALIBRATING);
  const calibCanvas = document.getElementById('calib-canvas');
  calibCanvas.style.pointerEvents = 'auto';
  document.getElementById('btn-calibrate').classList.add('active');
  document.getElementById('calib-hint').textContent = 'Haz clic en las 4 esquinas de la pared (sentido horario, empezando arriba-izquierda).';
  drawCalibOverlay();
}

function handleCalibClick(evt) {
  if (!runtime.calibrating) return;
  const rect = evt.target.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  const idx = runtime.calibClicks * 2;
  runtime.calibSrcPoints[idx] = x;
  runtime.calibSrcPoints[idx + 1] = y;
  runtime.calibClicks++;
  drawCalibOverlay();

  if (runtime.calibClicks >= 4) {
    finishCalibration();
  }
}

function finishCalibration() {
  const s = runtime.calibSrcPoints;
  const src = [
    { x: s[0], y: s[1] }, { x: s[2], y: s[3] },
    { x: s[4], y: s[5] }, { x: s[6], y: s[7] }
  ];
  const w = runtime.stageW, h = runtime.stageH;
  const dst = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  runtime.calibMatrix = computeHomography(src, dst);
  runtime.calibrating = false;

  const calibCanvas = document.getElementById('calib-canvas');
  calibCanvas.style.pointerEvents = 'none';
  document.getElementById('btn-calibrate').classList.remove('active');
  document.getElementById('calib-hint').textContent = 'Calibración guardada correctamente.';

  try {
    localStorage.setItem('bubbleBodyCalibration', JSON.stringify(Array.from(s)));
  } catch (e) { /* almacenamiento no disponible, se ignora */ }

  const ctx = calibCanvas.getContext('2d');
  ctx.clearRect(0, 0, calibCanvas.width, calibCanvas.height);
  setSystemState(runtime.cameraActive ? (runtime.personPresent ? SYS.DETECTED : SYS.DETECTING) : SYS.OFF);
}

function loadStoredCalibration() {
  try {
    const raw = localStorage.getItem('bubbleBodyCalibration');
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 8) return;
    for (let i = 0; i < 8; i++) runtime.calibSrcPoints[i] = arr[i];
    const src = [
      { x: arr[0], y: arr[1] }, { x: arr[2], y: arr[3] },
      { x: arr[4], y: arr[5] }, { x: arr[6], y: arr[7] }
    ];
    const w = runtime.stageW, h = runtime.stageH;
    const dst = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    runtime.calibMatrix = computeHomography(src, dst);
    document.getElementById('calib-hint').textContent = 'Calibración cargada desde almacenamiento local.';
  } catch (e) { /* ignorar */ }
}

function drawCalibOverlay() {
  const calibCanvas = document.getElementById('calib-canvas');
  const ctx = calibCanvas.getContext('2d');
  ctx.clearRect(0, 0, calibCanvas.width, calibCanvas.height);
  ctx.strokeStyle = '#5ad8ff';
  ctx.fillStyle = '#5ad8ff';
  ctx.lineWidth = 2;
  ctx.font = '13px monospace';

  for (let i = 0; i < runtime.calibClicks; i++) {
    const x = runtime.calibSrcPoints[i * 2];
    const y = runtime.calibSrcPoints[i * 2 + 1];
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, TWO_PI);
    ctx.fill();
    ctx.fillText(String(i + 1), x + 10, y - 10);
  }
  if (runtime.calibClicks > 1) {
    ctx.beginPath();
    ctx.moveTo(runtime.calibSrcPoints[0], runtime.calibSrcPoints[1]);
    for (let i = 1; i < runtime.calibClicks; i++) {
      ctx.lineTo(runtime.calibSrcPoints[i * 2], runtime.calibSrcPoints[i * 2 + 1]);
    }
    ctx.stroke();
  }
}

/* =====================================================================================
   8. RENDER (CANVAS 2D)
   ===================================================================================== */

const mainCanvas = document.getElementById('main-canvas');
const mainCtx = mainCanvas.getContext('2d');
const bgCanvas = document.getElementById('bg-canvas');
const bgCtx = bgCanvas.getContext('2d');
const videoEl = document.getElementById('input-video');

function resizeCanvases() {
  const stage = document.getElementById('stage');
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  runtime.stageW = rect.width;
  runtime.stageH = rect.height;

  for (const c of [mainCanvas, bgCanvas, document.getElementById('calib-canvas')]) {
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    c.style.width = rect.width + 'px';
    c.style.height = rect.height + 'px';
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  buildWalls(rect.width, rect.height);
}

function renderScene() {
  mainCtx.clearRect(0, 0, runtime.stageW, runtime.stageH);

  // Fondo de cámara (opcional)
  if (CONFIG.showBackground && runtime.cameraActive) {
    bgCtx.save();
    if (CONFIG.mirror) {
      bgCtx.translate(runtime.stageW, 0);
      bgCtx.scale(-1, 1);
    }
    bgCtx.clearRect(0, 0, runtime.stageW, runtime.stageH);
    bgCtx.drawImage(videoEl, 0, 0, runtime.stageW, runtime.stageH);
    bgCtx.restore();
    bgCanvas.style.display = 'block';
  } else {
    bgCanvas.style.display = 'none';
  }

  // Burbujas
  const count = runtime.activeBubbleCount;
  if (CONFIG.colorMode === 'multicolor') {
    for (let i = 0; i < count; i++) {
      const body = bubbles[i];
      mainCtx.globalAlpha = visualAlpha[i];
      mainCtx.fillStyle = bubbleColorCache[i];
      mainCtx.beginPath();
      mainCtx.arc(body.position.x, body.position.y, body.circleRadius, 0, TWO_PI);
      mainCtx.fill();
    }
  } else {
    mainCtx.fillStyle = currentSolidColor();
    for (let i = 0; i < count; i++) {
      const body = bubbles[i];
      mainCtx.globalAlpha = visualAlpha[i];
      mainCtx.beginPath();
      mainCtx.arc(body.position.x, body.position.y, body.circleRadius, 0, TWO_PI);
      mainCtx.fill();
    }
  }
  mainCtx.globalAlpha = 1;

  // Esqueleto de referencia
  if (CONFIG.showSkeleton && runtime.personPresent) {
    mainCtx.strokeStyle = 'rgba(255,180,84,0.85)';
    mainCtx.lineWidth = 2;
    mainCtx.beginPath();
    for (let c = 0; c < POSE_CONNECTIONS.length; c++) {
      const pair = POSE_CONNECTIONS[c];
      mainCtx.moveTo(PX[pair[0]], PY[pair[0]]);
      mainCtx.lineTo(PX[pair[1]], PY[pair[1]]);
    }
    mainCtx.stroke();

    mainCtx.fillStyle = 'rgba(255,180,84,0.9)';
    for (let i = 0; i < NUM_LANDMARKS; i++) {
      mainCtx.beginPath();
      mainCtx.arc(PX[i], PY[i], 3, 0, TWO_PI);
      mainCtx.fill();
    }
  }
}

/* =====================================================================================
   9. TELEMETRÍA
   ===================================================================================== */

const tmState = document.getElementById('tm-state');
const tmFps = document.getElementById('tm-fps');
const tmLatency = document.getElementById('tm-latency');
const tmBubbles = document.getElementById('tm-bubbles');
const tmLandmarks = document.getElementById('tm-landmarks');

const STATE_LABEL = {
  off: 'CÁMARA APAGADA',
  detecting: 'DETECTANDO CUERPO',
  detected: 'CUERPO DETECTADO',
  calibrating: 'CALIBRANDO'
};
const STATE_CLASS = {
  off: 'state-off', detecting: 'state-detecting',
  detected: 'state-detected', calibrating: 'state-calibrating'
};

function setSystemState(state) {
  if (runtime.systemState === state) return;
  runtime.systemState = state;
  tmState.textContent = STATE_LABEL[state];
  tmState.className = 'telemetry-value ' + STATE_CLASS[state];
}

let telemetryAccum = 0;
function updateTelemetry(dtMs) {
  telemetryAccum += dtMs;
  if (telemetryAccum < 250) return;
  telemetryAccum = 0;
  tmFps.textContent = Math.round(runtime.fps).toString();
  tmLatency.textContent = Math.max(0, Math.round(runtime.poseLatencyMs)) + ' ms';
  tmBubbles.textContent = runtime.activeBubbleCount.toString();
  tmLandmarks.textContent = runtime.landmarksVisible + ' / 33';
}

/* =====================================================================================
   10. UI / BINDINGS DEL PANEL
   ===================================================================================== */

function bindUI() {
  document.getElementById('btn-camera').addEventListener('click', () => {
    if (runtime.cameraActive) stopCamera(); else startCamera();
  });

  document.getElementById('btn-regen').addEventListener('click', () => {
    for (let i = 0; i < runtime.activeBubbleCount; i++) {
      const p = spawnNearCenter(i, 17);
      Body.setPosition(bubbles[i], { x: p.x, y: p.y });
      Body.setVelocity(bubbles[i], { x: 0, y: 0 });
    }
    buildSlots(runtime.activeBubbleCount);
  });

  document.getElementById('btn-calibrate').addEventListener('click', startCalibration);

  document.getElementById('btn-toggle-bg').addEventListener('click', () => {
    CONFIG.showBackground = !CONFIG.showBackground;
    document.getElementById('btn-toggle-bg').classList.toggle('active', CONFIG.showBackground);
    document.getElementById('stage').classList.toggle('bg-transparent', !CONFIG.showBackground);
  });

  document.getElementById('calib-canvas').addEventListener('click', handleCalibClick);

  const count = document.getElementById('ctl-count');
  count.addEventListener('input', () => {
    document.getElementById('val-count').textContent = count.value;
    setActiveBubbleCount(parseInt(count.value, 10));
  });

  const size = document.getElementById('ctl-size');
  size.addEventListener('input', () => {
    document.getElementById('val-size').textContent = parseFloat(size.value).toFixed(1);
    setBubbleSize(parseFloat(size.value));
  });

  const adhesion = document.getElementById('ctl-adhesion');
  adhesion.addEventListener('input', () => {
    document.getElementById('val-adhesion').textContent = parseFloat(adhesion.value).toFixed(2);
    CONFIG.adhesion = parseFloat(adhesion.value);
  });

  const smooth = document.getElementById('ctl-smooth');
  smooth.addEventListener('input', () => {
    document.getElementById('val-smooth').textContent = parseFloat(smooth.value).toFixed(2);
    CONFIG.smoothing = parseFloat(smooth.value);
  });

  const arrival = document.getElementById('ctl-arrival');
  arrival.addEventListener('input', () => {
    document.getElementById('val-arrival').textContent = parseFloat(arrival.value).toFixed(2);
    CONFIG.arrivalSpeed = parseFloat(arrival.value);
  });

  const bounce = document.getElementById('ctl-bounce');
  bounce.addEventListener('input', () => {
    document.getElementById('val-bounce').textContent = parseFloat(bounce.value).toFixed(2);
    setBounce(parseFloat(bounce.value));
  });

  const floatCtl = document.getElementById('ctl-float');
  floatCtl.addEventListener('input', () => {
    document.getElementById('val-float').textContent = parseFloat(floatCtl.value).toFixed(2);
    CONFIG.floatStrength = parseFloat(floatCtl.value);
  });

  document.getElementById('ctl-distmode').addEventListener('change', (e) => {
    CONFIG.distMode = e.target.value;
  });

  const colorModeSel = document.getElementById('ctl-colormode');
  const customColorField = document.getElementById('field-custom-color');
  colorModeSel.addEventListener('change', (e) => {
    CONFIG.colorMode = e.target.value;
    customColorField.style.display = (CONFIG.colorMode === 'custom') ? '' : 'none';
    if (CONFIG.colorMode === 'multicolor') rebuildColorCache();
  });
  customColorField.style.display = (CONFIG.colorMode === 'custom') ? '' : 'none';

  document.getElementById('ctl-color').addEventListener('input', (e) => {
    CONFIG.color = e.target.value;
  });

  document.getElementById('ctl-skeleton').addEventListener('change', (e) => {
    CONFIG.showSkeleton = e.target.checked;
  });

  document.getElementById('ctl-mirror').addEventListener('change', (e) => {
    CONFIG.mirror = e.target.checked;
  });

  document.getElementById('ctl-usecalib').addEventListener('change', (e) => {
    if (e.target.checked && !runtime.calibMatrix) {
      alert('Aún no hay una calibración guardada. Usa "Calibrar pared" primero.');
      e.target.checked = false;
      return;
    }
    CONFIG.useCalibration = e.target.checked;
  });

  window.addEventListener('resize', () => {
    resizeCanvases();
    generateTextCandidates();
    buildTextSlots(runtime.activeBubbleCount);
  });

  // Tecla H: oculta/muestra el panel de configuración y el HUD de telemetría, dejando el
  // escenario a pantalla completa (útil para proyección/grabación limpia). Se ignora si el
  // foco está sobre un control del formulario, para no interferir con su uso normal.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'h' && e.key !== 'H') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    document.body.classList.toggle('ui-hidden');
    resizeCanvases();
    generateTextCandidates();
    buildTextSlots(runtime.activeBubbleCount);
  });
}

/* =====================================================================================
   11. BUCLE PRINCIPAL
   ===================================================================================== */

let lastFrameTime = 0;

function freeFloatStep(dtSec) {
  const centerX = runtime.stageW * 0.5;
  const centerY = runtime.stageH * 0.5;
  const count = runtime.activeBubbleCount;
  // Radio "cómodo" alrededor del centro: más allá de esto, el tirón de regreso se refuerza
  // para que ningún modo termine pegando las burbujas contra los bordes del stage.
  const leashRadius = Math.min(runtime.stageW, runtime.stageH) * 0.34;

  for (let i = 0; i < count; i++) {
    const body = bubbles[i];

    wanderAngle[i] += (hashNoise(i * 91.7 + lastFrameTime * 0.0002) - 0.5) * 0.22;

    let fx = Math.cos(wanderAngle[i]) * CONFIG.floatStrength * 0.00085 * wanderSpeed[i];
    let fy = Math.sin(wanderAngle[i]) * CONFIG.floatStrength * 0.00085 * wanderSpeed[i];
    fy -= CONFIG.floatStrength * 0.00022; // flotación ascendente, más perceptible

    const dx = centerX - body.position.x;
    const dy = centerY - body.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy) + 0.0001;

    // Tirón base hacia el centro: siempre presente, para que la nube de burbujas
    // "libres" viva agrupada en el medio del stage en vez de esparcirse por toda el área.
    fx += dx * 0.0000016;
    fy += dy * 0.0000016;

    if (CONFIG.distMode === 'cluster') {
      fx += dx * 0.0000045;
      fy += dy * 0.0000045;
    } else if (CONFIG.distMode === 'disperse') {
      const invDist = 1 / dist;
      fx -= dx * invDist * 0.00006;
      fy -= dy * invDist * 0.00006;
    }

    // Correa suave: más allá del radio cómodo, refuerza el regreso al centro
    // independientemente del modo, evitando fugas hacia los bordes.
    if (dist > leashRadius) {
      const over = dist - leashRadius;
      fx += (dx / dist) * over * 0.000006;
      fy += (dy / dist) * over * 0.000006;
    }

    body.force.x += fx;
    body.force.y += fy;
  }
}

function attachedStep(nowSec) {
  const count = runtime.activeBubbleCount;
  const baseSpeed = CONFIG.arrivalSpeed * (0.4 + CONFIG.adhesion * 0.6);
  const dtSecInv = 60; // referencia estable de 60fps para el cálculo de velocidad aparente

  // Amplitud de una respiración orgánica: mantiene el sistema vivo aunque la persona esté
  // quieta, sin romper la coherencia de la silueta (escala con bodyScale). Se subió el piso
  // para que el efecto se note incluso con floatStrength bajo.
  const breathAmp = 0.012 + CONFIG.floatStrength * 0.024;

  // ¿Seguimos dentro de la ventana de la cascada de integración? Se calcula una sola vez
  // por frame (no por burbuja) para poder saltarnos todo el trabajo extra en cuanto termina.
  const sinceMode = nowSec - runtime.modeStartTime;
  const cascadeActive = sinceMode < (CASCADE_WINDOW + ARRIVAL_RAMP);

  for (let i = 0; i < count; i++) {
    computeTargetFor(i, nowSec);

    targetX[i] += Math.sin(nowSec * breathFreqA[i] + breathPhaseA[i]) * bodyScale * breathAmp;
    targetY[i] += Math.cos(nowSec * breathFreqB[i] + breathPhaseB[i]) * bodyScale * breathAmp;

    // Micro-deriva continua (comparte el ángulo de "wander" del modo libre): añade un
    // temblor sutil y desincronizado por burbuja para que la silueta nunca se sienta
    // perfectamente rígida, sin desestabilizar la forma general del cuerpo.
    wanderAngle[i] += (hashNoise(i * 91.7 + nowSec * 13.7) - 0.5) * 0.18;
    targetX[i] += Math.cos(wanderAngle[i]) * bodyScale * 0.006 * wanderSpeed[i];
    targetY[i] += Math.sin(wanderAngle[i]) * bodyScale * 0.006 * wanderSpeed[i];

    // Velocidad de llegada propia por burbuja (0.7x .. 1.5x aprox) para que el enjambre no
    // se mueva "en bloque": cada burbuja converge a un ritmo ligeramente distinto.
    let speed = baseSpeed * (0.7 + wanderSpeed[i] * 0.55);

    let destX = targetX[i];
    let destY = targetY[i];

    // Órbita residual PERMANENTE (no se apaga nunca a 0, solo se encoge): incluso mucho
    // después de que la burbuja "llegó" a su lugar, sigue trazando una pequeña espiral
    // alrededor de su posición ideal. Esto es lo que evita que el enjambre se vea
    // congelado una vez formada la silueta: siempre hay un leve baile residual.
    const idleOrbitAmt = 3.5 + bodyScale * 0.018;
    const idleAngle = wanderAngle[i] * 1.7 + nowSec * 1.4 + formationDelay[i] * TWO_PI;
    destX += Math.cos(idleAngle) * idleOrbitAmt;
    destY += Math.sin(idleAngle) * idleOrbitAmt * 0.85;

    if (cascadeActive) {
      // Disparo escalonado: la burbuja i "despierta" en sinceMode == formationDelay[i]*CASCADE_WINDOW
      // y tarda ARRIVAL_RAMP segundos en llegar a su velocidad plena.
      const localT = clamp((sinceMode - formationDelay[i] * CASCADE_WINDOW) / ARRIVAL_RAMP, 0, 1);
      const eased = easeOutCubic(localT);

      // En vez de volar en línea recta hacia el target (lo que se lee como "encajar en
      // un molde rígido"), cada burbuja orbita alrededor de su destino con un radio que
      // se va cerrando a medida que eased -> 1. El resultado es una espiral que converge
      // y se asienta suavemente, como partículas de humo o líquido coalesciendo, en vez
      // de piezas de un rompecabezas encajando de golpe.
      const orbitAmt = (1 - eased) * (bodyScale * 0.22 + 22);
      const orbitAngle = wanderAngle[i] * 2.4 + nowSec * 2.1 + formationDelay[i] * TWO_PI;
      destX += Math.cos(orbitAngle) * orbitAmt;
      destY += Math.sin(orbitAngle) * orbitAmt * 0.8;

      speed *= 0.16 + eased * 0.84;
    }

    const body = bubbles[i];
    const curX = body.position.x, curY = body.position.y;
    const nx = curX + (destX - curX) * speed;
    const ny = curY + (destY - curY) * speed;

    _tmpPos.x = nx; _tmpPos.y = ny;
    Body.setPosition(body, _tmpPos);

    _tmpVel.x = (nx - curX) * dtSecInv * 0.016;
    _tmpVel.y = (ny - curY) * dtSecInv * 0.016;
    Body.setVelocity(body, _tmpVel);
  }
}

function textFormStep(nowSec) {
  const count = runtime.activeBubbleCount;
  const baseSpeed = CONFIG.arrivalSpeed * 0.85;

  const sinceMode = nowSec - runtime.modeStartTime;
  const cascadeActive = sinceMode < (CASCADE_WINDOW + ARRIVAL_RAMP);

  for (let i = 0; i < count; i++) {
    let destX = textTargetX[i] + Math.sin(nowSec * 1.5 + textPhaseA[i]) * 9;
    let destY = textTargetY[i] + Math.cos(nowSec * 1.2 + textPhaseB[i]) * 9;

    let speed = baseSpeed * (0.7 + wanderSpeed[i] * 0.55);

    const idleOrbitAmt = 2.5;
    const idleAngle = wanderAngle[i] * 1.7 + nowSec * 1.4 + formationDelay[i] * TWO_PI;
    destX += Math.cos(idleAngle) * idleOrbitAmt;
    destY += Math.sin(idleAngle) * idleOrbitAmt * 0.85;

    if (cascadeActive) {
      const localT = clamp((sinceMode - formationDelay[i] * CASCADE_WINDOW) / ARRIVAL_RAMP, 0, 1);
      const eased = easeOutCubic(localT);

      const orbitAmt = (1 - eased) * 60;
      const orbitAngle = wanderAngle[i] * 2.4 + nowSec * 2.1 + formationDelay[i] * TWO_PI;
      destX += Math.cos(orbitAngle) * orbitAmt;
      destY += Math.sin(orbitAngle) * orbitAmt * 0.8;

      speed *= 0.16 + eased * 0.84;
    }

    const body = bubbles[i];
    const curX = body.position.x, curY = body.position.y;
    const nx = curX + (destX - curX) * speed;
    const ny = curY + (destY - curY) * speed;

    _tmpPos.x = nx; _tmpPos.y = ny;
    Body.setPosition(body, _tmpPos);

    _tmpVel.x = (nx - curX) * 60 * 0.016;
    _tmpVel.y = (ny - curY) * 60 * 0.016;
    Body.setVelocity(body, _tmpVel);
  }
}

function mainLoop(now) {
  requestAnimationFrame(mainLoop);

  if (!lastFrameTime) lastFrameTime = now;
  let dtMs = now - lastFrameTime;
  if (dtMs > 60) dtMs = 60; // clamp para evitar saltos tras pestañas inactivas
  lastFrameTime = now;
  const dtSec = dtMs / 1000;

  runtime.fps = runtime.fps * 0.92 + (1000 / (dtMs || 16)) * 0.08;

  // Timeout de tracking: si no llegan resultados de pose, se considera persona ausente
  if (runtime.cameraActive && runtime.personPresent &&
      (now - runtime.lastPoseTimestamp) > POSE_TIMEOUT_MS) {
    runtime.personPresent = false;
  }

  if (poseInitialized) {
    updateSmoothedLandmarks();
    updateAnchors();
  }

  const nowSec = now / 1000;

  // Determina el modo de movimiento deseado para este frame y, si acaba de cambiar
  // respecto al frame anterior, relanza la cascada de integración (modeStartTime = ahora)
  // para que el nuevo destino se "arme" poco a poco en vez de saltar de golpe.
  let desiredMode;
  if (runtime.personPresent) {
    desiredMode = 'attached';
  } else if (!runtime.calibrating && CONFIG.distMode === 'text') {
    desiredMode = 'text';
  } else if (!runtime.calibrating) {
    desiredMode = 'free';
  } else {
    desiredMode = runtime.motionMode; // en calibración, no tocar el modo actual
  }
  if (desiredMode !== runtime.motionMode) {
    runtime.motionMode = desiredMode;
    runtime.modeStartTime = nowSec;
  }

  if (runtime.personPresent) {
    setSystemState(SYS.DETECTED);
    attachedStep(nowSec);
  } else if (runtime.cameraActive && !runtime.calibrating) {
    setSystemState(SYS.DETECTING);
    if (CONFIG.distMode === 'text') textFormStep(nowSec); else freeFloatStep(dtSec);
  } else if (!runtime.calibrating) {
    setSystemState(SYS.OFF);
    if (CONFIG.distMode === 'text') textFormStep(nowSec); else freeFloatStep(dtSec);
  }

  Engine.update(engine, dtMs);
  renderScene();
  updateTelemetry(dtMs);
}

/* =====================================================================================
   12. INICIALIZACIÓN
   ===================================================================================== */

function init() {
  resizeCanvases();
  document.getElementById('stage').classList.toggle('bg-transparent', !CONFIG.showBackground);
  initBubblePool();

  // Coloca todas las burbujas iniciales dispersas dentro del stage
  for (let i = 0; i < MAX_BUBBLES; i++) {
    const p = spawnNearCenter(i, 0);
    Body.setPosition(bubbles[i], { x: p.x, y: p.y });
  }

  generateTextCandidates();
  setActiveBubbleCount(CONFIG.bubbleCount);
  currentBubbleRadius = CONFIG.bubbleSize;

  loadStoredCalibration();
  initPose();
  bindUI();

  requestAnimationFrame(mainLoop);
}

window.addEventListener('DOMContentLoaded', init);
