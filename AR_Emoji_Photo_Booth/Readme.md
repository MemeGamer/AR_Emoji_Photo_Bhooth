AR Emoji Photo Booth
This project implements a web‑based AR Emoji Photo Booth using modern browser APIs and MediaPipe. It allows a user to stand in front of the camera, trigger a countdown by raising a hand, overlay a selectable emoji on their face in real time, capture a photo with the chosen emoji, and download the photo via a QR code. The app is designed to be deployed as a static site (e.g. Netlify) and runs entirely client‑side apart from optional image hosting.

Features
Start screen with instructions – A simple welcome screen explains how to begin (raise your hand to start) and includes a “Start” button to enter the booth.

Hand‑triggered countdown – Raising a hand above the head for a brief moment triggers a 3‑2‑1 countdown. The hand can be lowered while the countdown continues; raising a hand again will not restart the timer.

Real‑time face and hand tracking – The app uses MediaPipe’s Face Detection and Hands solutions to find the user’s face and track hand motions. The face detector is configured with the “short‑range” model, which is recommended for faces within about 2 m
mediapipe.readthedocs.io
. The hands pipeline employs a two‑stage model: a palm detector identifies oriented hand bounding boxes, and a hand‑landmark model then estimates 3D keypoints
mediapipe.readthedocs.io
.

Emoji overlay and swiping – Twenty emoji images are preloaded from the emojis/ folder. During the live experience, the user can swipe their hand horizontally to cycle through the available emojis. A hand emoji icon appears on the wrist when a hand is detected to give visual feedback.

Photo capture and QR code – Raising a hand while the emoji is active triggers a second countdown and captures a photo with the emoji drawn on top. The captured image is shown on a result screen, accompanied by a QR code that encodes a downloadable link. By default the app uploads the captured image to Cloudinary via an unsigned upload preset. When the upload succeeds, the QR code contains a short URL to the hosted image; if the upload fails, a tiny fallback image is embedded directly in the QR code.

Customizable assets – All emojis, the background image, and the hand icon are stored in folders (emojis/, bg/, hand/). You can replace these images with your own assets without changing code.

Project structure
graphql
Copy
Edit
├── index.html         # Main HTML page defining start, booth and result screens
├── style.css          # Styles for layout, colours and responsive design
├── app.js             # Core JavaScript: loads models, tracks face/hand, overlays emoji, handles swipes and uploads
├── emojis/            # 20 PNG emoji images (replace to customize)
├── bg/                # Background image used on booth/result screens
├── hand/              # PNG image for the hand detection overlay
└── README.md          # This file
Models used
Face Detection (MediaPipe)
The app imports the MediaPipe Face Detection solution via a CDN. In JavaScript, the model option selects between a short‑range and a full‑range detector. The short‑range model is ideal for faces within about 2 metres; the full‑range model works up to ~5 metres
mediapipe.readthedocs.io
. This project uses the short‑range model to minimise file size and latency.

Hands (MediaPipe)
Hand tracking is implemented with the MediaPipe Hands solution. Hands employs a pipeline of two models: a palm detector that returns oriented bounding boxes and a hand‑landmark model that produces 3D keypoints of the detected hand
mediapipe.readthedocs.io
. These landmarks allow us to locate the wrist for swipe detection and to draw a hand overlay icon.

Running locally
Serve the project – Modern browsers restrict camera usage to secure contexts. To run the booth locally, you must serve the files via HTTP (e.g. using Python or Node). In the project directory run:

bash
Copy
Edit
# Option 1: using Python 3
python3 -m http.server 8000

# Option 2: using Node's http-server (install globally first)
npx http-server -p 8000
Then open http://localhost:8000 in a browser and allow camera access.

Testing on mobile – You can also host the site on a static hosting service (Netlify, GitHub Pages, Vercel) and access it over HTTPS, which is required for camera and microphone APIs.

Cloudinary configuration – To enable working QR codes, you must configure Cloudinary uploads. The app includes constants at the top of app.js:

js
Copy
Edit
const CLOUDINARY_CLOUD_NAME = 'your_cloud_name';
const CLOUDINARY_UPLOAD_PRESET = 'your_unsigned_preset';
Replace these with your own Cloudinary cloud name and an unsigned upload preset. Create a new unsigned preset in the Cloudinary console under Settings → Upload → Upload presets. Unsigned uploads let the client upload images without exposing your API key; your api_secret should never be committed to client‑side code
cloudinary.com
. The upload API endpoint takes the form https://api.cloudinary.com/v1_1/<cloud_name>/image/upload 
cloudinary.com
.

Falling back to embedded QR – If the upload fails (e.g. due to misconfigured Cloudinary credentials), the app downscales the captured image to a tiny thumbnail and embeds it directly in the QR code. Some scanners may not recognise data‑URI QR codes; using Cloudinary or another image host is recommended for robust downloads.

Customising assets
Changing emojis
Each emoji is a 72×72 pixel PNG stored in the emojis/ folder. To change an emoji:

Replace the corresponding file with your own PNG (use the same filename or adjust the emojis array in app.js).

Ensure the images are square and have transparent backgrounds for best results.

You can also add or remove emojis by editing the emojiCodes array near the top of app.js and placing matching files in emojis/. The names in the array correspond to the filenames without the .png extension.

Changing the background
The background image shown on the booth and result screens lives at bg/background.png. Replace this image to personalise the booth. Use a high‑resolution image with bright colours to complement the emoji theme.

Changing the hand overlay
The hand detection icon is loaded from hand/hand.png. Swap this image for a different indicator (e.g. a pointing hand or glow) and ensure it fits well on the wrist.

License
This project is provided as‑is for demonstration purposes. MediaPipe models are released under the Apache 2.0 license. Emoji images are sourced from the open‑source Twemoji project (CC‑BY 4.0). The Cloudinary upload functionality requires adherence to Cloudinary’s terms of service.