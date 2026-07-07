const video = document.querySelector("#camera");
const inkCanvas = document.querySelector("#inkCanvas");
const recordCanvas = document.querySelector("#recordCanvas");
const startButton = document.querySelector("#startCamera");
const recordButton = document.querySelector("#recordToggle");
const clearButton = document.querySelector("#clearInk");
const undoButton = document.querySelector("#undoInk");
const flipButton = document.querySelector("#flipCamera");
const brushSize = document.querySelector("#brushSize");
const inkColor = document.querySelector("#inkColor");
const trailMode = document.querySelector("#trailMode");
const filterSelect = document.querySelector("#filterSelect");
const statusEl = document.querySelector("#status");
const cursor = document.querySelector("#cursor");
const preview = document.querySelector("#preview");
const downloadLink = document.querySelector("#downloadLink");
const savePanel = document.querySelector("#savePanel");

const ctx = inkCanvas.getContext("2d", { alpha: true });
const recordCtx = recordCanvas.getContext("2d", { alpha: false });

let stream = null;
let facingMode = "user";
let handLandmarker = null;
let lastVideoTime = -1;
let lastPoint = null;
let smoothedPoint = null;
let isDrawingByTouch = false;
let recorder = null;
let recordedChunks = [];
let animationFrame = null;
let lastGestureState = "";
let missedGestureFrames = 0;
let isPinching = false;
let drawingGestureFrames = 0;
const undoStack = [];
const maxUndoSteps = 30;

const filterMap = {
  none: "none",
  cinema: "contrast(1.12) saturate(0.92) sepia(0.14)",
  mono: "grayscale(1) contrast(1.18)",
  neon: "saturate(1.55) contrast(1.2) hue-rotate(305deg)",
  warm: "saturate(1.12) sepia(0.22) brightness(1.06)",
};

function setStatus(message) {
  statusEl.textContent = message;
}

function isLocalhost() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function canAskForCamera() {
  return window.isSecureContext || isLocalhost();
}

function cameraHelpMessage() {
  if (window.location.protocol === "file:") {
    return "现在像是直接双击打开了 HTML。请先启动本地服务，再用 http://localhost:5173 打开，否则摄像头和模型加载容易被拦。";
  }
  if (!("mediaDevices" in navigator) || !("getUserMedia" in navigator.mediaDevices)) {
    return "这个浏览器没有开放摄像头 API。请用新版 Chrome、Edge 或 Safari 打开。";
  }
  if (!canAskForCamera()) {
    return "摄像头被浏览器安全策略拦住了：请用 http://localhost 打开，或部署到 HTTPS 后再用手机访问。";
  }
  return "";
}

function resizeCanvases() {
  const rect = inkCanvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  for (const canvas of [inkCanvas, recordCanvas]) {
    const old = document.createElement("canvas");
    old.width = canvas.width;
    old.height = canvas.height;
    old.getContext("2d").drawImage(canvas, 0, 0);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const nextCtx = canvas.getContext("2d");
    nextCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (old.width && old.height && canvas === inkCanvas) {
      nextCtx.drawImage(old, 0, 0, rect.width, rect.height);
    }
  }
  undoStack.length = 0;
  updateUndoButton();
}

function updateUndoButton() {
  undoButton.disabled = undoStack.length === 0;
}

function captureUndoSnapshot() {
  if (!inkCanvas.width || !inkCanvas.height) return;
  undoStack.push(ctx.getImageData(0, 0, inkCanvas.width, inkCanvas.height));
  if (undoStack.length > maxUndoSteps) undoStack.shift();
  updateUndoButton();
}

function undoInk() {
  const snapshot = undoStack.pop();
  if (!snapshot) {
    setStatus("没有可以撤回的笔画。");
    return;
  }
  ctx.putImageData(snapshot, 0, 0);
  lastPoint = null;
  smoothedPoint = null;
  updateUndoButton();
  setStatus("已撤回上一笔。");
}

function clearInk() {
  captureUndoSnapshot();
  const rect = inkCanvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  lastPoint = null;
  smoothedPoint = null;
  missedGestureFrames = 0;
  isPinching = false;
  drawingGestureFrames = 0;
}

function drawPoint(point) {
  const rect = inkCanvas.getBoundingClientRect();
  const size = Number(brushSize.value);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = inkColor.value;
  ctx.lineWidth = size;
  ctx.shadowColor = trailMode.checked ? inkColor.value : "transparent";
  ctx.shadowBlur = trailMode.checked ? size * 1.8 : 0;

  if (!lastPoint) {
    captureUndoSnapshot();
    lastPoint = point;
    ctx.beginPath();
    ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = inkColor.value;
    ctx.fill();
    return;
  }

  const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
  if (distance > Math.min(rect.width, rect.height) * 0.24) {
    lastPoint = point;
    return;
  }

  ctx.beginPath();
  ctx.moveTo(lastPoint.x, lastPoint.y);
  const midX = (lastPoint.x + point.x) / 2;
  const midY = (lastPoint.y + point.y) / 2;
  ctx.quadraticCurveTo(midX, midY, point.x, point.y);
  ctx.stroke();
  lastPoint = point;
}

function resetAirStroke(force = false) {
  cursor.style.opacity = "0";
  cursor.classList.remove("is-drawing");
  if (!force && missedGestureFrames < 5) return;
  lastPoint = null;
  smoothedPoint = null;
  drawingGestureFrames = 0;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function screenDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isFingerCurled(landmarks, tip, dip, pip, mcp, relaxed = false) {
  const palmSize = screenDistance(landmarks[0], landmarks[9]);
  const tipToMcp = distance(landmarks[tip], landmarks[mcp]);
  const fingerLength =
    distance(landmarks[mcp], landmarks[pip]) +
    distance(landmarks[pip], landmarks[dip]) +
    distance(landmarks[dip], landmarks[tip]);
  const foldRatio = tipToMcp / Math.max(fingerLength, 0.001);
  const foldLimit = relaxed ? 0.86 : 0.74;
  const palmLimit = relaxed ? 0.82 : 0.68;
  return foldRatio < foldLimit && tipToMcp < palmSize * palmLimit;
}

function areWritingFingersCurled(landmarks, relaxed = false) {
  return (
    isFingerCurled(landmarks, 12, 11, 10, 9, relaxed) &&
    isFingerCurled(landmarks, 16, 15, 14, 13, relaxed) &&
    isFingerCurled(landmarks, 20, 19, 18, 17, relaxed)
  );
}

function isPinchClosed(landmarks, relaxed = false) {
  const pinchDistance = screenDistance(landmarks[4], landmarks[8]);
  const palmSize = screenDistance(landmarks[0], landmarks[9]);
  const indexTipToDip = screenDistance(landmarks[8], landmarks[7]);
  const pinchRatio = pinchDistance / Math.max(palmSize, 0.001);
  const fingertipRatio = pinchDistance / Math.max(indexTipToDip, 0.001);
  return relaxed
    ? pinchRatio < 0.38 && fingertipRatio < 1.35
    : pinchRatio < 0.26 && fingertipRatio < 0.92;
}

function updateDrawingGesture(landmarks) {
  const strictGesture = isPinchClosed(landmarks) && areWritingFingersCurled(landmarks);
  const relaxedGesture = isPinchClosed(landmarks, true) && areWritingFingersCurled(landmarks, true);
  drawingGestureFrames = strictGesture ? drawingGestureFrames + 1 : 0;
  if (!isPinching && drawingGestureFrames >= 3) isPinching = true;
  if (isPinching && !relaxedGesture) {
    isPinching = false;
    drawingGestureFrames = 0;
  }
  return isPinching;
}

function landmarkToPoint(landmark) {
  const rect = inkCanvas.getBoundingClientRect();
  const rawPoint = {
    x: rect.width - landmark.x * rect.width,
    y: landmark.y * rect.height,
  };

  if (!smoothedPoint) {
    smoothedPoint = rawPoint;
    return rawPoint;
  }

  const smoothing = 0.42;
  smoothedPoint = {
    x: smoothedPoint.x + (rawPoint.x - smoothedPoint.x) * smoothing,
    y: smoothedPoint.y + (rawPoint.y - smoothedPoint.y) * smoothing,
  };
  return smoothedPoint;
}

async function loadHandLandmarker() {
  if (handLandmarker) return handLandmarker;
  const vision = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/vision_bundle.mjs"
  );
  const fileset = await vision.FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm"
  );
  handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  return handLandmarker;
}

async function startCamera() {
  const help = cameraHelpMessage();
  if (help) {
    setStatus(help);
    return;
  }

  try {
    startButton.disabled = true;
    setStatus("正在启动摄像头和手势检测...");
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode,
        width: { ideal: 1280 },
        height: { ideal: 1920 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    resizeCanvases();
    setStatus("任何手势都可用食指定位；三指握拳并捏合拇指食指时落笔。");
    detectHands();
    loadHandLandmarker().catch(() => {
      setStatus("手势模型暂时没加载成功，仍可用触屏签名和录制。");
    });
  } catch (error) {
    if (error.name === "NotAllowedError") {
      setStatus("摄像头权限被拒绝了。请在浏览器地址栏/系统设置里允许此页面使用摄像头。");
    } else if (error.name === "NotFoundError") {
      setStatus("没有找到可用摄像头。请确认电脑或手机摄像头没有被其他软件占用。");
    } else {
      setStatus(`摄像头启动失败：${error.message}`);
    }
  } finally {
    startButton.disabled = false;
  }
}

function detectHands() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  const tick = async () => {
    if (video.readyState >= 2 && handLandmarker && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = handLandmarker.detectForVideo(video, performance.now());
      const landmarks = result.landmarks?.[0];
      if (landmarks) {
        missedGestureFrames = 0;
        const point = landmarkToPoint(landmarks[8]);
        cursor.style.left = `${point.x}px`;
        cursor.style.top = `${point.y}px`;
        cursor.style.opacity = "1";
        if (updateDrawingGesture(landmarks)) {
          cursor.classList.add("is-drawing");
          drawPoint(point);
          if (lastGestureState !== "drawing") {
            setStatus("正在签名：保持三指握拳，并捏合拇指和食指。");
            lastGestureState = "drawing";
          }
        } else {
          cursor.classList.remove("is-drawing");
          lastPoint = null;
          if (lastGestureState !== "aiming") {
            setStatus("食指正在定位；三指握拳并捏合时才会落笔。");
            lastGestureState = "aiming";
          }
        }
      } else {
        missedGestureFrames += 1;
        if (missedGestureFrames >= 5) {
          cursor.classList.remove("is-drawing");
          isPinching = false;
          resetAirStroke(true);
        }
        if (lastGestureState !== "idle") {
          setStatus("把手放进画面：食指定位，三指握拳并捏合落笔。");
          lastGestureState = "idle";
        }
      }
    }
    animationFrame = requestAnimationFrame(tick);
  };
  tick();
}

function touchPoint(event) {
  const rect = inkCanvas.getBoundingClientRect();
  const touch = event.touches?.[0] || event;
  return {
    x: touch.clientX - rect.left,
    y: touch.clientY - rect.top,
  };
}

function drawRecordFrame() {
  const rect = inkCanvas.getBoundingClientRect();
  recordCtx.save();
  recordCtx.filter = filterMap[filterSelect.value] || "none";
  recordCtx.translate(rect.width, 0);
  recordCtx.scale(-1, 1);
  recordCtx.drawImage(video, 0, 0, rect.width, rect.height);
  recordCtx.restore();
  recordCtx.drawImage(inkCanvas, 0, 0, rect.width, rect.height);
  if (recorder?.state === "recording") requestAnimationFrame(drawRecordFrame);
}

function startRecording() {
  if (!("MediaRecorder" in window)) {
    setStatus("这个浏览器暂不支持网页录制，可以先截图保存签名效果。");
    return;
  }
  recordedChunks = [];
  const canvasStream = recordCanvas.captureStream(30);
  recorder = new MediaRecorder(canvasStream, {
    mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm",
  });
  recorder.ondataavailable = (event) => {
    if (event.data.size) recordedChunks.push(event.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    preview.src = url;
    downloadLink.href = url;
    savePanel.hidden = false;
    setStatus("录好了。点保存视频后，可从浏览器分享或存到相册。");
  };
  recorder.start();
  recordButton.textContent = "停止";
  recordButton.classList.add("is-recording");
  setStatus("录制中...");
  drawRecordFrame();
}

function stopRecording() {
  recorder?.stop();
  recordButton.textContent = "录制";
  recordButton.classList.remove("is-recording");
}

inkCanvas.addEventListener("pointerdown", (event) => {
  isDrawingByTouch = true;
  lastPoint = null;
  drawPoint(touchPoint(event));
});

inkCanvas.addEventListener("pointermove", (event) => {
  if (!isDrawingByTouch) return;
  event.preventDefault();
  drawPoint(touchPoint(event));
});

for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) {
  inkCanvas.addEventListener(eventName, () => {
    isDrawingByTouch = false;
    lastPoint = null;
  });
}

startButton.addEventListener("click", startCamera);
clearButton.addEventListener("click", clearInk);
undoButton.addEventListener("click", undoInk);
recordButton.addEventListener("click", () => {
  if (!stream) {
    setStatus("需要先点击“开始镜头”，摄像头启动成功后才能录制。");
    return;
  }
  if (recorder?.state === "recording") stopRecording();
  else startRecording();
});

flipButton.addEventListener("click", async () => {
  facingMode = facingMode === "user" ? "environment" : "user";
  await startCamera();
});

filterSelect.addEventListener("change", () => {
  document.documentElement.style.setProperty(
    "--camera-filter",
    filterMap[filterSelect.value] || "none",
  );
});

window.addEventListener("resize", resizeCanvases);
resizeCanvases();

const initialHelp = cameraHelpMessage();
if (initialHelp) {
  setStatus(initialHelp);
}
