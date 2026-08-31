// --- CONSTANTS & STATE ---

// The current event ID is passed from the Flask template to the window object
const EVENT_ID = window.CURRENT_EVENT_ID || "";
// Endpoint to fetch participants for the current event
const API_PARTICIPANTS = `/api/participants/${EVENT_ID}`;

// In-memory list of all participants loaded from the backend
let participants = [];
// List of participants who have already won (to avoid picking them again)
let selectedWinners = [];
// Flag to prevent multiple spins at the same time
let spinning = false;

// DOM Elements
const canvas = document.getElementById("wheelCanvas");
const ctx = canvas.getContext("2d");
const spinButton = document.getElementById("spinButton");
const clearButton = document.getElementById("clearButton");
const winnersList = document.getElementById("winnersList");
const wheelSelectedName = document.getElementById("wheelSelectedName");
const participantCountBadge = document.getElementById("participantCountBadge");
const winnerCountBadge = document.getElementById("winnerCountBadge");
const numWinnersInput = document.getElementById("numWinners");

/**
 * Fisher-Yates shuffle algorithm to randomize an array in place.
 * (Currently used as a utility if needed)
 */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/**
 * Initialization: Fetch participants from the server and do the initial wheel draw.
 */
async function loadParticipants() {
  try {
    const res = await fetch(API_PARTICIPANTS);
    const data = await res.json();
    participants = data;
    
    // Update the UI with the total count
    participantCountBadge.textContent = `${participants.length} registered participants`;
    
    // Enable/Disable spin button based on availability
    spinButton.disabled = participants.length === 0;

    // Set the max pickable winners to the number of participants
    if (participants.length > 0) {
      numWinnersInput.max = participants.length;
    }

    // Initial render of the wheel
    drawWheel();
  } catch (e) {
    participantCountBadge.textContent = "Error loading participants";
    spinButton.disabled = true;
  }
}

/**
 * Core Drawing Logic: Renders the wheel slices and participant names on the Canvas.
 */
function drawWheel() {
  // If no participants, draw a neutral empty circle
  if (!participants.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.arc(160, 160, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#64748b";
    ctx.font = "16px Poppins, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No participants yet", 160, 165);
    return;
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = 150;

  // Filter out participants who have already won in this session
  const availableParticipants = participants.filter(
    (p) => !selectedWinners.some((w) => w.id === p.id),
  );

  // If everyone has won, clear the wheel
  if (availableParticipants.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Calculate angle for each slice
  const sliceAngle = (2 * Math.PI) / availableParticipants.length;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Iterate and draw each slice
  availableParticipants.forEach((p, index) => {
    const startAngle = index * sliceAngle;
    const endAngle = startAngle + sliceAngle;

    // Use HSL for dynamic, aesthetic colors
    const hue = (index * (360 / availableParticipants.length)) % 360;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = `hsl(${hue}, 80%, 85%)`;
    ctx.fill();

    // Draw participant name inside the slice
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(startAngle + sliceAngle / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#1e293b";
    ctx.font = "12px Poppins, system-ui, sans-serif";
    // Offset text so it stays within the outer edge
    ctx.fillText(p.name, radius - 15, 4);
    ctx.restore();
  });
}

/**
 * Updates the "Winners" sidebar with the list of people picked.
 */
function updateWinnersUI() {
  winnersList.innerHTML = "";
  selectedWinners.forEach((w, index) => {
    const li = document.createElement("li");
    li.className =
      "list-group-item d-flex justify-content-between align-items-start";
    li.style.animation = "fadeIn 0.5s ease-in-out";
    li.innerHTML = `
      <div class="me-2">
        <div class="fw-semibold text-primary">${index + 1}. ${w.name}</div>
        <div class="text-muted small">${w.company_name} · ${w.position}</div>
      </div>
    `;
    
    // Inject CSS for the fade-in effect if not already present
    if (!document.getElementById("fadeInKeyframes")) {
      const style = document.createElement("style");
      style.id = "fadeInKeyframes";
      style.innerHTML = `@keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }`;
      document.head.appendChild(style);
    }
    winnersList.appendChild(li);
  });

  if (winnerCountBadge) {
    winnerCountBadge.textContent = `${selectedWinners.length} selected`;
  }
}

/**
 * Helper to wait for a certain amount of time (used for suspense between spins).
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main Controller for the spinning animation and selection logic.
 */
async function spinAndPickLocal() {
  if (spinning || !participants.length) return;

  const numWinners = parseInt(numWinnersInput.value, 10) || 1;

  spinning = true;
  spinButton.disabled = true;
  clearButton.disabled = true;

  for (let i = 0; i < numWinners; i++) {
    // Determine who is left to pick from
    const availableParticipants = participants.filter(
      (p) => !selectedWinners.some((w) => w.id === p.id),
    );
    
    if (availableParticipants.length === 0) {
      wheelSelectedName.textContent = "All Picked!";
      break;
    }

    wheelSelectedName.textContent = "Spinning...";

    // Pre-calculate the winner locally
    const randomIndex = Math.floor(
      Math.random() * availableParticipants.length,
    );
    const thisWinner = availableParticipants[randomIndex];

    // Animation settings
    const duration = 2500; // 2.5 seconds
    const start = performance.now();

    // The Animation Loop
    await new Promise((resolve) => {
      function animate(now) {
        const elapsed = now - start;
        const t = Math.min(elapsed / duration, 1);
        
        // Cubic ease-out calculation for "natural" slowing down
        const eased = 1 - Math.pow(1 - t, 3);
        
        const randomExtraSpins = Math.PI * 8; // Adds 4 full turns for momentum
        const sliceAngle = (2 * Math.PI) / availableParticipants.length;
        const targetAngleForTop = -Math.PI / 2; // -90 deg (where the visual pointer sits)

        // Calculate where the winner segment's center is on the circle
        const winnerCenterAngle = randomIndex * sliceAngle + sliceAngle / 2;

        // Determine final rotation needed to line up the winner under the arrow
        const endRotation =
          randomExtraSpins + (targetAngleForTop - winnerCenterAngle);

        const currentAngle = eased * endRotation;

        // Apply rotation to the entire canvas view
        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(currentAngle);
        ctx.translate(-canvas.width / 2, -canvas.height / 2);
        drawWheel(); // Redraw the static wheel state within the rotated context
        ctx.restore();

        if (t < 1) {
          requestAnimationFrame(animate); 
        } else {
          resolve(); // Animation finished
        }
      }
      requestAnimationFrame(animate);
    });

    // Finalize the pick
    selectedWinners.push(thisWinner);
    updateWinnersUI();
    wheelSelectedName.textContent = thisWinner.name;

    // Pause for suspense if more picks are coming
    if (i < numWinners - 1 && availableParticipants.length > 1) {
      await sleep(1500);
    }
  }

  // Final draw to update states
  drawWheel();

  spinning = false;
  // Re-enable/Disable button based on remaining pool
  spinButton.disabled = selectedWinners.length >= participants.length;
  clearButton.disabled = false;

  if (selectedWinners.length > 0) {
    wheelSelectedName.textContent = "Draw Complete";
  }
}

/**
 * Resets the local session state.
 */
function clearWinners() {
  selectedWinners = [];
  updateWinnersUI();
  wheelSelectedName.textContent = "Ready";
  drawWheel();
  spinButton.disabled = participants.length === 0;
}

// --- EVENT LISTENERS ---

if (spinButton) {
  spinButton.addEventListener("click", spinAndPickLocal);
}

if (clearButton) {
  clearButton.addEventListener("click", clearWinners);
}

// Kick off the initial load
if (canvas) {
  loadParticipants();
  
  // Real-time update: poll the backend every 5 seconds to get new participants
  setInterval(() => {
    // Only refresh if not currently spinning to avoid visual glitches
    if (!spinning) {
      loadParticipants();
    }
  }, 5000); // 5 seconds interval
}
