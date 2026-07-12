const stage = document.querySelector(".dv-stage");
const liveScreen = document.querySelector(".live-screen");
const video = document.querySelector("#camera");
const inkCanvas = document.querySelector("#inkCanvas");
const recordCanvas = document.querySelector("#recordCanvas");
const recordButton = document.querySelector("#recordButton");
const resetButton = document.querySelector("#resetButton");
const flipButton = document.querySelector("#flipButton");
const zoomControl = document.querySelector("#zoomControl");
const statusEl = document.querySelector("#status");
const cursor = document.querySelector("#cursor");
const timecode = document.querySelector("#timecode");
const recState = document.querySelector("#recState");
const playbackVideo = document.querySelector("#playbackVideo");
const saveRecording = document.querySelector("#saveRecording");
const downloadLink = document.querySelector("#downloadLink");

const ctx = inkCanvas.getContext("2d", { alpha: true });
const recordCtx = recordCanvas.getContext("2d", { alpha: false });

let stream = null;
let facingMode = "user";
let handLandmarker = null;
let lastVideoTime = -1;
let animationFrame = null;
let lastPoint = null;
let lastMidPoint = null;
let smoothedPoint = null;
let missedGestureFrames = 0;
let isPinching = false;
let drawingGestureFrames = 0;
let lastGestureState = "";
let isDrawingByTouch = false;
let recorder = null;
let recordedChunks = [];
let recordingStartedAt = 0;
let timerFrame = null;
let lastRecordingBlob = null;
let lastRecordingFile = null;
let zoom = 1;
let isPlaybackActive = false;
const undoStack = [];
const maxUndoSteps = 24;

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
    return "请用本地服务打开：访问 http://localhost:5173/dv98/。";
  }
  if (!canAskForCamera()) {
    return "手机浏览器需要 HTTPS 才能打开摄像头。请使用 Vercel HTTPS 链接。";
  }
  if (!("mediaDevices" in navigator) || !("getUserMedia" in navigator.mediaDevices)) {
    return "这个浏览器没有开放摄像头 API，请用新版 Safari 或 Chrome。";
  }
  return "";
}

function resizeCanvases() {
  const rect = liveScreen.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  for (const canvas of [inkCanvas, recordCanvas]) {
    const old = document.createElement("canvas");
    old.width = canvas.width;
    old.height = canvas.height;
    if (canvas === inkCanvas && old.width && old.height) {
      old.getContext("2d").drawImage(canvas, 0, 0);
    }
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const nextCtx = canvas.getContext("2d");
    nextCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (canvas === inkCanvas && old.width && old.height) {
      nextCtx.drawImage(old, 0, 0, rect.width, rect.height);
    }
  }
}

function captureUndoSnapshot() {
  if (!inkCanvas.width || !inkCanvas.height) return;
  undoStack.push(ctx.getImageData(0, 0, inkCanvas.width, inkCanvas.height));
  if (undoStack.length > maxUndoSteps) undoStack.shift();
}

function resetStrokeState() {
  lastPoint = null;
  lastMidPoint = null;
  smoothedPoint = null;
}

function undoInk() {
  const snapshot = undoStack.pop();
  if (!snapshot) {
    setStatus("没有可以重签的上一笔。");
    return;
  }
  ctx.putImageData(snapshot, 0, 0);
  resetStrokeState();
  setStatus("已重签上一笔。");
}

function clearInkAfterSave() {
  const rect = inkCanvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  undoStack.length = 0;
  resetStrokeState();
}

function canDrawInk() {
  return recorder?.state === "recording" && !isPlaybackActive;
}

function drawPoint(point) {
  const rect = inkCanvas.getBoundingClientRect();
  const size = Math.max(5, Math.min(rect.width, rect.height) * 0.018);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#fff8e6";
  ctx.fillStyle = "#fff8e6";
  ctx.lineWidth = size;
  ctx.shadowColor = "#fff8e6";
  ctx.shadowBlur = size * 2.1;

  if (!lastPoint) {
    captureUndoSnapshot();
    lastPoint = point;
    lastMidPoint = point;
    ctx.beginPath();
    ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
  if (distance > Math.min(rect.width, rect.height) * 0.28) {
    lastPoint = point;
    lastMidPoint = point;
    return;
  }

  const maxSegment = Math.max(size * 1.15, 7);
  const steps = Math.max(1, Math.ceil(distance / maxSegment));
  let previousPoint = lastPoint;
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const nextPoint = {
      x: lastPoint.x + (point.x - lastPoint.x) * t,
      y: lastPoint.y + (point.y - lastPoint.y) * t,
    };
    const midPoint = {
      x: (previousPoint.x + nextPoint.x) / 2,
      y: (previousPoint.y + nextPoint.y) / 2,
    };
    ctx.beginPath();
    ctx.moveTo(lastMidPoint.x, lastMidPoint.y);
    ctx.quadraticCurveTo(previousPoint.x, previousPoint.y, midPoint.x, midPoint.y);
    ctx.stroke();
    previousPoint = nextPoint;
    lastMidPoint = midPoint;
  }
  lastPoint = point;
}

function touchPoint(event) {
  const rect = inkCanvas.getBoundingClientRect();
  const pointer = event.touches?.[0] || event;
  return {
    x: pointer.clientX - rect.left,
    y: pointer.clientY - rect.top,
  };
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
  return foldRatio < (relaxed ? 0.86 : 0.74) && tipToMcp < palmSize * (relaxed ? 0.82 : 0.68);
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

function getVideoCoverPlacement() {
  const rect = inkCanvas.getBoundingClientRect();
  const videoWidth = video.videoWidth || rect.width;
  const videoHeight = video.videoHeight || rect.height;
  const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight) * zoom;
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    rect,
    x: (rect.width - width) / 2,
    y: (rect.height - height) / 2,
    width,
    height,
  };
}

function landmarkToPoint(landmark) {
  const placement = getVideoCoverPlacement();
  const rawPoint = {
    x: placement.rect.width - (placement.x + landmark.x * placement.width),
    y: placement.y + landmark.y * placement.height,
  };
  rawPoint.x = Math.min(placement.rect.width, Math.max(0, rawPoint.x));
  rawPoint.y = Math.min(placement.rect.height, Math.max(0, rawPoint.y));

  if (!smoothedPoint) {
    smoothedPoint = rawPoint;
    return rawPoint;
  }
  const movement = Math.hypot(rawPoint.x - smoothedPoint.x, rawPoint.y - smoothedPoint.y);
  const smoothing = movement > placement.rect.width * 0.08 ? 0.84 : 0.58;
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
  const modelAssetPath =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  const options = {
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  try {
    handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath, delegate: "GPU" },
    });
  } catch (error) {
    console.warn("GPU hand model failed, falling back to CPU.", error);
    handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { modelAssetPath, delegate: "CPU" },
    });
  }
  return handLandmarker;
}

async function startCamera() {
  const help = cameraHelpMessage();
  if (help) {
    setStatus(help);
    return false;
  }
  try {
    setStatus("正在打开 DV-98 镜头...");
    recordButton.disabled = true;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    resizeCanvases();
    stage.classList.add("is-camera-on");
    recordButton.setAttribute("aria-label", "开始录制");
    setStatus("镜头已开启。点击 REC 开始录制后才可以签名。");
    detectHands();
    loadHandLandmarker()
      .then(() => setStatus("手势已就绪。点击 REC 开始录制。"))
      .catch((error) => {
        console.error("Hand model failed to load.", error);
        setStatus("手势模型加载失败，仍可触屏签名和录制。");
      });
    return true;
  } catch (error) {
    if (error.name === "NotAllowedError") {
      setStatus("摄像头权限被拒绝。请在浏览器设置里允许摄像头。");
    } else {
      setStatus(`摄像头启动失败：${error.message}`);
    }
    return false;
  } finally {
    recordButton.disabled = false;
  }
}

function detectHands() {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  const tick = () => {
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
        const wantsToDraw = updateDrawingGesture(landmarks);
        if (wantsToDraw && canDrawInk()) {
          cursor.classList.add("is-drawing");
          drawPoint(point);
          if (lastGestureState !== "drawing") {
            setStatus("正在签名：保持三指握拳，并捏合拇指和食指。");
            lastGestureState = "drawing";
          }
        } else {
          cursor.classList.remove("is-drawing");
          resetStrokeState();
          if (!canDrawInk()) {
            if (lastGestureState !== "locked") {
              setStatus("录制开始后才可以落笔签名。");
              lastGestureState = "locked";
            }
          } else if (lastGestureState !== "aiming") {
              setStatus("食指定位中；捏合并三指握拳才会落笔。");
              lastGestureState = "aiming";
          }
        }
      } else {
        missedGestureFrames += 1;
        if (missedGestureFrames >= 5) {
          cursor.style.opacity = "0";
          cursor.classList.remove("is-drawing");
          isPinching = false;
          resetStrokeState();
        }
      }
    }
    animationFrame = requestAnimationFrame(tick);
  };
  tick();
}

function drawRecordFrame() {
  const placement = getVideoCoverPlacement();
  const rect = placement.rect;
  recordCtx.save();
  recordCtx.fillStyle = "#050506";
  recordCtx.fillRect(0, 0, rect.width, rect.height);
  recordCtx.filter = "sepia(25%) saturate(78%) contrast(112%) brightness(98%)";
  recordCtx.translate(rect.width, 0);
  recordCtx.scale(-1, 1);
  recordCtx.drawImage(video, placement.x, placement.y, placement.width, placement.height);
  recordCtx.restore();

  recordCtx.save();
  recordCtx.globalAlpha = 0.22;
  recordCtx.strokeStyle = "#ffffff";
  recordCtx.lineWidth = 1;
  recordCtx.beginPath();
  recordCtx.moveTo(rect.width / 3, 0);
  recordCtx.lineTo(rect.width / 3, rect.height);
  recordCtx.moveTo((rect.width / 3) * 2, 0);
  recordCtx.lineTo((rect.width / 3) * 2, rect.height);
  recordCtx.moveTo(0, rect.height / 3);
  recordCtx.lineTo(rect.width, rect.height / 3);
  recordCtx.moveTo(0, (rect.height / 3) * 2);
  recordCtx.lineTo(rect.width, (rect.height / 3) * 2);
  recordCtx.stroke();
  recordCtx.restore();

  recordCtx.drawImage(inkCanvas, 0, 0, rect.width, rect.height);
  recordCtx.save();
  recordCtx.globalAlpha = 0.2;
  for (let y = 0; y < rect.height; y += 4) {
    recordCtx.fillStyle = y % 8 === 0 ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)";
    recordCtx.fillRect(0, y, rect.width, 1);
  }
  recordCtx.restore();

  if (recorder?.state === "recording") requestAnimationFrame(drawRecordFrame);
}

function updateTimer() {
  if (recorder?.state !== "recording") return;
  const seconds = Math.floor((performance.now() - recordingStartedAt) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  timecode.textContent = `00:${mm}:${ss}`;
  timerFrame = requestAnimationFrame(updateTimer);
}

function showPlayback(blob) {
  lastRecordingBlob = blob;
  lastRecordingFile = new File([blob], "lens-signature-dv98.webm", { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  playbackVideo.src = url;
  playbackVideo.hidden = false;
  playbackVideo.currentTime = 0;
  playbackVideo.play().catch(() => {});
  downloadLink.href = url;
  saveRecording.hidden = false;
  isPlaybackActive = true;
  stage.classList.add("is-playing-back");
  setStatus("录好了。正在取景器里回放，点击保存后会清空笔画。");
}

function startRecording() {
  if (!("MediaRecorder" in window)) {
    setStatus("这个浏览器暂不支持网页录制，可以先用签名取景效果。");
    return;
  }
  recordedChunks = [];
  exitPlayback(false);
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
    recState.textContent = "REC";
    showPlayback(blob);
  };
  recorder.start();
  recordingStartedAt = performance.now();
  recState.textContent = "●";
  setStatus("录制中。再次点击红色按钮停止并回放。");
  updateTimer();
  drawRecordFrame();
}

function stopRecording() {
  if (timerFrame) cancelAnimationFrame(timerFrame);
  recorder?.stop();
}

async function handleRecordButton() {
  if (!stream) {
    const ok = await startCamera();
    if (ok) startRecording();
    return;
  }
  if (isPlaybackActive) {
    exitPlayback(false);
  }
  if (recorder?.state === "recording") stopRecording();
  else startRecording();
}

async function shareLastRecording() {
  if (!lastRecordingBlob || !lastRecordingFile) return;
  const finishSave = () => {
    clearInkAfterSave();
    exitPlayback(true);
    setStatus("已保存/导出，签名笔迹已清空，可以拍下一段。");
  };
  if (navigator.canShare?.({ files: [lastRecordingFile] })) {
    try {
      await navigator.share({
        files: [lastRecordingFile],
        title: "镜头签 DV-98",
        text: "我的 DV-98 镜头签视频",
      });
      finishSave();
      return;
    } catch {
      setStatus("分享面板已关闭，可再次点击保存或使用下载视频。");
      return;
    }
  }
  downloadLink.click();
  finishSave();
}

function exitPlayback(clearVideo = false) {
  isPlaybackActive = false;
  stage.classList.remove("is-playing-back");
  saveRecording.hidden = true;
  playbackVideo.pause();
  if (clearVideo) {
    playbackVideo.removeAttribute("src");
    playbackVideo.load();
    playbackVideo.hidden = true;
    lastRecordingBlob = null;
    lastRecordingFile = null;
    downloadLink.removeAttribute("href");
  }
}

inkCanvas.addEventListener("pointerdown", (event) => {
  if (!canDrawInk()) {
    setStatus("录制开始后才可以在屏幕上写字。");
    return;
  }
  isDrawingByTouch = true;
  resetStrokeState();
  drawPoint(touchPoint(event));
});

inkCanvas.addEventListener("pointermove", (event) => {
  if (!isDrawingByTouch) return;
  if (!canDrawInk()) {
    isDrawingByTouch = false;
    resetStrokeState();
    return;
  }
  event.preventDefault();
  drawPoint(touchPoint(event));
});

for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) {
  inkCanvas.addEventListener(eventName, () => {
    isDrawingByTouch = false;
    resetStrokeState();
  });
}

recordButton.addEventListener("click", handleRecordButton);
resetButton.addEventListener("click", undoInk);
flipButton.addEventListener("click", async () => {
  facingMode = facingMode === "user" ? "environment" : "user";
  await startCamera();
});
zoomControl.addEventListener("input", () => {
  zoom = Number(zoomControl.value);
  liveScreen.style.setProperty("--zoom", zoom);
  setStatus(`变焦 ${zoom.toFixed(1)}x`);
});
saveRecording.addEventListener("click", shareLastRecording);
window.addEventListener("resize", resizeCanvases);
screen.orientation?.addEventListener?.("change", () => setTimeout(resizeCanvases, 250));
resizeCanvases();
