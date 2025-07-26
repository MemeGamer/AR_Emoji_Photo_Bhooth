/*
 * Smiley Booth Web App
 *
 * This script implements an AR emoji photo booth using MediaPipe face and hand
 * detection. Users can raise their hand for three seconds to begin the
 * experience, swipe their hand left to cycle through 20 different smiley
 * emojis, and raise their hand again for three seconds to capture a photo.
 * The captured photo is displayed along with a QR code so that users can
 * download it to their phones. An exit button resets the app back to the
 * initial screen.
 */

// DOM elements
const startScreen = document.getElementById('start-screen');
const boothScreen = document.getElementById('booth-screen');
const resultScreen = document.getElementById('result-screen');

const startBtn = document.getElementById('start-btn');
const exitBtn = document.getElementById('exit-btn');
const exitBtn2 = document.getElementById('exit-btn2');

const videoElement = document.getElementById('video');
const overlayCanvas = document.getElementById('overlay');
const overlayCtx = overlayCanvas.getContext('2d');

const countdownEl = document.getElementById('countdown');
const instructionsEl = document.getElementById('instructions');

const resultCanvas = document.getElementById('result-canvas');
const resultCtx = resultCanvas.getContext('2d');
const qrContainer = document.getElementById('qr-container');

// Container for the row of emoji thumbnails. It may be undefined if the
// element is missing from the DOM. Ensure this is declared before
// functions reference it to avoid a ReferenceError.
const emojiRow = document.getElementById('emoji-row');

// Application state constants
const States = {
  IDLE: 'IDLE',
  // Waiting for the user to raise their hand to start the booth. A hand
  // raise will initiate a three‑second countdown before the AR overlay
  // appears.
  WAITING_START_HAND: 'WAITING_START_HAND',
  // Countdown in progress after the user has raised their hand to start.
  START_COUNTDOWN: 'START_COUNTDOWN',
  // AR overlay is active. Emoji is drawn and user can swipe to cycle
  // smileys or raise their hand to start the photo countdown.
  OVERLAY: 'OVERLAY',
  // Countdown before capturing the photo. During this state swipes and
  // hand raises are ignored until the capture completes.
  CAPTURE_COUNTDOWN: 'CAPTURE_COUNTDOWN'
};

// Current state variables
let currentState = States.IDLE;
// Timestamp when the start countdown began (after user raised their hand)
let countdownStartTime = null;
// Timestamp when the capture countdown began (after user raised their hand to take photo)
let captureCountdownStartTime = null;

// Detection results
let latestFaceBox = null;        // { xCenter, yCenter, width, height } normalized bounding box
// Smoothed bounding box to reduce jitter.  We will update this using
// exponential smoothing so that the emoji does not jump around if the
// raw detection varies slightly between frames.
let smoothedFaceBox = null;
const faceSmoothingAlpha = 0.4;
let latestHandLandmarks = null;  // array of hand landmarks (if any)

// Emoji loading
const emojiCodes = [
  '1f600', // grinning face
  '1f603', // smiling face with open mouth
  '1f604', // smiling face with open mouth and smiling eyes
  '1f601', // grinning face with smiling eyes
  '1f606', // laughing face
  '1f605', // smiling face with sweat
  '1f923', // rolling on the floor laughing
  '1f602', // face with tears of joy
  '1f60a', // smiling face with smiling eyes
  '1f607', // smiling face with halo
  '1f608', // smiling face with horns
  '1f609', // winking face
  '1f60b', // face savoring food
  '1f60c', // relieved face
  '1f60d', // heart eyes
  '1f60e', // sunglasses
  '1f60f', // smirking face
  '1f610', // neutral face
  '1f611', // expressionless face
  '1f612'  // unamused face
];
const emojiImages = [];
let emojisLoaded = false;

// Preload emoji images
function preloadEmojis() {
  let loadedCount = 0;
  return new Promise((resolve) => {
    emojiCodes.forEach((code, index) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      // Load the emoji image from the local emojis directory. Having
      // the files locally avoids network requests and allows users to
      // customise the emoji set by replacing images in the `emojis` folder.
      img.src = `emojis/${code}.png`;
      img.onload = () => {
        loadedCount++;
        if (loadedCount === emojiCodes.length) {
          emojisLoaded = true;
          resolve();
        }
      };
      emojiImages[index] = img;
    });
  });
}

// Hand icon loading
// The booth can display a small hand icon over the detected wrist to
// provide visual feedback that a hand has been detected. The image is
// loaded from a local `hand` folder so users can replace it with their
// own graphic. We expose a promise so other code can wait for the
// image to finish loading before trying to draw it.
const handIcon = new Image();
let handIconLoaded = false;
function preloadHandIcon() {
  return new Promise((resolve) => {
    handIcon.crossOrigin = 'anonymous';
    handIcon.src = 'hand/hand.png';
    handIcon.onload = () => {
      handIconLoaded = true;
      resolve();
    };
    handIcon.onerror = () => {
      // If the hand image fails to load, just resolve so the app continues
      console.warn('Warning: hand icon failed to load');
      resolve();
    };
  });
}

// Render the horizontal emoji thumbnail bar. Each thumbnail corresponds
// to an emoji in the `emojiImages` array. The active thumbnail is
// highlighted and enlarged. When clicked, the selected emoji changes
// immediately. After rendering, the bar is scrolled so that the active
// thumbnail appears in the centre.
function renderEmojiRow() {
  if (!emojisLoaded) return;
  // Clear previous thumbnails
  emojiRow.innerHTML = '';
  emojiImages.forEach((img, index) => {
    const thumb = document.createElement('img');
    thumb.src = img.src;
    if (index === selectedEmojiIndex) {
      thumb.classList.add('active');
    }
    // Clicking a thumbnail manually selects the emoji
    thumb.addEventListener('click', () => {
      selectedEmojiIndex = index;
      renderEmojiRow();
    });
    emojiRow.appendChild(thumb);
  });
  centerSelectedEmoji();
}

// Scroll the emoji bar so that the active emoji is centred. This uses
// `scrollLeft` based on the active element's offset relative to the
// container's width.
function centerSelectedEmoji() {
  const activeThumb = emojiRow.children[selectedEmojiIndex];
  if (!activeThumb) return;
  const containerWidth = emojiRow.offsetWidth;
  const activeCenter = activeThumb.offsetLeft + activeThumb.offsetWidth / 2;
  emojiRow.scrollLeft = activeCenter - containerWidth / 2;
}

// Selected emoji index
let selectedEmojiIndex = 0;
// Swipe detection variables
//
// Detect a swipe by monitoring horizontal motion of the wrist over
// successive frames. When a hand is detected we record the current
// x‑coordinate and timestamp. If the wrist moves left or right by
// more than SWIPE_DIFF_THRESHOLD within SWIPE_MAX_DURATION
// milliseconds, and enough time has passed since the last swipe
// (SWIPE_COOLDOWN), we cycle to the next emoji. These constants
// control sensitivity and timing. Lower thresholds and cooldowns
// make swipes easier to trigger. You can adjust these values if
// detection is too sensitive or not responsive enough.
let swipeStartX = null;
let swipeStartTime = 0;
let lastSwipeTime = 0;
const SWIPE_DIFF_THRESHOLD = 0.08; // normalized x difference needed for a swipe
const SWIPE_MAX_DURATION   = 3000; // ms, maximum time allowed for a swipe gesture
const SWIPE_COOLDOWN       = 300;  // ms, minimum time between successive swipes

// Cooldown tracking for hand raises. After a hand is lowered, the user
// must wait at least HAND_COOLDOWN_MS milliseconds before a new raise
// starts a timer. This prevents continuous raises from immediately
// triggering another countdown or capture.
let lastHandLowerTimeStart = 0;
let lastHandLowerTimeCapture = 0;
const HAND_COOLDOWN_MS = 2000; // 2‑second cooldown between raises

// MediaPipe face detection and hands instances
let faceDetection = null;
let hands = null;
let camera = null;

// Initialise MediaPipe tasks
async function initMediaPipe() {
  // Create a FaceDetection instance. When the script is loaded via a <script> tag
  // the global class is exported directly on the FaceDetection object (not as
  // FaceDetection.FaceDetection). See MediaPipe documentation for details.
  faceDetection = new FaceDetection({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4/${file}`
  });
  faceDetection.setOptions({
    // Use the short-range model for faces within ~2 meters. The legacy API does not support
    // modelSelection in JavaScript; use the `model` option instead.
    model: 'short',
    minDetectionConfidence: 0.5
  });
  faceDetection.onResults(handleFaceResults);

  // Create a Hands instance. Like FaceDetection, the Hands class is exported
  // directly on the global Hands object.
  hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5
  });
  hands.onResults(handleHandResults);
}

// Start the camera and detection loop
async function startCamera() {
  camera = new Camera(videoElement, {
    onFrame: async () => {
      try {
        // Send the current frame to both detectors sequentially
        await faceDetection.send({ image: videoElement });
        await hands.send({ image: videoElement });
      } catch (e) {
        console.error('Error sending frame to MediaPipe:', e);
      }
    },
    // Use a modest resolution to balance performance and quality
    width: 640,
    height: 480
  });
  await camera.start();
}

// Handle face detection results
function handleFaceResults(results) {
  if (results && results.detections && results.detections.length > 0) {
    const bbox = results.detections[0].boundingBox;
    const raw = {
      xCenter: bbox.xCenter,
      yCenter: bbox.yCenter,
      width: bbox.width,
      height: bbox.height
    };
    // Initialise smoothedBox on first detection
    if (!smoothedFaceBox) {
      smoothedFaceBox = { ...raw };
    } else {
      // Exponential smoothing: new = alpha * raw + (1 - alpha) * previous
      smoothedFaceBox.xCenter = faceSmoothingAlpha * raw.xCenter + (1 - faceSmoothingAlpha) * smoothedFaceBox.xCenter;
      smoothedFaceBox.yCenter = faceSmoothingAlpha * raw.yCenter + (1 - faceSmoothingAlpha) * smoothedFaceBox.yCenter;
      smoothedFaceBox.width   = faceSmoothingAlpha * raw.width   + (1 - faceSmoothingAlpha) * smoothedFaceBox.width;
      smoothedFaceBox.height  = faceSmoothingAlpha * raw.height  + (1 - faceSmoothingAlpha) * smoothedFaceBox.height;
    }
    latestFaceBox = smoothedFaceBox;
  } else {
    latestFaceBox = null;
    smoothedFaceBox = null;
  }
}

// Handle hand detection results
function handleHandResults(results) {
  if (results && results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    latestHandLandmarks = results.multiHandLandmarks[0];
  } else {
    latestHandLandmarks = null;
  }
}

// Utility to check whether the hand is raised above the face
function isHandRaised() {
  if (!latestHandLandmarks || !latestFaceBox) return false;
  // Landmark 0 is the wrist; take y coordinate of wrist
  const wristY = latestHandLandmarks[0].y;
  // Compute top of face bounding box
  const faceTop = latestFaceBox.yCenter - latestFaceBox.height / 2;
  return wristY < faceTop;
}

// Utility to check if the hand is raised above a general threshold (used when face not detected)
function isHandRaisedGeneral() {
  if (!latestHandLandmarks) return false;
  const wristY = latestHandLandmarks[0].y;
  // Consider top 30% of the frame
  return wristY < 0.3;
}

// Draw the selected emoji over the face bounding box
// Use a constant scale so that the emoji covers the entire head. Changing
// this value allows the user to adjust how large the emoji appears relative
// to the detected face.
// Scale factor for the emoji relative to the detected face.  The size
// determines how much of the head the emoji covers.  In practice a
// value around 1.3–1.5 looks natural; a larger value squashes the
// graphic and causes it to spill outside the face.  We reduce the
// previous value (1.5) to 1.4 to correct mis‑alignment where the
// emoji appeared oversized and offset from the user’s face.
// The user requested a larger emoji.  Empirically a value of 2.5
// provides full coverage of the head and aligns better with the
// underlying face detection.  Adjust this constant if you need a
// different scale.
const EMOJI_SCALE = 2.5;
// Vertical offset applied to the emoji so that it sits a bit higher on
// the face.  Increasing the offset brings the emoji up and exposes
// more of the user’s neck.  Raising from 0.1 to 0.15 better centres
// the emoji on the face while avoiding hair overlap.
// The user found that a negative offset aligns the emoji better on
// their face.  Negative values push the emoji downward relative to
// the detected bounding box.  For example, -0.2 moves the emoji
// downward by 20 % of its height.
const EMOJI_Y_OFFSET = 0.10;

/*
 * Cloudinary configuration
 *
 * To generate a scannable QR code, the captured photo must be hosted
 * somewhere accessible on the internet.  A static Netlify site cannot
 * be modified at runtime, so we use Cloudinary’s unsigned upload API to
 * host the downsized image and obtain a short URL.  You can create a
 * free Cloudinary account and set up an unsigned upload preset.
 *
 * Replace `demo` with your own cloud name and `ml_default` with the
 * unsigned preset you create.  See Cloudinary’s documentation for
 * details【421510167385868†L2243-L2248】.  Without changes these values
 * target Cloudinary’s public demo environment and may be rate limited.
 */
const CLOUDINARY_CLOUD_NAME = 'dimeazdye';
const CLOUDINARY_UPLOAD_PRESET = 'arbooth';

function drawEmoji() {
  if (!latestFaceBox || !emojisLoaded) return;
  const img = emojiImages[selectedEmojiIndex];
  if (!img) return;

  // Compute scaled pixel coordinates. We enlarge the emoji so it covers more
  // than just the bounding box of the face. A scale of 1.5 means the emoji
  // will be 50% larger than the detected face box, helping it cover the
  // entire head.
  const scale = EMOJI_SCALE;
  const wNorm = latestFaceBox.width;
  const hNorm = latestFaceBox.height;
  const xCenter = latestFaceBox.xCenter;
  const yCenter = latestFaceBox.yCenter;
  const width = wNorm * overlayCanvas.width * scale;
  const height = hNorm * overlayCanvas.height * scale;
  // Centre the emoji horizontally over the face
  const x = (xCenter - (wNorm * scale) / 2) * overlayCanvas.width;
  let y = (yCenter - (hNorm * scale) / 2) * overlayCanvas.height;
  // Move the emoji up slightly to show more neck
  y -= height * EMOJI_Y_OFFSET;
  overlayCtx.drawImage(img, x, y, width, height);
}

// Draw a small hand icon over the detected wrist. The icon size is
// proportional to the overlay canvas width so it scales with the
// camera resolution. If no hand is detected or the icon has not
// finished loading, nothing is drawn. Adjust HAND_ICON_SCALE to
// increase or decrease the size of the hand overlay.
const HAND_ICON_SCALE = 0.08; // fraction of overlay width used for the icon
function drawHandIcon() {
  if (!handIconLoaded || !latestHandLandmarks) return;
  const wrist = latestHandLandmarks[0];
  const canvasW = overlayCanvas.width;
  const canvasH = overlayCanvas.height;
  const size = canvasW * HAND_ICON_SCALE;
  const x = wrist.x * canvasW - size / 2;
  const y = wrist.y * canvasH - size / 2;
  overlayCtx.drawImage(handIcon, x, y, size, size);
}

// Update overlay (canvas and HTML elements) based on current state and detection results
function updateOverlay() {
  // Ensure overlay canvas matches the video resolution
  if (videoElement.videoWidth && videoElement.videoHeight) {
    overlayCanvas.width = videoElement.videoWidth;
    overlayCanvas.height = videoElement.videoHeight;
  }
  // Clear overlay canvas
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  // Draw emoji if we are in the overlay or during a capture countdown
  if (currentState === States.OVERLAY || currentState === States.CAPTURE_COUNTDOWN) {
    drawEmoji();
    // Draw hand icon whenever a hand is detected during the overlay or countdown
    drawHandIcon();
    // Show the emoji thumbnail bar during overlay and capture countdown
    emojiRow.classList.remove('hidden');
  } else {
    // Hide the thumbnail bar when not in overlay or capture countdown
    emojiRow.classList.add('hidden');
  }

  // Evaluate states and update countdown/instructions
  const now = Date.now();
  switch (currentState) {
    case States.WAITING_START_HAND: {
      // Waiting for initial hand raise to start. Show instruction and clear countdown.
      instructionsEl.textContent = 'Raise your hand above your head to start';
      countdownEl.textContent = '';
      const raised = isHandRaised() || isHandRaisedGeneral();
      if (raised && now - lastHandLowerTimeStart >= HAND_COOLDOWN_MS) {
        // Begin the start countdown
        currentState = States.START_COUNTDOWN;
        countdownStartTime = now;
        countdownEl.textContent = '3';
        instructionsEl.textContent = '';
      } else if (!raised) {
        // Update time the hand was lowered for cooldown tracking
        lastHandLowerTimeStart = now;
      }
      break;
    }
    case States.START_COUNTDOWN: {
      // Countdown before overlay becomes active
      const elapsed = (now - countdownStartTime) / 1000;
      const remaining = 3 - elapsed;
      if (remaining > 0) {
        countdownEl.textContent = Math.ceil(remaining).toString();
        instructionsEl.textContent = '';
      } else {
        // Countdown finished, move to overlay state
        countdownEl.textContent = '';
        currentState = States.OVERLAY;
        instructionsEl.textContent = 'Swipe your hand from right to left to change the smiley.\nRaise your hand to take a photo.';
        // Reset swipe tracking state
        swipeStartX = null;
        swipeStartTime = 0;
        // Ensure the thumbnail bar is updated when entering the overlay
        renderEmojiRow();
      }
      break;
    }
    case States.OVERLAY: {
      // Draw emoji overlay handled above. Allow swipe to change emoji and hand raise to trigger capture countdown.
      // Swipe detection
      if (latestHandLandmarks) {
        const wristX = latestHandLandmarks[0].x;
        if (swipeStartX === null) {
          // Start tracking the swipe when a hand is first detected
          swipeStartX = wristX;
          swipeStartTime = now;
        } else {
          const dx = wristX - swipeStartX;
          const dt = now - swipeStartTime;
          // Check if the hand has moved horizontally by more than the threshold
          if (Math.abs(dx) > SWIPE_DIFF_THRESHOLD && dt < SWIPE_MAX_DURATION && (now - lastSwipeTime) > SWIPE_COOLDOWN) {
            // Register a swipe: cycle to the next emoji
            selectedEmojiIndex = (selectedEmojiIndex + 1) % emojiImages.length;
            lastSwipeTime = now;
            // Reset swipe tracking
            swipeStartX = null;
            swipeStartTime = 0;
            // Update the thumbnail bar to reflect the new selection
            renderEmojiRow();
          } else if (dt >= SWIPE_MAX_DURATION) {
            // If too much time has passed, reset the start position
            swipeStartX = wristX;
            swipeStartTime = now;
          }
        }
      } else {
        // Reset swipe tracking if no hand is detected
        swipeStartX = null;
        swipeStartTime = 0;
      }
      // Check for hand raise to start capture countdown
      const raisedCapture = isHandRaised() || isHandRaisedGeneral();
      if (raisedCapture && now - lastHandLowerTimeCapture >= HAND_COOLDOWN_MS) {
        // Begin capture countdown
        currentState = States.CAPTURE_COUNTDOWN;
        captureCountdownStartTime = now;
        countdownEl.textContent = '3';
        instructionsEl.textContent = '';
      } else if (!raisedCapture) {
        lastHandLowerTimeCapture = now;
      }
      break;
    }
    case States.CAPTURE_COUNTDOWN: {
      // Countdown before photo capture
      const elapsed = (now - captureCountdownStartTime) / 1000;
      const remaining = 3 - elapsed;
      if (remaining > 0) {
        countdownEl.textContent = Math.ceil(remaining).toString();
        instructionsEl.textContent = '';
      } else {
        // Countdown finished, take photo and transition back to idle
        countdownEl.textContent = '';
        lastHandLowerTimeCapture = now;
        currentState = States.IDLE;
        takePhoto();
        return;
      }
      break;
    }
    default: {
      break;
    }
  }
}

// Capture the current frame and overlay, then display the result screen
function takePhoto() {
  // Resize result canvas to video resolution
  resultCanvas.width = videoElement.videoWidth;
  resultCanvas.height = videoElement.videoHeight;
  // Draw the current video frame before stopping the camera. Drawing the frame
  // first prevents the capture from being black if the stream is stopped.
  resultCtx.drawImage(videoElement, 0, 0, resultCanvas.width, resultCanvas.height);
  // Draw the selected emoji on the captured frame
  if (latestFaceBox && emojisLoaded) {
    const img = emojiImages[selectedEmojiIndex];
    const scale = EMOJI_SCALE;
    const wNorm = latestFaceBox.width;
    const hNorm = latestFaceBox.height;
    const xCenter = latestFaceBox.xCenter;
    const yCenter = latestFaceBox.yCenter;
    const width = wNorm * resultCanvas.width * scale;
    const height = hNorm * resultCanvas.height * scale;
    const x = (xCenter - (wNorm * scale) / 2) * resultCanvas.width;
    let y = (yCenter - (hNorm * scale) / 2) * resultCanvas.height;
    // Apply the same vertical offset as the overlay
    y -= height * EMOJI_Y_OFFSET;
    resultCtx.drawImage(img, x, y, width, height);
  }
  // Stop the camera after drawing the frame
  if (camera) {
    try {
      camera.stop();
    } catch (e) {
      console.warn('Camera stop error:', e);
    }
  }
  // Create a downscaled version of the captured image to embed in a QR code.
  // A full‑resolution PNG would produce an enormous data URL that cannot be
  // encoded in a QR code. We scale the image down and export it as a JPEG to
  // reduce the data size. The QR code will still embed the complete photo
  // albeit at a lower resolution.
  // Downscale the captured image further to reduce the QR code data size.
  // A width of 80 pixels keeps the photo recognisable but dramatically
  // reduces the length of the resulting data URL, which improves scan
  // reliability when encoding directly into a QR code.
  // To ensure the encoded data URL fits within QR code capacity, scale the
  // downscaled image down to 50 pixels in width. With JPEG compression,
  // this produces a data URL of roughly 3 KB, which QRCode.js can
  // accommodate.
  // Prepare a small thumbnail for fallback QR codes.  When the Cloudinary
  // upload succeeds, the QR code will encode the remote URL rather than
  // this tiny preview.  The small thumbnail yields a short data URI that
  // fits comfortably in a QR code and is still identifiable when scanned.
  const thumbWidth = 20;
  const thumbHeight = Math.round((resultCanvas.height / resultCanvas.width) * thumbWidth);
  const scaledCanvas = document.createElement('canvas');
  const scaledCtx = scaledCanvas.getContext('2d');
  scaledCanvas.width = thumbWidth;
  scaledCanvas.height = thumbHeight;
  scaledCtx.drawImage(resultCanvas, 0, 0, thumbWidth, thumbHeight);
  // Export the tiny thumbnail as JPEG for fallback QR codes.
  const tinyDataURL = scaledCanvas.toDataURL('image/jpeg', 0.6);
  /*
   * Upload the downscaled image to Cloudinary and generate a QR code for the
   * returned URL.  If the upload fails (for example, due to missing
   * configuration or network issues), fall back to embedding the data URL
   * directly into the QR code.  Using a remote URL produces a much
   * shorter string that most QR code scanners can decode reliably.  See
   * Cloudinary’s API reference for details on unsigned uploads【421510167385868†L2243-L2248】.
   */
  async function handleQRCode() {
    // Use the tinyDataURL as the default QR payload.  This small
    // base64 string fits comfortably into a QR code.  If Cloudinary
    // upload succeeds, we replace qrText with the secure URL returned
    // from the API.
    let qrText = tinyDataURL;
    try {
      // Convert the full‑resolution captured image to a Blob for upload.
      const fullDataURL = resultCanvas.toDataURL('image/jpeg', 0.9);
      const fullRes = await fetch(fullDataURL);
      const fullBlob = await fullRes.blob();
      const formData = new FormData();
      formData.append('file', fullBlob);
      formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
      const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
        method: 'POST',
        body: formData
      });
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        if (uploadData.secure_url) {
          qrText = uploadData.secure_url;
        }
      } else {
        console.warn('Cloudinary upload failed with status', uploadRes.status);
      }
    } catch (err) {
      console.warn('Error uploading to Cloudinary:', err);
    }
    // Clear any previous QR code
    qrContainer.innerHTML = '';
    // Generate the QR code.  Use a 200 px size for a more compact
    // appearance now that the encoded text is short (either a URL or
    // tiny preview).
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrText)}`;
    const img = document.createElement('img');
    img.src = qrUrl;
    img.alt = 'QR Code';
    img.width = 200;
    img.height = 200;
    qrContainer.appendChild(img);
  }
  handleQRCode();
  // Display result screen and hide booth screen
  boothScreen.classList.add('hidden');
  resultScreen.classList.remove('hidden');
  // Hide the emoji thumbnail bar when showing the result
  emojiRow.classList.add('hidden');
  currentState = States.IDLE;
}

// Reset the application to the start screen
function resetToStart() {
  // Stop the camera if running
  if (camera) {
    try {
      camera.stop();
    } catch (e) {
      console.warn('Camera stop error:', e);
    }
  }
  // Hide booth and result screens
  boothScreen.classList.add('hidden');
  resultScreen.classList.add('hidden');
  // Show start screen
  startScreen.classList.remove('hidden');
  // Reset state variables
  currentState = States.IDLE;
  // Reset countdown timers
  countdownStartTime = null;
  captureCountdownStartTime = null;
  latestFaceBox = null;
  latestHandLandmarks = null;
  // reset swipe tracking variables
  swipeStartX = null;
  swipeStartTime = 0;
  lastSwipeTime = 0;
  // reset hand cooldown timers
  lastHandLowerTimeStart = 0;
  lastHandLowerTimeCapture = 0;
  selectedEmojiIndex = 0;
  instructionsEl.textContent = '';
  countdownEl.textContent = '';
  qrContainer.innerHTML = '';
  // Hide emoji bar when returning to start
  emojiRow.classList.add('hidden');
}

// Start the booth experience from the start screen
async function startExperience() {
  // Hide start and result screens, show booth screen
  startScreen.classList.add('hidden');
  resultScreen.classList.add('hidden');
  boothScreen.classList.remove('hidden');
  // Reset variables for a fresh session
  currentState = States.WAITING_START_HAND;
  // Reset countdown timers
  countdownStartTime = null;
  captureCountdownStartTime = null;
  // reset swipe tracking variables
  swipeStartX = null;
  swipeStartTime = 0;
  lastSwipeTime = 0;
  // reset cooldown timers
  lastHandLowerTimeStart = 0;
  lastHandLowerTimeCapture = 0;
  selectedEmojiIndex = 0;
  instructionsEl.textContent = '';
  countdownEl.textContent = '';
  // Render the emoji thumbnail bar. It remains hidden until the overlay
  // state becomes active; updateOverlay will toggle its visibility.
  renderEmojiRow();
  // Start camera and detection
  await startCamera();
  // Begin drawing loop
  requestAnimationFrame(drawLoop);
}

// Continuous drawing loop that updates the overlay
function drawLoop() {
  if (!boothScreen.classList.contains('hidden')) {
    updateOverlay();
    requestAnimationFrame(drawLoop);
  }
}

// Event listeners
startBtn.addEventListener('click', async () => {
  // Ensure emojis and the hand icon are loaded and MediaPipe tasks are initialised before starting
  if (!emojisLoaded) {
    await preloadEmojis();
  }
  // Load the hand icon only once. If it’s already loaded this promise resolves immediately.
  if (!handIconLoaded) {
    await preloadHandIcon();
  }
  if (!faceDetection || !hands) {
    await initMediaPipe();
  }
  startExperience();
});

exitBtn.addEventListener('click', () => {
  resetToStart();
});

exitBtn2.addEventListener('click', () => {
  resetToStart();
});