// --- CONSTANTS & STATE ---

// The current event ID is passed from the Flask template to the window object
const EVENT_ID = window.CURRENT_EVENT_ID || "";
const API_PARTICIPANTS = `/api/participants/${EVENT_ID}`;
const API_PRIZES = `/api/prizes/${EVENT_ID}`;

// In-memory lists loaded from the backend
let participants = Array.isArray(window.INITIAL_PARTICIPANTS) ? window.INITIAL_PARTICIPANTS : [];
let prizes = Array.isArray(window.INITIAL_PRIZES) ? window.INITIAL_PRIZES : [];

// List of paired winners: { winner: participantObj, prize: prizeObj }
let selectedWinners = [];
let spinning = false;

// DOM Elements
const canvas = document.getElementById("wheelCanvas");
const ctx = canvas ? canvas.getContext("2d") : null;
const spinButton = document.getElementById("spinButton");
const clearButton = document.getElementById("clearButton");
const winnersList = document.getElementById("winnersList");
const wheelSelectedName = document.getElementById("wheelSelectedName");
const prizeCountBadge = document.getElementById("prizeCountBadge");
const winnerCountBadge = document.getElementById("winnerCountBadge");
const numWinnersInput = document.getElementById("numWinners");
const raffleLoop = document.getElementById("raffleLoop");

let raffleIndex = 0;
let raffleTimer = null;

/**
 * Initialization: Fetch data from the server.
 */
async function loadData() {
  try {
    const [partRes, prizeRes] = await Promise.all([
      fetch(API_PARTICIPANTS),
      fetch(API_PRIZES)
    ]);

    if (!partRes.ok || !prizeRes.ok) {
      throw new Error("Unable to load raffle data");
    }

    const fetchedParticipants = await partRes.json();
    const fetchedPrizes = await prizeRes.json();
    if (!Array.isArray(fetchedParticipants) || !Array.isArray(fetchedPrizes)) {
      throw new Error("Raffle data has an invalid format");
    }
    participants = fetchedParticipants;
    prizes = fetchedPrizes;
    
    // Update the UI with the total counts
    if (prizeCountBadge) {
      prizeCountBadge.innerHTML = `<i data-lucide="gift" style="width:12px;height:12px;margin-right:4px;vertical-align:-1px"></i>${prizes.length} prizes | ${participants.length} participants`;
      if (window.lucide) lucide.createIcons();
    }

    updateRaffleLoop();
    updateButtonState();
    
    // Set the max pickable winners to the minimum of available participants and prizes
    const maxPicks = Math.min(participants.length, prizes.length);
    if (maxPicks > 0) {
      numWinnersInput.max = maxPicks;
    }

    drawWheel();
  } catch (e) {
    if (prizeCountBadge) {
      prizeCountBadge.textContent = prizes.length
        ? `${prizes.length} prizes | refresh unavailable`
        : "Unable to load prizes";
    }
    if (raffleLoop && !participants.length) {
      raffleLoop.textContent = "Unable to load participants. Please refresh.";
    }
    updateButtonState();
    drawWheel();
  }
}

function updateButtonState() {
  const availableParticipants = participants.filter(
    (p) => !selectedWinners.some((w) => w.winner.id === p.id)
  );
  const availablePrizes = prizes.filter(
    (pr) => !selectedWinners.some((w) => w.prize.id === pr.id)
  );

  if (spinButton) {
    spinButton.disabled = availableParticipants.length === 0 || availablePrizes.length === 0 || spinning;
  }
}

/**
 * Core Drawing Logic: Renders the wheel slices with PRIZES on the Canvas.
 */
function drawWheel() {
  if (!ctx || !canvas) return;

  const availablePrizes = prizes.filter(
    (pr) => !selectedWinners.some((w) => w.prize.id === pr.id)
  );
  const wheelColors = [
    "#b9e8d2",
    "#b9dff2",
    "#f4d7a8",
    "#d7c8ed",
    "#f2c7c7",
    "#c9e3d8",
    "#c9d9ef",
    "#ead9b8",
  ];

  // If no prizes available to spin for, draw a neutral empty circle
  if (!availablePrizes.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#eaf8f3";
    ctx.beginPath();
    ctx.arc(160, 160, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#516d66";
    ctx.font = "600 14px 'Poppins', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(prizes.length ? "All prizes won!" : "No prizes yet", 160, 165);
    return;
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = 150;

  // Calculate angle for each slice
  const sliceAngle = (2 * Math.PI) / availablePrizes.length;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Iterate and draw each slice
  availablePrizes.forEach((pr, index) => {
    const startAngle = index * sliceAngle;
    const endAngle = startAngle + sliceAngle;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = wheelColors[index % wheelColors.length];
    ctx.fill();
    
    // Subtle border between slices
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw PRIZE name inside the slice
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(startAngle + sliceAngle / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#173f36";
    ctx.font = "600 12px 'Poppins', sans-serif";
    // Shadow for text readability
    ctx.shadowColor = "rgba(255,255,255,0.7)";
    ctx.shadowBlur = 4;
    
    // Truncate long prize names
    let label = pr.name;
    if (label.length > 15) label = label.substring(0, 15) + '...';
    
    ctx.fillText(label, radius - 20, 4);
    ctx.restore();
  });
}

/**
 * Updates the "Winners" sidebar with the list of people picked and their prizes.
 */
function updateWinnersUI() {
  winnersList.innerHTML = "";
  selectedWinners.forEach((item, index) => {
    const li = document.createElement("li");
    li.className =
      "list-group-item d-flex justify-content-between align-items-start";
    li.style.animation = "fadeIn 0.5s ease-in-out";
    li.innerHTML = `
      <div class="me-2 w-100">
        <div class="d-flex justify-content-between">
           <div class="fw-semibold text-primary">
             ${index + 1}. <span class="text-primary">${item.winner.name}</span>
           </div>
        </div>
        <div class="text-muted small mb-1">${item.winner.company_name} · ${item.winner.position}</div>
        <div class="badge bg-success-soft text-success text-wrap text-start mt-1">
          <i data-lucide="gift" style="width:10px;height:10px;margin-right:2px;vertical-align:-1px"></i>
          Won: ${item.prize.name}
        </div>
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
  
  if (window.lucide) lucide.createIcons();

  if (winnerCountBadge) {
    winnerCountBadge.textContent = `${selectedWinners.length} selected`;
  }
}

/**
 * Live raffle loop: continuously cycles through the participant names.
 */
function updateRaffleLoop() {
 if (!raffleLoop) return;

 if (!participants.length) {
   raffleLoop.textContent = "Waiting for participants...";
   return;
 }

 const loopNames = participants.map((p) => p.name).filter(Boolean);
 if (!loopNames.length) {
   raffleLoop.textContent = "Waiting for participants...";
   return;
 }

 const nextName = loopNames[raffleIndex % loopNames.length];
 raffleLoop.textContent = `Now showing: ${nextName}`;
 raffleIndex += 1;

 if (raffleTimer) clearInterval(raffleTimer);
 raffleTimer = setInterval(() => {
   if (!participants.length || spinning) return;
   const activeNames = participants.map((p) => p.name).filter(Boolean);
   if (!activeNames.length) return;
   raffleIndex = (raffleIndex + 1) % activeNames.length;
   raffleLoop.textContent = `Now showing: ${activeNames[raffleIndex]}`;
 }, 1400);
}

/**
 * Helper to wait for a certain amount of time.
 */
function sleep(ms) {
 return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main Controller for the spinning animation and selection logic.
 */
async function spinAndPickLocal() {
  if (spinning || !numWinnersInput || !spinButton || !wheelSelectedName || !clearButton) return;

  const requestedWinners = parseInt(numWinnersInput.value, 10) || 1;
  const numWinners = Math.max(
    1,
    Math.min(requestedWinners, participants.length, prizes.length)
  );

  spinning = true;
  updateButtonState();
  clearButton.disabled = true;
  spinButton.classList.add("btn-spinning");

  for (let i = 0; i < numWinners; i++) {
    // Determine available pools
    const availableParticipants = participants.filter(
      (p) => !selectedWinners.some((w) => w.winner.id === p.id)
    );
    const availablePrizes = prizes.filter(
      (pr) => !selectedWinners.some((w) => w.prize.id === pr.id)
    );
    
    if (availableParticipants.length === 0 || availablePrizes.length === 0) {
      wheelSelectedName.textContent = "Finished!";
      break;
    }

    wheelSelectedName.innerHTML = `<span class="text-primary">Spinning...</span>`;

    // 1. Randomly pick the PRIZE for the visual wheel
    const randomPrizeIndex = Math.floor(Math.random() * availablePrizes.length);
    const thisPrize = availablePrizes[randomPrizeIndex];
    
    // 2. Randomly pick the PARTICIPANT in the background
    const randomWinnerIndex = Math.floor(Math.random() * availableParticipants.length);
    const thisWinner = availableParticipants[randomWinnerIndex];

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
        const sliceAngle = (2 * Math.PI) / availablePrizes.length;
        const targetAngleForTop = -Math.PI / 2; // -90 deg (where the visual pointer sits)

        // Calculate where the PRIZE segment's center is on the circle
        const winnerCenterAngle = randomPrizeIndex * sliceAngle + sliceAngle / 2;

        // Determine final rotation needed to line up the PRIZE under the arrow
        const endRotation = randomExtraSpins + (targetAngleForTop - winnerCenterAngle);

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
    selectedWinners.push({ winner: thisWinner, prize: thisPrize });
    updateWinnersUI();
    wheelSelectedName.innerHTML = `<span class="text-gradient">${thisPrize.name}</span>`;

    // Pause for suspense if more picks are coming
    if (i < numWinners - 1 && availableParticipants.length > 1 && availablePrizes.length > 1) {
      await sleep(1500);
    }
  }

  // Final draw to update states (removes won prizes from the wheel)
  drawWheel();

  spinning = false;
  spinButton.classList.remove("btn-spinning");
  updateButtonState();
  clearButton.disabled = false;

  if (selectedWinners.length > 0) {
    wheelSelectedName.innerHTML = `<span class="text-gradient">Complete</span>`;
  }
}

/**
 * Resets the local session state.
 */
function clearWinners() {
  selectedWinners = [];
  updateWinnersUI();
  wheelSelectedName.textContent = "Ready";
  if (raffleLoop) raffleLoop.textContent = "Now showing: " + (participants[0]?.name || "Waiting for participants...");
  drawWheel();
  updateButtonState();
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
  loadData();
  
  // Real-time update: poll the backend every 5 seconds to get new data
  setInterval(() => {
    // Only refresh if not currently spinning to avoid visual glitches
    if (!spinning) {
      loadData();
    }
  }, 5000); // 5 seconds interval
}
